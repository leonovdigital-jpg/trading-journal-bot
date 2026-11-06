#!/usr/bin/env node
// Чтение торгового журнала из Apps Script без зависимостей — чтобы этим мог
// пользоваться не только бот на сервере, но и еженедельная аналитика, которая
// запускается в облаке Claude и ставить npm-пакеты не может.
//
//   node tools/sheets.js '{"action":"dump","from":"last","rows":5}'
//
// Apps Script отвечает на POST редиректом на .../echo, а содержимое по этому
// адресу реплицируется с задержкой: первый GET нередко отдаёт 404. Скрипт при
// этом уже отработал, поэтому повторяем только GET по тому же Location.

const URL_EXEC = process.env.APPS_SCRIPT_URL
  || 'https://script.google.com/macros/s/AKfycbyrKuqc4_RwXsu2y_kCZVLbD6BUFMnqyzuokQun-4J13aWQlc96pgME2Ai3vef_oYVhQw/exec';

// Общий ключ: веб-приложение отвечает анонимным запросам, а его адрес публичен.
// Берём из SHEETS_KEY, а если его нет — из .env рядом с проектом.
const SHEETS_KEY = process.env.SHEETS_KEY || (() => {
  try {
    const text = require('fs').readFileSync(__dirname + '/../.env', 'utf8');
    const line = text.split('\n').find(l => l.startsWith('SHEETS_KEY='));
    return line ? line.slice('SHEETS_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
  } catch (e) { return ''; }
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function echo(location, attempts = 8) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    const r = await fetch(location, { redirect: 'manual' });
    if (r.status === 200) {
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) { last = 'не JSON'; }
    } else {
      last = 'status ' + r.status;
    }
    await sleep(600 * i);
  }
  throw new Error('echo не отдал ответ: ' + last);
}

async function post(payload, attempts = 3) {
  let last = null;
  if (SHEETS_KEY) payload = Object.assign({ key: SHEETS_KEY }, payload);
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(URL_EXEC, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.status === 200) {
        const text = await r.text();
        try { return JSON.parse(text); } catch (e) { last = new Error('не JSON'); }
      } else if (r.status === 302 && r.headers.get('location')) {
        return await echo(r.headers.get('location'));
      } else {
        last = new Error('status ' + r.status);
      }
    } catch (error) {
      last = error;
    }
    await sleep(800 * i);
  }
  throw last || new Error('таблица не ответила');
}

module.exports = { post };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('нужен JSON-запрос аргументом'); process.exit(1); }
  post(JSON.parse(arg))
    .then(d => console.log(JSON.stringify(d, null, 1)))
    .catch(e => { console.error(e.message); process.exit(1); });
}
