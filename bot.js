require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyrKuqc4_RwXsu2y_kCZVLbD6BUFMnqyzuokQun-4J13aWQlc96pgME2Ai3vef_oYVhQw/exec';

const userStates = new Map();

// Apps Script отвечает на POST редиректом на script.googleusercontent.com/…/echo,
// а содержимое по этому адресу реплицируется с задержкой: первый GET нередко
// получает 404 или редирект обратно на /exec (→ «doGet не найден»). Скрипт при
// этом уже отработал, поэтому повторяем только GET по тому же Location.
// Повторный POST — крайний случай; он безопасен, так как записи идемпотентны
// по requestId (скрипт вернёт сохранённый ответ, а не запишет второй раз).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchEcho(location, attempts = 6) {
  let last = '';
  let redirects = 0;
  for (let i = 1; i <= attempts; i++) {
    const r = await axios.get(location, { maxRedirects: 0, validateStatus: () => true });
    if (r.status === 200 && r.data && typeof r.data === 'object') return r.data;
    last = `status ${r.status}`;
    // 404 обычно проходит через секунду; редирект обратно на /exec — ключ уже мёртв
    if (r.status === 302 && ++redirects >= 2) break;
    if (i < attempts) await sleep(500 * i);
  }
  throw new Error('echo not ready: ' + last);
}

async function sheetsPost(payload, attempts = 3) {
  let lastError = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await axios.post(WEBHOOK_URL, payload, { maxRedirects: 0, validateStatus: () => true });

      if (r.status === 200 && r.data && typeof r.data === 'object') return r.data;

      if (r.status === 302 && r.headers.location) {
        return await fetchEcho(r.headers.location);
      }

      lastError = new Error(`unexpected reply: status ${r.status}`);
    } catch (error) {
      lastError = error;
    }
    console.warn(`Sheets attempt ${i}/${attempts} failed (${payload.action || 'add'}): ${lastError.message}`);
    if (i < attempts) await sleep(1500);
  }

  throw lastError;
}

function newRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Список пропов живёт в Apps Script (PROPS) — бот берёт его оттуда,
// чтобы не держать две копии. Fallback на случай недоступности Sheets.
const DEFAULT_PROPS = ['Instant', '100k challenge', 'FundingPips'];
let propsCache = null;
// Размеры аккаунтов (лист Props) — база для пересчёта риска $ → %.
// Не кэшируем: после пройденного челленджа размер меняется строкой в Props.
let propSizes = {};

async function getProps() {
  if (propsCache) return propsCache;
  await fetchPropInfo();
  return propsCache || DEFAULT_PROPS;
}

async function fetchPropInfo() {
  try {
    const data = await sheetsPost({ action: 'ping' });
    const props = data && data.data && data.data.props;
    if (Array.isArray(props) && props.length > 0) propsCache = props;
    if (data && data.data && data.data.sizes) propSizes = data.data.sizes;
  } catch (error) {
    console.error('Props fetch error:', error.message);
  }
  return { props: propsCache || DEFAULT_PROPS, sizes: propSizes };
}

// 300$ на аккаунте 50 000$ → 0.6 (%). Три знака хватает: 333$/100k = 0.333
function usdToRiskPct(usd, size) {
  return Math.round(usd / size * 100 * 1000) / 1000;
}

// Воркер снапшотов живёт на том же сервере и слушает только localhost.
// Если переменной нет (запуск не на сервере) — авторежим выключен, бот работает как раньше.
const WORKER_URL = process.env.WORKER_URL || '';

// Символ берём из самой ссылки: в <title> страницы снапшота он есть всегда.
// Зашивать символ в код нельзя: разметка привязана к брокеру, а брокера пользователь меняет.
// Язык страницы значения не имеет: с телефона ссылка приходит с домена ru. и заголовок
// выглядит как «Снимок графика «PEPPERSTONE:USDCHF» от leonovdigital», а с компьютера —
// «PEPPERSTONE:USDCHF Chart Image by leonovdigital». Ищем сам шаблон БИРЖА:СИМВОЛ.
async function symbolFromLink(link) {
  try {
    const r = await axios.get(link, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const title = String(r.data).match(/<title>([\s\S]*?)<\/title>/i);
    if (!title) return null;
    const m = title[1].match(/([A-Z][A-Z0-9_]*:[A-Z0-9_.]+)/);
    return m ? m[1] : null;
  } catch (error) {
    console.error('Symbol fetch error:', error.message);
    return null;
  }
}

// Возвращает промис с шестью ссылками. Запускается сразу, как пришла ссылка, и «доспевает»,
// пока пользователь отвечает на вопросы, — к моменту записи скрины обычно уже готовы.
function requestSnapshots(symbol, opts = {}) {
  return axios.post(`${WORKER_URL}/snapshots`, Object.assign({ symbol }, opts), { timeout: 240000 })
    .then(r => r.data.links)
    .catch(err => {
      const reason = (err.response && err.response.data && err.response.data.error) || err.message;
      throw new Error(reason);
    });
}

// Если в момент записи скрины не снялись — бот не просит пользователя ничего делать,
// а пробует сам: две попытки с паузой, и допишет их в ту же строку, когда получится.
// Строку знаем точно (её вернул Apps Script), поэтому промахнуться мимо сделки нельзя.
async function backfillScreenshots(ctx, row, symbol, firstError) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await sleep(attempt === 1 ? 20000 : 90000);
    try {
      const s = await requestSnapshots(symbol);
      const reply = await sheetsPost({
        action: 'setScreenshots',
        requestId: newRequestId(),
        row: row,
        links: { h1: s['1h'], h4: s['4h'], d1: s['1d'], dxy1h: s.dxy1h, dxy4h: s.dxy4h, dxy1d: s.dxy1d }
      });
      if (reply && reply.success === true) {
        await ctx.reply(`📸 Скрины досняты и записаны (строка ${reply.data.row}).`).catch(() => {});
        return;
      }
      console.error('Backfill write failed:', JSON.stringify(reply).slice(0, 200));
    } catch (error) {
      console.error(`Backfill attempt ${attempt} failed:`, error.message);
      firstError = error.message;
    }
  }
  await ctx.reply(`❌ Скрины так и не снялись: ${firstError}\nПроверь съёмщика: /tv\nКогда починится — /shots <ссылка на вход>`).catch(() => {});
}

