// HTTP-сервис поверх снапшотов. Слушает только localhost: бот живёт на этой же машине,
// наружу ничего открывать не нужно.
//
// POST /snapshots { symbol, tfs?, dxy? } → { links: { ... } }
//   tfs  — список таймфреймов, по умолчанию ["1h","4h","1d"] (ещё умеет "5m", "15m")
//   dxy  — символ индекса доллара; null отключает его съёмку (нужно при закрытии сделки)
// Ключи ответа: таймфрейм актива как есть ("1h"), у DXY с приставкой ("dxy1h").
// GET  /health                     → { ok, loggedIn, busy }
const express = require("express");
const { takeSnapshots, getPage, isLoggedIn } = require("./snapshot");

const PORT = Number(process.env.WORKER_PORT || 3100);
const DXY = process.env.DXY_SYMBOL || "CAPITALCOM:DXY";

// Браузер один, поэтому две задачи одновременно выполнять нельзя — они будут
// перебивать друг другу символ и таймфрейм. Вторая ждёт, а не падает.
let queue = Promise.resolve();
let busy = false;

function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    const page = await getPage();
    res.json({ ok: true, loggedIn: await isLoggedIn(page), busy });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message.split("\n")[0] });
  }
});

app.post("/snapshots", async (req, res) => {
  const symbol = String(req.body && req.body.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "нет символа" });

  const body = req.body || {};
  const tfs = Array.isArray(body.tfs) && body.tfs.length ? body.tfs : ["1h", "4h", "1d"];
  const dxy = body.dxy === null || body.dxy === false ? null : String(body.dxy || DXY).trim();
  const started = Date.now();
  console.log(`задача: ${symbol} [${tfs.join(", ")}]${dxy ? " + " + dxy : ""}${busy ? " (ждёт очереди)" : ""}`);

  serialize(async () => {
    busy = true;
    try {
      const symbols = dxy ? [symbol, dxy] : [symbol];
      const raw = await takeSnapshots(symbols, { tfs: tfs, restoreSymbol: symbol });

      const links = {};
      tfs.forEach(function (tf) {
        links[tf] = raw[symbol + " " + tf];
        if (dxy) links["dxy" + tf] = raw[dxy + " " + tf];
      });
      const missing = Object.entries(links).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) throw new Error("не снялось: " + missing.join(", "));
      console.log(`готово за ${((Date.now() - started) / 1000).toFixed(0)} с`);
      res.json({ links, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      const msg = e.message.split("\n")[0];
      console.error("ошибка:", msg);
      res.status(500).json({ error: msg });
    } finally {
      busy = false;
    }
  });
});

app.listen(PORT, "127.0.0.1", () => console.log(`воркер слушает 127.0.0.1:${PORT}, DXY = ${DXY}`));
