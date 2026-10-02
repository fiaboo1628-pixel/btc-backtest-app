// Màn Backtest / Parameters: thay trang /tune/ cũ. Chỉnh tham số theo schema của hub, chạy backtest freqtrade ở LAB
// (/api/tune/backtest), xem kết quả theo năm / theo coin, lịch sử các lần thử, áp dụng cho bot sau khi xác nhận.
import { cls, fmt, isoDay, modeInfo, money, pct, signed, signedPct, dateTime } from "../format.js";
import { clampParam, diffParams, rangePresets, sameParams, timerange } from "../model.js";
import { card, confirm, errorBox, esc, loading, note, toast, $, $$ } from "../ui.js";
import { lineChart } from "../chart.js";

export const title = "Backtest";

const S = { schema: null, values: {}, bot: null, history: [], lastRun: null, polling: false, running: false, range: "all", wallet: 1000,
  from: "", to: "", resultMsg: "", resultKind: "err", topMsg: "", botErr: null };
let root = null, ctx = null, pollTimer = null, botTimer = null;

export function mount(el, c) {
  root = el; ctx = c;
  if (!ctx.store.hub?.features?.tune) {
    root.innerHTML = `<div class="cards">${card("", `<p>Hub chưa bật phần backtest / chỉnh tham số.</p>
      <p class="hint">Cần cả khối <code>lab</code> (freqtrade webserver) và <code>live</code> trong <code>bot/deploy/hub.json</code>, và hub chạy trong image freqtrade (xem log hub).</p>`)}</div>`;
    return;
  }
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  init();
}
export function unmount() {
  clearTimeout(pollTimer); clearInterval(botTimer); pollTimer = botTimer = null; S.polling = false;
  root?.removeEventListener("click", onClick); root?.removeEventListener("input", onInput); root?.removeEventListener("change", onChange);
  root = null;
}
export function refresh(what) { if (what === "visible") { refreshBot(); if (S.running) poll(); } else init(); }

async function init() {
  root.innerHTML = `<div class="cards">${card("", loading("Đang tải tham số của bot…"))}</div>`;
  if (!S.from) { const r = rangePresets()[0]; S.from = r.from; S.to = r.to; }
  try {
    S.schema = await ctx.api("/api/tune/schema");
  } catch (e) {
    root.innerHTML = `<div class="cards">${card("", errorBox(e, { retry: "schema", title: "Không tải được tham số" }))}</div>`;
    return;
  }
  // mở với tham số bot đang chạy: sửa vài tham số rồi "Áp dụng" không vô tình kéo tham số khác về mặc định
  if (!Object.keys(S.values).length) S.values = { ...(S.schema.live || S.schema.lab) };
  render();
  refreshBot(); botTimer = setInterval(refreshBot, 30000);
  loadHistory();
  const r = await ctx.api("/api/tune/backtest").catch(() => null);
  if (r?.running) { S.running = true; poll(); }
  else if (r?.status === "error") { S.resultMsg = r.message || "Backtest lỗi"; S.resultKind = "err"; paintResult(); }
  else if (r?.last) { S.lastRun = r.last; paintResult(); }
}

async function refreshBot() {
  try { S.bot = await ctx.api("/api/tune/live"); S.botErr = null; } catch (e) { S.botErr = e; }
  paintBot();
}

// ---------------------------------------------------------------- vẽ
const stepOf = (p) => (p.type === "int" ? 1 : Math.pow(10, -(p.decimals ?? 2)));

function paramHtml(p) {
  const id = `p_${p.name}`;
  if (p.type === "bool") {
    return `<div class="param" data-name="${esc(p.name)}"><div class="row"><label for="${id}">${esc(p.label)}</label>
      <span class="switch"><input type="checkbox" id="${id}" data-param="${esc(p.name)}"><span></span></span></div>
      <div class="help">${esc(p.help)}</div></div>`;
  }
  const st = stepOf(p);
  return `<div class="param" data-name="${esc(p.name)}"><div class="row"><label for="${id}">${esc(p.label)}</label>
      <input type="number" id="${id}" data-param="${esc(p.name)}" min="${p.min}" max="${p.max}" step="${st}" inputmode="decimal"></div>
    <div class="help">${esc(p.help)}</div>
    <input type="range" data-slider="${esc(p.name)}" min="${p.min}" max="${p.max}" step="${st}" aria-label="${esc(p.label)} slider">
    <div class="meta"><span>${p.min}</span><span>default ${p.type === "bool" ? "" : p.default}</span><span>${p.max}</span></div></div>`;
}