// В журнале хранится пара без брокера («USDCHF»), а воркеру нужен полный символ
// («PEPPERSTONE:USDCHF»): разметка привязана к брокеру. Запоминаем соответствие при
// открытии сделки, чтобы при закрытии — возможно, через сутки и после перезапуска —
// знать, чей график снимать.
const SYMBOLS_FILE = process.env.SYMBOLS_FILE || `${__dirname}/symbols.json`;

function loadSymbols() {
  try {
    return JSON.parse(require('fs').readFileSync(SYMBOLS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}

function rememberSymbol(pair, symbol) {
  try {
    const all = loadSymbols();
    all[pair] = symbol;
    require('fs').writeFileSync(SYMBOLS_FILE, JSON.stringify(all, null, 2));
  } catch (error) {
    console.error('Symbols save error:', error.message);
  }
}

function symbolForPair(pair) {
  return loadSymbols()[pair] || null;
}

async function workerHealth() {
  if (!WORKER_URL) return null;
  try {
    const r = await axios.get(`${WORKER_URL}/health`, { timeout: 8000 });
    return r.data;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Сессию бот определяет сам по времени входа. Границы заданы в МЕСТНОМ времени бирж,
// а не в минском: Минск часы не переводит, Лондон и Нью-Йорк переводят, поэтому привязка
// к «10:00 по Минску» ломалась бы дважды в год (и ещё в те недели, когда Европа и США
// переводят часы в разные дни). Intl считает смещения сам, библиотек не нужно.
//
//   LO   — с открытия Лондона, 08:00 по Лондону  (сейчас 10:00 по Минску)
//   NY   — с начала Нью-Йорка, 08:00 по Нью-Йорку (сейчас 15:00)
//   NYSE — со звонка биржи, 09:30 по Нью-Йорку, до закрытия в 16:00 (сейчас 16:30)
//
// Вне этих окон (раннее утро, вечер после закрытия, выходные) бот не угадывает — спрашивает.
function minutesIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
}

function detectSession(date = new Date()) {
  const ny = minutesIn(date, 'America/New_York');
  const lo = minutesIn(date, 'Europe/London');

  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return null;

  if (ny.minutes >= 9 * 60 + 30 && ny.minutes < 16 * 60) return 'NYSE';
  if (ny.minutes >= 8 * 60 && ny.minutes < 9 * 60 + 30) return 'NY';
  if (lo.minutes >= 8 * 60 && ny.minutes < 8 * 60) return 'LO';
  return null;
}

function parseNumber(text) {
  const cleaned = String(text).trim().replace(/\s/g, '').replace(',', '.').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
}

function fmtMoney(n) {
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}$`;
}

function fmtPct(n) {
  if (n === '' || n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)}%`;
}

function fmtRR(n) {
  if (n === '' || n === null || n === undefined) return '—';
  return Number(n).toFixed(2);
}

async function uploadToGoogleSheets(trade, links) {
  try {
    const payload = {
      requestId: newRequestId(),
      day: trade.day,
      session: trade.session,
      pair: trade.pair,
      thoughts: trade.thoughts,
      position: trade.position,
      accounts: trade.accounts,
      errors: '',
      grade: trade.grade || '',
      screenshot5m: links[0] || '',
      screenshot1h: links[1] || '',
      screenshot4h: links[2] || '',
      screenshot1d: links[3] || '',
      dxySmt1: links[4] || '',
      dxySmt4: links[5] || '',
      dxySmt1d: links[6] || ''
    };

    const reply = await sheetsPost(payload);
    if (reply.success !== true) {
      console.error('Upload rejected by Sheets:', JSON.stringify(reply).slice(0, 300));
      return null;
    }
    return reply.data || {};
  } catch (error) {
    console.error('Upload error:', error.message);
    return null;
  }
}

async function updateTradeResult(trade, result, results, errors, result1h) {
  try {
    const payload = {
      action: 'updateTrade',
      requestId: newRequestId(),
      row: trade.row,
      pair: trade.pair,
      result: result,
      result1h: result1h || '',
      results: results,
      errors: errors || ''
    };

    const data = await sheetsPost(payload);
    if (data.success !== true) {
      console.error('Update rejected by Sheets:', JSON.stringify(data).slice(0, 300));
      return null;
    }
    return data.data || {};
  } catch (error) {
    console.error('Update error:', error.message);
    return null;
  }
}

async function getOpenTrades() {
  const data = await sheetsPost({ action: 'getOpenTrades' });

  if (!data || data.success !== true) {
    throw new Error('Sheets ответил: ' + JSON.stringify(data).slice(0, 200));
  }

  if (Array.isArray(data.props) && data.props.length > 0) propsCache = data.props;

  const trades = data.trades || [];
  const today = data.today;

  return {
    today: today,
    todayTrades: trades.filter(t => t.date === today),
    allTrades: trades
  };
}

async function getStats() {
  const data = await sheetsPost({ action: 'getStats' });
  if (!data || data.success !== true) {
    throw new Error('Sheets ответил: ' + JSON.stringify(data).slice(0, 200));
  }
  return data.data;
}

function formatStats(stats) {
  const [year, month] = stats.month.split('-').map(Number);
  const monthName = new Date(Date.UTC(year, month - 1, 15))
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const lines = [`📊 ${monthName}`];

  for (const p of stats.props) {
    lines.push('');
    if (p.currentBalance === null) {
      lines.push(`💼 ${p.name} — размер аккаунта не задан в Props`);
      continue;
    }
    const balance = Number(p.currentBalance).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    const size = Number(p.accountSize).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
    const vsSize = p.currentBalance - p.accountSize;
    lines.push(`💼 ${p.name}: ${balance}$ · аккаунт ${size}$ (${fmtPct(vsSize / p.accountSize * 100)})`);
    // месяц — от баланса: текущий − баланс на 1-е число (не сумма сделок журнала)
    const monthStart = Number(p.monthStartBalance).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    lines.push(`   месяц: ${fmtMoney(p.monthUsd)} · ${fmtPct(p.monthPct)} (с ${monthStart}$)` +
      ` · сделок ${p.monthTrades}` +
      (p.monthTrades ? ` · winrate ${Math.round(p.monthWins / p.monthTrades * 100)}%` : '') +
      (p.open ? ` · ⏳ открыто ${p.open}` : ''));
  }

  const total = stats.props.reduce((s, p) => s + (p.monthUsd || 0), 0);
  lines.push('', `Σ за месяц: ${fmtMoney(total)}`);
  return lines.join('\n');
}

/*** Клавиатуры ***/

function accountsKeyboard(props, selected) {
  const rows = props.map((name, i) => [{
    text: `${selected.includes(name) ? '✅' : '☐'} ${name}`,
    callback_data: `accsel_${i}`
  }]);
  rows.push([{ text: '➡️ Готово', callback_data: 'accdone' }]);
  return { inline_keyboard: rows };
}

const RISK_PRESETS = [0.25, 0.5, 1];

// Кнопки в долларах под размер конкретного аккаунта; в callback — процент,
// потому что в таблицу идёт именно он. Без размера (нет строки в Props) — в %.
function riskKeyboard(size) {
  const presets = RISK_PRESETS.map(pct => ({
    text: size ? `${Math.round(size * pct / 100)}$ (${pct}%)` : `${pct}%`,
    callback_data: `prisk_${pct}`
  }));
  return { inline_keyboard: [presets, [{ text: 'Своё', callback_data: 'prisk_custom' }]] };
}

function riskLabel(state, name) {
  const usd = state.accRiskUsd[name];
  return usd !== undefined ? `${usd}$ (${state.accRisks[name]}%)` : `${state.accRisks[name]}%`;
}

function riskSummary(state) {
  return state.accSelected.map(n => `${n} — ${riskLabel(state, n)}`).join(', ');
}

async function askRiskForNext(ctx, state) {
  const name = state.accSelected[state.riskIdx];
  if (!name) {
    state.step = 'waiting_thoughts';
    userStates.set(ctx.chat.id, state);
    await ctx.reply(`Аккаунты: ${riskSummary(state)}\n\nНапиши свои мысли перед входом:`);
    return;
  }

  state.step = 'waiting_risk';
  userStates.set(ctx.chat.id, state);
  const size = (state.sizes || {})[name];
  const question = size
    ? `Риск на ${name} — сколько $? (аккаунт ${size.toLocaleString('ru-RU')}$)`
    : `Риск на ${name} (% от размера аккаунта)? Размер в Props не задан`;
  await ctx.reply(question, { reply_markup: riskKeyboard(size) });
}

function sessionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'LO', callback_data: 'session_LO' }],
      [{ text: 'NY', callback_data: 'session_NY' }],
      [{ text: 'NYSE', callback_data: 'session_NYSE' }]
    ]
  };
}

function positionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Long', callback_data: 'pos_Long' }],
      [{ text: 'Short', callback_data: 'pos_Short' }]
    ]
  };
}

// Сессию берём из времени входа и спрашиваем, только если оно вне торговых окон
// (раннее утро, вечер после закрытия NYSE, выходные).
async function afterAsset(ctx, state) {
  const session = detectSession();

  if (session) {
    state.session = session;
    state.step = 'waiting_position';
    userStates.set(ctx.chat.id, state);
    // Определённую сессию всегда показываем и даём переопределить: бот считает по часам,
    // а пользователь мог войти раньше, чем прислал ссылку.
    await ctx.reply(`Сессия: ${session}\n\nLong или Short?`, {
      reply_markup: {
        inline_keyboard: positionKeyboard().inline_keyboard.concat([
          [{ text: `🔁 Сессия ${session} — поменять`, callback_data: 'session_change' }]
        ])
      }
    });
    return;
  }

  state.step = 'waiting_session';
  userStates.set(ctx.chat.id, state);
  await ctx.reply('Сейчас вне твоих сессий — выбери вручную:', { reply_markup: sessionKeyboard() });
}

function gradeKeyboard() {
  return {
    inline_keyboard: [[
      { text: 'A', callback_data: 'grade_A' },
      { text: 'A (-)', callback_data: 'grade_A (-)' },
      { text: 'B', callback_data: 'grade_B' },
      { text: 'C', callback_data: 'grade_C' }
    ]]
  };
}

