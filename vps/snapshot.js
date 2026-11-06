// Снимает снапшоты TradingView с графика пользователя (layout с его разметкой).
// Модуль: takeSnapshots(["PEPPERSTONE:USDCHF", "CAPITALCOM:DXY"]) → { "SYM 1h": url, ... }
// CLI:    node snapshot.js "PEPPERSTONE:USDCHF" "CAPITALCOM:DXY"
//
// Важное:
// - разметка привязана к символу КОНКРЕТНОГО брокера (PEPPERSTONE:USDCHF ≠ SAXO:USDCHF),
//   поэтому символ приходит снаружи, из ссылки пользователя, и не зашит в код;
// - ссылку берём из ответа POST /snapshot/ на «Copy link»: «Open in new tab» открывает
//   вкладку, которая иногда виснет намертво и вешает весь Playwright;
// - браузер по CDP НЕ закрываем: close() убил бы постоянный сервис tv-browser,
//   поэтому подключение одно на весь процесс и переиспользуется (см. getPage).
const { chromium } = require("playwright-core");

const CDP = "http://127.0.0.1:9222";
const OFFSET = 0.15;                                   // сдвиг графика влево: пустое поле справа
const TF_KEYS = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1D" };
const DEFAULT_TFS = ["1h", "4h", "1d"];

// Кадр старших таймфреймов (1 час и выше): свечи крупнее и справа остаётся пустое
// поле — там пользователь смотрит, куда цена пойдёт дальше, и туда же уезжают
// подписи уровней, которые иначе наползают на правый край.
const HTF_BAR_SCALE = 1.4;        // свечи крупнее на 40%
const HTF_RIGHT_PCT = 0.25;       // четверть кадра справа — пустая
const LTF_RIGHT_PCT = OFFSET;     // на 5 минутах оставляем как было

// Скрин входа на 5 минутах не должен захватывать прошлые дни — только сегодняшний.
// После Alt+R в кадре ровно 14.1 часа (замерено 13.10: Alt+R сбрасывает и масштаб,
// поэтому величина стабильна и зум не накапливается на графике пользователя).
// Один щелчок колеса сжимает кадр в 1.109 раза — это тоже замер, 5 щелчков дали 8.4 ч.
const SPAN_AFTER_RESET_H = 14.1;
const ZOOM_RATIO = 1.109;
const TARGET_SPAN_H = 8.4;        // влезает в сегодня при любом входе начиная с 09:00

// Начало сегодняшних суток по Минску в unix-секундах. Минск часы не переводит,
// поэтому смещение всегда +3.
function minskMidnightUnix(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const get = t => Number(p.find(x => x.type === t).value);
  return Date.UTC(get("year"), get("month") - 1, get("day")) / 1000 - 3 * 3600;
}

// setVisibleRange в этой сборке TradingView бросает «Not implemented», а вот
// getVisibleRange работает — и этого достаточно: зумим колесом и ПРОВЕРЯЕМ по факту,
// пока левый край не окажется внутри сегодняшних суток. Раньше число щелчков
// считалось от замера на USDCHF, и на UK100 с ночными перерывами в кадр лез
// вчерашний вечер: те же свечи растягиваются на большее время.
async function visibleRange(page) {
  return page.evaluate(() => {
    try {
      const ch = window.TradingViewApi && window.TradingViewApi.activeChart && window.TradingViewApi.activeChart();
      const r = ch && ch.getVisibleRange && ch.getVisibleRange();
      return r && r.from ? { from: r.from, to: r.to } : null;
    } catch (e) { return null; }
  });
}

async function zoomToToday(page, box, y) {
  const todayStart = minskMidnightUnix();
  const zx = box.x + box.width * 0.92;        // зумим у правого края — последние бары на месте

  for (let round = 0; round < 6; round++) {
    const r = await visibleRange(page);
    if (!r) return false;                      // API нет — пусть сработает запасной путь
    if (r.from >= todayStart) return true;

    const need = (r.to - r.from) / Math.max(1, r.to - todayStart);
    const steps = Math.min(25, Math.max(1, Math.ceil(Math.log(need) / Math.log(ZOOM_RATIO))));
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(zx, y);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700);
  }
  return true;                                 // ближе уже не подобраться, оставляем как есть
}