function render() {
  const { params, spaces } = S.schema;
  const sections = Object.entries(spaces).map(([space, t]) => {
    const list = params.filter((p) => p.space === space);
    return list.length ? card(t, list.map(paramHtml).join("")) : "";
  }).join("");
  const ranges = rangePresets();
  root.innerHTML = `<div class="cards">
    <div class="wide" id="topMsg"></div>
    ${card("Live bot", `<div id="botInfo">${loading("Đang hỏi bot…")}</div>`, { wide: true })}
    ${sections}
    ${card("Period & stake", `
      <div class="chips" role="group" aria-label="Preset periods">${ranges.map((r) => `<button class="chip" type="button" data-range="${r.id}" aria-pressed="${S.range === r.id}">${esc(r.label)}</button>`).join("")}</div>
      <div class="grid2">
        <label class="field">From <input type="date" id="dFrom" value="${esc(S.from)}"></label>
        <label class="field">To <span class="hint" style="margin:0">(trống = đến nay)</span> <input type="date" id="dTo" value="${esc(S.to)}"></label>
      </div>
      <label class="field" style="margin-top:8px">Stake (USDT) <input type="number" id="wallet" min="10" step="10" inputmode="numeric" value="${S.wallet}"></label>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" type="button" data-act="default" title="Đưa mọi tham số về mặc định của chiến lược">Defaults</button>
        <button class="btn sm" type="button" data-act="live" title="Lấy lại bộ tham số bot đang chạy">Load live</button>
      </div>`)}
    ${card("Result", `<div id="resultMsg"></div><div class="progress hidden" id="prog"><i></i></div><div id="result"><p class="hint">Chưa chạy lần nào trong phiên này. Chỉnh tham số rồi bấm <b>Run backtest</b>.</p></div>`, { wide: true, id: "resultBox" })}
    ${card("Recent runs", `<div id="hist"><p class="hint">Chưa có.</p></div>`, { wide: true, id: "histBox" })}
    <div class="actionbar wide">
      <button class="btn primary" id="btnRun" type="button">Run backtest</button>
      <button class="btn danger" id="btnApply" type="button">Apply to bot</button>
    </div>
  </div>`;
  syncInputs();
}

function syncInputs() {
  if (!root || !S.schema) return;
  for (const p of S.schema.params) {
    const div = $(`.param[data-name="${p.name}"]`, root);
    if (!div) continue;
    const v = S.values[p.name];
    if (p.type === "bool") $("input[type=checkbox]", div).checked = !!v;
    else { $("input[type=number]", div).value = v; $("input[type=range]", div).value = v; }
    div.classList.toggle("changed", v !== S.schema.live[p.name]);
  }
  const isLive = sameParams(S.schema.params, S.values, S.schema.live);
  const b = $("#btnApply", root);
  if (b) { b.disabled = isLive || S.running; b.textContent = isLive ? "Same as live" : "Apply to bot"; b.title = isLive ? "Bot đang dùng đúng bộ tham số này" : "Ghi tham số vào bot đang chạy (có hộp xác nhận)"; }
  const run = $("#btnRun", root);
  if (run) { run.disabled = S.running; run.textContent = S.running ? "Running…" : "Run backtest"; }
}

