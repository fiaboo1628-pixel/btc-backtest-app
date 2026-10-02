import * as Data from "./data.js";
import { CATALOG, CATALOG_BY_ID, paramsWithDefaults } from "./catalog.js";
import { OPS } from "./rules.js";
import { TF_MS, TF_LIST, resample } from "./timeframes.js";
import { DEFAULT_EXIT, DEFAULT_ACCOUNT } from "./engine.js";
import { createLive } from "./live.js";
import { toBotParams, fromBotParams } from "./botparams.js";

// Vercel Web Analytics + Speed Insights: tải không bắt buộc — lỗi/offline thì bỏ qua, app vẫn chạy.
// Hub (máy chủ nhà qua Tailscale) và máy local không có node_modules/@vercel → bỏ qua để khỏi lỗi 404 trong console.
if (!/(\.ts\.net|^localhost|^127\.0\.0\.1)$/.test(location.hostname)) {
  import("@vercel/analytics").then((m) => m.inject()).catch(() => {});
  import("@vercel/speed-insights").then((m) => m.injectSpeedInsights()).catch(() => {});
}

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 2) => (n == null || !Number.isFinite(n)) ? "–" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const sign = (n, d = 1) => (n > 0 ? "+" : "") + fmt(n, d);
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const day = (t) => new Date(t).toISOString().slice(0, 10);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
function toast(text, kind = "ok") {
  const el = $("#toast");
  el.innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : "";
  if (text) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ============================================================== state
// 5 coin bot đang chạy (bot/deploy/config.base.json pair_whitelist), đúng thứ tự whitelist
const BOT_COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
const state = {
  presets: [],
  strategy: null,
  activeId: store.get("activeDataset", null),
  dataset: null,          // {meta, candles, funding}
  abort: null,
  // nhiều coin chung tài khoản: coin đã tích, số lệnh mở tối đa, tự dừng khi sụt vốn 15%
  portfolio: store.get("portfolio", { coins: BOT_COINS, maxOpen: 5, halt: false }),
};

// ============================================================== tabs
const TABS = ["data", "strategy", "result"];            // + "live" khi chạy trên hub
let currentTab = "data";
const tabScroll = {};
function showTab(name) {
  if (name === currentTab) return;
  toast("");
  tabScroll[currentTab] = window.scrollY;                    // nhớ vị trí cuộn của tab đang rời
  const dir = TABS.indexOf(name) > TABS.indexOf(currentTab) ? "next" : "prev";
  currentTab = name;
  document.querySelectorAll(".tab").forEach((s) => {
    const on = s.id === `tab-${name}`;
    s.hidden = !on;
    s.classList.remove("in-next", "in-prev");
    if (on) { void s.offsetWidth; s.classList.add(`in-${dir}`); } // chạy lại hiệu ứng trượt
  });
  document.querySelectorAll(".tabbar [data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === name));
  if (name === "live") state.live?.start(); else state.live?.stop();
  window.scrollTo({ top: tabScroll[name] || 0, behavior: "instant" });
}

// Vuốt ngang để đổi tab (bỏ qua khi kéo thanh trượt, cuộn bảng, đang gõ chữ, hoặc bắt đầu sát mép màn hình —
// mép trái là cử chỉ "quay lại" của iOS)
function enableSwipe() {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  // lắng nghe cả trang (tab ngắn thì vùng trống bên dưới cũng vuốt được), trừ thanh trên và thanh tab
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    ok = e.touches.length === 1 && t.clientX > 24 && t.clientX < innerWidth - 24
      && !e.target.closest("input[type=range], textarea, .tablewrap, .appbar, .tabbar")
      && !(e.target === document.activeElement && e.target.matches("input, select")); // đang gõ/chọn
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!ok) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const i = TABS.indexOf(currentTab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) showTab(TABS[i]);
  }, { passive: true });
}

// Ẩn thanh tab khi bàn phím mở (iOS đẩy thanh cố định lên trên bàn phím).
// Dựa vào vùng hiển thị bị thu hẹp chứ không dựa vào focus: ô ngày/ô chọn trên iOS mở bộ chọn,
// không mở bàn phím, và vẫn giữ focus sau khi chọn xong.
function hideTabbarWithKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => document.body.classList.toggle("kb", window.innerHeight - vv.height > 150);
  vv.addEventListener("resize", update);
  update();
}

// ============================================================== data
// giải thích khung nến: nến nhỏ = biết giá đi lên hay xuống trước trong nến giao dịch → thoát lệnh chính xác hơn
const TF_HELP = {
  "1m": "Best for trailing stops: exits are checked minute by minute. Big download — about 6 months takes a few minutes.",
  "5m": "Good balance: can backtest 5m and larger (15m, 1h, 4h…); exits are checked on every 5m candle.",
  "15m": "Stops and trailing are checked only once per 15m candle, so tight trailing (under ~0.5R) looks better than it really is.",
  "1h": "Only for 1h+ strategies; stops and trailing are checked once per hour, so results are rough.",
};
function dlHint() {
  const tf = $("#dlTf").value, from = Date.parse($("#dlFrom").value) || Date.now();
  const n = Math.max(0, (Date.now() - from) / TF_MS[tf]);
  const reqs = Math.ceil(n / 1000);
  const mb = (n * 6 * 8) / 1e6;
  const secs = reqs * 0.14;
  $("#tfHelp").textContent = TF_HELP[tf] || "";
  $("#dlHint").textContent = `About ${fmtInt(n)} candles · takes ~${secs < 90 ? `${Math.ceil(secs)} s` : `${fmt(secs / 60, 1)} min`} · uses ${fmt(mb, 0)} MB`;
}

