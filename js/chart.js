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
