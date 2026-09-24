// Dữ liệu: tải nến + funding từ API công khai Binance (không cần tài khoản), lưu trong IndexedDB,
// cập nhật phần mới, nhập/xuất CSV.
import { TF_MS } from "./timeframes.js";

export const MARKETS = {
  futures: {
    label: "Futures USDT-M (perpetual)",
    klines: "/fapi/v1/klines", funding: "/fapi/v1/fundingRate", base: "https://fapi.binance.com", limit: 1000,
  },
  spot: {
    label: "Spot",
    klines: "/api/v3/klines", funding: null, base: "https://data-api.binance.vision", limit: 1000,
  },
};

// ---------------------------------------------------------------- IndexedDB
const DB_NAME = "btc-backtest", DB_VER = 1;
let dbp = null;
function db() {
  dbp ??= new Promise((ok, fail) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("meta", { keyPath: "id" });
      r.result.createObjectStore("chunks");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(stores, mode);
    const res = fn(t);
    t.oncomplete = () => ok(res);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error);
  });
}
const reqP = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });

export const datasetId = (market, symbol, tf) => `${market}:${symbol.toUpperCase()}:${tf}`;
const CHUNK = 20000;
const COLS = ["t", "o", "h", "l", "c", "v"];

export async function listDatasets() {
  return tx(["meta"], "readonly", (t) => reqP(t.objectStore("meta").getAll()));
}

export async function loadDataset(id) {
  const meta = await tx(["meta"], "readonly", (t) => reqP(t.objectStore("meta").get(id)));
  if (!meta) return null;
  const n = meta.count;
  const out = Object.fromEntries(COLS.map((k) => [k, new Float64Array(n)]));
  await tx(["chunks"], "readonly", async (t) => {
    const st = t.objectStore("chunks");
    const parts = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => reqP(st.get(`${id}#${i}`))));
    let off = 0;
    for (const p of parts) {
      for (const k of COLS) out[k].set(p[k], off);
      off += p.t.length;
    }
  });
  return { meta, candles: out, funding: meta.funding || [] };
}

async function saveDataset(meta, candles) {
  const n = candles.t.length;
  const chunks = Math.ceil(n / CHUNK);
  await tx(["meta", "chunks"], "readwrite", (t) => {
    const st = t.objectStore("chunks");
    for (let i = 0; i < Math.max(chunks, meta.chunks || 0); i++) {
      if (i >= chunks) { st.delete(`${meta.id}#${i}`); continue; }
      const part = {};
      for (const k of COLS) part[k] = Float64Array.from(candles[k].slice(i * CHUNK, (i + 1) * CHUNK));
      st.put(part, `${meta.id}#${i}`);
    }
    t.objectStore("meta").put({ ...meta, count: n, chunks,
      first: n ? candles.t[0] : null, last: n ? candles.t[n - 1] : null, updated: Date.now() });
  });
}

export async function deleteDataset(id) {
  const meta = await tx(["meta"], "readonly", (t) => reqP(t.objectStore("meta").get(id)));
  if (!meta) return;
  await tx(["meta", "chunks"], "readwrite", (t) => {
    for (let i = 0; i < meta.chunks; i++) t.objectStore("chunks").delete(`${id}#${i}`);
    t.objectStore("meta").delete(id);
  });
}

// ---------------------------------------------------------------- Binance
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function getJson(url, signal) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status === 418 || r.status >= 500) && attempt < 5) {
      await sleep(Number(r.headers.get("Retry-After") || 0) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.msg) msg += `: ${j.msg}`; } catch { /* không phải JSON */ }
    if (r.status === 451 || r.status === 403) msg += " (Binance chặn truy cập từ khu vực/mạng này)";
    throw new Error(msg);
  }
}

/** Kiểm tra trình duyệt gọi được API Binance không (CORS, chặn vùng). */
export async function testConnection(market, apiBase) {
  const m = MARKETS[market];
  const base = apiBase || m.base;
  const t0 = performance.now();
  const rows = await getJson(`${base}${m.klines}?symbol=BTCUSDT&interval=1h&limit=2`);
  return { ok: Array.isArray(rows) && rows.length > 0, ms: Math.round(performance.now() - t0) };
}

/**
 * Tải (hoặc cập nhật) nến. Nếu đã có dữ liệu cùng id thì chỉ tải phần mới sau nến cuối.
 * onProgress({done, total, phase})
 */