async function saveNewTrade(ctx, state) {
  let links = state.links;
  let snapshotError = null;

  // Скрины снимаются параллельно опросу; здесь просто забираем результат.
  // Журнал не должен зависеть от воркера: если он не справился — пишем сделку
  // с одним скрином и говорим об этом прямо.
  if (state.snapshots) {
    await ctx.reply('⏳ Забираю остальные таймфреймы...');
    try {
      const s = await state.snapshots;
      links = [state.links[0], s['1h'], s['4h'], s['1d'], s.dxy1h, s.dxy4h, s.dxy1d];
    } catch (error) {
      snapshotError = error.message;
      console.error('Snapshots failed:', snapshotError);
    }
  }

  await ctx.reply('⏳ Загружаю в журнал...');

  const sheetData = {
    day: new Date().toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'Europe/Minsk' }),
    session: state.session,
    pair: state.asset,
    thoughts: state.thoughts,
    position: state.position,
    grade: state.grade,
    accounts: state.accSelected.map(name => ({ name: name, risk: state.accRisks[name] }))
  };

  const result = await uploadToGoogleSheets(sheetData, links);

  if (!result) {
    state.step = 'waiting_grade';
    userStates.set(ctx.chat.id, state);
    await ctx.reply('❌ Не записалось в таблицу. Нажми оценку ещё раз.', { reply_markup: gradeKeyboard() });
    return;
  }

  userStates.set(ctx.chat.id, { step: 'idle' });

  if (snapshotError && state.symbol && result.row) {
    backfillScreenshots(ctx, result.row, state.symbol, snapshotError);
  }

  const shots = snapshotError
    ? `\n\n⚠️ Скрины таймфреймов не снялись: ${snapshotError}\nПробую ещё раз сам — напишу, когда добавлю.`
    : (state.snapshots ? `\n📸 Скрины: 1h, 4h, 1d + DXY — записаны` : '');

  await ctx.reply(
    `✅ ${state.asset} ${state.position} · оценка ${state.grade} · ${riskSummary(state)}${shots}\n\n` +
    'Записал.\n<b>Ты дал цену слова, у тебя есть 5 минут…</b>\n\n/closetrade для закрытия',
    { parse_mode: 'HTML' }
  );
}

async function askUsdForNext(ctx, state) {
  const prop = state.closeQueue[state.closeIdx];

  if (!prop) {
    if ((state.closeResults || []).length === 0) {
      await finishClose(ctx, state);
      return;
    }
    state.step = 'closing_errors';
    userStates.set(ctx.chat.id, state);
    await ctx.reply('Ошибки после сделки/выводы:', {
      reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'errors_skip' }]] }
    });
    return;
  }

  state.step = 'closing_usd';
  userStates.set(ctx.chat.id, state);

  await ctx.reply(
    `${prop.name} (риск ${prop.risk}%) — сколько $?\nНапример: 250, -180 или 0 (б/у)`,
    { reply_markup: { inline_keyboard: [[{ text: '⏳ Ещё открыт — пропустить', callback_data: 'usd_skip' }]] } }
  );
}

async function finishClose(ctx, state) {
  const trade = state.closingTrade;
  const results = state.closeResults || [];

  state.step = 'idle';
  userStates.set(ctx.chat.id, state);

  if (results.length === 0) {
    await ctx.reply('Ничего не закрыто — все пропы остались открытыми.');
    return;
  }

  let result = state.closeResult;
  let result1h = '';
  let shotsError = null;

  if (state.closeShots) {
    await ctx.reply('⏳ Забираю скрины закрытия...');
    try {
      const shots = await state.closeShots;
      result = shots['5m'];
      result1h = shots['1h'];
    } catch (error) {
      shotsError = error.message;
      console.error('Close snapshots failed:', shotsError);
    }
  }

  await ctx.reply('⏳ Записываю...');

  const data = await updateTradeResult(trade, result, results, state.closeErrors, result1h);

  if (!data) {
    await ctx.reply('❌ Ошибка при обновлении таблицы. Попробуй /closetrade ещё раз.');
    return;
  }

  const lines = (data.report || []).map(r =>
    `${r.name}: ${fmtMoney(r.usd)} → ${fmtPct(r.pct)} → RR ${fmtRR(r.rr)}`
  );

  const skipped = state.closeQueue
    .filter(p => !results.find(r => r.name === p.name))
    .map(p => p.name);

  let text = `✅ ${trade.pair} закрыт:\n` + lines.join('\n');
  if (shotsError) text += `\n\n⚠️ Скрины закрытия не снялись: ${shotsError}`;
  else if (state.closeShots) text += `\n📸 Скрины закрытия: 5м и 1ч`;
  if (state.closeErrors) text += `\n\n📝 ${state.closeErrors}`;
  if (skipped.length > 0) text += `\n\n⏳ Ещё открыто: ${skipped.join(', ')} — закроешь через /closetrade`;

  await ctx.reply(text);
}

