// Biểu đồ SVG tự vẽ (không thư viện): đường vốn và cột lãi/lỗ theo ngày. Trả về chuỗi SVG.
import { esc } from "./ui.js";

/**
 * Đường vốn. points: [[x, y], ...] (x tăng dần). opts: {w, h, label, fmtY, fmtX}
 * Tô màu xanh/đỏ theo cuối so với đầu; vạch đứt ở mức ban đầu; ghi min/max.
 */
export function lineChart(points, { w = 600, h = 140, label = "Equity", fmtY = (v) => v, fmtX = (v) => v } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p[1]));
  if (pts.length < 2) return `<div class="chart-empty">Chưa đủ dữ liệu để vẽ (cần ≥ 2 điểm).</div>`;
  const padL = 6, padR = 6, padT = 14, padB = 18;
  const ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || Math.abs(hi) * 0.02 || 1;
  const X = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const Y = (v) => padT + ((hi - v) * (h - padT - padB)) / span;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
  const base = Y(pts[0][1]);
  const up = ys.at(-1) >= ys[0];
  const col = up ? "var(--up)" : "var(--down)";
  const iMax = ys.indexOf(hi), iMin = ys.indexOf(lo);
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="chart line" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: từ ${esc(fmtY(ys[0]))} đến ${esc(fmtY(ys.at(-1)))}, thấp nhất ${esc(fmtY(lo))}, cao nhất ${esc(fmtY(hi))}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${padL}" x2="${w - padR}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" class="baseline"/>
    <path d="${d} L${X(pts.length - 1).toFixed(1)},${h - padB} L${padL},${h - padB} Z" fill="url(#${id})" stroke="none"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <text x="${X(iMax).toFixed(1)}" y="${Math.max(10, Y(hi) - 4).toFixed(1)}" class="lbl" text-anchor="${iMax > pts.length / 2 ? "end" : "start"}">${esc(fmtY(hi))}</text>
    <text x="${X(iMin).toFixed(1)}" y="${Math.min(h - padB - 2, Y(lo) + 12).toFixed(1)}" class="lbl" text-anchor="${iMin > pts.length / 2 ? "end" : "start"}">${esc(fmtY(lo))}</text>
    <text x="${padL}" y="${h - 4}" class="lbl muted">${esc(fmtX(pts[0][0]))}</text>
    <text x="${w - padR}" y="${h - 4}" class="lbl muted" text-anchor="end">${esc(fmtX(pts.at(-1)[0]))}</text>
  </svg>`;
}

/**
 * Cột lãi/lỗ theo ngày. days: [{date, abs, trades}] cũ → mới. Mỗi cột có <title> để rê chuột.
 */
export function barChart(days, { w = 600, h = 110, cur = "USDT", fmt = (v) => v, fmtDay = (v) => v } = {}) {
  const list = (days || []).filter((d) => d);
  if (!list.length) return `<div class="chart-empty">Chưa có ngày nào có lệnh.</div>`;
  const maxAbs = Math.max(1e-9, ...list.map((d) => Math.abs(d.abs || 0)));
  const padB = 16, mid = (h - padB) / 2, bw = Math.max(1, w / list.length - 2);
  const bars = list.map((d, i) => {
    const v = d.abs || 0, bh = (Math.abs(v) / maxAbs) * (mid - 4);
    const x = i * (w / list.length) + 1, y = v >= 0 ? mid - bh : mid;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" class="${v > 0 ? "bup" : v < 0 ? "bdown" : "bzero"}"><title>${esc(fmtDay(d.date))}: ${esc(fmt(v))} ${esc(cur)} · ${d.trades ?? 0} trades</title></rect>`;
  }).join("");
  const total = list.reduce((s, d) => s + (d.abs || 0), 0);
  return `<svg class="chart bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily P&L, ${list.length} ngày, tổng ${esc(fmt(total))} ${esc(cur)}">
    <line x1="0" x2="${w}" y1="${mid}" y2="${mid}" class="baseline"/>${bars}
    <text x="0" y="${h - 3}" class="lbl muted">${esc(fmtDay(list[0].date))}</text>
    <text x="${w}" y="${h - 3}" class="lbl muted" text-anchor="end">${esc(fmtDay(list.at(-1).date))}</text>
  </svg>`;
}

/** Thanh sụt vốn so với ngưỡng: current/max/threshold (%). */
export function drawdownBar({ current_dd_pct = 0, max_dd_pct = 0, threshold_pct = 15 }) {
  const scale = Math.max(threshold_pct * 1.25, max_dd_pct * 1.05, 1);
  const p = (v) => `${Math.min(100, (100 * v) / scale).toFixed(1)}%`;
  const lvl = max_dd_pct > threshold_pct ? "over" : max_dd_pct > threshold_pct * 0.66 ? "near" : "ok";
  return `<div class="ddbar ${lvl}" role="img" aria-label="Sụt vốn hiện tại ${current_dd_pct}%, lớn nhất ${max_dd_pct}%, ngưỡng tự dừng ${threshold_pct}%">
    <div class="dd-max" style="width:${p(max_dd_pct)}"></div>
    <div class="dd-cur" style="width:${p(current_dd_pct)}"></div>
    <div class="dd-th" style="left:${p(threshold_pct)}"><span>${threshold_pct}%</span></div>
  </div>`;
}

