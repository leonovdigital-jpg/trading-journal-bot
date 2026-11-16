// Счета пользователя — общий список для памяток «📋 Правила» (rules-cards.js) и для
// утренней проверки правил (rules-check.js). В одном месте, чтобы они не разошлись.
//
// pick    — статьи фирмы, где лежат правила этого счёта (для памятки).
// notMine — статьи про ДРУГИЕ модели, даже если pick их зацепил: о правках в них
//           пользователь просил не писать (16.11.2026: «зачем мне инфа не по моему
//           аккаунту?» — пришла правка про EXP 001, 1-Step, а у него 2 Step Flex).

// Счета пользователя. Типы подтвердил пользователь 13.11.2026: Instant — Lite,
// 100k challenge — Two Step. Явно просим не включать чужие варианты: иначе памятка
// раздувается правилами, которые к счёту не относятся.
const ACCOUNTS = [
  {
    account: 'FundingPips', firm: 'FundingPips', size: '100 000 $',
    plan: '2 Step Flex', stage: 'Evaluation (позже будет Master — правила Master тоже нужны, отдельным блоком)',
    bought: 'в сентябре 2026',
    // Статьи, где лежат правила этой модели. Всё остальное в справке — про другие модели.
    pick: a => /^(2 Step Flex|News Trading & Weekend Holding|Responsible Trading Policy|Trade Copier|Reward Methods|Understanding Trading Mechanics|Master Account Setup)$/i.test(a.title),
    note: 'Поддержка FundingPips: правила счёта определяются датой покупки.',
    notMine: () => false            // pick и так перечисляет статьи поимённо
  },
  {
    account: 'Instant', firm: 'Finotive', size: '50 000 $',
    plan: 'Instant Funding Lite (именно Lite — правила Standard и Pro не включай)', stage: 'funded',
    bought: 'до 15.09.2026',
    pick: a => /instant|prohibited|news|straddl|hedg|copier|expert advisor|scalping|high-frequency|liquidity|consistency|drawdown|breach|strike|reward payment|payout|profit concentration|over-sizing|inactiv|weekend|terms|rules/i.test(a.title + ' ' + a.url),
    note: 'Поддержка Finotive 13.11.2026: правила из Terms действуют на этот счёт, включая 7.15 Profit Concentration и 7.9 News Straddling; новые правила в Terms помечаются как новые. FAQ и Terms описывают одно и то же. Оговорку про дату покупки не пиши.',
    notMine: a => /standard|\bpro\b|one[- ]?step|1-step|two[- ]?step|2-step|solo|challenge/i.test(a.title) && !/lite/i.test(a.title)
  },
  {
    account: '100k challenge', firm: 'Finotive', size: '100 000 $',
    plan: 'Two Step Challenge (именно Two Step — правила One Step и Solo не включай)', stage: 'evaluation (Phase 1 или 2; после прохождения — funded, его правила дай отдельным блоком)',
    bought: 'до 15.09.2026',
    pick: a => /challenge|one step|two step|solo|prohibited|news|straddl|hedg|copier|expert advisor|scalping|high-frequency|liquidity|consistency|drawdown|breach|strike|inactiv|weekend|terms|rules/i.test(a.title + ' ' + a.url),
    note: 'Поддержка Finotive 13.11.2026: правила из Terms действуют на этот счёт, включая 7.9 News Straddling; новые правила в Terms помечаются как новые. Оговорку про дату покупки не пиши. 7.15 Profit Concentration по тексту Terms действует только для Instant Funding Standard и Lite — в эту памятку его не включай.',
    notMine: a => /one[- ]?step|1-step|solo|instant/i.test(a.title) && !/two[- ]?step|2-step/i.test(a.title)
  }
];

// Касается ли статья хоть одного счёта пользователя у этой фирмы.
function isMine(firm, article) {
  return ACCOUNTS.some(acc => acc.firm === firm && acc.pick(article) && !acc.notMine(article));
}

// Коротко о счетах фирмы — для разбора правок.
function describeAccounts(firm) {
  return ACCOUNTS.filter(a => a.firm === firm).map(a => `«${a.account}» — ${a.plan}, ${a.size}, этап: ${a.stage}`).join('; ');
}

module.exports = { ACCOUNTS, isMine, describeAccounts };