function paintBot() {
  const box = $("#botInfo", root);
  if (!box) return;
  if (S.botErr) { box.innerHTML = errorBox(S.botErr, { title: "Không hỏi được bot" }); return; }
  const s = S.bot;
  if (!s) return;
  if (!s.reachable) { box.innerHTML = note(`Hub không gọi được bot: ${s.error || ""}`, "err"); return; }
  const m = modeInfo(s.mode);
  const coins = (s.pairs || []).map((p) => `<span class="coinchip">${esc(p.split("/")[0])}</span>`).join("");
  box.innerHTML = `<dl class="info">
    <dt>Account</dt><dd><span class="pill ${m.cls}">${esc(m.name)}</span> <span class="hint">${esc(m.help)}</span></dd>
    <dt>Strategy</dt><dd>${esc(s.strategy)} · ${esc(s.timeframe)} · max ${esc(s.max_open_trades)} open · ${esc(s.state)}</dd>
    <dt>Pairs</dt><dd>${coins}</dd>
    <dt>Open</dt><dd>${esc(s.open_trades)} · P&L <span class="${cls(s.profit_pct)}">${signedPct(s.profit_pct)}</span></dd>
  </dl>
  <p class="hint">Backtest chạy bằng freqtrade trên máy chủ, đúng các coin và nến trên, khớp lệnh theo nến 15m. Nến có tới ngày nào: xem màn <a href="#data">Data</a>.</p>`;
}

function equity(r) {
  return lineChart(r.equity, { label: "Backtest equity", fmtY: (v) => money(v, r.stake_currency || "USDT", 0), fmtX: (v) => isoDay(v) });
}

function findBaseline(run) {
  return S.history.find((h) => h !== run && h.at !== run.at && h.timerange === run.timerange) || null;
}