async function refreshDatasets() {
  const list = (await Data.listDatasets()).sort((a, b) => a.id.localeCompare(b.id));
  const box = $("#dsList");
  if (!list.length) { box.innerHTML = `<p class="hint">No data yet — choose a candle size above and tap Download.</p>`; }
  else {
    box.innerHTML = list.map((m) => {
      const on = m.id === state.activeId;
      return `<div class="ds ${on ? "active" : ""}" data-id="${esc(m.id)}">
        <button class="ds-main" data-act="use" type="button" aria-pressed="${on}">
          <b>${esc(m.symbol)} · ${esc(m.tf)} candles · ${m.market === "futures" ? "Futures" : "Spot"} ${on ? `<span class="pill good">In use</span>` : ""}</b>
          <span class="hint">${day(m.first)} → ${day(m.last)} · ${fmtInt(m.count)} candles</span>
        </button>
        <div class="ds-acts">
          <button class="btn sm" data-act="update" type="button" title="Download candles newer than the last one">Update</button>
          <button class="btn sm" data-act="csv" type="button" title="Save as a CSV file">CSV</button>
          <button class="btn sm danger" data-act="del" type="button" aria-label="Delete ${esc(m.id)}">Delete</button>
        </div>
      </div>`;
    }).join("");
  }
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    $("#storageInfo").textContent = `${fmt((e.usage || 0) / 1e6, 1)} MB used`;
  }
  if (!list.find((m) => m.id === state.activeId) && list.length) await useDataset(list[0].id);
  else if (!list.length) { state.activeId = null; state.dataset = null; updateDsLabel(); }
}

async function useDataset(id) {
  state.activeId = id; store.set("activeDataset", id);
  state.dataset = await Data.loadDataset(id);
  updateDsLabel(); refreshTfOptions(); await refreshDatasets(); renderPortfolioCoins();
  const m = state.dataset.meta;
  if (!$("#rFrom").value || Date.parse($("#rFrom").value) < m.first) $("#rFrom").value = day(m.first);
}
function updateDsLabel() {
  const m = state.dataset?.meta;
  $("#dsLabel").textContent = m ? `${m.symbol} ${m.tf} ${m.market === "futures" ? "Futures" : "Spot"} · ${day(m.first)} → ${day(m.last)}` : "No data";
}

async function startDownload(opts) {
  const ctl = new AbortController();
  state.abort = ctl;
  $("#btnDownload").disabled = true; $("#btnCancel").hidden = false;
  const prog = $("#dlProg"); prog.classList.remove("hidden");
  // giữ màn hình sáng khi đang tải: màn hình tắt thì iOS dừng mạng của app
  const lock = { s: null, want: true };
  const takeLock = () => { if (lock.want && !document.hidden) navigator.wakeLock?.request("screen").then((w) => { lock.s = w; }, () => {}); };
  const relock = () => { if (!lock.s || lock.s.released) takeLock(); };
  takeLock(); document.addEventListener("visibilitychange", relock);
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const r = await Data.download({
      ...opts, apiBase: $("#apiBase").value.trim() || undefined, signal: ctl.signal,
      onProgress: ({ done, total, phase }) => {
        prog.firstElementChild.style.width = `${Math.min(100, (done / total) * 100)}%`;
        $("#dlStatus").textContent = phase === "paused" ? `Paused in background · ${done}/${total}` : `${phase} ${done}/${total}`;
      },
    });
    $("#dlStatus").textContent = "";
    toast(`Done: +${fmtInt(r.added)} candles (${fmtInt(r.count)} total).`);
    await useDataset(r.id);
  } catch (e) {
    $("#dlStatus").textContent = "";
    toast(e.name === "AbortError" ? "Stopped. Download again to resume."
      : `Download failed: ${e.message}. Progress is saved — tap Download to resume.`, "err");
    await refreshDatasets().catch(() => {});
  } finally {
    lock.want = false; document.removeEventListener("visibilitychange", relock); lock.s?.release().catch(() => {});
    prog.classList.add("hidden"); $("#btnDownload").disabled = false; $("#btnCancel").hidden = true; state.abort = null;
  }
}

// ============================================================== strategy
const clone = (x) => JSON.parse(JSON.stringify(x));
function normalize(s) {
  return {
    name: s.name || "Strategy", description: s.description || "", tradeTf: s.tradeTf || "15m",
    long: s.long || [], short: s.short || [],
    exit: { ...DEFAULT_EXIT, ...s.exit }, account: { ...DEFAULT_ACCOUNT, ...s.account },
  };
}
function saved() { return store.get("strategies", {}); }
function persistCurrent() { store.set("currentStrategy", state.strategy); refreshBotFit(); }

