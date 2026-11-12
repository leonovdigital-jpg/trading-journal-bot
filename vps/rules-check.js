#!/usr/bin/env node
// Слежка за правилами проп-фирм. Каждое утро по будням сверяет статьи справочного
// центра со вчерашними и пишет короткую сводку в таблицу — бот вставит её в
// утреннее сообщение.
//
// Что изменилось, решает код, а не модель: сравнение текста статей. Claude зовётся
// только когда что-то правда поменялось — чтобы объяснить по-человечески, что именно
// и важно ли это. В обычный день токены не тратятся вообще.
//
// Снимок обновляется только после того, как сводка записалась. Если разбор упал,
// завтра те же изменения будут найдены снова, а не потеряются.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { post } = require('./sheets.js');

const DIR = path.join(__dirname, 'rules');

// Источники правил по фирмам. У FundingPips справочный центр на Zendesk: сайт закрыт
// от ботов, но открытый API отдаёт все статьи с датой правки и полным текстом.
const SOURCES = [
  { prop: 'FundingPips', type: 'zendesk', base: 'https://help.fundingpips.com', locale: 'en-us' }
];

function plain(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function zendeskArticles(src) {
  const out = {};
  let url = `${src.base}/api/v2/help_center/${src.locale}/articles.json?per_page=100`;
  for (let page = 0; url && page < 20; page++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.status !== 200) throw new Error(`${src.prop}: справочный центр ответил ${r.status}`);
    const data = await r.json();
    for (const a of data.articles || []) {
      if (a.draft) continue;
      out[a.id] = { title: a.title, url: a.html_url, updated: a.updated_at, text: plain(a.body) };
    }
    url = data.next_page;
  }
  return out;
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

function compare(prop, before, after) {
  const changes = [];
  for (const id of Object.keys(after)) {
    const now = after[id], was = before[id];
    if (!was) { changes.push({ kind: 'новая статья', title: now.title, url: now.url, diff: now.text.slice(0, 4000) }); continue; }
    if (was.text === now.text) continue;               // дату правки двигают и опечатками
    changes.push({ kind: 'изменена', title: now.title, url: now.url, diff: diffText(was.text, now.text).slice(0, 6000) });
  }
  for (const id of Object.keys(before)) {
    if (!after[id]) changes.push({ kind: 'удалена', title: before[id].title, url: before[id].url, diff: '' });
  }
  return changes;
}

function summarize(prop, changes) {
  const body = changes.map(c =>
    `### ${c.kind}: ${c.title}\n${c.url}\n${c.diff ? '```diff\n' + c.diff + '\n```' : ''}`
  ).join('\n\n');

  const prompt =
`Ты следишь за правилами проп-фирмы ${prop} для трейдера, который торгует у неё на счёте 100 000 $.
Ниже — статьи справочного центра, которые изменились со вчерашнего дня (в виде diff: «-» было, «+» стало).

Напиши по-русски, на «ты», обычным текстом без markdown, не длиннее 700 знаков:
- Если поменялись правила, которые влияют на торговлю или выплаты (новости и окна вокруг них,
  дневная и общая просадка, удержание позиций на выходные и ночь, запрещённые стратегии,
  консистентность, лот, сроки и условия выплат), — что именно стало иначе, одной-двумя фразами
  на каждое изменение, с числами «было → стало».
- Если правки косметические (опечатки, форматирование, маркетинг, акции) — так и скажи одной фразой.
Ничего не выдумывай: если из diff не понять, что изменилось по сути, так и напиши.

${body}`;

  const out = execFileSync('claude', ['-p', prompt, '--model', 'opus'], {
    encoding: 'utf8', timeout: 600000, maxBuffer: 10 * 1024 * 1024
  });
  return out.trim();
}

function minskDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(d);
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const parts = [];
  const snapshots = [];

  for (const src of SOURCES) {
    const file = path.join(DIR, `${src.prop}.json`);
    let now;
    try {
      now = await zendeskArticles(src);
    } catch (e) {
      parts.push(`${src.prop}: не смог прочитать правила — ${e.message}`);
      continue;
    }

    if (!fs.existsSync(file)) {
      parts.push(`${src.prop}: начал следить, статей с правилами — ${Object.keys(now).length}.`);
      snapshots.push([file, now]);
      continue;
    }

    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const changes = compare(src.prop, before, now);
    if (!changes.length) {
      parts.push(`${src.prop}: без изменений.`);
      snapshots.push([file, now]);
      continue;
    }

    console.log(`${src.prop}: изменений ${changes.length}:`, changes.map(c => `${c.kind} «${c.title}»`).join('; '));
    try {
      parts.push(`${src.prop}: ${summarize(src.prop, changes)}`);
      snapshots.push([file, now]);
    } catch (e) {
      // Снимок не трогаем — завтра эти же изменения найдутся снова.
      parts.push(`${src.prop}: правки есть (${changes.length}), но разобрать не вышло — повторю завтра.`);
      console.error('разбор упал:', e.message);
    }
  }

  const text = parts.join('\n');
  const r = await post({ action: 'setRulesDigest', date: minskDate(), text: text });
  if (!r || r.success !== true) throw new Error('сводка не записалась: ' + JSON.stringify(r).slice(0, 200));

  for (const [file, data] of snapshots) fs.writeFileSync(file, JSON.stringify(data));
  console.log('сводка записана:\n' + text);
}

main().catch(e => { console.error(e.message); process.exit(1); });
