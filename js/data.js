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

const isHidden = () => typeof document !== "undefined" && document.hidden;
const abortErr = (signal) => signal.reason ?? new DOMException("Aborted", "AbortError");

/** Chờ tới khi app hiện lại trên màn hình (iOS dừng mạng khi app chạy nền). */
function whenVisible(signal) {
  return new Promise((ok, fail) => {
    if (!isHidden()) return ok();
    const done = () => { document.removeEventListener("visibilitychange", on); signal?.removeEventListener("abort", stop); };
    const on = () => { if (!document.hidden) { done(); ok(); } };
    const stop = () => { done(); fail(abortErr(signal)); };
    document.addEventListener("visibilitychange", on);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * GET JSON; thử lại khi bị giới hạn tốc độ/lỗi máy chủ.
 * resume: lỗi mạng (iOS cắt kết nối khi chuyển app, mạng chập chờn) thì chờ app hiện lại rồi thử tiếp,
 * thay vì bỏ cả lần tải. Không dùng khi dò đường gọi (resolveBase) để còn chuyển sang proxy nhanh.
 */
async function getJson(url, signal, { resume = false, onPause } = {}) {
  for (let attempt = 0, netFails = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url, { signal });
    } catch (e) {
      if (!resume || e.name === "AbortError" || !(e instanceof TypeError)) throw e;
      if (isHidden()) {
        onPause?.(true); await whenVisible(signal); onPause?.(false);
      } else {
        if (++netFails > 5) throw e;
        await sleep(1000 * netFails);
      }
      continue;
    }
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status === 418 || r.status >= 500) && attempt < 5) {
      await sleep(Number(r.headers.get("Retry-After") || 0) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.msg) msg += `: ${j.msg}`; } catch { /* không phải JSON */ }
    if (r.status === 451 || r.status === 403) msg += " (blocked by Binance for this region/network)";
    throw new Error(msg);
  }
}

// Proxy cùng tên miền (api/binance.js khi chạy trên Vercel). Trên host tĩnh khác (GitHub Pages...) nó trả 404
// và app giữ lỗi gốc.
const proxyBase = (market) => (typeof location !== "undefined" && /^https?:$/.test(location.protocol)
  ? `${location.origin}/api/binance/${market === "futures" ? "fapi" : "spot"}` : null);
const PROXY_KEY = (market) => `viaProxy:${market}`;
const remembered = (market) => { try { return localStorage.getItem(PROXY_KEY(market)) === "1"; } catch { return false; } };
const remember = (market) => { try { localStorage.setItem(PROXY_KEY(market), "1"); } catch { /* bộ nhớ bị chặn */ } };

/**
 * Chọn đường gọi Binance: địa chỉ tự nhập > proxy đã nhớ > gọi thẳng; gọi thẳng lỗi mạng/CORS hoặc bị chặn vùng
 * (451/403) thì thử proxy cùng tên miền và nhớ lựa chọn.
 */
async function resolveBase(market, apiBase, signal) {
  if (apiBase) return { base: apiBase, via: "custom proxy" };
  const m = MARKETS[market], px = proxyBase(market);
  if (px && remembered(market)) return { base: px, via: "app proxy" };
  const probe = (base) => getJson(`${base}${m.klines}?symbol=BTCUSDT&interval=1h&limit=1`, signal);
  try {
    await probe(m.base);
    return { base: m.base, via: "direct" };
  } catch (e) {
    const blocked = e instanceof TypeError || /HTTP (451|403)/.test(e.message);
    if (e.name === "AbortError" || !px || !blocked) throw e;
    try { await probe(px); } catch { throw e; }
    remember(market);
    return { base: px, via: "app proxy" };
  }
}

/** Kiểm tra trình duyệt gọi được API Binance không (CORS, chặn vùng). */
export async function testConnection(market, apiBase) {
  const m = MARKETS[market];
  const t0 = performance.now();
  const { base, via } = await resolveBase(market, apiBase);
  const rows = await getJson(`${base}${m.klines}?symbol=BTCUSDT&interval=1h&limit=2`);
  return { ok: Array.isArray(rows) && rows.length > 0, ms: Math.round(performance.now() - t0), via };
}