/*** Команды ***/

bot.start((ctx) => {
  userStates.delete(ctx.chat.id);
  ctx.reply('👋 Привет! Кинь одну Share-ссылку с TradingView — снимок входа 1-5m.\n' +
    '1h, 4h, 1d и DXY сниму сам с твоего графика.\n\n' +
    'Если пришлёшь несколько ссылок сразу — возьму их как есть, в порядке:\n' +
    '1-5m, 1h, 4h, 1d, DXY 1h, DXY 4h, DXY 1d\n\n' +
    '/closetrade — закрыть сделку\n/stats — балансы и текущий месяц по пропам\n' +
    '/balance — поправить баланс пропа\n/shots — дослать скрины в последнюю сделку\n' +
    '/tv — проверить съёмщик скринов\n/reset — сбросить диалог');
});

bot.command('reset', async (ctx) => {
  userStates.delete(ctx.chat.id);
  await ctx.reply('🔄 Сброшено. Отправляй ссылки с TradingView.');
});

// Дослать скрины в уже записанную сделку: /shots <ссылка на снимок входа>.
// Нужно, когда съёмщик не справился в момент записи, — чтобы не вбивать шесть ссылок руками.
bot.command('shots', async (ctx) => {
  if (!WORKER_URL) {
    await ctx.reply('Автосъёмка выключена: бот запущен не на сервере с воркером.');
    return;
  }

  const link = (ctx.message.text.match(/https:\/\/(?:[a-z]*\.)?tradingview\.com\/x\/[a-zA-Z0-9]+/) || [])[0];
  if (!link) {
    await ctx.reply('Пришли так: /shots <ссылка на твой снимок входа>\nСкрины добавлю в последнюю записанную сделку.');
    return;
  }

  const symbol = await symbolFromLink(link);
  if (!symbol) {
    await ctx.reply('Не понял символ из ссылки.');
    return;
  }

  await ctx.reply(`⏳ ${symbol}: снимаю 1h, 4h, 1d и DXY — около полутора минут.`);

  try {
    const s = await requestSnapshots(symbol);
    const reply = await sheetsPost({
      action: 'setScreenshots',
      requestId: newRequestId(),
      row: 'last',
      links: { h1: s['1h'], h4: s['4h'], d1: s['1d'], dxy1h: s.dxy1h, dxy4h: s.dxy4h, dxy1d: s.dxy1d }
    });

    if (!reply || reply.success !== true) {
      await ctx.reply('❌ Не записалось в таблицу: ' + (reply && reply.message));
      return;
    }

    const d = reply.data;
    await ctx.reply(`✅ ${d.pair} (строка ${d.row}): добавлено ${d.written.length} скринов` +
      (d.skipped.length ? `\nБыли заняты и не тронуты: ${d.skipped.join(', ')}` : ''));
  } catch (error) {
    await ctx.reply('❌ Скрины не снялись: ' + error.message);
  }
});

// Проверка съёмщика скринов: жив ли, не слетела ли сессия TradingView
bot.command('tv', async (ctx) => {
  if (!WORKER_URL) {
    await ctx.reply('Автосъёмка скринов выключена: бот запущен не на сервере с воркером.');
    return;
  }
  const h = await workerHealth();
  if (!h || !h.ok) {
    await ctx.reply(`❌ Воркер не отвечает: ${(h && h.error) || 'нет связи'}\nСкрины придётся присылать вручную.`);
  } else if (!h.loggedIn) {
    await ctx.reply('⚠️ Воркер жив, но сессия TradingView слетела — нужен повторный вход на сервере.');
  } else {
    await ctx.reply(`✅ Воркер готов${h.busy ? ', сейчас занят съёмкой' : ''}. Кидай одну ссылку 1-5m — остальное сниму сам.`);
  }
});

bot.command('stats', async (ctx) => {
  try {
    const stats = await getStats();
    await ctx.reply(formatStats(stats));
  } catch (error) {
    console.error('Stats error:', error.message);
    await ctx.reply('❌ Не могу прочитать статистику: ' + error.message);
  }
});

