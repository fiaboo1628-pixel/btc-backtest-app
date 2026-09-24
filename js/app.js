import * as Data from "./data.js";
import { CATALOG, CATALOG_BY_ID, paramsWithDefaults } from "./catalog.js";
import { OPS } from "./rules.js";
import { TF_MS, TF_LIST } from "./timeframes.js";
import { DEFAULT_EXIT, DEFAULT_ACCOUNT } from "./engine.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 2) => (n == null || !Number.isFinite(n)) ? "–" : n.toLocaleString("vi-VN", { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (n, d = 1) => (n > 0 ? "+" : "") + fmt(n, d);
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const day = (t) => new Date(t).toISOString().slice(0, 10);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bộ nhớ trình duyệt bị chặn */ } },
};
function toast(text, kind = "ok") {
  const el = $("#toast");
  el.innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : "";
  if (text) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ============================================================== trạng thái
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

// ============================================================== DỮ LIỆU
function dlHint() {
  const tf = $("#dlTf").value, from = Date.parse($("#dlFrom").value) || Date.now();
  const n = Math.max(0, (Date.now() - from) / TF_MS[tf]);
  const reqs = Math.ceil(n / 1000);
  const mb = (n * 6 * 8) / 1e6;
  $("#dlHint").textContent = `≈ ${Math.round(n).toLocaleString("vi-VN")} nến · ${reqs} lần gọi API · ~${fmt(reqs * 0.14 / 60, 1)} phút · ~${fmt(mb, 0)} MB`
    + (tf === "1m" && n > 300000 ? " — khung 1m nên tải tối đa khoảng 6 tháng." : "");
}

async function refreshDatasets() {
  const list = (await Data.listDatasets()).sort((a, b) => a.id.localeCompare(b.id));
  const box = $("#dsList");
  if (!list.length) { box.innerHTML = `<p class="note">Chưa có dữ liệu. Tải ở trên hoặc nhập CSV.</p>`; }
  else {
    box.innerHTML = list.map((m) => `
      <div class="item ${m.id === state.activeId ? "active" : ""}" data-id="${esc(m.id)}">
        <b>${esc(m.symbol)} · ${esc(m.tf)} · ${m.market === "futures" ? "Futures" : "Spot"}</b>
        <span class="note">${day(m.first)} → ${day(m.last)} · ${m.count.toLocaleString("vi-VN")} nến${m.funding?.length ? ` · ${m.funding.length} mốc funding` : ""}</span>
        <div class="row">
          <button class="btn sm ${m.id === state.activeId ? "primary" : ""}" data-act="use" type="button">${m.id === state.activeId ? "Đang dùng" : "Dùng"}</button>
          <button class="btn sm" data-act="update" type="button">Cập nhật</button>
          <button class="btn sm" data-act="csv" type="button">Xuất CSV</button>
          <button class="btn sm danger" data-act="del" type="button">Xoá</button>
        </div>
      </div>`).join("");
  }
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    $("#storageInfo").textContent = `Đang dùng ${fmt((e.usage || 0) / 1e6, 1)} MB bộ nhớ trình duyệt.`;
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
  $("#dsLabel").textContent = m ? `${m.symbol} ${m.tf} ${m.market === "futures" ? "Futures" : "Spot"} · ${day(m.first)} → ${day(m.last)}` : "Chưa chọn dữ liệu";
}

async function startDownload(opts) {
  const ctl = new AbortController();
  state.abort = ctl;
  $("#btnDownload").disabled = true; $("#btnCancel").hidden = false;
  const prog = $("#dlProg"); prog.classList.remove("hidden");
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const r = await Data.download({
      ...opts, apiBase: $("#apiBase").value.trim() || undefined, signal: ctl.signal,
      onProgress: ({ done, total, phase }) => {
        prog.firstElementChild.style.width = `${Math.min(100, (done / total) * 100)}%`;
        $("#dlStatus").textContent = `Đang tải ${phase}: ${done}/${total}`;
      },
    });
    $("#dlStatus").textContent = "";
    toast(`Xong: thêm ${r.added.toLocaleString("vi-VN")} nến, tổng ${r.count.toLocaleString("vi-VN")} nến.`);
    await useDataset(r.id);
  } catch (e) {
    $("#dlStatus").textContent = "";
    toast(e.name === "AbortError" ? "Đã dừng tải." : `Lỗi tải dữ liệu: ${e.message}${e.message.startsWith("Failed to fetch") || e.message.includes("NetworkError") ? "\nCó thể trình duyệt không được phép gọi Binance trực tiếp (CORS) — thử \"Kiểm tra kết nối\" hoặc dùng proxy." : ""}`, "err");
  } finally {
    prog.classList.add("hidden"); $("#btnDownload").disabled = false; $("#btnCancel").hidden = true; state.abort = null;
  }
}

