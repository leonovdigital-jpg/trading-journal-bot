// Снимает снапшоты TradingView с графика пользователя (layout с его разметкой).
// Модуль: takeSnapshots(["PEPPERSTONE:USDCHF", "CAPITALCOM:DXY"]) → { "SYM 1h": url, ... }
// CLI:    node snapshot.js "PEPPERSTONE:USDCHF" "CAPITALCOM:DXY"
//
// Важное:
// - разметка привязана к символу КОНКРЕТНОГО брокера (PEPPERSTONE:USDCHF ≠ SAXO:USDCHF),
//   поэтому символ приходит снаружи, из ссылки пользователя, и не зашит в код;
// - ссылку берём из ответа POST /snapshot/ на «Copy link»: «Open in new tab» открывает
//   вкладку, которая иногда виснет намертво и вешает весь Playwright;
// - браузер по CDP НЕ закрываем: close() убил бы постоянный сервис tv-browser.
const { chromium } = require("playwright-core");

const CDP = "http://127.0.0.1:9222";
const OFFSET = 0.15;                                   // сдвиг графика влево: пустое поле справа
const TF_KEYS = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1D" };
const DEFAULT_TFS = ["1h", "4h", "1d"];

async function getPage() {
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error("браузер без контекста — сервис tv-browser не поднялся?");
  const page = ctx.pages().find(p => p.url().includes("tradingview.com/chart")) || ctx.pages()[0];
  if (!page) throw new Error("нет вкладки с графиком");
  page.on("dialog", d => d.dismiss().catch(() => {}));
  return page;
}

async function setSymbol(page, symbol) {
  await page.locator("#header-toolbar-symbol-search").click();
  await page.waitForTimeout(500);
  await page.keyboard.type(symbol);
  await page.waitForTimeout(1800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3500);
}

async function setInterval_(page, pane, key) {
  await pane.click({ position: { x: 400, y: 400 } }).catch(() => {});
  await page.keyboard.type(key);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
}

// Проверка, что сессия жива: у гостя TradingView рисует кнопку входа.
async function isLoggedIn(page) {
  return (await page.locator("#header-toolbar-symbol-search").count()) > 0
      && (await page.getByRole("button", { name: /Sign in|Войти/ }).count()) === 0;
}

async function takeSnapshots(symbols, opts = {}) {
  const tfs = (opts.tfs && opts.tfs.length ? opts.tfs : DEFAULT_TFS)
    .filter(t => TF_KEYS[t]);
  if (!tfs.length) throw new Error("не знаю таких таймфреймов");

  const page = await getPage();

  await page.getByRole("button", { name: "Don`t need" }).click({ timeout: 2000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  if (!await isLoggedIn(page)) throw new Error("сессия TradingView слетела — нужен повторный вход");

  const pane = page.locator(".chart-gui-wrapper").first();
  const box = await pane.boundingBox();
  if (!box) throw new Error("не вижу область графика");
  const y = box.y + box.height * 0.5;
  const out = {};

  for (const symbol of symbols) {
    await setSymbol(page, symbol);

    for (const name of tfs) {
      await setInterval_(page, pane, TF_KEYS[name]);
      await page.keyboard.press("Alt+r");          // вернуть вид к последним барам
      await page.waitForTimeout(2500);             // даём разметке дорисоваться

      const x0 = box.x + box.width * 0.85, x1 = x0 - box.width * OFFSET;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 10, y); await page.waitForTimeout(30); }
      await page.mouse.up();
      await page.waitForTimeout(1000);

      const respP = page.waitForResponse(r => r.url().includes("/snapshot/") && r.request().method() === "POST", { timeout: 25000 });
      await page.locator("#header-toolbar-screenshot").click();
      await page.waitForTimeout(700);
      await page.getByText("Copy link", { exact: true }).click();
      const id = (await (await respP).text()).trim();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      out[symbol + " " + name] = "https://www.tradingview.com/x/" + id + "/";
    }
  }

  // Возвращаем график туда, где работает пользователь: его символ на 5 минутах.
  // Иначе приложение на Mac и телефоне откроется на DXY 1d — чужое состояние.
  if (opts.restoreSymbol) {
    await setSymbol(page, opts.restoreSymbol).catch(() => {});
    await setInterval_(page, pane, "5").catch(() => {});
    await page.keyboard.press("Alt+r").catch(() => {});
  }

  return out;
}

module.exports = { takeSnapshots, getPage, isLoggedIn };

if (require.main === module) {
  const symbols = process.argv.slice(2);
  if (!symbols.length) { console.error("укажи символы, например PEPPERSTONE:USDCHF"); process.exit(1); }
  takeSnapshots(symbols)
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error("ОШИБКА:", e.message.split("\n")[0]); process.exit(1); });
}
