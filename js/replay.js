// Replay: xem lại backtest từng nến như Visual mode của MT5 — nến chạy dần, mũi tên vào/ra lệnh,
// đường SL/trailing dời theo từng nến (đúng đường stop mà bộ máy backtest đã dùng), số dư cập nhật.
import { createChart, LineType, CrosshairMode } from "../vendor/lightweight-charts.js";

const $ = (s) => document.querySelector(s);
const SPEEDS = [4, 20, 80, 400];   // nến/giây cho 1× 5× 20× 100×
const WINDOW = 500;                  // số nến giữ trên biểu đồ (cuộn theo)
const S = (ms) => Math.floor(ms / 1000);

let cur = null;                      // phiên replay đang mở

/**
 * @param {object} o {bars: {t,o,h,l,c}, trades: [{dir, entryT, exitT, entry, exit, amount, pnl, reason, balance, path}],
 *                    wallet, tfMs, fmt(n,d), sign(n,d)}
 */
export function openReplay(o) {
  closeReplay();
  const box = $("#replay");
  box.hidden = false;
  document.body.classList.add("replaying");
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const chart = createChart($("#rpChart"), {
    autoSize: true,
    layout: { background: { color: col("--panel") }, textColor: col("--muted"), fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: col("--line") }, horzLines: { color: col("--line") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7 },
    crosshair: { mode: CrosshairMode.Normal },
  });
  const up = col("--up"), down = col("--down");
  const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
  const stops = chart.addLineSeries({ color: col("--warn"), lineWidth: 2, lineType: LineType.WithSteps,
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });

  const B = o.bars, N = B.t.length;
  const trades = o.trades;
  const find = (t) => { let lo = 0, hi = N - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (B.t[m] < t) lo = m + 1; else hi = m; } return lo; };
  const entryIdx = trades.map((x) => find(x.entryT));
  const bar = (i) => ({ time: S(B.t[i]), open: B.o[i], high: B.h[i], low: B.l[i], close: B.c[i] });

  const st = { idx: Math.max(0, (entryIdx[0] ?? 0) - 60), playing: false, speed: 1, acc: 0, last: 0, raf: 0,
    from: 0, entryLine: null, entryFor: -1 };
  cur = { chart, st };

  const scrub = $("#rpScrub");
  scrub.min = 0; scrub.max = N - 1; scrub.step = 1;

  function full() {
    st.from = Math.max(0, st.idx - WINDOW);
    const data = [];
    for (let i = st.from; i <= st.idx; i++) data.push(bar(i));
    candles.setData(data);
    overlay();
  }

  // mũi tên vào/ra + đường stop + HUD, chỉ tính các lệnh trong cửa sổ đang hiện
  function overlay() {
    const t0 = B.t[st.from], tNow = B.t[st.idx];
    const marks = [], pts = new Map();
    let open = -1, lastClosed = -1;
    for (let k = 0; k < trades.length; k++) {
      const x = trades[k];
      if (x.entryT > tNow) break;
      if (x.exitT <= tNow) lastClosed = k; else open = k;
      if (x.exitT < t0 && x.entryT < t0) continue;
      if (x.entryT >= t0) marks.push({ time: S(x.entryT), position: x.dir === 1 ? "belowBar" : "aboveBar",
        color: x.dir === 1 ? up : down, shape: x.dir === 1 ? "arrowUp" : "arrowDown", text: x.dir === 1 ? "L" : "S" });
      if (x.exitT <= tNow && x.exitT >= t0) marks.push({ time: S(x.exitT), position: x.dir === 1 ? "aboveBar" : "belowBar",
        color: x.pnl >= 0 ? up : down, shape: "circle", text: `${label(x.reason)} ${o.sign(x.pnl, 1)}` });
      for (const [t, v] of x.path || []) if (t >= t0 && t <= tNow && t <= x.exitT) pts.set(S(t), v);
      const gap = S(x.exitT + o.tfMs);
      if (x.exitT < tNow && !pts.has(gap)) pts.set(gap, null);      // ngắt đường giữa các lệnh
    }
    marks.sort((a, b) => a.time - b.time);
    candles.setMarkers(marks);
    stops.setData([...pts.entries()].filter(([t]) => t <= S(tNow)).sort((a, b) => a[0] - b[0])
      .map(([time, value]) => (value == null ? { time } : { time, value })));

    // đường giá vào lệnh khi đang có lệnh
    if (open !== st.entryFor) {
      if (st.entryLine) { candles.removePriceLine(st.entryLine); st.entryLine = null; }
      if (open >= 0) st.entryLine = candles.createPriceLine({ price: trades[open].entry, color: col("--accent"), lineWidth: 1,
        lineStyle: 2, axisLabelVisible: true, title: trades[open].dir === 1 ? "Long" : "Short" });
      st.entryFor = open;
    }
    const bal = lastClosed >= 0 ? trades[lastClosed].balance : o.wallet;
    $("#rpBal").textContent = o.fmt(bal, 0);
    $("#rpBal").className = bal >= o.wallet ? "up" : "down";
    if (open >= 0) {
      const x = trades[open], u = x.dir * x.amount * (B.c[st.idx] - x.entry);
      $("#rpPos").innerHTML = `<span class="${x.dir === 1 ? "up" : "down"}">${x.dir === 1 ? "Long" : "Short"}</span> <span class="${u >= 0 ? "up" : "down"}">${o.sign(u, 1)}</span>`;
    } else $("#rpPos").textContent = "—";
    $("#rpNo").textContent = `${lastClosed + 1 + (open >= 0 ? 1 : 0)}/${trades.length}`;
    $("#rpTime").textContent = new Date(tNow).toISOString().slice(0, 16).replace("T", " ");
    scrub.value = st.idx;
    scrub.style.setProperty("--fill", `${(st.idx / Math.max(1, N - 1)) * 100}%`);
  }

  function step(n) {
    const to = Math.min(N - 1, Math.max(0, st.idx + n));
    if (to === st.idx) return false;
    if (n === 1 && to - st.from < WINDOW * 1.5) { st.idx = to; candles.update(bar(to)); }
    else { st.idx = to; full(); return true; }
    return true;
  }

  function loop(ts) {
    if (!st.playing) return;
    const dt = st.last ? Math.min(250, ts - st.last) : 0;
    st.last = ts;
    st.acc += (dt / 1000) * SPEEDS[st.speed];
    let moved = false;
    while (st.acc >= 1) { st.acc -= 1; if (!step(1)) { setPlaying(false); break; } moved = true; }
    if (moved) overlay();
    st.raf = requestAnimationFrame(loop);
  }
  function setPlaying(p) {
    st.playing = p; st.last = 0; st.acc = 0;
    $("#rpPlay").innerHTML = p ? "&#10074;&#10074;" : "&#9654;";
    $("#rpPlay").setAttribute("aria-label", p ? "Pause" : "Play");
    cancelAnimationFrame(st.raf);
    if (p) st.raf = requestAnimationFrame(loop);
  }
  const jump = (i) => { setPlaying(false); st.idx = Math.min(N - 1, Math.max(0, i)); full(); chart.timeScale().scrollToRealTime(); };
  const nextTrade = () => { const k = entryIdx.findIndex((e) => e > st.idx); if (k >= 0) jump(entryIdx[k]); };
  const prevTrade = () => { let k = -1; entryIdx.forEach((e, j) => { if (e < st.idx) k = j; }); if (k >= 0) jump(entryIdx[k]); };

  const on = (id, ev, fn) => { const el = $(id); el[`on${ev}`] = fn; };
  on("#rpPlay", "click", () => setPlaying(!st.playing));
  on("#rpNext", "click", () => { setPlaying(false); step(1); overlay(); });
  on("#rpPrev", "click", () => { setPlaying(false); step(-1); });
  on("#rpNextTrade", "click", nextTrade);
  on("#rpPrevTrade", "click", prevTrade);
  on("#rpClose", "click", closeReplay);
  on("#rpScrub", "input", () => jump(Number(scrub.value)));
  document.querySelectorAll("#rpSpeed button").forEach((b, k) => {
    b.setAttribute("aria-pressed", String(k === st.speed));
    b.onclick = () => { st.speed = k; document.querySelectorAll("#rpSpeed button").forEach((x, j) => x.setAttribute("aria-pressed", String(j === k))); };
  });
  cur.stop = () => setPlaying(false);
  full();
  chart.timeScale().scrollToRealTime();
}

export function closeReplay() {
  if (!cur) return;
  cur.stop?.();
  cur.chart.remove();
  cur = null;
  $("#replay").hidden = true;
  document.body.classList.remove("replaying");
}

function label(r) {
  return { stop_loss: "SL", trailing: "Trail", take_profit: "TP", time: "Time", end: "End" }[r] || r;
}
