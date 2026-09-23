// HTTP-сервис поверх снапшотов. Слушает только localhost: бот живёт на этой же машине,
// наружу ничего открывать не нужно.
//
// POST /snapshots { symbol, dxy? } → { links: { "1h": url, "4h": url, "1d": url,
//                                               "dxy1h": url, "dxy4h": url, "dxy1d": url } }
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

  const dxy = String(req.body && req.body.dxy || DXY).trim();
  const started = Date.now();
  console.log(`задача: ${symbol} + ${dxy}${busy ? " (ждёт очереди)" : ""}`);

  serialize(async () => {
    busy = true;
    try {
      const raw = await takeSnapshots([symbol, dxy], { restoreSymbol: symbol });
      const links = {
        "1h": raw[symbol + " 1h"], "4h": raw[symbol + " 4h"], "1d": raw[symbol + " 1d"],
        dxy1h: raw[dxy + " 1h"], dxy4h: raw[dxy + " 4h"], dxy1d: raw[dxy + " 1d"]
      };
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