// Ширина свечей и пустое поле справа — через шкалу времени TradingView.
// Раньше поле справа добивалось протяжкой мыши по графику: это и неточно, и опасно —
// нажатие приходилось на область с разметкой пользователя и могло утащить линию.
// getTimeScale() даёт barSpacing/setBarSpacing и rightOffset/setRightOffset напрямую.
// Alt+R перед следующим кадром сбрасывает и то и другое, так что на графике
// пользователя ничего не накапливается.
async function frameChart(page, barScale, rightPct) {
  return page.evaluate(({ scale, pct }) => {
    try {
      const ch = window.TradingViewApi && window.TradingViewApi.activeChart && window.TradingViewApi.activeChart();
      const ts = ch && ch.getTimeScale && ch.getTimeScale();
      if (!ts || !ts.setBarSpacing || !ts.setRightOffset) return false;

      if (scale && scale !== 1) ts.setBarSpacing(ts.barSpacing() * scale);

      const spacing = ts.barSpacing();
      const width = ts.width();
      if (!spacing || !width) return false;
      ts.setRightOffset(Math.round((width / spacing) * pct));
      return true;
    } catch (e) { return false; }
  }, { scale: barScale, pct: rightPct });
}

// Запасной путь, если внутреннего API не окажется: подбор колесом.
// Сколько щелчков колеса нужно, чтобы в кадр не попал вчерашний день.
function zoomStepsForToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now);
  const get = t => Number(parts.find(p => p.type === t).value);
  const sinceMidnight = get("hour") + get("minute") / 60;

  const target = Math.max(1, Math.min(TARGET_SPAN_H, sinceMidnight));
  return Math.ceil(Math.log(SPAN_AFTER_RESET_H / target) / Math.log(ZOOM_RATIO));
}

// Подключение держим одно на весь процесс. Раньше connectOverCDP звался на каждую
// задачу и на каждую проверку здоровья, а закрыть подключение нечем (close() убивает
// сам браузер) — за двое суток накопилось 1222 живых соединения. Chromium рассылает
// события во все разом: съёмка расползлась с 84 секунд до 931, а потом браузер вовсе
// перестал принимать новые подключения (25.09, сделка осталась без скринов).
let cached = null;

function pickPage(browser) {
  const ctx = browser.contexts()[0];
  if (!ctx) return null;
  const page = ctx.pages().find(p => p.url().includes("tradingview.com/chart")) || ctx.pages()[0];
  if (!page) return null;
  page.on("dialog", d => d.dismiss().catch(() => {}));
  return page;
}

async function getPage() {
  if (cached && !cached.browser.isConnected()) cached = null;

  if (cached) {
    if (!cached.page.isClosed()) return cached.page;
    // Вкладку переоткрыли — ищем новую в ТОМ ЖЕ подключении. Переподключаться нельзя:
    // старое соединение не закрыть (close() убьёт браузер), и оно осталось бы висеть.
    const page = pickPage(cached.browser);
    if (page) { cached.page = page; return page; }
    cached = null;
  }

  const browser = await chromium.connectOverCDP(CDP, { timeout: 30000 });
  browser.on("disconnected", () => { cached = null; });

  const page = pickPage(browser);
  if (!page) throw new Error("нет вкладки с графиком — сервис tv-browser не поднялся?");

  cached = { browser: browser, page: page };
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

// Индикаторы, которые надо прятать перед съёмкой. MSNR рисует уровни на сотни
// пунктов выше и ниже цены; автомасштаб растягивает шкалу на них, и свечи на
// 5-минутке превращаются в полоску (02.11 так уехал скрин в журнале).
// Индикатор живёт на графике, а не на символе, поэтому тянется за всеми парами.
const HIDE_INDICATORS = (process.env.HIDE_INDICATORS || "MSNR")
  .split(",").map(x => x.trim()).filter(Boolean);

// Строку легенды ищем по началу названия: классы у TradingView меняются от сборки
// к сборке, а подпись — нет.
async function legendRowRect(page, prefix) {
  return page.evaluate(name => {
    const titles = [...document.querySelectorAll("div")].filter(el =>
      el.children.length === 0 && (el.textContent || "").trim().startsWith(name));
    let row = titles[0];
    while (row && !(row.className || "").toString().includes("item-")) row = row.parentElement;
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x, y: r.y, h: r.height };
  }, prefix);
}