// /balance                → текущие балансы
// /balance 100k 98369     → зафиксировать фактический баланс пропа на текущий момент.
// Проценты по сделкам считаются от РАЗМЕРА аккаунта (лист Props) и не меняются;
// фиксация влияет только на «текущий баланс» = фиксация + сделки после неё.
bot.command('balance', async (ctx) => {
  try {
    const args = ctx.message.text.replace(/^\/balance(@\w+)?\s*/i, '').trim();
    const props = await getProps();

    if (!args) {
      const stats = await getStats();
      const lines = stats.props.map(p => p.currentBalance === null
        ? `• ${p.name}: размер аккаунта не задан`
        : `• ${p.name}: ${Number(p.currentBalance).toLocaleString('ru-RU')}$` +
          (p.snapshotAt ? ` (зафиксировано ${Number(p.snapshotBalance).toLocaleString('ru-RU')}$ ${p.snapshotAt}, после: ${fmtMoney(p.pnlSince)})`
                        : ` (аккаунт ${Number(p.accountSize).toLocaleString('ru-RU')}$ + сделки)`));
      await ctx.reply(`Балансы сейчас:\n${lines.join('\n')}\n\nЕсли на счёте другая сумма — зафиксируй факт:\n/balance <проп> <сумма>\nНапример: /balance instant 48789\nПроценты по сделкам от этого не меняются.`);
      return;
    }

    const m = args.match(/^(.+?)\s+([\d\s.,]+)$/);
    if (!m) {
      await ctx.reply('Формат: /balance <проп> <сумма>\nНапример: /balance instant 48789');
      return;
    }

    const query = m[1].trim().toLowerCase();
    const amount = parseNumber(m[2]);
    const matches = props.filter(p => p.toLowerCase().includes(query));

    if (matches.length !== 1) {
      await ctx.reply(`Не понял, какой проп: «${m[1].trim()}». Доступны: ${props.join(', ')}`);
      return;
    }
    if (amount === null || amount <= 0) {
      await ctx.reply('Сумма должна быть положительным числом, например 48789');
      return;
    }

    const reply = await sheetsPost({ action: 'setBalance', requestId: newRequestId(), name: matches[0], balance: amount });
    if (!reply || reply.success !== true) {
      await ctx.reply('❌ Не записалось: ' + (reply && reply.message));
      return;
    }

    const d = reply.data;
    await ctx.reply(`✅ ${d.name}: ${Number(d.balance).toLocaleString('ru-RU')}$ зафиксировано ${d.at}\n\nДальше баланс движется от этой суммы по закрытым сделкам. Проверить: /stats`);
  } catch (error) {
    console.error('Balance error:', error.message);
    await ctx.reply('❌ Ошибка: ' + error.message);
  }
});

bot.command('closetrade', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId) || {};

  let data;
  try {
    data = await getOpenTrades();
  } catch (error) {
    console.error('Get open trades error:', error.message);
    await ctx.reply('❌ Не могу прочитать журнал: ' + error.message);
    return;
  }

  const useToday = data.todayTrades.length > 0;
  const trades = useToday ? data.todayTrades : data.allTrades;

  if (trades.length === 0) {
    await ctx.reply('❌ В журнале нет незакрытых сделок.');
    return;
  }

  state.openTrades = trades;
  state.step = 'closing_select_trade';
  userStates.set(chatId, state);

  const buttons = trades.map((trade, idx) => {
    const open = trade.openProps.map(p => p.name).join(', ');
    const when = useToday ? `${trade.session} · ${trade.time}` : `${trade.date} ${trade.time}`;
    return [{ text: `${trade.pair} · ${when} · ${open}`, callback_data: `close_trade_${idx}` }];
  });

  buttons.push([{ text: '❌ Отмена', callback_data: 'close_cancel' }]);

  const header = useToday
    ? `Сделки за сегодня (${data.today}):`
    : `За сегодня сделок нет. Все незакрытые:`;

  await ctx.reply(header + '\n\nКакую закрываем?', {
    reply_markup: { inline_keyboard: buttons }
  });
});

/*** Текст ***/

bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const state = userStates.get(chatId) || {};

    const links = text.match(/https:\/\/(?:[a-z]*\.)?tradingview\.com\/x\/[a-zA-Z0-9]+/g) || [];

    // Шаги, на которых бот ждёт именно текст — там ссылка означает не новую сделку
    const awaitingText = ['waiting_thoughts', 'waiting_risk_custom', 'closing_result', 'closing_usd', 'closing_errors']
      .includes(state.step);

    if (links.length > 0 && !awaitingText) {
      // Одна ссылка + доступный воркер = авторежим: остальные шесть таймфреймов
      // бот снимет сам с графика пользователя. Несколько ссылок — как раньше, вручную.
      if (links.length === 1 && WORKER_URL) {
        const symbol = await symbolFromLink(links[0]);
        if (symbol) {
          const asset = symbol.split(':').pop();
          const snapshots = requestSnapshots(symbol);
          snapshots.catch(() => {});   // ошибку разберём при записи, здесь только чтобы не падать

          rememberSymbol(asset, symbol);
          const state = { links: [links[0]], asset, symbol, snapshots };
          await ctx.reply(`✅ ${asset} · снимок 1-5m принят\n\n⏳ 1h, 4h, 1d и DXY снимаю сам — будут готовы к концу опроса.`);
          await afterAsset(ctx, state);
          return;
        }
        await ctx.reply('Не понял символ из ссылки — дальше вручную.');
      }

      const tfNames = ['1-5m', '1h', '4h', '1d', 'DXY 1h', 'DXY 4h', 'DXY 1d'];
      const display = links.map((_, i) => `${i + 1}. ${tfNames[i] || `Link ${i + 1}`}`).join('\n');

      userStates.set(chatId, { links: links, step: 'waiting_asset' });

      await ctx.reply(`✅ Получено ${links.length} ссылок:\n\n${display}\n\nДалее → выбери актив`);
      await ctx.reply('Какой актив?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USDCHF', callback_data: 'asset_USDCHF' }],
            [{ text: 'UK100', callback_data: 'asset_UK100' }],
            [{ text: 'US30', callback_data: 'asset_US30' }]
          ]
        }
      });
      return;
    }

    if (state.step === 'waiting_risk_custom') {
      const name = state.accSelected[state.riskIdx];
      const size = (state.sizes || {})[name];
      const value = parseNumber(text);

      if (size) {
        // ввод в долларах, в таблицу — % от размера аккаунта
        if (value === null || value <= 0 || value > size * 0.1) {
          await ctx.reply(`Не понял сумму. Введи риск в долларах, например 300 (не больше ${Math.round(size * 0.1)}$ — это 10% аккаунта)`);
          return;
        }
        state.accRiskUsd[name] = value;
        state.accRisks[name] = usdToRiskPct(value, size);
      } else {
        if (value === null || value <= 0 || value > 10) {
          await ctx.reply('Не понял риск. Введи число в процентах, например 0.5 или 1');
          return;
        }
        state.accRisks[name] = value;
      }
      state.riskIdx++;
      await askRiskForNext(ctx, state);

    } else if (state.step === 'waiting_thoughts') {
      state.thoughts = text;
      state.step = 'waiting_grade';
      userStates.set(chatId, state);
      await ctx.reply('Оцени позицию:', { reply_markup: gradeKeyboard() });

    } else if (state.step === 'closing_errors') {
      state.closeErrors = text.trim();
      await finishClose(ctx, state);

    } else if (state.step === 'closing_result') {
      state.closeResult = text;
      state.closeIdx = 0;
      state.closeResults = [];
      await askUsdForNext(ctx, state);

    } else if (state.step === 'closing_usd') {
      const usd = parseNumber(text);
      if (usd === null) {
        await ctx.reply('Не понял сумму. Введи число в долларах: 250, -180 или 0');
        return;
      }
      const prop = state.closeQueue[state.closeIdx];
      state.closeResults.push({ name: prop.name, usd: usd, risk: prop.risk });
      state.closeIdx++;
      await askUsdForNext(ctx, state);

    } else if (['waiting_asset', 'waiting_session', 'waiting_position', 'waiting_accounts', 'waiting_risk', 'waiting_grade', 'closing_select_trade'].includes(state.step)) {
      await ctx.reply('Нажми кнопку выше 👆 или /reset чтобы начать заново.');

    } else {
      await ctx.reply('Не понял. Отправь Share-ссылки с TradingView, или /closetrade чтобы закрыть сделку.');
    }
  } catch (err) {
    console.error('❌ Error in text handler:', err.message, err.stack);
    await ctx.reply('❌ Ошибка: ' + err.message).catch(() => {});
  }
});