/**
 * Nến quanh một lệnh backtest. rows [ms, o, h, l, c, ema, atr]; lv từ model.tradeLevels; w = bề rộng thật (px) để chữ không méo.
 * Vẽ: vùng giữ lệnh, nến, EMA200, kênh thoát, giá vào/ra/SL, mũi tên vào/ra.
 */
export function candleChart(rows, t, lv, { w = 600, h = 280, fmtY = (v) => v, fmtX = (v) => v } = {}) {
  if (!rows?.length) return `<div class="chart-empty">Không có nến.</div>`;
  const lvls = [lv.stop, t.open_rate, t.close_rate].filter((v) => v != null);
  const padL = 4, padT = 10, padB = 18, padR = 10 + 6.5 * Math.max(...lvls.map((v) => `Out ${fmtY(v)}`.length));   // chỗ cho nhãn giá
  const lo = Math.min(...rows.map((r) => r[3]), ...lvls), hi = Math.max(...rows.map((r) => r[2]), ...lvls);
  const span = hi - lo || 1, step = (w - padL - padR) / rows.length, bw = Math.max(1, step * 0.7);
  const X = (i) => padL + (i + 0.5) * step;
  const Y = (v) => padT + ((hi - v) * (h - padT - padB)) / span;
  const path = (vals) => vals.map((v, i) => (v == null ? "" : `${vals[i - 1] == null ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).join("");
  const iOut = lv.iOut < 0 ? rows.length - 1 : lv.iOut;
  const used = [];
  const labelY = (y) => { while (used.some((u) => Math.abs(u - y) < 12)) y += y > h / 2 ? -12 : 12; used.push(y); return y; };
  const hline = (v, c, text) => `<line x1="${X(lv.iIn).toFixed(1)}" x2="${w - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="${c}"/>
    <text x="${w - padR + 3}" y="${(labelY(Y(v)) + 4).toFixed(1)}" class="lbl ${c}">${esc(text)} ${esc(fmtY(v))}</text>`;
  const arrow = (i, v, up, c) => { const x = X(i), y = Y(v), d = up ? 1 : -1;
    return `<path d="M${x.toFixed(1)},${y.toFixed(1)} l-5,${9 * d} h10 z" class="${c}"/>`; };
  const candles = rows.map((r, i) => { const x = X(i), c = r[4] >= r[1] ? "cup" : "cdown";
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(r[2]).toFixed(1)}" y2="${Y(r[3]).toFixed(1)}" class="${c}"/><rect x="${(x - bw / 2).toFixed(1)}" y="${Y(Math.max(r[1], r[4])).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(Y(r[1]) - Y(r[4]))).toFixed(1)}" class="${c}"/>`; }).join("");
  const win = (t.profit_abs ?? 0) > 0;
  return `<svg class="chart candles" viewBox="0 0 ${w} ${h}" style="height:${h}px" role="img" aria-label="${esc(t.pair)}: vào ${esc(fmtY(t.open_rate))}, ra ${esc(fmtY(t.close_rate))}">
    <rect x="${(X(lv.iIn) - step / 2).toFixed(1)}" y="${padT}" width="${((iOut - lv.iIn + 1) * step).toFixed(1)}" height="${h - padT - padB}" class="hold ${win ? "win" : "loss"}"/>
    <path d="${path(rows.map((r) => r[5]))}" class="ema"/>
    <path d="${path(lv.exit)}" class="xch"/>
    ${candles}
    ${lv.stop != null ? hline(lv.stop, "stop", "SL") : ""}
    ${hline(t.open_rate, "entry", "In")}
    ${t.close_rate != null ? hline(t.close_rate, win ? "exit up" : "exit down", "Out") : ""}
    ${lv.iIn >= 0 ? arrow(lv.iIn, t.is_short ? rows[lv.iIn][2] : rows[lv.iIn][3], !t.is_short, "mk-in") : ""}
    ${lv.iOut >= 0 ? arrow(lv.iOut, t.is_short ? rows[lv.iOut][3] : rows[lv.iOut][2], t.is_short, "mk-out") : ""}
    <text x="${padL}" y="${h - 4}" class="lbl muted">${esc(fmtX(rows[0][0]))}</text>
    <text x="${w - padR}" y="${h - 4}" class="lbl muted" text-anchor="end">${esc(fmtX(rows.at(-1)[0]))}</text>
  </svg>`;
}