const CHECKPOINT = 50; // lưu tạm sau mỗi ~50 yêu cầu (50k nến): app bị iOS đóng hẳn thì lần sau tải tiếp

/** Ghép nến mới (cols) vào bộ đã có; cols bắt đầu sau nến cuối thì nối, còn lại thay hẳn. */
function mergeCandles(prev, cols) {
  if (prev && !cols.t.length) return prev.candles;
  if (prev && cols.t[0] > prev.meta.last) {
    return Object.fromEntries(COLS.map((k) => {
      const a = new Float64Array(prev.candles[k].length + cols[k].length);
      a.set(prev.candles[k]); a.set(cols[k], prev.candles[k].length);
      return [k, a];
    }));
  }
  return Object.fromEntries(COLS.map((k) => [k, Float64Array.from(cols[k])]));
}

/**
 * Tải (hoặc cập nhật) nến. Nếu đã có dữ liệu cùng id thì chỉ tải phần mới sau nến cuối.
 * Lưu tạm định kỳ, nên bị ngắt giữa chừng thì bấm Download lại sẽ tải tiếp từ chỗ dừng.
 * onProgress({done, total, phase}); phase "paused" khi đang chờ mở lại app.
 */
export async function download({ market, symbol, tf, from, apiBase, onProgress, signal }) {
  const m = MARKETS[market];
  const { base } = await resolveBase(market, apiBase, signal);
  const id = datasetId(market, symbol, tf);
  let saved = await loadDataset(id);
  const ms = TF_MS[tf];
  const now = Date.now();
  const lastClosed = Math.floor(now / ms) * ms - ms;
  let start = saved ? saved.meta.last + ms : Math.floor(from / ms) * ms;
  if (saved && from < saved.meta.first) {                // extending into the past → reload (cả funding)
    start = Math.floor(from / ms) * ms;
    saved = { ...saved, funding: [] };
  }
  const meta = { id, market, symbol: symbol.toUpperCase(), tf };
  let cols = Object.fromEntries(COLS.map((k) => [k, []]));
  let added = 0;
  const flush = async () => {
    const candles = mergeCandles(saved, cols);
    const funding = saved?.funding || [];
    await saveDataset({ ...meta, funding, chunks: saved?.meta.chunks }, candles);
    const n = candles.t.length;
    saved = { meta: { ...meta, chunks: Math.ceil(n / CHUNK), first: candles.t[0], last: candles.t[n - 1] }, candles, funding };
    added += cols.t.length;
    cols = Object.fromEntries(COLS.map((k) => [k, []]));
  };
  const total = Math.max(1, Math.ceil((lastClosed - start) / ms / m.limit));
  let done = 0;
  const onPause = (p) => onProgress?.({ done, total, phase: p ? "paused" : "candles" });
  while (start <= lastClosed) {
    const url = `${base}${m.klines}?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=${m.limit}`;
    const rows = await getJson(url, signal, { resume: true, onPause });
    if (!rows.length) break;
    for (const r of rows) {
      if (r[0] > lastClosed) break;                      // bỏ nến chưa đóng
      cols.t.push(r[0]); cols.o.push(+r[1]); cols.h.push(+r[2]); cols.l.push(+r[3]);
      cols.c.push(+r[4]); cols.v.push(+r[5]);
    }
    start = rows[rows.length - 1][0] + ms;
    onProgress?.({ done: ++done, total, phase: "candles" });
    if (done % CHECKPOINT === 0 && cols.t.length) await flush();
    await sleep(120);                                     // ~8 yêu cầu/giây, dưới giới hạn Binance
  }
  if (cols.t.length || !saved) await flush();
  const { candles } = saved;
  if (m.funding && candles.t.length) {
    const funding = await downloadFunding(m, base, symbol, candles, saved.funding, onProgress, signal);
    await saveDataset({ ...meta, funding, chunks: saved.meta.chunks }, candles);
  }
  return { id, added, count: candles.t.length };
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
    const rows = await getJson(`${base}${m.funding}?symbol=${symbol}&startTime=${start}&limit=1000`, signal,
      { resume: true, onPause: (p) => onProgress?.({ done: n, total: n + 1, phase: p ? "paused" : "funding" }) });
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
  if (!cols.t.length) throw new Error("No rows read (need: time,open,high,low,close,volume)");
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