export async function download({ market, symbol, tf, from, apiBase, onProgress, signal }) {
  const m = MARKETS[market];
  const base = apiBase || m.base;
  const id = datasetId(market, symbol, tf);
  const existing = await loadDataset(id);
  const ms = TF_MS[tf];
  const now = Date.now();
  const lastClosed = Math.floor(now / ms) * ms - ms;
  let start = existing ? existing.meta.last + ms : Math.floor(from / ms) * ms;
  if (existing && from < existing.meta.first) start = Math.floor(from / ms) * ms; // mở rộng về quá khứ → tải lại
  const cols = Object.fromEntries(COLS.map((k) => [k, []]));
  const total = Math.max(1, Math.ceil((lastClosed - start) / ms / m.limit));
  let done = 0;
  while (start <= lastClosed) {
    const url = `${base}${m.klines}?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=${m.limit}`;
    const rows = await getJson(url, signal);
    if (!rows.length) break;
    for (const r of rows) {
      if (r[0] > lastClosed) break;                      // bỏ nến chưa đóng
      cols.t.push(r[0]); cols.o.push(+r[1]); cols.h.push(+r[2]); cols.l.push(+r[3]);
      cols.c.push(+r[4]); cols.v.push(+r[5]);
    }
    start = rows[rows.length - 1][0] + ms;
    onProgress?.({ done: ++done, total, phase: "nến" });
    await sleep(120);                                     // ~8 yêu cầu/giây, dưới giới hạn Binance
  }
  let candles;
  if (existing && cols.t.length && cols.t[0] > existing.meta.last) {
    candles = Object.fromEntries(COLS.map((k) => [k, Float64Array.from([...existing.candles[k], ...cols[k]])]));
  } else if (existing && !cols.t.length) {
    candles = existing.candles;
  } else {
    candles = Object.fromEntries(COLS.map((k) => [k, Float64Array.from(cols[k])]));
  }
  let funding = existing?.funding || [];
  if (m.funding && candles.t.length) funding = await downloadFunding(m, base, symbol, candles, funding, onProgress, signal);
  await saveDataset({ id, market, symbol: symbol.toUpperCase(), tf, funding, chunks: existing?.meta.chunks }, candles);
  return { id, added: cols.t.length, count: candles.t.length };
}

async function downloadFunding(m, base, symbol, candles, have, onProgress, signal) {
  const out = have.slice();
  let start = out.length ? out[out.length - 1].t + 1 : candles.t[0];
  const end = candles.t[candles.t.length - 1];
  const close = (t) => { // giá gần mốc funding, dùng khi Binance không trả markPrice
    let lo = 0, hi = candles.t.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles.t[mid] <= t) lo = mid; else hi = mid - 1; }
    return candles.o[lo];
  };
  let n = 0;
  while (start <= end) {
    const rows = await getJson(`${base}${m.funding}?symbol=${symbol}&startTime=${start}&limit=1000`, signal);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.fundingTime > end) break;
      const mark = Number(r.markPrice);
      out.push({ t: r.fundingTime, rate: Number(r.fundingRate), mark: mark > 0 ? mark : close(r.fundingTime) });
    }
    start = rows[rows.length - 1].fundingTime + 1;
    onProgress?.({ done: ++n, total: n + (rows.length === 1000 ? 1 : 0), phase: "funding" });
    if (rows.length < 1000) break;
    await sleep(250);
  }
  return out;
}

// ---------------------------------------------------------------- CSV
/** CSV: time,open,high,low,close,volume — time là mili-giây, giây, hoặc ngày giờ ISO. */
export async function importCsv(text, { market, symbol, tf }) {
  const cols = Object.fromEntries(COLS.map((k) => [k, []]));
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(/[,;\t]/);
    if (f.length < 6) continue;
    let t = Number(f[0]);
    if (!Number.isFinite(t)) { t = Date.parse(f[0].trim()); if (Number.isNaN(t)) continue; } // dòng tiêu đề
    else if (t < 1e11) t *= 1000;
    cols.t.push(t);
    for (const [k, i] of [["o", 1], ["h", 2], ["l", 3], ["c", 4], ["v", 5]]) cols[k].push(Number(f[i]));
  }
  if (!cols.t.length) throw new Error("Không đọc được dòng nào (cần: time,open,high,low,close,volume)");
  const order = cols.t.map((_, i) => i).sort((a, b) => cols.t[a] - cols.t[b]);
  const candles = Object.fromEntries(COLS.map((k) => [k, Float64Array.from(order, (i) => cols[k][i])]));
  const id = datasetId(market, symbol, tf);
  const old = await loadDataset(id);
  await saveDataset({ id, market, symbol: symbol.toUpperCase(), tf, funding: [], chunks: old?.meta.chunks }, candles);
  return { id, count: candles.t.length };
}

export function exportCsv(candles) {
  const lines = ["time,open,high,low,close,volume"];
  for (let i = 0; i < candles.t.length; i++) {
    lines.push(`${candles.t[i]},${candles.o[i]},${candles.h[i]},${candles.l[i]},${candles.c[i]},${candles.v[i]}`);
  }
  return lines.join("\n");
}
