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

async function sheetsPost(payload, attempts = 2) {
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

async function getProps() {
  if (propsCache) return propsCache;
  try {
    const data = await sheetsPost({ action: 'ping' });
    const props = data && data.data && data.data.props;
    if (Array.isArray(props) && props.length > 0) propsCache = props;
  } catch (error) {
    console.error('Props fetch error:', error.message);
  }
  return propsCache || DEFAULT_PROPS;
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
      rating: links[0] || '',
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

async function updateTradeResult(trade, result, results) {
  try {
    const payload = {
      action: 'updateTrade',
      requestId: newRequestId(),
      row: trade.row,
      pair: trade.pair,
      result: result,
      results: results
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
    lines.push(`   месяц: ${fmtMoney(p.monthUsd)} · ${fmtPct(p.monthPct)} · сделок ${p.monthTrades}` +
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

function riskKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '0.25', callback_data: 'prisk_0.25' },
        { text: '0.5', callback_data: 'prisk_0.5' },
        { text: '1', callback_data: 'prisk_1' }
      ],
      [{ text: 'Своё', callback_data: 'prisk_custom' }]
    ]
  };
}

async function askRiskForNext(ctx, state) {
  const name = state.accSelected[state.riskIdx];
  if (!name) {
    state.step = 'waiting_thoughts';
    userStates.set(ctx.chat.id, state);
    const summary = state.accSelected.map(n => `${n} — ${state.accRisks[n]}%`).join(', ');
    await ctx.reply(`Аккаунты: ${summary}\n\nНапиши свои мысли перед входом:`);
    return;
  }

  state.step = 'waiting_risk';
  userStates.set(ctx.chat.id, state);
  await ctx.reply(`Риск на ${name} (% от баланса)?`, { reply_markup: riskKeyboard() });
}

async function askUsdForNext(ctx, state) {
  const prop = state.closeQueue[state.closeIdx];

  if (!prop) {
    await finishClose(ctx, state);
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

  await ctx.reply('⏳ Записываю...');

  const data = await updateTradeResult(trade, state.closeResult, results);

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
  if (skipped.length > 0) text += `\n\n⏳ Ещё открыто: ${skipped.join(', ')} — закроешь через /closetrade`;

  await ctx.reply(text);
}

/*** Команды ***/

bot.start((ctx) => {
  userStates.delete(ctx.chat.id);
  ctx.reply('👋 Привет! Начинай отправлять Share ссылки с TradingView:\n\n1️⃣ 1-5m\n2️⃣ 1h\n3️⃣ 4h\n4️⃣ 1d\n5️⃣ DXY 1h (опционально)\n6️⃣ DXY 4h (опционально)\n7️⃣ DXY 1d (опционально)\n\n/closetrade — закрыть сделку\n/stats — балансы и текущий месяц по пропам\n/balance — поправить баланс пропа\n/reset — сбросить диалог');
});

bot.command('reset', async (ctx) => {
  userStates.delete(ctx.chat.id);
  await ctx.reply('🔄 Сброшено. Отправляй ссылки с TradingView.');
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
    const awaitingText = ['waiting_thoughts', 'waiting_risk_custom', 'closing_result', 'closing_usd']
      .includes(state.step);

    if (links.length > 0 && !awaitingText) {
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
      const risk = parseNumber(text);
      if (risk === null || risk <= 0 || risk > 10) {
        await ctx.reply('Не понял риск. Введи число в процентах, например 0.5 или 1');
        return;
      }
      state.accRisks[state.accSelected[state.riskIdx]] = risk;
      state.riskIdx++;
      await askRiskForNext(ctx, state);

    } else if (state.step === 'waiting_thoughts') {
      state.thoughts = text;
      await ctx.reply('⏳ Загружаю в журнал...');

      const sheetData = {
        day: new Date().toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'Europe/Minsk' }),
        session: state.session,
        pair: state.asset,
        thoughts: state.thoughts,
        position: state.position,
        accounts: state.accSelected.map(name => ({ name: name, risk: state.accRisks[name] }))
      };

      const result = await uploadToGoogleSheets(sheetData, state.links);

      if (result) {
        const accs = state.accSelected.map(n => `${n} ${state.accRisks[n]}%`).join(', ');
        await ctx.reply(`✅ Сделка открыта и записана в журнал!\n${state.asset} ${state.position} · ${accs}\n\nДля новой отправь ссылки или /closetrade для закрытия`);
        userStates.set(chatId, { step: 'idle' });
      } else {
        await ctx.reply('❌ Не записалось в таблицу. Попробуй ещё раз.');
      }

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

    } else if (['waiting_asset', 'waiting_session', 'waiting_position', 'waiting_accounts', 'waiting_risk', 'closing_select_trade'].includes(state.step)) {
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
      state.step = 'waiting_session';
      userStates.set(chatId, state);

      await ctx.reply('Какая сессия?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'LO', callback_data: 'session_LO' }],
            [{ text: 'NY', callback_data: 'session_NY' }],
            [{ text: 'NYSE', callback_data: 'session_NYSE' }]
          ]
        }
      });

    } else if (data.startsWith('session_')) {
      state.session = data.replace('session_', '');
      state.step = 'waiting_position';
      userStates.set(chatId, state);

      await ctx.reply('Long или Short?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Long', callback_data: 'pos_Long' }],
            [{ text: 'Short', callback_data: 'pos_Short' }]
          ]
        }
      });

    } else if (data.startsWith('pos_')) {
      state.position = data.replace('pos_', '');
      state.step = 'waiting_accounts';
      state.props = await getProps();
      state.accSelected = [];
      state.accRisks = {};
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
      if (value === 'custom') {
        state.step = 'waiting_risk_custom';
        userStates.set(chatId, state);
        await ctx.reply(`Введи риск на ${state.accSelected[state.riskIdx]} в %:`);
      } else {
        state.accRisks[state.accSelected[state.riskIdx]] = parseFloat(value);
        state.riskIdx++;
        await askRiskForNext(ctx, state);
      }

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
      state.step = 'closing_result';
      userStates.set(chatId, state);

      const open = trade.openProps.map(p => `${p.name} (${p.risk}%)`).join(', ');
      const closed = trade.closedProps.length > 0
        ? `\n✔️ Уже закрыто: ${trade.closedProps.map(p => `${p.name} ${fmtMoney(p.usd)}`).join(', ')}`
        : '';

      await ctx.reply(`✅ Закрываем: ${trade.pair} ${trade.position} (${trade.session})\n📍 Открыта: ${trade.date} в ${trade.time}\n💼 Открыто на: ${open}${closed}\n\nОтправь скрин результата:`);

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
  sheetsPost, uploadToGoogleSheets, updateTradeResult, getOpenTrades, getStats,
  parseNumber, fmtMoney, fmtPct, fmtRR, formatStats
};

if (require.main === module) app.listen(PORT, async () => {
  const BOT_DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://trading-journal-bot-18r8.onrender.com';
  const webhookUrl = `${BOT_DOMAIN}/bot`;

  try {
    await bot.telegram.deleteWebhook();
    console.log('🗑️ Deleted old webhook');

    await new Promise(r => setTimeout(r, 1000));

    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🤖 Trade Journal Bot webhook set to ${webhookUrl}`);

    const info = await bot.telegram.getWebhookInfo();
    console.log(`📍 Webhook info:`, JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
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