function refreshPick() {
  const mine = saved();
  $("#stPick").innerHTML = `<option value="">—</option>
    <optgroup label="Presets">${state.presets.map((p, i) => `<option value="p:${i}">${esc(p.name)}</option>`).join("")}</optgroup>
    ${Object.keys(mine).length ? `<optgroup label="Saved">${Object.keys(mine).map((n) => `<option value="s:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}`;
}

function refreshTfOptions() {
  const minMs = TF_MS[state.dataset?.meta.tf || "1m"];
  const opts = TF_LIST.filter((tf) => TF_MS[tf] >= minMs);
  const cur = state.strategy.tradeTf;
  $("#stTf").innerHTML = opts.map((tf) => `<option ${tf === cur ? "selected" : ""}>${tf}</option>`).join("");
  $("#tfNote").textContent = state.dataset && TF_MS[cur] < minMs ? `Data is ${state.dataset.meta.tf}: can't run ${cur}.` : "";
  renderConds();
}

function renderStrategy() {
  const s = state.strategy;
  $("#stName").value = s.name;
  refreshTfOptions();
  // [group, key, label, tooltip, min, max, step]
  const defs = [
    ["exit", "rAtr", "Stop (×ATR)", "1R = initial stop distance = this × ATR", 0.5, 10, 0.1],
    ["exit", "atrN", "ATR bars", "ATR length used for the stop / R", 5, 100, 1],
    ["exit", "trailStartR", "Trail at (R)", "Start trailing once profit reaches this many R (0 = no trailing)", 0, 10, 0.1],
    ["exit", "trailDistR", "Trail gap (R)", "Trailing stop distance from the high/low, in R", 0.1, 5, 0.1],
    ["exit", "tpR", "Take profit (R)", "Fixed take-profit at this many R (0 = off)", 0, 20, 0.1],
    ["exit", "maxHoldBars", "Max bars", "Close after this many bars (0 = off)", 0, 5000, 1],
    ["exit", "exitChannel", "Channel exit", "Close a Long when a bar closes below the low of this many previous bars (Short: above the high); exits at the next open. 0 = off", 0, 200, 1],
    ["account", "wallet", "Capital", "Starting balance (USDT)", 10, 1e9, 1],
    ["account", "riskPct", "Risk %", "Balance lost if the initial stop is hit", 0.05, 10, 0.05],
    ["account", "maxLev", "Max lev", "Leverage cap", 1, 50, 1],
    ["account", "fee", "Fee %", "Per side", 0, 1, 0.001],
    ["account", "slippage", "Slippage %", "Market fills worse than the price, per side (a Demo stop filled 0.047% below its trigger). 0 = like freqtrade's backtest", 0, 1, 0.001],
  ];
  const pct = new Set(["fee", "slippage"]);           // lưu dạng tỉ lệ, hiện dạng %
  $("#exitFields").innerHTML = defs.map(([g, k, label, tip, min, max, st]) => {
    const v = pct.has(k) ? +((s.account[k] ?? 0) * 100).toFixed(4) : (s[g][k] ?? 0);
    return `<label title="${esc(tip)}">${label}<input type="number" data-${g === "exit" ? "exit" : "acc"}="${k}" min="${min}" max="${max}" step="${st}" value="${v}" inputmode="decimal"></label>`;
  }).join("");
}

function renderConds() {
  for (const side of ["long", "short"]) {
    const box = $(side === "long" ? "#condLong" : "#condShort");
    box.innerHTML = "";
    state.strategy[side].forEach((cond, i) => box.appendChild(condEl(side, i, cond)));
  }
  if (!state.strategy.long.length) $("#condLong").innerHTML = `<p class="hint">Empty = no longs</p>`;
  if (!state.strategy.short.length) $("#condShort").innerHTML = `<p class="hint">Empty = no shorts</p>`;
}

function condEl(side, i, cond) {
  const el = $("#condTpl").content.firstElementChild.cloneNode(true);
  const def = CATALOG_BY_ID[cond.ind];
  const groups = [...new Set(CATALOG.map((x) => x.group))];
  $(".c-ind", el).innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">${CATALOG.filter((x) => x.group === g)
    .map((x) => `<option value="${x.id}" ${x.id === cond.ind ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>`).join("");
  $(".c-ind", el).title = def.help;
  const params = paramsWithDefaults(cond.ind, cond.params);
  $(".c-params", el).innerHTML = def.params.map((p) =>
    `<label>${esc(p.label)}<input type="number" data-p="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${params[p.key]}" inputmode="decimal"></label>`).join("");
  const minMs = Math.max(TF_MS[state.strategy.tradeTf], TF_MS[state.dataset?.meta.tf || "1m"]);
  $(".c-tf", el).innerHTML = `<option value="">—</option>` + TF_LIST.filter((tf) => TF_MS[tf] > minMs)
    .map((tf) => `<option ${tf === cond.tf ? "selected" : ""}>${tf}</option>`).join("");
  $(".c-op", el).innerHTML = Object.entries(OPS).map(([k, o]) => `<option value="${k}" ${k === cond.op ? "selected" : ""}>${o.label}</option>`).join("");
  const [lo, hi, st] = def.range;
  const val = $(".c-val", el), rng = $(".c-range", el);
  val.value = cond.value; rng.min = lo; rng.max = hi; rng.step = st; rng.value = cond.value;
  const fill = () => rng.style.setProperty("--fill", `${((rng.value - lo) / (hi - lo || 1)) * 100}%`);
  fill();
  const upd = (fn) => { fn(state.strategy[side][i]); persistCurrent(); };
  $(".c-ind", el).addEventListener("change", (e) => {
    const d = CATALOG_BY_ID[e.target.value];
    upd((c) => { c.ind = d.id; c.params = paramsWithDefaults(d.id, {}); c.value = +((d.range[0] + d.range[1]) / 2).toFixed(4); });
    renderConds();
  });
  el.querySelectorAll("[data-p]").forEach((inp) => inp.addEventListener("change", () =>
    upd((c) => { c.params = { ...paramsWithDefaults(c.ind, c.params), [inp.dataset.p]: Number(inp.value) }; })));
  $(".c-tf", el).addEventListener("change", (e) => upd((c) => { if (e.target.value) c.tf = e.target.value; else delete c.tf; }));
  $(".c-op", el).addEventListener("change", (e) => upd((c) => { c.op = e.target.value; }));
  val.addEventListener("change", () => { upd((c) => { c.value = Number(val.value); }); rng.value = val.value; fill(); });
  rng.addEventListener("input", () => { val.value = rng.value; fill(); upd((c) => { c.value = Number(rng.value); }); });
  $(".c-del", el).addEventListener("click", () => { state.strategy[side].splice(i, 1); persistCurrent(); renderConds(); });
  return el;
}

function loadStrategy(s) {
  state.strategy = normalize(clone(s));
  persistCurrent(); renderStrategy();
}

// ============================================================== results
let worker = null, runId = 0;
function getWorker() {
  worker ??= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return worker;
}

function attempts() {
  const key = `attempts:${state.strategy.name}`;
  const rec = store.get(key, { n: 0, last: "" });
  const sig = JSON.stringify({ ...state.strategy, name: undefined, description: undefined });
  if (sig !== rec.last) { rec.n++; rec.last = sig; store.set(key, rec); }
  return rec.n;
}

async function runBacktest() {
  if (!state.dataset) { showTab("data"); toast("Download or pick data first.", "err"); return; }
  const s = state.strategy;
  if (!s.long.length && !s.short.length) { showTab("strategy"); toast("Add at least one condition.", "err"); return; }
  showTab("result");
  const n = attempts();
  $("#attemptWarn").innerHTML = n >= 15
    ? `<div class="msg warn">${n} variants tried — good results get likelier by luck. Trust P2 and dry-run.</div>` : "";
  const btn = $("#btnRun"), label = $("#btnRun span"); btn.disabled = true; label.textContent = "…";
  const { candles, funding, meta } = state.dataset;
  const t0 = performance.now();
  const res = await runInWorker({ source: candles, sourceTf: meta.tf, funding: meta.market === "futures" ? funding : [], strategy: s, ...rangeArgs() });
  btn.disabled = false; label.textContent = "Run";
  if (!res.ok) { toast(res.error, "err"); return; }
  toast("");
  state.lastRun = { replay: res.replay, range: res.range, tf: s.tradeTf, wallet: s.account?.wallet ?? 1000, key: JSON.stringify(s) };
  renderResult(res, performance.now() - t0);
}

function rangeArgs() {
  const meta = state.dataset.meta;
  return { from: Date.parse($("#rFrom").value) || meta.first, to: $("#rTo").value ? Date.parse($("#rTo").value) : null,
    split: Date.parse($("#rSplit").value) || null };
}

function runInWorker(msg) {
  const id = ++runId;
  const w = getWorker();
  return new Promise((ok) => {
    const done = (r) => { w.removeEventListener("message", h); w.removeEventListener("error", fail); ok(r); };
    const h = (e) => { if (e.data.id === id) done(e.data); };
    // worker chết (hết bộ nhớ, lỗi tải module): báo lỗi thay vì kẹt nút Run, lần sau tạo worker mới
    const fail = (e) => { e.preventDefault?.(); w.terminate(); worker = null; done({ ok: false, error: `Backtest crashed: ${e.message || "out of memory?"}` }); };
    w.addEventListener("message", h);
    w.addEventListener("error", fail);
    w.postMessage({ id, ...msg });
  });
}

// ---------------------------------------------------------------- nhiều coin chung tài khoản
/** Bộ dữ liệu cùng sàn + khung nến với bộ đang dùng, theo coin. */
async function portfolioSets() {
  const m = state.dataset?.meta;
  if (!m) return new Map();
  const list = await Data.listDatasets();
  return new Map(list.filter((d) => d.market === m.market && d.tf === m.tf && d.count > 0).map((d) => [d.symbol, d]));
}

async function renderPortfolioCoins() {
  const box = $("#portCoins");
  const sets = await portfolioSets();
  const p = state.portfolio;
  // coin của bot trước (đúng thứ tự whitelist), rồi coin khác đã tải
  const names = [...BOT_COINS, ...[...sets.keys()].filter((s) => !BOT_COINS.includes(s)).sort()];
  box.innerHTML = names.map((sym) => {
    const have = sets.has(sym), on = have && p.coins.includes(sym);
    return `<label class="chip pick ${have ? "" : "off"}" title="${have ? "" : "Not downloaded for this market and candle size"}">
      <input type="checkbox" data-coin="${esc(sym)}" ${on ? "checked" : ""} ${have ? "" : "disabled"}> ${esc(sym.replace(/USDT$/, ""))}</label>`;
  }).join("") || `<span class="hint">Pick data first.</span>`;
  $("#portMax").value = p.maxOpen; $("#portHalt").checked = !!p.halt;
  $("#btnDlCoins").hidden = BOT_COINS.every((s) => sets.has(s));
}

async function runPortfolio() {
  if (!state.dataset) { showTab("data"); toast("Download or pick data first.", "err"); return; }
  const s = state.strategy;
  if (!s.long.length && !s.short.length) { showTab("strategy"); toast("Add at least one condition.", "err"); return; }
  const sets = await portfolioSets();
  const order = [...BOT_COINS, ...[...sets.keys()].filter((x) => !BOT_COINS.includes(x)).sort()];
  const coins = order.filter((x) => state.portfolio.coins.includes(x) && sets.has(x));
  if (!coins.length) { toast("Tick at least one coin that has data.", "err"); return; }
  showTab("result");
  const btn = $("#btnRunPort"); btn.disabled = true; btn.textContent = "…";
  const meta = state.dataset.meta;
  const t0 = performance.now();
  try {
    const data = await Promise.all(coins.map((sym) => Data.loadDataset(sets.get(sym).id)));
    const res = await runInWorker({
      kind: "portfolio", sourceTf: meta.tf, strategy: s, maxOpen: state.portfolio.maxOpen, haltDD: state.portfolio.halt ? 0.15 : 0,
      coins: data.map((d, i) => ({ symbol: coins[i], source: d.candles, funding: meta.market === "futures" ? d.funding : [] })),
      ...rangeArgs(),
    });
    if (!res.ok) { toast(res.error, "err"); return; }
    toast("");
    state.lastRun = { replay: [], range: res.range, tf: s.tradeTf, wallet: s.account?.wallet ?? 1000, key: JSON.stringify(s), coins };
    renderResult(res, performance.now() - t0);
  } finally { btn.disabled = false; btn.textContent = "Run portfolio"; }
}

/** Tải các coin của bot còn thiếu, cùng sàn/khung nến/ngày bắt đầu với bộ đang dùng (tuần tự, dùng Download sẵn có). */
async function downloadBotCoins() {
  const m = state.dataset?.meta;
  if (!m) { toast("Pick data first.", "err"); return; }
  const sets = await portfolioSets();
  for (const sym of BOT_COINS) {
    if (sets.has(sym)) continue;
    await startDownload({ market: m.market, symbol: sym, tf: m.tf, from: m.first });
    if (!state.dataset || state.dataset.meta.symbol !== sym) break;           // tải lỗi / dừng → thôi
  }
  await useDataset(Data.datasetId(m.market, m.symbol, m.tf)).catch(() => {});    // quay lại bộ đang dùng
}

function renderResult(r, ms) {
  $("#resBox").hidden = false;
  requestAnimationFrame(() => $("#resBox").scrollIntoView({ behavior: "smooth", block: "start" }));
  const s = state.strategy, P = r.periods, A = P[0];
  const coins = r.portfolio ? state.lastRun.coins.map((c) => c.replace(/USDT$/, "")).join(" ") : "";
  $("#resMeta").textContent = `${s.name} · ${s.tradeTf}${r.detailTf ? ` · exits on ${r.detailTf}` : ""}${r.portfolio ? ` · ${coins} · one account, max ${state.portfolio.maxOpen} open` : ""} · ${fmtInt(r.candles)} bars · ${fmt(ms / 1000, 1)} s`;
  const ex = s.exit || {};
  // trailing sát (< 0.5R) được lợi ảo khi không biết giá trong nến đi lên hay xuống trước.
  // Đo trên BTC 15m 2021–2026, gap 0.2R: chỉ nến 15m +110%, chi tiết 5m +88%, chi tiết 1m +77%.
  const warns = [];
  if (ex.trailStartR > 0 && ex.trailDistR < 0.5 && r.detailTf !== "1m")
    warns.push(`Trail gap ${ex.trailDistR}R: results with ${r.detailTf || s.tradeTf} candles look better than reality. Download 1m data for accurate trailing exits.`);
  if (r.halted) warns.push(`Stopped opening new trades on ${day(r.haltedAt)} after a 15% drawdown (the bot's halt). Open trades were managed to their exit.`);
  $("#resWarn").textContent = warns.join(" ");
  $("#btnReplay").hidden = !!r.portfolio;                  // Replay vẽ một coin
  $("#resCoinsCard").hidden = !r.portfolio;
  if (r.portfolio) {
    $("#resCoins").innerHTML = `<thead><tr><th>Coin</th><th>Trades</th><th>P&amp;L</th><th>PF</th><th>Win</th></tr></thead><tbody>`
      + r.perCoin.map((c) => `<tr><td>${esc(c.pair.replace(/USDT$/, ""))}</td><td>${c.trades} <small>${c.long}L/${c.short}S</small></td>
        <td class="${cls(c.pnl)}">${sign(c.pnl, 0)}</td><td>${fmt(c.profitFactor)}</td><td>${fmt(c.winrate * 100, 0)}%</td></tr>`).join("") + "</tbody>";
  }
  const my = (t) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`; };

  // tiêu đề: lãi/lỗ tổng + so với mua & giữ
  $("#resReturn").innerHTML = `<span class="${cls(A.profitPct)}">${sign(A.profitPct)}%</span>`;
  $("#resSub").innerHTML = `${fmt(A.cagrPct, 1)}%/yr · buy &amp; hold <span class="${cls(A.marketPct)}">${sign(A.marketPct)}%</span>`;
  const good = A.profitFactor >= 1.15 && A.maxDDPct <= 25, bad = A.profitPct <= 0 || A.maxDDPct > 40;
  $("#resBadges").innerHTML = `<span class="pill ${bad ? "bad" : good ? "good" : "mid"}">${bad ? "Weak" : good ? "Solid" : "OK"}</span>
    ${r.detailTf ? `<span class="pill">${r.detailTf} exits</span>` : ""}`;
  const kpi = (label, value, extra = "", c = "") => `<div class="kpi"><span>${label}</span><b class="${c}">${value}</b>${extra ? `<small>${extra}</small>` : ""}</div>`;
  $("#resKpis").innerHTML = kpi("Max DD", `${fmt(A.maxDDPct, 1)}%`, "", A.maxDDPct > 30 ? "down" : "")
    + kpi("Profit factor", fmt(A.profitFactor), "", A.profitFactor >= 1 ? "up" : "down")
    + kpi("Win rate", `${fmt(A.winrate * 100, 0)}%`)
    + kpi("Trades", fmtInt(A.trades), `${A.long}L · ${A.short}S`);

  // đường vốn: vùng tô + đường, mốc chia giai đoạn
  const eq = r.equity, W = 600, H = 180, pad = 8;
  if (eq.length > 1) {
    const xs = eq.map((e) => e[0]), ys = eq.map((e) => e[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1], lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const X = (t) => pad + ((t - x0) / (x1 - x0 || 1)) * (W - 2 * pad), Y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
    const pts = eq.map((e) => `${X(e[0]).toFixed(1)},${Y(e[1]).toFixed(1)}`);
    const split = P[1] ? X(P[2].from) : null;
    const up = ys[ys.length - 1] >= ys[0], col = up ? "var(--up)" : "var(--down)";
    $("#eqChart").innerHTML = `<defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${col}" stop-opacity=".32"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${Y(ys[0])}" y2="${Y(ys[0])}" stroke="var(--line)" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>
      ${split ? `<line x1="${split}" x2="${split}" y1="0" y2="${H}" stroke="var(--muted)" stroke-opacity=".5" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>` : ""}
      <polygon points="${pts[0].split(",")[0]},${H} ${pts.join(" ")} ${pts[pts.length - 1].split(",")[0]},${H}" fill="url(#eqFill)"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    $("#eqAxis").innerHTML = `<span>${my(x0)} · ${fmtInt(ys[0])}</span>${split ? `<span>split ${my(P[2].from)}</span>` : ""}<span>${my(x1)} · <b class="${cls(ys[ys.length - 1] - ys[0])}">${fmtInt(ys[ys.length - 1])}</b></span>`;
  } else { $("#eqChart").innerHTML = ""; $("#eqAxis").innerHTML = ""; }

  // theo năm: thanh ngang
  const maxAbs = Math.max(1, ...A.years.map((y) => Math.abs(y.pnl)));
  $("#resYears").innerHTML = A.years.map((y) => `<div class="yr">
      <span class="y">${y.year}</span>
      <span class="bar"><i class="${y.pnl >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(y.pnl) / maxAbs * 100).toFixed(1)}%"></i></span>
      <b class="${cls(y.pnl)}">${sign(y.pnl, 0)}</b>
      <small>${y.trades} · PF ${fmt(y.pf)}</small></div>`).join("") || `<p class="hint">No trades</p>`;

  // lý do thoát: thanh tỉ lệ + chú thích
  const names = { stop_loss: "Stop", trailing: "Trail", take_profit: "TP", time: "Time", exit_signal: "Channel", end: "Open at end" };
  const reasons = Object.entries(r.exitReasons), tot = reasons.reduce((a, [, v]) => a + v, 0) || 1;
  $("#resExitBar").innerHTML = reasons.map(([k, v]) => `<i class="x-${k}" style="flex:${v}"></i>`).join("");
  $("#resExits").innerHTML = reasons.map(([k, v]) => `<span class="chip"><i class="dot x-${k}"></i>${names[k] || k} ${v} · ${fmt(v / tot * 100, 0)}%</span>`).join("")
    || `<span class="hint">No trades</span>`;

  // bảng giai đoạn
  const row = (label, f) => `<tr><td>${label}</td>${P.map((p) => `<td>${f(p)}</td>`).join("")}</tr>`;
  $("#resPeriods").innerHTML = `<thead><tr><th></th>${P.map((p) => `<th>${p.name}<br><small>${my(p.from)}–${my(p.to)}</small></th>`).join("")}</tr></thead><tbody>
    ${row("Return", (p) => `<b class="${cls(p.profitPct)}">${sign(p.profitPct)}%</b>`)}
    ${row("CAGR", (p) => `<span class="${cls(p.cagrPct)}">${sign(p.cagrPct)}%</span>`)}
    ${row("Max DD", (p) => `${fmt(p.maxDDPct, 1)}%`)}
    ${row("PF", (p) => fmt(p.profitFactor))}
    ${row("Trades", (p) => `${p.trades} <small>${p.long}L/${p.short}S</small>`)}
    ${row("Win rate", (p) => `${fmt(p.winrate * 100, 1)}%`)}
    ${row(r.portfolio ? "Buy &amp; hold (avg)" : "Buy &amp; hold", (p) => `<span class="${cls(p.marketPct)}">${sign(p.marketPct)}%</span>`)}</tbody>`;

  // lệnh gần nhất
  const px = (v) => fmt(v, v >= 100 ? 1 : v >= 1 ? 3 : 5);
  $("#resTrades").innerHTML = r.trades.slice(0, 100).map((x) => `<div class="tr">
      <span class="side ${x.dir === 1 ? "long" : "short"}">${x.dir === 1 ? "L" : "S"}</span>
      <span class="tmain"><b>${x.pair ? `${esc(x.pair.replace(/USDT$/, ""))} ` : ""}${px(x.entry)} → ${px(x.exit)}</b><small>${new Date(x.exitT).toISOString().slice(0, 16).replace("T", " ")} · ${names[x.reason] || x.reason}</small></span>
      <b class="${cls(x.pnl)}">${sign(x.pnl, 2)}</b></div>`).join("");
}

async function openReplayView() {
  const run = state.lastRun, ds = state.dataset;
  if (!run || !ds) return;
  if (!run.replay.length) { toast("No trades to replay.", "warn"); return; }
  const src = ds.candles;
  const base = run.tf === ds.meta.tf ? src : resample(src, run.tf);
  // chỉ giữ khoảng thời gian đã backtest
  let a = 0; while (a < base.t.length && base.t[a] < run.range[0]) a++;
  let b = base.t.length; while (b > a && base.t[b - 1] > run.range[1]) b--;
  const cut = (k) => Array.prototype.slice.call(base[k], a, b);
  const bars = { t: cut("t"), o: cut("o"), h: cut("h"), l: cut("l"), c: cut("c") };
  const R = await import("./replay.js");
  R.openReplay({ bars, trades: run.replay, wallet: run.wallet, tfMs: TF_MS[run.tf], fmt, sign });
}

// ============================================================== hub (máy chủ nhà)
// Chạy trên hub (bot/hub): nến lấy từ máy chủ, thêm tab Live và nút gửi tham số sang bot.
async function setupHub() {
  const h = await Data.hubInfo();
  if (!h) return;
  state.hub = h;
  const f = h.features || {};
  if (f.data) {
    const sets = h.datasets.filter((d) => d.count > 0);
    const hint = $("#hubHint");
    hint.hidden = !sets.length;
    hint.textContent = `Home server has ${sets.map((d) => `${d.symbol} ${d.tf}`).join(", ")} ready — Download copies it from there in seconds.`;
  }
  if (f.live) {
    TABS.push("live");
    $(".tabbar [data-tab=live]").hidden = false;
    state.live = createLive({ root: $("#liveBox"), esc, fmt, sign, cls });
  }
  if (f.tune) {
    $("#botCard").hidden = false;
    // khuôn tham số theo chiến lược bot đang chạy (/api/hub .strategy; chắc hơn thì /api/tune/schema .strategy)
    state.botStrategy = h.strategy || null;
    fetch("/api/tune/schema", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.strategy) state.botStrategy = j.strategy; })
      .catch(() => {}).finally(refreshBotFit);
  }
}