/*** Кнопки ***/

bot.on('callback_query', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const data = ctx.callbackQuery.data;
    const state = userStates.get(chatId) || {};

    if (data.startsWith('asset_')) {
      state.asset = data.replace('asset_', '');
      await afterAsset(ctx, state);

    } else if (data === 'session_change') {
      state.step = 'waiting_session';
      userStates.set(chatId, state);
      await ctx.reply('Какая сессия?', { reply_markup: sessionKeyboard() });

    } else if (data.startsWith('session_')) {
      state.session = data.replace('session_', '');
      state.step = 'waiting_position';
      userStates.set(chatId, state);

      await ctx.reply('Long или Short?', { reply_markup: positionKeyboard() });

    } else if (data.startsWith('pos_')) {
      // Без этой проверки кнопка Long/Short, нажатая на шаге выбора сессии,
      // протаскивала диалог дальше, и сделка записывалась с пустой сессией.
      if (state.step !== 'waiting_position') {
        await ctx.answerCbQuery('Сначала выбери сессию');
        return;
      }
      state.position = data.replace('pos_', '');
      state.step = 'waiting_accounts';
      const info = await fetchPropInfo();
      state.props = info.props;
      state.sizes = info.sizes;
      state.accSelected = [];
      state.accRisks = {};
      state.accRiskUsd = {};
      userStates.set(chatId, state);

      await ctx.reply('На каких аккаунтах вошёл? (можно несколько)', {
        reply_markup: accountsKeyboard(state.props, state.accSelected)
      });

    } else if (data.startsWith('accsel_')) {
      if (state.step !== 'waiting_accounts') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      const name = state.props[parseInt(data.split('_')[1], 10)];
      if (name) {
        const i = state.accSelected.indexOf(name);
        if (i === -1) state.accSelected.push(name); else state.accSelected.splice(i, 1);
        // сохраняем порядок как в списке пропов
        state.accSelected.sort((a, b) => state.props.indexOf(a) - state.props.indexOf(b));
        userStates.set(chatId, state);
        await ctx.editMessageReplyMarkup(accountsKeyboard(state.props, state.accSelected)).catch(() => {});
      }

    } else if (data === 'accdone') {
      if (state.step !== 'waiting_accounts') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      if (state.accSelected.length === 0) {
        await ctx.answerCbQuery('Выбери хотя бы один аккаунт', { show_alert: true });
        return;
      }
      state.riskIdx = 0;
      await askRiskForNext(ctx, state);

    } else if (data.startsWith('prisk_')) {
      if (state.step !== 'waiting_risk') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      const value = data.replace('prisk_', '');
      const name = state.accSelected[state.riskIdx];
      const size = (state.sizes || {})[name];
      if (value === 'custom') {
        state.step = 'waiting_risk_custom';
        userStates.set(chatId, state);
        await ctx.reply(size ? `Введи риск на ${name} в долларах:` : `Введи риск на ${name} в %:`);
      } else {
        const pct = parseFloat(value);
        state.accRisks[name] = pct;
        if (size) state.accRiskUsd[name] = Math.round(size * pct / 100);
        state.riskIdx++;
        await askRiskForNext(ctx, state);
      }

    } else if (data.startsWith('grade_')) {
      if (state.step !== 'waiting_grade') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      state.grade = data.replace('grade_', '');
      state.step = 'saving';
      userStates.set(chatId, state);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      await saveNewTrade(ctx, state);

    } else if (data === 'errors_skip') {
      if (state.step !== 'closing_errors') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      state.closeErrors = '';
      await finishClose(ctx, state);

    } else if (data.startsWith('close_trade_')) {
      const tradeIdx = parseInt(data.split('_')[2], 10);
      const trade = (state.openTrades || [])[tradeIdx];

      if (!trade) {
        await ctx.reply('Список устарел. Набери /closetrade заново.');
        await ctx.answerCbQuery();
        return;
      }

      state.closingTrade = trade;
      state.closeQueue = trade.openProps;

      const open = trade.openProps.map(p => `${p.name} (${p.risk}%)`).join(', ');
      const closed = trade.closedProps.length > 0
        ? `\n✔️ Уже закрыто: ${trade.closedProps.map(p => `${p.name} ${fmtMoney(p.usd)}`).join(', ')}`
        : '';
      const head = `✅ Закрываем: ${trade.pair} ${trade.position} (${trade.session})\n📍 Открыта: ${trade.date} в ${trade.time}\n💼 Открыто на: ${open}${closed}`;

      // Скрины закрытия бот снимает сам — 5м и 1ч по тому же брокеру, что и вход.
      // Символ помним с открытия; если не знаем (сделка из старых или бот не на сервере),
      // работает прежний путь — просим скрин руками.
      const closeSymbol = WORKER_URL ? symbolForPair(trade.pair) : null;

      if (closeSymbol) {
        state.closeShots = requestSnapshots(closeSymbol, { tfs: ['5m', '1h'], dxy: null });
        state.closeShots.catch(() => {});
        state.closeResult = '';
        state.closeIdx = 0;
        state.closeResults = [];
        userStates.set(chatId, state);

        await ctx.reply(`${head}\n\n⏳ Скрины закрытия (5м и 1ч) снимаю сам.`);
        await askUsdForNext(ctx, state);
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      state.step = 'closing_result';
      userStates.set(chatId, state);
      await ctx.reply(`${head}\n\nОтправь скрин результата:`);

    } else if (data === 'usd_skip') {
      if (state.step !== 'closing_usd') {
        await ctx.answerCbQuery('Этот шаг уже пройден');
        return;
      }
      state.closeIdx++;
      await askUsdForNext(ctx, state);

    } else if (data === 'close_cancel') {
      userStates.set(chatId, { step: 'idle' });
      await ctx.reply('❌ Отменено');
    }

    await ctx.answerCbQuery().catch(() => {});
  } catch (err) {
    console.error('❌ Error in callback handler:', err.message, err.stack);
    await ctx.reply('❌ Ошибка: ' + err.message).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  }
});

