import * as Data from "./data.js";
import { CATALOG, CATALOG_BY_ID, paramsWithDefaults } from "./catalog.js";
import { OPS } from "./rules.js";
import { TF_MS, TF_LIST, resample } from "./timeframes.js";
import { DEFAULT_EXIT, DEFAULT_ACCOUNT } from "./engine.js";

// Initialize Vercel Web Analytics
// thống kê truy cập (Vercel Analytics): tải không bắt buộc — lỗi/offline thì bỏ qua, app vẫn chạy
import("@vercel/analytics").then((m) => m.inject()).catch(() => {});

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
const state = {
  presets: [],
  strategy: null,
  activeId: store.get("activeDataset", null),
  dataset: null,          // {meta, candles, funding}
  abort: null,
};

// ============================================================== tabs
const TABS = ["data", "strategy", "result"];
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
function dlHint() {
  const tf = $("#dlTf").value, from = Date.parse($("#dlFrom").value) || Date.now();
  const n = Math.max(0, (Date.now() - from) / TF_MS[tf]);
  const reqs = Math.ceil(n / 1000);
  const mb = (n * 6 * 8) / 1e6;
  const secs = reqs * 0.14;
  $("#dlHint").textContent = `~${fmtInt(n)} candles · ${secs < 90 ? `${Math.ceil(secs)} s` : `${fmt(secs / 60, 1)} min`} · ${fmt(mb, 0)} MB`
    + (tf === "1m" && n > 300000 ? " · 1m: keep it under ~6 months" : "");
}

async function refreshDatasets() {
  const list = (await Data.listDatasets()).sort((a, b) => a.id.localeCompare(b.id));
  const box = $("#dsList");
  if (!list.length) { box.innerHTML = `<p class="hint">Nothing yet.</p>`; }
  else {
    box.innerHTML = list.map((m) => {
      const on = m.id === state.activeId;
      return `<div class="ds ${on ? "active" : ""}" data-id="${esc(m.id)}">
        <button class="ds-main" data-act="use" type="button" aria-pressed="${on}">
          <b>${esc(m.symbol)} ${esc(m.tf)} <span class="tag">${m.market === "futures" ? "F" : "S"}</span></b>
          <span class="hint">${day(m.first)} → ${day(m.last)} · ${fmtInt(m.count)}</span>
        </button>
        <button class="icon" data-act="update" type="button" aria-label="Update" title="Update">↻</button>
        <button class="icon" data-act="csv" type="button" aria-label="Export CSV" title="Export CSV">⤓</button>
        <button class="icon danger" data-act="del" type="button" aria-label="Delete" title="Delete">✕</button>
      </div>`;
    }).join("");
  }
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    $("#storageInfo").textContent = `${fmt((e.usage || 0) / 1e6, 1)} MB`;
  }
  if (!list.find((m) => m.id === state.activeId) && list.length) await useDataset(list[0].id);
  else if (!list.length) { state.activeId = null; state.dataset = null; updateDsLabel(); }
}

async function useDataset(id) {
  state.activeId = id; store.set("activeDataset", id);
  state.dataset = await Data.loadDataset(id);
  updateDsLabel(); refreshTfOptions(); await refreshDatasets();
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
function persistCurrent() { store.set("currentStrategy", state.strategy); }

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
    ["exit", "rAtr", "Stop (×ATR)", "1R = initial stop distance = this × ATR(14)", 0.5, 10, 0.1],
    ["exit", "trailStartR", "Trail at (R)", "Start trailing once profit reaches this many R (0 = no trailing)", 0, 10, 0.1],
    ["exit", "trailDistR", "Trail gap (R)", "Trailing stop distance from the high/low, in R", 0.1, 5, 0.1],
    ["exit", "tpR", "Take profit (R)", "Fixed take-profit at this many R (0 = off)", 0, 20, 0.1],
    ["exit", "maxHoldBars", "Max bars", "Close after this many bars (0 = off)", 0, 5000, 1],
    ["account", "wallet", "Capital", "Starting balance (USDT)", 10, 1e9, 1],
    ["account", "riskPct", "Risk %", "Balance lost if the initial stop is hit", 0.05, 10, 0.05],
    ["account", "maxLev", "Max lev", "Leverage cap", 1, 50, 1],
    ["account", "fee", "Fee %", "Per side", 0, 1, 0.001],
  ];
  $("#exitFields").innerHTML = defs.map(([g, k, label, tip, min, max, st]) => {
    const v = k === "fee" ? +(s.account.fee * 100).toFixed(4) : (s[g][k] ?? 0);
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
  const id = ++runId;
  const from = Date.parse($("#rFrom").value) || meta.first, to = $("#rTo").value ? Date.parse($("#rTo").value) : null;
  const split = Date.parse($("#rSplit").value) || null;
  const t0 = performance.now();
  const w = getWorker();
  const res = await new Promise((ok) => {
    const h = (e) => { if (e.data.id === id) { w.removeEventListener("message", h); ok(e.data); } };
    w.addEventListener("message", h);
    w.postMessage({ id, source: candles, sourceTf: meta.tf, funding: meta.market === "futures" ? funding : [], strategy: s, split, from, to });
  });
  btn.disabled = false; label.textContent = "Run";
  if (!res.ok) { toast(res.error, "err"); return; }
  toast("");
  state.lastRun = { replay: res.replay, range: res.range, tf: s.tradeTf, wallet: s.account?.wallet ?? 1000 };
  renderResult(res, performance.now() - t0);
}

function renderResult(r, ms) {
  $("#resBox").hidden = false;
  requestAnimationFrame(() => $("#resBox").scrollIntoView({ behavior: "smooth", block: "start" }));
  const s = state.strategy, P = r.periods, A = P[0];
  $("#resMeta").textContent = `${s.name} · ${s.tradeTf}${r.detailTf ? ` · exits on ${r.detailTf}` : ""} · ${fmtInt(r.candles)} bars · ${fmt(ms / 1000, 1)} s`;
  const ex = s.exit || {};
  $("#resWarn").textContent = !r.detailTf && ex.trailStartR > 0 && ex.trailDistR < 0.3
    ? `Trail gap ${ex.trailDistR}R on ${s.tradeTf} bars only is optimistic. Use smaller-TF data (e.g. 1m) for accurate exits.` : "";
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
  const names = { stop_loss: "Stop", trailing: "Trail", take_profit: "TP", time: "Time", end: "Open at end" };
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
    ${row("Buy &amp; hold", (p) => `<span class="${cls(p.marketPct)}">${sign(p.marketPct)}%</span>`)}</tbody>`;

  // lệnh gần nhất
  $("#resTrades").innerHTML = r.trades.slice(0, 100).map((x) => `<div class="tr">
      <span class="side ${x.dir === 1 ? "long" : "short"}">${x.dir === 1 ? "L" : "S"}</span>
      <span class="tmain"><b>${fmt(x.entry, 1)} → ${fmt(x.exit, 1)}</b><small>${new Date(x.exitT).toISOString().slice(0, 16).replace("T", " ")} · ${names[x.reason] || x.reason}</small></span>
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
      toast(r.ok ? `Binance OK · ${r.via} · ${r.ms} ms` : "Binance returned no data.", r.ok ? "ok" : "warn");
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
    state.strategy.account[k] = k === "fee" ? Number(e.target.value) / 100 : Number(e.target.value); persistCurrent();
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

  await refreshDatasets();
  if (state.activeId) await useDataset(state.activeId).catch(() => refreshDatasets());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