function refreshBotFit() {
  if (!state.hub?.features?.tune) return;
  const bot = state.botStrategy || undefined;
  $("#botHint").textContent = `Send these thresholds to the running ${bot || "bot"}. Only the numbers change — the bot's logic stays the same; the strategy has to follow the bot's template (load the "${bot === "DonchianRevert" ? "DonchianRevert" : "TrendBreakout"}" preset to start). An open trade keeps its initial stop (1R); exits switch to the new values right away.`;
  let msg = "";
  try { toBotParams(state.strategy, bot); } catch (e) { msg = `Can't send this strategy: ${e.message}.`; }
  $("#botFit").textContent = msg;
  $("#btnSendBot").disabled = !!msg;
  $("#btnFromBot").disabled = !!msg;
}

// Nạp tham số bot đang chạy vào chiến lược hiện tại, để backtest đúng bộ số bot dùng (preset là giá trị mặc định).
async function loadBotValues() {
  try {
    const sch = await (await fetch("/api/tune/schema", { cache: "no-store" })).json();
    if (!sch.live) throw new Error("the bot isn't answering");
    state.botStrategy = sch.strategy || state.botStrategy;
    loadStrategy(fromBotParams(state.strategy, sch.live, state.botStrategy || undefined));
    toast("Loaded the bot's current values. Tap Run to backtest them.", "ok");
  } catch (e) { toast(`Can't load the bot's values: ${e.message}`, "err"); }
}