// ============================================================== CHIẾN LƯỢC
const clone = (x) => JSON.parse(JSON.stringify(x));
function normalize(s) {
  return {
    name: s.name || "Chiến lược", description: s.description || "", tradeTf: s.tradeTf || "15m",
    long: s.long || [], short: s.short || [],
    exit: { ...DEFAULT_EXIT, ...s.exit }, account: { ...DEFAULT_ACCOUNT, ...s.account },
  };
}
function saved() { return store.get("strategies", {}); }
function persistCurrent() { store.set("currentStrategy", state.strategy); }

function refreshPick() {
  const mine = saved();
  $("#stPick").innerHTML = `<option value="">— chọn —</option>
    <optgroup label="Mẫu có sẵn">${state.presets.map((p, i) => `<option value="p:${i}">${esc(p.name)}</option>`).join("")}</optgroup>
    ${Object.keys(mine).length ? `<optgroup label="Đã lưu">${Object.keys(mine).map((n) => `<option value="s:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}`;
}

function refreshTfOptions() {
  const minMs = TF_MS[state.dataset?.meta.tf || "1m"];
  const opts = TF_LIST.filter((tf) => TF_MS[tf] >= minMs);
  const cur = state.strategy.tradeTf;
  $("#stTf").innerHTML = opts.map((tf) => `<option ${tf === cur ? "selected" : ""}>${tf}</option>`).join("");
  $("#tfNote").textContent = state.dataset
    ? (TF_MS[cur] < minMs ? `Dữ liệu đang dùng là khung ${state.dataset.meta.tf}: không chạy được khung ${cur}.` : `Khung lớn hơn ${state.dataset.meta.tf} được ghép tự động từ dữ liệu đã tải.`)
    : "Chưa chọn dữ liệu.";
  renderConds();
}

function renderStrategy() {
  const s = state.strategy;
  $("#stName").value = s.name;
  refreshTfOptions();
  const exitDefs = [
    ["rAtr", "1R = ? × ATR(14)", 0.5, 10, 0.1], ["trailStartR", "Kích hoạt trailing tại (R)", 0.5, 10, 0.1],
    ["trailDistR", "Khoảng trailing (R)", 0.1, 5, 0.1], ["maxHoldBars", "Giữ tối đa (nến, 0 = không)", 0, 5000, 1],
  ];
  $("#exitFields").innerHTML = exitDefs.map(([k, label, min, max, st]) =>
    `<label>${label}<input type="number" data-exit="${k}" min="${min}" max="${max}" step="${st}" value="${s.exit[k]}" inputmode="decimal"></label>`).join("");
  const accDefs = [
    ["wallet", "Vốn ban đầu (USDT)", 10, 1e9, 1], ["riskPct", "Rủi ro mỗi lệnh (% vốn)", 0.05, 10, 0.05],
    ["maxLev", "Đòn bẩy tối đa", 1, 50, 1], ["fee", "Phí mỗi chiều (%)", 0, 1, 0.001],
  ];
  $("#accFields").innerHTML = accDefs.map(([k, label, min, max, st]) =>
    `<label>${label}<input type="number" data-acc="${k}" min="${min}" max="${max}" step="${st}" value="${k === "fee" ? +(s.account.fee * 100).toFixed(4) : s.account[k]}" inputmode="decimal"></label>`).join("");
}

function renderConds() {
  for (const side of ["long", "short"]) {
    const box = $(side === "long" ? "#condLong" : "#condShort");
    box.innerHTML = "";
    state.strategy[side].forEach((cond, i) => box.appendChild(condEl(side, i, cond)));
  }
  $("#shortNote").textContent = state.dataset?.meta.market === "spot"
    ? "Dữ liệu Spot: backtest vẫn tính Short như futures để tham khảo."
    : "Để trống = không đánh Short.";
}

function condEl(side, i, cond) {
  const el = $("#condTpl").content.firstElementChild.cloneNode(true);
  const def = CATALOG_BY_ID[cond.ind];
  const groups = [...new Set(CATALOG.map((x) => x.group))];
  $(".c-ind", el).innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">${CATALOG.filter((x) => x.group === g)
    .map((x) => `<option value="${x.id}" ${x.id === cond.ind ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>`).join("");
  const params = paramsWithDefaults(cond.ind, cond.params);
  $(".c-params", el).innerHTML = def.params.map((p) =>
    `<label>${esc(p.label)}<input type="number" data-p="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${params[p.key]}" inputmode="decimal"></label>`).join("");
  const minMs = Math.max(TF_MS[state.strategy.tradeTf], TF_MS[state.dataset?.meta.tf || "1m"]);
  $(".c-tf", el).innerHTML = `<option value="">= GD</option>` + TF_LIST.filter((tf) => TF_MS[tf] > minMs)
    .map((tf) => `<option ${tf === cond.tf ? "selected" : ""}>${tf}</option>`).join("");
  $(".c-op", el).innerHTML = Object.entries(OPS).map(([k, o]) => `<option value="${k}" ${k === cond.op ? "selected" : ""}>${o.label}</option>`).join("");
  const [lo, hi, st] = def.range;
  const val = $(".c-val", el), rng = $(".c-range", el);
  val.value = cond.value; rng.min = lo; rng.max = hi; rng.step = st; rng.value = cond.value;
  $(".c-help", el).textContent = def.help;
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
  val.addEventListener("change", () => { upd((c) => { c.value = Number(val.value); }); rng.value = val.value; });
  rng.addEventListener("input", () => { val.value = rng.value; upd((c) => { c.value = Number(rng.value); }); });
  $(".c-del", el).addEventListener("click", () => { state.strategy[side].splice(i, 1); persistCurrent(); renderConds(); });
  return el;
}

function loadStrategy(s) {
  state.strategy = normalize(clone(s));
  persistCurrent(); renderStrategy();
}

// ============================================================== KẾT QUẢ
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
  if (!state.dataset) { showTab("data"); toast("Chưa có dữ liệu: tải hoặc chọn dữ liệu trước.", "err"); return; }
  const s = state.strategy;
  if (!s.long.length && !s.short.length) { showTab("strategy"); toast("Chiến lược chưa có điều kiện nào.", "err"); return; }
  showTab("result");
  const n = attempts();
  $("#attemptWarn").innerHTML = n >= 15
    ? `<div class="msg warn">Đã thử ${n} biến thể của "${esc(s.name)}". Càng thử nhiều, kết quả đẹp càng dễ là do may mắn — hãy tin Giai đoạn 2 và dry-run hơn là con số tổng.</div>` : "";
  const btn = $("#btnRun"), label = $("#btnRun span"); btn.disabled = true; label.textContent = "Đang chạy";
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
  btn.disabled = false; label.textContent = "Chạy";
  if (!res.ok) { toast(res.error, "err"); return; }
  toast("");
  renderResult(res, performance.now() - t0);
}

function renderResult(r, ms) {
  $("#resBox").hidden = false;
  requestAnimationFrame(() => $("#resBox").scrollIntoView({ behavior: "smooth", block: "start" }));
  const s = state.strategy;
  $("#resMeta").textContent = `${s.name} · ${s.tradeTf} · ${r.candles.toLocaleString("vi-VN")} nến · tín hiệu ${r.signals.long} Long / ${r.signals.short} Short · ${fmt(ms / 1000, 1)} giây`;
  const P = r.periods;
  const row = (label, f) => `<tr><td>${label}</td>${P.map((p) => `<td>${f(p)}</td>`).join("")}</tr>`;
  const my = (t) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`; };
  $("#resPeriods").innerHTML = `<thead><tr><th></th>${P.map((p) => `<th>${p.name.replace("Giai đoạn", "GĐ")}<br><small>${my(p.from)}–${my(p.to)}</small></th>`).join("")}</tr></thead><tbody>
    ${row("Lợi nhuận", (p) => `<b class="${cls(p.profitPct)}">${sign(p.profitPct)}%</b>`)}
    ${row("Mỗi năm", (p) => `<span class="${cls(p.cagrPct)}">${sign(p.cagrPct)}%</span>`)}
    ${row("Sụt giảm", (p) => `${fmt(p.maxDDPct, 1)}%`)}
    ${row("Profit factor", (p) => fmt(p.profitFactor))}
    ${row("Số lệnh", (p) => p.trades)}
    ${row("Long / Short", (p) => `${p.long} / ${p.short}`)}
    ${row("Tỉ lệ thắng", (p) => `${fmt(p.winrate * 100, 1)}%`)}
    ${row("Giá tài sản", (p) => `<span class="${cls(p.marketPct)}">${sign(p.marketPct)}%</span>`)}</tbody>`;
  // đường vốn
  const eq = r.equity, W = 600, H = 160, pad = 6;
  if (eq.length > 1) {
    const xs = eq.map((e) => e[0]), ys = eq.map((e) => e[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1], lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const X = (t) => pad + ((t - x0) / (x1 - x0 || 1)) * (W - 2 * pad), Y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
    const pts = eq.map((e) => `${X(e[0]).toFixed(1)},${Y(e[1]).toFixed(1)}`).join(" ");
    const split = P[1] ? X(P[2].from) : null;
    const col = ys[ys.length - 1] >= ys[0] ? "var(--up)" : "var(--down)";
    $("#eqChart").innerHTML = `<line x1="0" x2="${W}" y1="${Y(ys[0])}" y2="${Y(ys[0])}" stroke="var(--line)" stroke-dasharray="4 4"/>
      ${split ? `<line x1="${split}" x2="${split}" y1="0" y2="${H}" stroke="var(--muted)" stroke-dasharray="3 5"/>` : ""}
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  } else $("#eqChart").innerHTML = "";
  $("#resYears").innerHTML = `<thead><tr><th>Năm</th><th>Lệnh</th><th>Lãi/lỗ</th><th>PF</th></tr></thead><tbody>${P[0].years
    .map((y) => `<tr><td>${y.year}</td><td>${y.trades}</td><td class="${cls(y.pnl)}">${sign(y.pnl, 0)}</td><td>${fmt(y.pf)}</td></tr>`).join("")}</tbody>`;
  const names = { stop_loss: "dính stoploss", trailing: "trailing", time: "hết thời gian", end: "đóng cuối kỳ" };
  $("#resExits").textContent = Object.entries(r.exitReasons).map(([k, v]) => `${names[k] || k}: ${v}`).join(" · ") || "Không có lệnh.";
  $("#resTrades").innerHTML = `<thead><tr><th>Ra</th><th>Chiều</th><th>Vào</th><th>Ra</th><th>Lãi/lỗ</th><th>Lý do</th></tr></thead><tbody>${r.trades.slice(0, 100)
    .map((x) => `<tr><td>${new Date(x.exitT).toISOString().slice(0, 16).replace("T", " ")}</td><td class="${x.dir === 1 ? "up" : "down"}">${x.dir === 1 ? "Long" : "Short"}</td>
      <td>${fmt(x.entry, 1)}</td><td>${fmt(x.exit, 1)}</td><td class="${cls(x.pnl)}">${sign(x.pnl, 2)}</td><td>${names[x.reason] || x.reason}</td></tr>`).join("")}</tbody>`;
}