/*** Сервер ***/

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/bot', (req, res) => {
  console.log('📨 Incoming update:', JSON.stringify(req.body, null, 2));
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// При require из тестов сервер не поднимаем — только экспортируем функции
module.exports = {
  bot, sheetsPost, uploadToGoogleSheets, updateTradeResult, getOpenTrades, getStats,
  parseNumber, fmtMoney, fmtPct, fmtRR, formatStats, usdToRiskPct, detectSession
};

// На своём сервере работаем длинным опросом (BOT_MODE=polling): Telegram не ходит
// к нам, а мы к нему — не нужны ни домен, ни сертификат, ни открытые порты.
// На Render остаётся вебхук. Одновременно включать нельзя: Telegram отдаёт
// апдейты либо туда, либо сюда, и второй экземпляр будет получать 409.
if (require.main === module) app.listen(PORT, async () => {
  const POLLING = process.env.BOT_MODE === 'polling';

  try {
    await bot.telegram.deleteWebhook();
    console.log('🗑️ Deleted old webhook');

    if (POLLING) {
      // launch() не резолвится, пока бот жив, — поэтому без await.
      // Если опрос упал (таймаут сети, 409 от перехваченного вебхука), процесс
      // обязан умереть: express сам по себе продолжал бы слушать порт, systemd
      // считал бы сервис живым, а бот молчал бы. Restart=always поднимет заново.
      bot.launch().catch(err => {
        console.error('❌ Polling died, exiting for restart:', err.message);
        process.exit(1);
      });
      console.log('🤖 Trade Journal Bot started in polling mode');
    } else {
      const BOT_DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://trading-journal-bot-18r8.onrender.com';
      const webhookUrl = `${BOT_DOMAIN}/bot`;

      await new Promise(r => setTimeout(r, 1000));

      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🤖 Trade Journal Bot webhook set to ${webhookUrl}`);

      const info = await bot.telegram.getWebhookInfo();
      console.log(`📍 Webhook info:`, JSON.stringify(info, null, 2));
    }
  } catch (err) {
    console.error('❌ Start error:', err.message);
  }

  try {
    const data = await getOpenTrades();
    console.log(`✅ Sheets ok. Props: ${(propsCache || DEFAULT_PROPS).join(', ')}. Today ${data.today}: ${data.todayTrades.length} open, всего незакрытых ${data.allTrades.length}`);
  } catch (err) {
    console.error('❌ Sheets check failed:', err.message);
  }

  console.log(`📡 Server listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  process.exit(0);
});
