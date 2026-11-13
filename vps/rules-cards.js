#!/usr/bin/env node
// Карточки правил по счетам пользователя: только то, за что фирма может закрыть счёт
// или срезать выплату. Кнопка «📋 Правила» в боте показывает их по одной на счёт.
//
// Откуда текст: официальные страницы фирм из тех же снимков, что сверяет
// rules-check.js каждое утро (rules/<Фирма>.json). Пересказывает Claude, но только по
// этим текстам и со ссылкой на источник у каждого правила: здесь цена ошибки — счёт.
//
//   node rules-cards.js                 — пересобрать все карточки
//   node rules-cards.js FundingPips     — только счета этой фирмы (так зовёт rules-check)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { post } = require('./sheets.js');

const DIR = path.join(__dirname, 'rules');

// Счета пользователя. plan и stage известны не везде — тогда карточка честно
// покрывает все варианты и пишет, что тип счёта нужно уточнить.
const ACCOUNTS = [
  {
    account: 'FundingPips', firm: 'FundingPips', size: '100 000 $',
    plan: '2 Step Flex', stage: 'Evaluation (позже будет Master — правила Master тоже нужны, отдельным блоком)',
    bought: 'в сентябре 2026',
    // Статьи, где лежат правила этой модели. Всё остальное в справке — про другие модели.
    pick: a => /^(2 Step Flex|News Trading & Weekend Holding|Responsible Trading Policy|Trade Copier|Reward Methods|Understanding Trading Mechanics|Master Account Setup)$/i.test(a.title),
    note: 'Поддержка FundingPips: правила счёта определяются датой покупки.'
  },
  {
    account: 'Instant', firm: 'Finotive', size: '50 000 $',
    plan: 'Instant Funding (Standard, Lite или Pro — не уточнено)', stage: 'funded',
    bought: 'до 15.09.2026',
    pick: a => /instant|prohibited|straddl|hedg|copier|expert advisor|scalping|high-frequency|liquidity|consistency|drawdown|breach|strike|reward payment|payout|profit concentration|over-sizing|inactiv|weekend|terms|rules/i.test(a.title + ' ' + a.url),
    note: 'Поддержка Finotive: изменения правил с 1 октября касаются только счетов, купленных после 1 октября. Счёт куплен раньше, а на сайте — уже новая версия правил.'
  },
  {
    account: '100k challenge', firm: 'Finotive', size: '100 000 $',
    plan: 'Challenge (One Step, Two Step или Solo — не уточнено)', stage: 'evaluation',
    bought: 'до 15.09.2026',
    pick: a => /challenge|one step|two step|solo|prohibited|straddl|hedg|copier|expert advisor|scalping|high-frequency|liquidity|consistency|drawdown|breach|strike|inactiv|weekend|terms|rules/i.test(a.title + ' ' + a.url),
    note: 'Поддержка Finotive: изменения правил с 1 октября касаются только счетов, купленных после 1 октября. Счёт куплен раньше, а на сайте — уже новая версия правил.'
  }
];

const LIMIT = 12000;  // жёсткий предел; бот режет длинную памятку на несколько сообщений
const TARGET = 6000;  // сколько просим у модели — с запасом до предела, чтобы не резать

function buildPrompt(acc, sources) {
  const body = sources.map(s => `### ${s.title}\n${s.url}\n${s.text.slice(0, 120000)}`).join('\n\n');
  return `Ты готовишь для трейдера памятку по его счёту у проп-фирмы ${acc.firm}.

Счёт: «${acc.account}», размер ${acc.size}, модель: ${acc.plan}, этап: ${acc.stage}, куплен ${acc.bought}.
${acc.note}

Задача: перечисли ТОЛЬКО правила, нарушение которых может привести к закрытию счёта (бан, breach,
закрытие, удаление) или к срезанию выплаты / прибыли (profit deduction, reduced reward, strike).
Всё остальное — описание продукта, советы, рекомендации, удобства — не включай.

Требования:
- По-русски, на «ты», обычным текстом без markdown, без решёток и звёздочек. До ${TARGET} знаков.
  Если не влезает — сокращай формулировки, но не выбрасывай правила.
- Каждое правило — одна строка: «• что нельзя / какой лимит, с числами → что будет (бан счёта / срез
  выплаты / срез прибыли сделки / страйк) [короткое название статьи]».
- Числа — точно как в тексте. Если в тексте условие размыто (например, «намеренная торговля новостями»
  без определения) — так и напиши «критерий размыт».
- Если правило зависит от модели или этапа, а модель/этап счёта не уточнены — укажи, для каких
  вариантов оно действует. Не угадывай, какой вариант у трейдера.
- Если два источника противоречат друг другу — напиши об этом в той же строке.
- Сгруппируй: сначала то, что закрывает счёт, потом то, что режет выплату.
- Ничего не добавляй от себя. Используй только тексты ниже.
- Выведи ТОЛЬКО саму памятку: без вступления, без слов о её длине, без списка того, что не вошло,
  без комментариев о себе. Никаких инструментов не запускай — всё нужное уже в этом сообщении.

Официальные тексты фирмы:

${body}`;
}

async function main() {
  const only = process.argv[2];
  const snaps = {};
  let failed = 0;

  for (const acc of ACCOUNTS) {
    if (only && acc.firm !== only) continue;
    if (!snaps[acc.firm]) {
      snaps[acc.firm] = Object.values(JSON.parse(fs.readFileSync(path.join(DIR, `${acc.firm}.json`), 'utf8')));
    }
    const sources = snaps[acc.firm].filter(acc.pick);
    if (!sources.length) { console.error(`${acc.account}: не нашёл ни одной статьи с правилами`); failed++; continue; }

    let text;
    try {
      // Подсказку отдаём через stdin: тексты справки бывают на сотни килобайт.
      text = execFileSync('claude', ['-p', '--model', 'opus', '--disallowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'], {
        input: buildPrompt(acc, sources), encoding: 'utf8', timeout: 900000, maxBuffer: 10 * 1024 * 1024
      }).trim();
    } catch (e) {
      console.error(`${acc.account}: Claude не собрал карточку: ${e.message}`); failed++; continue;
    }
    if (text.length > LIMIT) text = text.slice(0, LIMIT).replace(/\n[^\n]*$/, '') + '\n…(обрезано)';

    const r = await post({
      action: 'setRulesCard', account: acc.account, firm: acc.firm,
      text, sources: sources.length, generatedAt: new Date().toISOString()
    });
    if (!r || r.success !== true) { console.error(`${acc.account}: не записалось: ${JSON.stringify(r).slice(0, 200)}`); failed++; continue; }
    console.log(`${acc.account}: карточка готова (${text.length} знаков, источников ${sources.length})`);
  }
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
