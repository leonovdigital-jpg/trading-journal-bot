#!/usr/bin/env node
// Слежка за правилами проп-фирм. Каждое утро по будням сверяет официальные
// страницы с правилами со вчерашними и пишет итог по каждой фирме в таблицу —
// бот вставит его в утреннее сообщение.
//
// У каждой фирмы всегда ровно один из трёх итогов: «без изменений», «вот что
// изменилось» или «не смог проверить». Молчания нет: пользователь просил, чтобы
// не было так, что правило поменялось, а бот решил, что это неважно, и не сказал.
// Поэтому список изменённых страниц со ссылками идёт в отчёт всегда, а пересказ
// Claude — только поверх него.
//
// Что изменилось, решает код: сравнение текста. Claude зовётся только когда текст
// правда поменялся — чтобы объяснить, что именно. В обычный день токенов нет.
//
// Снимок обновляется только после того, как итог записался. Если разбор упал,
// завтра те же изменения найдутся снова, а не потеряются.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { post } = require('./sheets.js');

const DIR = path.join(__dirname, 'rules');

// Официальные источники правил.
// FundingPips: справочный центр на Zendesk. Сайт закрыт от ботов (403), но открытый
//   API отдаёт все статьи с полным текстом. Старый intercom.help у них мёртв.
// Finotive: справочный центр собирается скриптом в браузере, без браузера его не
//   прочитать. Зато официальная страница правил отдаётся целиком.
const FIRMS = [
  // Поддержка FundingPips 12.11.2026: правила счёта определяются датой его покупки.
  // Значит, правка в справке касается новых счетов, а уже купленный живёт по старым.
  { firm: 'FundingPips', type: 'zendesk', base: 'https://help.fundingpips.com', locale: 'en-us',
    context: 'Важно: у этой фирмы правила счёта определяются датой его покупки. Изменение касается счетов, купленных после него, а уже купленный счёт трейдера живёт по старым правилам. Скажи об этом одной фразой в конце — это пригодится, когда он будет покупать следующий счёт.' },
  // Finotive: справочный центр рисуется скриптом в браузере, но для машин он отдаёт
  // всю справку одним текстом — llms-full.txt (≈300 статей, разделитель «---»,
  // в каждой «Source: <адрес>»). Плюс официальная страница правил на сайте.
  { firm: 'Finotive', type: 'multi', parts: [
    { type: 'llmsfull', url: 'https://help.finotivefunding.com/llms-full.txt' },
    { type: 'pages', urls: ['https://finotivefunding.com/rules'] }
  ] }
];