async function sendToBot() {
  let live = null;
  try {
    const sch = await (await fetch("/api/tune/schema", { cache: "no-store" })).json();
    live = sch.live; state.botStrategy = sch.strategy || state.botStrategy;
  } catch { /* vẫn cho gửi theo khuôn đã biết */ }
  let params;
  try { ({ params } = toBotParams(state.strategy, state.botStrategy || undefined)); } catch (e) { toast(e.message, "err"); return; }
  const changes = Object.entries(params).filter(([k, v]) => !live || live[k] !== v)
    .map(([k, v]) => `${k}: ${live ? `${live[k]} → ` : ""}${v}`);
  if (!changes.length) { toast("The bot already runs these values.", "ok"); return; }
  const tested = state.lastRun?.key === JSON.stringify(state.strategy) ? ""
    : "\n\n⚠ You haven't backtested exactly these values yet (tap Run first).";
  if (!confirm(`Send to the bot?\n\n${changes.join("\n")}${tested}`)) return;
  const btn = $("#btnSendBot"); btn.disabled = true;
  try {
    const r = await fetch("/api/tune/apply", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    toast(j.reloaded ? "Sent. The bot reloaded with the new values." : j.message, j.reloaded ? "ok" : "warn");
  } catch (e) {
    toast(`Send failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false; refreshBotFit();
  }
}

// ============================================================== init
async function init() {
  document.querySelectorAll(".tabbar [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#btnRun").addEventListener("click", runBacktest);
  $("#btnReplay").addEventListener("click", openReplayView);
  enableSwipe();
  hideTabbarWithKeyboard();

  // data
  $("#apiBase").value = store.get("apiBase", "");
  $("#apiBase").addEventListener("change", (e) => store.set("apiBase", e.target.value.trim()));
  ["#dlTf", "#dlFrom"].forEach((s) => $(s).addEventListener("change", dlHint)); dlHint();
  $("#btnDownload").addEventListener("click", () => startDownload({
    market: $("#dlMarket").value, symbol: $("#dlSymbol").value.trim().toUpperCase(), tf: $("#dlTf").value,
    from: Date.parse($("#dlFrom").value) || Date.UTC(2021, 0, 1),
  }));
  $("#btnCancel").addEventListener("click", () => state.abort?.abort());
  $("#btnTest").addEventListener("click", async () => {
    try {
      const r = await Data.testConnection($("#dlMarket").value, $("#apiBase").value.trim() || undefined);
      toast(r.ok ? `Binance reachable (${r.via}, ${r.ms} ms) — Download should work.` : "Binance returned no data.", r.ok ? "ok" : "warn");
    } catch (e) {
      toast(`Can't reach Binance: ${e.message}. Try a proxy or CSV (Advanced).`, "err");
    }
  });
  $("#dsList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    const meta = (await Data.listDatasets()).find((m) => m.id === id);
    if (b.dataset.act === "use") await useDataset(id);
    if (b.dataset.act === "update") await startDownload({ market: meta.market, symbol: meta.symbol, tf: meta.tf, from: meta.first });
    if (b.dataset.act === "del" && confirm(`Delete ${id}?`)) { await Data.deleteDataset(id); await refreshDatasets(); }
    if (b.dataset.act === "csv") {
      const d = await Data.loadDataset(id);
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([Data.exportCsv(d.candles)], { type: "text/csv" })), download: `${id.replaceAll(":", "_")}.csv` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  });
  $("#csvFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await Data.importCsv(await f.text(), { market: $("#csvMarket").value, symbol: $("#csvSymbol").value.trim(), tf: $("#csvTf").value });
      toast(`Imported ${fmtInt(r.count)} candles.`); await useDataset(r.id);
    } catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  });

  // strategy
  const names = await fetch("presets/index.json").then((r) => r.json()).catch(() => []);
  state.presets = await Promise.all(names.map((n) => fetch(`presets/${n}`).then((r) => r.json())));
  state.strategy = normalize(store.get("currentStrategy", null) || state.presets[0] || { name: "New strategy" });
  refreshPick(); renderStrategy();
  $("#stPick").addEventListener("change", (e) => {
    const v = e.target.value; if (!v) return;
    loadStrategy(v.startsWith("p:") ? state.presets[+v.slice(2)] : saved()[v.slice(2)]);
    e.target.value = "";
  });
  $("#stName").addEventListener("change", (e) => { state.strategy.name = e.target.value.trim() || "Strategy"; persistCurrent(); });
  $("#stTf").addEventListener("change", (e) => { state.strategy.tradeTf = e.target.value; persistCurrent(); refreshTfOptions(); });
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
    state.strategy[b.dataset.add].push({ ind: "rsi", params: { n: 14 }, op: b.dataset.add === "long" ? "<=" : ">=", value: b.dataset.add === "long" ? 30 : 70 });
    persistCurrent(); renderConds();
  }));
  $("#exitFields").addEventListener("change", (e) => { const k = e.target.dataset.exit; if (k) { state.strategy.exit[k] = Number(e.target.value); persistCurrent(); } });
  $("#exitFields").addEventListener("change", (e) => {
    const k = e.target.dataset.acc; if (!k) return;
    state.strategy.account[k] = k === "fee" || k === "slippage" ? Number(e.target.value) / 100 : Number(e.target.value); persistCurrent();
  });
  $("#btnSave").addEventListener("click", () => {
    const all = saved(); all[state.strategy.name] = clone(state.strategy); store.set("strategies", all); refreshPick();
    toast(`Saved "${state.strategy.name}".`);
  });
  $("#btnDelete").addEventListener("click", () => {
    const all = saved(); if (!all[state.strategy.name]) { toast("Not saved yet.", "warn"); return; }
    if (!confirm(`Delete "${state.strategy.name}"?`)) return;
    delete all[state.strategy.name]; store.set("strategies", all); refreshPick();
  });
  $("#btnExport").addEventListener("click", () => {
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([JSON.stringify(state.strategy, null, 2)], { type: "application/json" })),
      download: `${state.strategy.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("#importJson").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { loadStrategy(JSON.parse(await f.text())); toast("Imported."); } catch (err) { toast(`Invalid file: ${err.message}`, "err"); }
    e.target.value = "";
  });

  $("#btnSendBot").addEventListener("click", sendToBot);
  $("#btnFromBot").addEventListener("click", loadBotValues);
  setupHub();

  // nhiều coin chung tài khoản
  const savePort = () => store.set("portfolio", state.portfolio);
  $("#portCoins").addEventListener("change", (e) => {
    const sym = e.target.dataset.coin; if (!sym) return;
    const set = new Set(state.portfolio.coins);
    if (e.target.checked) set.add(sym); else set.delete(sym);
    state.portfolio.coins = [...set]; savePort();
  });
  $("#portMax").addEventListener("change", (e) => { state.portfolio.maxOpen = Math.max(1, Math.round(Number(e.target.value) || 5)); e.target.value = state.portfolio.maxOpen; savePort(); });
  $("#portHalt").addEventListener("change", (e) => { state.portfolio.halt = e.target.checked; savePort(); });
  $("#btnRunPort").addEventListener("click", runPortfolio);
  $("#btnDlCoins").addEventListener("click", downloadBotCoins);

  await refreshDatasets();
  if (state.activeId) await useDataset(state.activeId).catch(() => refreshDatasets());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