// visible=false — жмём «Hide», true — «Show». Кнопки появляются только при наведении.
async function setIndicator(page, prefix, visible) {
  const rect = await legendRowRect(page, prefix);
  if (!rect) return false;

  await page.mouse.move(rect.x + 20, rect.y + rect.h / 2);
  await page.waitForTimeout(500);

  const want = visible ? /^(Show|Показать)$/ : /^(Hide|Скрыть)$/;
  const btn = await page.evaluate(({ name, pattern }) => {
    const re = new RegExp(pattern);
    const titles = [...document.querySelectorAll("div")].filter(el =>
      el.children.length === 0 && (el.textContent || "").trim().startsWith(name));
    let row = titles[0];
    while (row && !(row.className || "").toString().includes("item-")) row = row.parentElement;
    if (!row) return null;
    for (const x of row.querySelectorAll("[aria-label],[title]")) {
      const label = x.getAttribute("aria-label") || x.getAttribute("title") || "";
      const r = x.getBoundingClientRect();
      if (re.test(label.trim()) && r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, { name: prefix, pattern: want.source });

  if (!btn) return false;                      // уже в нужном состоянии
  await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(800);
  return true;
}

// Уровни сделки с графика. На графике нарисован инструмент позиции (long_position
// или short_position) — в нём и лежит план: цена входа в первой точке, а стоп и
// цель заданы в тиках от неё. Журнал раньше хранил только результат в R, поэтому
// на вопрос «сколько я упустил, выйдя раньше» ответить было нечем: расстояние до
// стопа и цели в ценах нигде не записывалось.
//
// Размер тика берём из форматировщика цен самого графика: он печатает цену с тем
// числом знаков, с каким торгуется инструмент (USDCHF — пять, золото — два).
async function readPosition(page) {
  return page.evaluate(() => {
    try {
      const chart = window.TradingViewApi && window.TradingViewApi.activeChart && window.TradingViewApi.activeChart();
      if (!chart || !chart.getAllShapes) return null;

      const tools = (chart.getAllShapes() || [])
        .filter(s => s.name === "long_position" || s.name === "short_position");
      if (!tools.length) return null;

      let tick = 0.01;
      try {
        const sample = chart.priceFormatter().format(1.23456789);
        const dot = sample.indexOf(".");
        tick = dot === -1 ? 1 : Math.pow(10, -(sample.length - dot - 1));
      } catch (e) { /* остаёмся на 0.01 */ }

      // Инструментов может быть несколько: старый план мог остаться на графике.
      // Берём самый поздний по времени точки входа.
      let best = null;
      for (const tool of tools) {
        const api = chart.getShapeById(tool.id);
        const points = (api.getPoints && api.getPoints()) || [];
        const props = (api.getProperties && api.getProperties()) || {};
        const entry = points[0] && points[0].price;
        const time = (points[0] && points[0].time) || 0;
        if (!entry || !props.stopLevel || !props.profitLevel) continue;
        if (best && time <= best.time) continue;

        const long = tool.name === "long_position";
        const sign = long ? 1 : -1;
        best = {
          kind: long ? "long" : "short",
          entry: entry,
          stop: entry - sign * props.stopLevel * tick,
          target: entry + sign * props.profitLevel * tick,
          rr: Math.round((props.profitLevel / props.stopLevel) * 100) / 100,
          time: time,
          tick: tick
        };
      }
      return best;
    } catch (e) { return null; }
  });
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

  // Прячем мешающие индикаторы на время съёмки и возвращаем их в finally,
  // чтобы график пользователя не остался без них из-за ошибки посреди работы.
  const hidden = [];
  for (const name of HIDE_INDICATORS) {
    if (await setIndicator(page, name, false).catch(() => false)) hidden.push(name);
  }
  if (hidden.length) {
    await page.keyboard.press("Alt+r").catch(() => {});   // пересобрать масштаб уже без них
    await page.waitForTimeout(1200);
  }

  try {
  for (const symbol of symbols) {
    await setSymbol(page, symbol);

    // План сделки читаем только по основному инструменту: на DXY позиции нет.
    if (symbol === symbols[0]) {
      out.position = await readPosition(page).catch(() => null);
    }

    // У DXY свой набор таймфреймов: 5-минутка индекса в журнале не нужна.
    const symbolTfs = (opts.tfsBySymbol && opts.tfsBySymbol[symbol]) || tfs;

    for (const name of symbolTfs) {
      await setInterval_(page, pane, TF_KEYS[name]);
      await page.keyboard.press("Alt+r");          // вернуть вид к последним барам (и масштаб)
      await page.waitForTimeout(2500);             // даём разметке дорисоваться

      if (name === "5m" && opts.todayOnly) {
        const byApi = await zoomToToday(page, box, y).catch(() => false);
        if (!byApi) {
          const steps = zoomStepsForToday();     // без API — старый подбор на глаз
          const zx = box.x + box.width * 0.92;
          for (let i = 0; i < steps; i++) {
            await page.mouse.move(zx, y);
            await page.mouse.wheel(0, -120);
            await page.waitForTimeout(150);
          }
        }
        await page.waitForTimeout(1200);
      }

      const htf = name !== "5m" && name !== "15m";
      const framed = await frameChart(page, htf ? HTF_BAR_SCALE : 1, htf ? HTF_RIGHT_PCT : LTF_RIGHT_PCT)
        .catch(() => false);

      if (!framed) {                               // API нет — старая протяжка мышью
        const x0 = box.x + box.width * 0.85, x1 = x0 - box.width * OFFSET;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 10, y); await page.waitForTimeout(30); }
        await page.mouse.up();
      }
      await page.waitForTimeout(1200);

      const respP = page.waitForResponse(r => r.url().includes("/snapshot/") && r.request().method() === "POST", { timeout: 25000 });
      await page.locator("#header-toolbar-screenshot").click();
      await page.waitForTimeout(700);
      await page.getByText("Copy link", { exact: true }).click();
      const resp = await respP;
      const id = (await resp.text()).trim();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // На обслуживании TradingView отдаёт на этот POST HTML-страницу вместо номера
      // снимка. Раньше она целиком уезжала в ссылку и в журнал (25.09, колонка S:
      // «https://www.tradingview.com/x/<!DOCTYPE html>…» на всю ячейку).
      if (!/^[A-Za-z0-9_-]{6,24}$/.test(id)) {
        const hint = id.replace(/\s+/g, " ").slice(0, 80);
        throw new Error(`TradingView не отдал снимок (HTTP ${resp.status()}): ${hint}`);
      }

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

  } finally {
    for (const name of hidden) {
      await setIndicator(page, name, true).catch(() => {});
    }
  }
}

module.exports = { takeSnapshots, getPage, isLoggedIn };

if (require.main === module) {
  const symbols = process.argv.slice(2);
  if (!symbols.length) { console.error("укажи символы, например PEPPERSTONE:USDCHF"); process.exit(1); }
  takeSnapshots(symbols)
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error("ОШИБКА:", e.message.split("\n")[0]); process.exit(1); });
}