// ============================================================== khởi động
async function init() {
  document.querySelectorAll(".tabbar [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#btnRun").addEventListener("click", runBacktest);
  enableSwipe();
  hideTabbarWithKeyboard();

  // dữ liệu
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
      toast(r.ok ? `Kết nối Binance được (${r.ms} ms).` : "Binance trả về dữ liệu rỗng.", r.ok ? "ok" : "warn");
    } catch (e) {
      toast(`Không gọi được Binance: ${e.message}\nNếu là lỗi mạng/CORS, cần dùng proxy (mục Nâng cao) hoặc nhập CSV.`, "err");
    }
  });
  $("#dsList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    const meta = (await Data.listDatasets()).find((m) => m.id === id);
    if (b.dataset.act === "use") await useDataset(id);
    if (b.dataset.act === "update") await startDownload({ market: meta.market, symbol: meta.symbol, tf: meta.tf, from: meta.first });
    if (b.dataset.act === "del" && confirm(`Xoá dữ liệu ${id}?`)) { await Data.deleteDataset(id); await refreshDatasets(); }
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
      toast(`Đã nhập ${r.count.toLocaleString("vi-VN")} nến.`); await useDataset(r.id);
    } catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  });

  // chiến lược
  const names = await fetch("presets/index.json").then((r) => r.json()).catch(() => []);
  state.presets = await Promise.all(names.map((n) => fetch(`presets/${n}`).then((r) => r.json())));
  state.strategy = normalize(store.get("currentStrategy", null) || state.presets[0] || { name: "Chiến lược mới" });
  refreshPick(); renderStrategy();
  $("#stPick").addEventListener("change", (e) => {
    const v = e.target.value; if (!v) return;
    loadStrategy(v.startsWith("p:") ? state.presets[+v.slice(2)] : saved()[v.slice(2)]);
    e.target.value = "";
  });
  $("#stName").addEventListener("change", (e) => { state.strategy.name = e.target.value.trim() || "Chiến lược"; persistCurrent(); });
  $("#stTf").addEventListener("change", (e) => { state.strategy.tradeTf = e.target.value; persistCurrent(); refreshTfOptions(); });
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
    state.strategy[b.dataset.add].push({ ind: "rsi", params: { n: 14 }, op: b.dataset.add === "long" ? "<=" : ">=", value: b.dataset.add === "long" ? 30 : 70 });
    persistCurrent(); renderConds();
  }));
  $("#exitFields").addEventListener("change", (e) => { const k = e.target.dataset.exit; if (k) { state.strategy.exit[k] = Number(e.target.value); persistCurrent(); } });
  $("#accFields").addEventListener("change", (e) => {
    const k = e.target.dataset.acc; if (!k) return;
    state.strategy.account[k] = k === "fee" ? Number(e.target.value) / 100 : Number(e.target.value); persistCurrent();
  });
  $("#btnSave").addEventListener("click", () => {
    const all = saved(); all[state.strategy.name] = clone(state.strategy); store.set("strategies", all); refreshPick();
    toast(`Đã lưu "${state.strategy.name}".`);
  });
  $("#btnDelete").addEventListener("click", () => {
    const all = saved(); if (!all[state.strategy.name]) { toast("Chiến lược này chưa được lưu.", "warn"); return; }
    if (!confirm(`Xoá "${state.strategy.name}" khỏi danh sách đã lưu?`)) return;
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
    try { loadStrategy(JSON.parse(await f.text())); toast("Đã nhập chiến lược."); } catch (err) { toast(`File không hợp lệ: ${err.message}`, "err"); }
    e.target.value = "";
  });

  await refreshDatasets();
  if (state.activeId) await useDataset(state.activeId).catch(() => refreshDatasets());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