function plain(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|section|a|span|button)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split('\n')
    .map(s => s.replace(/\s+/g, ' ').trim())
    // На сайтах с Alpine.js в тексте остаются куски кода разметки — выкидываем их,
    // иначе любая пересборка сайта выглядела бы как правка правил. Узко, по приметам
    // кода: первая версия выбрасывала все строки на «=», и вместе с мусором пропадали
    // настоящие правила вида «= $750», «= Breach».
    .filter(s => s
      && !/=>|\$watch|\$refs|\$nextTick|getElementById|isOpen|window\.inner|@mouse|@focus|clientHeight|style\.max/.test(s)
      && !/^[{}()"';>]+$/.test(s))
    .join('\n');
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (r.status !== 200) throw new Error(`${url} ответил ${r.status}`);
  return r;
}

async function zendesk(src) {
  const out = {};
  let url = `${src.base}/api/v2/help_center/${src.locale}/articles.json?per_page=100`;
  for (let page = 0; url && page < 20; page++) {
    const data = await (await get(url)).json();
    for (const a of data.articles || []) {
      if (a.draft) continue;
      out[a.id] = { title: a.title, url: a.html_url, text: plain(a.body) };
    }
    url = data.next_page;
  }
  if (!Object.keys(out).length) throw new Error('справочный центр вернул ноль статей');
  return out;
}

async function pages(src) {
  const out = {};
  for (const url of src.urls) {
    const html = await (await get(url)).text();
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || url;
    const text = plain(html);
    // Страница без текста — это сбой отдачи (заглушка, капча), а не «правил больше нет».
    if (text.length < 500) throw new Error(`${url} отдал почти пустую страницу`);
    out[url] = { title: title.trim(), url, text };
  }
  return out;
}

async function llmsfull(src) {
  const text = await (await get(src.url)).text();
  const out = {};
  for (const chunk of text.split(/\n---\n/)) {
    const title = (chunk.match(/^# (.+)$/m) || [])[1];
    const url = (chunk.match(/^Source: (\S+)$/m) || [])[1];
    if (!title || !url) continue;
    out[url] = { title: title.trim(), url: url.replace(/\.md$/, ''), text: chunk.trim() };
  }
  // Меньше сотни статей — это обрезанная отдача, а не «статьи удалили».
  if (Object.keys(out).length < 100) throw new Error(`${src.url}: прочитал только ${Object.keys(out).length} статей`);
  return out;
}

async function fetchFirm(src) {
  if (src.type === 'zendesk') return zendesk(src);
  if (src.type === 'pages') return pages(src);
  if (src.type === 'llmsfull') return llmsfull(src);
  if (src.type === 'multi') {
    const out = {};
    for (const part of src.parts) Object.assign(out, await fetchFirm(part));
    return out;
  }
  throw new Error('неизвестный источник ' + src.type);
}

function diffText(before, after) {
  const tmp = fs.mkdtempSync('/tmp/rules-');
  const a = path.join(tmp, 'было'), b = path.join(tmp, 'стало');
  fs.writeFileSync(a, before + '\n');
  fs.writeFileSync(b, after + '\n');
  let out = '';
  try { execFileSync('diff', ['-U2', a, b], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || ''); }       // diff выходит с кодом 1, когда разница есть
  fs.rmSync(tmp, { recursive: true, force: true });
  return out.split('\n').slice(2).join('\n');        // шапку с именами файлов не нужно
}

function compare(before, after) {
  const changes = [];
  for (const id of Object.keys(after)) {
    const now = after[id], was = before[id];
    if (!was) { changes.push({ kind: 'новая', title: now.title, url: now.url, diff: now.text.slice(0, 4000) }); continue; }
    if (was.text === now.text) continue;               // дату правки двигают и опечатками
    changes.push({ kind: 'изменена', title: now.title, url: now.url, diff: diffText(was.text, now.text).slice(0, 6000) });
  }
  for (const id of Object.keys(before)) {
    if (!after[id]) changes.push({ kind: 'удалена', title: before[id].title, url: before[id].url, diff: '' });
  }
  return changes;
}

function summarize(firm, changes, context) {
  const body = changes.map(c =>
    `### ${c.kind}: ${c.title}\n${c.url}\n${c.diff ? '```diff\n' + c.diff + '\n```' : ''}`
  ).join('\n\n');

  const prompt =
`Ты следишь за правилами проп-фирмы ${firm} для трейдера, который у неё торгует.
Ниже — официальные страницы с правилами, которые изменились со вчерашнего дня
(в виде diff: «-» было, «+» стало).

Напиши по-русски, на «ты», обычным текстом без markdown, не длиннее 700 знаков:
- Если поменялись правила, которые влияют на торговлю или выплаты (новости и окна вокруг них,
  дневная и общая просадка, удержание позиций на выходные и ночь, запрещённые стратегии,
  консистентность, лот, сроки и условия выплат), — что именно стало иначе, одной-двумя фразами
  на каждое изменение, с числами «было → стало», и к какому типу счёта это относится.
- Если правки косметические (опечатки, форматирование, маркетинг, акции, цены) — так и скажи одной фразой.
Ничего не выдумывай: если из diff не понять, что изменилось по сути, так и напиши.
${context ? '\n' + context + '\n' : ''}
${body}`;

  return execFileSync('claude', ['-p', prompt, '--model', 'opus'], {
    encoding: 'utf8', timeout: 600000, maxBuffer: 10 * 1024 * 1024
  }).trim();
}

function minskDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(d);
}

async function save(firm, status, text) {
  const r = await post({ action: 'setRulesDigest', firm, date: minskDate(), status, text });
  if (!r || r.success !== true) throw new Error(`${firm}: итог не записался: ${JSON.stringify(r).slice(0, 200)}`);
}

async function checkFirm(src) {
  const file = path.join(DIR, `${src.firm}.json`);

  let now;
  try {
    now = await fetchFirm(src);
  } catch (e) {
    await save(src.firm, 'error', `не смог прочитать правила: ${e.message}`);
    return;
  }

  if (!fs.existsSync(file)) {
    await save(src.firm, 'started', `начал следить, страниц с правилами — ${Object.keys(now).length}. Изменения покажу со следующего дня.`);
    fs.writeFileSync(file, JSON.stringify(now));
    return;
  }

  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const changes = compare(before, now);
  if (!changes.length) {
    await save(src.firm, 'none', 'без изменений');
    fs.writeFileSync(file, JSON.stringify(now));
    return;
  }

  console.log(`${src.firm}: изменений ${changes.length}:`, changes.map(c => `${c.kind} «${c.title}»`).join('; '));

  // Список страниц со ссылками — всегда, что бы ни сказал разбор. Решение «важно или
  // нет» остаётся за пользователем: он может открыть страницу и посмотреть сам.
  const list = changes.map(c => `• ${c.kind}: ${c.title} — ${c.url}`).join('\n');
  let summary;
  try {
    summary = summarize(src.firm, changes, src.context);
  } catch (e) {
    console.error('разбор упал:', e.message);
    // Снимок не трогаем — завтра эти же изменения найдутся и разберутся снова.
    await save(src.firm, 'changed', `изменились страницы, но пересказать не вышло — открой и посмотри сам:\n${list}`);
    return;
  }
  await save(src.firm, 'changed', `${summary}\n${list}`);
  fs.writeFileSync(file, JSON.stringify(now));
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  let failed = 0;
  // Фирмы проверяются по отдельности: сбой одной не должен оставить без итога другую.
  for (const src of FIRMS) {
    try {
      await checkFirm(src);
      console.log(`${src.firm}: готово`);
    } catch (e) {
      failed++;
      console.error(`${src.firm}: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