function paintResult() {
  const msg = $("#resultMsg", root), box = $("#result", root), prog = $("#prog", root);
  if (!msg || !box) return;
  msg.innerHTML = note(S.resultMsg, S.resultKind);
  prog.classList.toggle("hidden", !S.running);
  if (S.resultKind === "err" && S.resultMsg) { box.innerHTML = ""; return; }   // không hiện kết quả cũ như thể là mới
  const run = S.lastRun;
  if (!run) return;
  const r = run.result, cur = r.stake_currency || "USDT";
  const prev = findBaseline(run);
  const delta = (k, d = 2) => (prev ? `<small class="${cls(r[k] - prev.result[k])}">${signed(r[k] - prev.result[k], d)} vs. prev</small>` : "");
  const ddDelta = prev ? `<small class="${cls(prev.result.max_dd_pct - r.max_dd_pct)}">${signed(r.max_dd_pct - prev.result.max_dd_pct, 1)} vs. prev</small>` : "";
  const k = (label, val, c = "", sub = "") => `<div class="kpi"><span class="kpi-label">${esc(label)}</span><b class="kpi-value ${c}">${val}</b>${sub}</div>`;
  const years = (r.years || []).map((y) => `<tr><td>${esc(y.year)}</td><td>${y.trades}</td><td class="${cls(y.profit_abs)}">${signed(y.profit_abs, 0)}</td><td>${y.profit_factor ? fmt(y.profit_factor) : "–"}</td></tr>`).join("");
  const pairs = (r.pairs || []).map((p) => `<tr><td>${esc(p.pair.split("/")[0])}</td><td>${p.trades}</td><td class="${cls(p.profit_abs)}">${signed(p.profit_abs, 0)}</td><td class="${cls(p.profit_pct)}">${signedPct(p.profit_pct)}</td><td>${p.profit_factor ? fmt(p.profit_factor) : "–"}</td><td>${p.trades ? pct(p.winrate_pct, 0) : "–"}</td></tr>`).join("");
  box.innerHTML = `
    <p class="hint">${esc(r.timerange)} · ${r.trades} lệnh (${r.trades_long ?? "–"} Long / ${r.trades_short ?? "–"} Short) · vốn thử ${money(run.wallet ?? S.wallet, cur, 0)}
      ${run.detail ? `· khớp lệnh theo nến ${esc(run.detail)}` : "· khớp lệnh theo nến tín hiệu"} · chạy lúc ${esc(dateTime(run.at))}</p>
    ${(run.warnings || []).length ? `<div class="msg warn">${run.warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="kpis three">
      ${k("Profit", signedPct(r.profit_pct), cls(r.profit_pct), delta("profit_pct"))}
      ${k("Max drawdown", pct(r.max_dd_pct, 1), "", ddDelta)}
      ${k("Profit factor", fmt(r.profit_factor), "", prev ? delta("profit_factor") : "")}
      ${k("Win rate", pct(r.winrate_pct, 1))}
      ${k("CAGR", signedPct(r.cagr_pct), cls(r.cagr_pct))}
      ${k("Market (avg)", signedPct(r.market_change_pct), cls(r.market_change_pct))}
    </div>
    ${equity(r)}
    <div class="tablewrap"><table><thead><tr><th>Year</th><th>Trades</th><th>P&L (${esc(cur)})</th><th>PF</th></tr></thead><tbody>${years || `<tr><td colspan="4" class="hint">Không có</td></tr>`}</tbody></table></div>
    ${pairs ? `<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Coin</th><th>Trades</th><th>P&L (${esc(cur)})</th><th>%</th><th>PF</th><th>Win</th></tr></thead><tbody>${pairs}</tbody></table></div>` : ""}
    <p class="hint">PF "–" = coin không có lệnh lỗ. Kết quả quá khứ không bảo đảm tương lai.</p>
    ${!sameParams(S.schema.params, run.params, S.values) ? note("Tham số trên form đã đổi sau lần chạy này — chạy lại trước khi áp dụng.", "warn") : ""}`;
}

function paintHistory() {
  const box = $("#hist", root);
  if (!box) return;
  if (!S.history.length) { box.innerHTML = `<p class="hint">Chưa có lần thử nào (hub nhớ 20 lần gần nhất, mất khi hub khởi động lại).</p>`; return; }
  box.innerHTML = S.history.map((x, i) => {
    const d = diffParams(S.schema.params, S.schema.live, x.params);
    return `<div class="hist"><div class="top"><span>${esc(x.result.timerange)} · ${esc(dateTime(x.at))}</span>
      <span><b class="${cls(x.result.profit_pct)}">${signedPct(x.result.profit_pct)}</b> · DD ${pct(x.result.max_dd_pct, 1)} · PF ${fmt(x.result.profit_factor)} · ${x.result.trades} trades</span></div>
      <div class="diff">${d.length ? esc(d.map((c) => `${c.label}: ${c.from} → ${c.to}`).join(" · ")) : "Giống tham số bot đang chạy"}</div>
      <div><button class="btn sm" type="button" data-hist="${i}" title="Nạp bộ tham số này lên form">Use params</button></div></div>`;
  }).join("");
}

// ---------------------------------------------------------------- sự kiện
function setVal(p, v) { S.values[p.name] = clampParam(p, v); syncInputs(); }
const paramOf = (name) => S.schema.params.find((p) => p.name === name);

function onInput(e) {
  const t = e.target;
  if (t.dataset.slider) { const p = paramOf(t.dataset.slider); S.values[p.name] = clampParam(p, t.value); const n = $(`input[type=number][data-param="${p.name}"]`, root); if (n) n.value = S.values[p.name]; syncInputs(); }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.param) { const p = paramOf(t.dataset.param); setVal(p, p.type === "bool" ? t.checked : t.value); }
  if (t.id === "dFrom" || t.id === "dTo") { S[t.id === "dFrom" ? "from" : "to"] = t.value; S.range = ""; $$("button[data-range]", root).forEach((c) => c.setAttribute("aria-pressed", "false")); }
  if (t.id === "wallet") { S.wallet = Math.max(10, Number(t.value) || 1000); t.value = S.wallet; }
}
function onClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.range) {
    const r = rangePresets().find((x) => x.id === b.dataset.range);
    S.range = r.id; S.from = r.from; S.to = r.to;
    $("#dFrom", root).value = r.from; $("#dTo", root).value = r.to;
    $$("button[data-range]", root).forEach((c) => c.setAttribute("aria-pressed", c.dataset.range === r.id));
  } else if (b.dataset.act === "default") {
    for (const p of S.schema.params) S.values[p.name] = p.default; syncInputs();
  } else if (b.dataset.act === "live") {
    S.values = { ...S.schema.live }; syncInputs();
  } else if (b.dataset.hist != null) {
    S.values = { ...S.history[Number(b.dataset.hist)].params }; syncInputs(); window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (b.id === "btnRun") runBacktest();
  else if (b.id === "btnApply") openConfirm();
}

// ---------------------------------------------------------------- backtest
async function runBacktest() {
  if (!S.from) { toast("Chọn ngày bắt đầu.", "err"); return; }
  S.resultMsg = ""; S.running = true; syncInputs(); paintResult();
  try {
    const r = await ctx.api("/api/tune/backtest", { method: "POST", body: { params: S.values, timerange: timerange(S.from, S.to), wallet: S.wallet } });
    if (r.warnings?.length) toast(r.warnings[0], "info", 6000);
    $("#resultBox", root)?.scrollIntoView({ behavior: "smooth", block: "start" });
    poll();
  } catch (e) {
    S.running = false; S.resultMsg = e.message + (e.hint ? ` — ${e.hint}` : ""); S.resultKind = "err"; syncInputs(); paintResult();
  }
}

async function poll() {
  if (S.polling || !root) return;
  S.polling = true;
  try {
    for (;;) {
      if (!root) return;
      const r = await ctx.api("/api/tune/backtest");
      const bar = $("#prog i", root);
      if (bar) bar.style.width = `${Math.round((r.progress || 0) * 100)}%`;
      if (r.running) {
        S.running = true; S.resultMsg = `Đang chạy: ${r.step || "…"} ${r.progress ? `(${Math.round(r.progress * 100)}%)` : ""}`; S.resultKind = "info"; paintResult(); syncInputs();
        await new Promise((ok) => { pollTimer = setTimeout(ok, 1500); });
        continue;
      }
      S.running = false;
      if (r.status === "error") { S.resultMsg = r.message || "Backtest lỗi"; S.resultKind = "err"; S.lastRun = null; }
      else { S.resultMsg = ""; if (r.last) { S.lastRun = r.last; S.lastRun.wallet ??= S.wallet; } loadHistory(); }
      break;
    }
  } catch (e) { S.running = false; S.resultMsg = e.message; S.resultKind = "err"; }
  S.polling = false;
  paintResult(); syncInputs();
}

async function loadHistory() {
  try { S.history = await ctx.api("/api/tune/history"); paintHistory(); } catch { /* không chặn */ }
}

// ---------------------------------------------------------------- áp dụng cho bot
async function openConfirm() {
  const d = diffParams(S.schema.params, S.schema.live, S.values);
  const tested = S.lastRun && sameParams(S.schema.params, S.lastRun.params, S.values);
  const m = modeInfo(S.bot?.mode);
  const html = `<p><span class="pill ${m.cls}">${esc(m.name)}</span>${S.bot?.strategy ? ` · ${esc(S.bot.strategy)}` : ""}</p>
    <p class="hint">Bot nạp lại chiến lược ngay. Lệnh đang mở giữ stoploss ban đầu; luật thoát dùng tham số mới.</p>
    <ul class="plain">${d.map((c) => `<li><b>${esc(c.label)}</b>: ${esc(c.from)} → <b>${esc(c.to)}</b></li>`).join("")}</ul>
    ${tested ? note(`Đã backtest bộ này: ${signedPct(S.lastRun.result.profit_pct)}, DD ${pct(S.lastRun.result.max_dd_pct, 1)} (${esc(S.lastRun.result.timerange)}).`, "ok")
             : note("Bộ tham số này CHƯA được backtest trong phiên này. Nên chạy backtest trước.", "warn")}`;
  const ok = await confirm({ title: m.cls === "mode-live" ? "Apply to LIVE bot?" : "Apply to bot?", html, ok: "Apply", danger: true });
  if (!ok) return;
  const top = $("#topMsg", root);
  try {
    const r = await ctx.api("/api/tune/apply", { method: "POST", body: { params: S.values } });
    top.innerHTML = note(r.message, r.reloaded ? "ok" : "warn");
    const s = await ctx.api("/api/tune/schema"); S.schema.live = s.live; syncInputs(); refreshBot(); loadHistory();
    toast(r.reloaded ? "Đã áp dụng cho bot." : "Đã ghi nhưng chưa nạp lại được bot.", r.reloaded ? "ok" : "err");
  } catch (e) { top.innerHTML = note(`Không áp dụng được: ${e.message}${e.hint ? ` — ${e.hint}` : ""}`, "err"); }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
