// Постоянный Chromium на экране :99 с профилем, где живёт сессия TradingView.
// Воркер не поднимает свой браузер, а подключается к этому по CDP: нет борьбы
// за профиль и нет холодного старта на каждую задачу.
const { chromium } = require("playwright-core");

const PROFILE = "/home/ubuntu/tv-profile";
const LAYOUT = "https://www.tradingview.com/chart/cuIEk8aJ/";   // layout eur_usd с разметкой

// TradingView иногда показывает beforeunload-диалог; Playwright закрывает его сам,
// но если диалог успел исчезнуть, всплывает ошибка Page.handleJavaScriptDialog.
// Раньше она валила процесс, и systemd перезапускал браузер по кругу (242 раза).
// Такие ошибки логируем и живём дальше — умираем только если закрылся сам браузер.
process.on("unhandledRejection", err => console.log("проигнорирована ошибка:", String(err && err.message || err).split("\n")[0]));
process.on("uncaughtException",  err => console.log("проигнорировано исключение:", String(err && err.message || err).split("\n")[0]));

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: "/snap/bin/chromium",
    headless: false,
    viewport: null,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=9222",
      "--window-position=0,0",
      "--window-size=1920,1040",
      "--force-device-scale-factor=2"
    ]
  });

  ctx.on("page", p => p.on("dialog", d => d.dismiss().catch(() => {})));

  const page = ctx.pages()[0] || await ctx.newPage();
  page.on("dialog", d => d.dismiss().catch(() => {}));
  await page.goto(LAYOUT, { timeout: 90000 }).catch(e => console.log("goto:", e.message.split("\n")[0]));
  console.log("браузер поднят, вкладка:", await page.title().catch(() => "?"));

  ctx.on("close", () => { console.log("браузер закрылся, выходим для перезапуска"); process.exit(1); });
  await new Promise(() => {});
})().catch(e => { console.error("ошибка запуска:", e.message.split("\n")[0]); process.exit(1); });
