// Chạy lại backtest trên biểu đồ nến, kiểu "Visual mode" của MetaTrader: nến của một coin cả giai đoạn, mũi tên vào/ra
// và đường nối từng lệnh (xanh lãi / đỏ lỗ), con trỏ thời gian chạy tới (play / pause / tốc độ / kéo thanh trượt),
// kéo và thu phóng bằng tay (chuột, một ngón, hai ngón), đường vốn cả tài khoản chạy theo bên dưới.
// Vẽ bằng canvas (hơn chục nghìn nến — SVG chậm trên điện thoại). Không phụ thuộc màn hình: nhận nến + lệnh + vốn.
import { equityCurve, replayState, sortByClose } from "./model.js";
import { esc } from "./ui.js";

const SPEEDS = [1, 2, 5, 10, 25, 50, 100];      // nến mỗi giây
const PAD = { t: 8, b: 20, l: 2 };                   // lề phải (this.pr) nới theo nhãn giá dài nhất
const MIN_N = 12, DEFAULT_N = 120;
const DAY = 86400e3, MONTH = 30 * DAY;
const TICKS = [3600e3, 2 * 3600e3, 4 * 3600e3, 12 * 3600e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY, MONTH, 3 * MONTH, 6 * MONTH, 12 * MONTH];
const IN = "#2f81f7", OUT = "#e0a000";          // mũi tên vào / ra (cùng màu với biểu đồ nến từng lệnh)

const ICON = {
  first: '<path d="M6 5v14M18 5l-10 7 10 7z"/>', play: '<path d="M6 4l14 8-14 8z"/>', pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
  step: '<path d="M6 5l10 7-10 7z"/><path d="M18 5v14"/>', last: '<path d="M18 5v14M6 5l10 7-10 7z"/>',
  minus: '<path d="M5 12h14"/>', plus: '<path d="M12 5v14M5 12h14"/>', fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
};
const btn = (k, title) => `<button class="ibtn sm" type="button" data-rp="${k}" title="${title}" aria-label="${title}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg></button>`;
const pad2 = (x) => String(x).padStart(2, "0");

/** Bước lưới "đẹp" (1, 2, 5 × 10^k) không nhỏ hơn `raw`. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw - 1e-12);
}

/** Nhãn thời gian theo cỡ ô lưới: giờ → "HH:00", ngày → "dd/mm", tháng → "mm/yyyy", năm → "yyyy" (giờ máy người xem). */
export function tickLabel(ms, tick) {
  const d = new Date(ms);
  if (tick < DAY) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (tick < MONTH) return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  if (tick < 12 * MONTH) return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  return String(d.getFullYear());
}

/** Ô lưới thời gian chứa `ms` (đổi ô = vẽ một vạch): dưới một ngày theo UTC, ngày theo giờ máy, tháng/năm theo lịch. */
function bucket(ms, tick) {
  if (tick >= MONTH) { const d = new Date(ms); return Math.floor((d.getFullYear() * 12 + d.getMonth()) / Math.round(tick / MONTH)); }
  if (tick >= DAY) return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60e3) / tick);
  return Math.floor(ms / tick);
}

function line(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function tri(ctx, x, y, up, color, s = 6) {
  ctx.fillStyle = color; ctx.beginPath();
  if (up) { ctx.moveTo(x, y - s); ctx.lineTo(x - s, y + s); ctx.lineTo(x + s, y + s); } else { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y - s); ctx.lineTo(x + s, y - s); }
  ctx.closePath(); ctx.fill();
}

export class Replay {
  /**
   * el: phần tử chứa (nội dung bị thay). candles: [[ms, o, h, l, c, ema, …], …] tăng dần. trades: lệnh của coin này;
   * allTrades: lệnh mọi coin (đường vốn + thống kê). wallet: vốn ban đầu. cur: đơn vị vốn.
   * fmt: {price(v), num(v) (tiền không đơn vị), money(v) (tiền có đơn vị), time(ms)}.
   */
  constructor(el, { candles, trades, allTrades, wallet, tf = "", cur = "USDT", fmt }) {
    this.el = el; this.c = candles; this.wallet = wallet; this.tf = tf; this.cur = cur; this.fmt = fmt;
    this.ms = candles.length > 1 ? candles[1][0] - candles[0][0] : 3600e3;
    this.all = sortByClose(allTrades);
    this.eq = equityCurve(this.all, wallet, candles[0][0]);
    this.trades = (trades || []).map((t) => ({ ...t, iIn: this.idx(t.open_timestamp), iOut: t.close_timestamp == null ? Infinity : this.idx(t.close_timestamp) }));
    const N = candles.length;
    this.cursor = N - 1; this.n = Math.min(DEFAULT_N, N); this.i0 = Math.max(0, N - this.n);
    const lastOut = this.trades.reduce((m, t) => Math.max(m, Number.isFinite(t.iOut) ? t.iOut : t.iIn), -1);
    if (lastOut >= 0) this.i0 = Math.max(0, Math.min(N - this.n, Math.ceil(lastOut) - Math.round(this.n * 0.8)));   // mở ở lệnh cuối
    this.speed = 10; this.playing = false; this.sel = null; this.hover = null; this.colors = null;
    this.pointers = new Map(); this.raf = 0; this.pr = 56;
    el.replay = this;                                   // cho test tự động / gỡ lỗi
    this.render();
  }

  /** Chỉ số nến (lẻ) tại thời điểm ms: nến chứa ms + phần đã qua trong nến. */
  idx(ms) {
    const c = this.c;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m][0] <= ms) lo = m; else hi = m - 1; }
    return lo + Math.min(0.999, Math.max(-1, (ms - c[lo][0]) / this.ms));
  }
  atMs() { return this.c[this.cursor][0] + this.ms - 1; }           // cuối nến con trỏ: lệnh đóng trong nến đó đã tính

  // ---------------------------------------------------------------- khung + sự kiện
  render() {
    this.el.innerHTML = `<div class="replay">
      <div class="rp-bar">
        <span class="rp-grp">${btn("first", "Về đầu")}${btn("play", "Chạy")}${btn("step", "Tiến một nến")}${btn("last", "Tới cuối")}
        <select class="rp-speed" data-rp="speed" aria-label="Tốc độ chạy (nến mỗi giây)" title="Nến mỗi giây">${SPEEDS.map((s) => `<option value="${s}"${s === this.speed ? " selected" : ""}>${s}/s</option>`).join("")}</select></span>
        <span class="rp-grp">${btn("minus", "Thu nhỏ")}${btn("plus", "Phóng to")}${btn("fit", "Xem toàn bộ")}</span>
      </div>
      <canvas class="rp-price" tabindex="0" role="img" aria-label="Biểu đồ nến ${esc(this.tf)}: ${this.c.length} nến, ${this.trades.length} lệnh"></canvas>
      <input type="range" class="rp-scrub" min="0" max="${this.c.length - 1}" value="${this.cursor}" aria-label="Thời điểm đang xem">
      <canvas class="rp-equity" role="img" aria-label="Đường vốn cả tài khoản"></canvas>
      <div class="rp-stats kpis three keep"></div>
      <p class="rp-info hint"></p>
    </div>`;
    const q = (s) => this.el.querySelector(s);
    this.price = q(".rp-price"); this.equity = q(".rp-equity"); this.scrub = q(".rp-scrub"); this.stats = q(".rp-stats"); this.info = q(".rp-info");
    this.playBtn = q('[data-rp="play"]');
    this.el.addEventListener("click", this.onClick);
    this.el.addEventListener("change", this.onChange);
    this.scrub.addEventListener("input", () => { this.pause(); this.setCursor(Number(this.scrub.value), true); });
    const p = this.price;
    p.addEventListener("pointerdown", this.onDown); p.addEventListener("pointermove", this.onMove);
    p.addEventListener("pointerup", this.onUp); p.addEventListener("pointercancel", this.onUp); p.addEventListener("pointerleave", this.onLeave);
    p.addEventListener("wheel", this.onWheel, { passive: false });
    p.addEventListener("keydown", this.onKey);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.resize();
  }
  destroy() { this.pause(); this.ro?.disconnect(); this.el.innerHTML = ""; }

  onClick = (e) => {
    const b = e.target.closest("[data-rp]");
    if (!b || b.tagName === "SELECT") return;
    const N = this.c.length, k = b.dataset.rp;
    if (k === "play") (this.playing ? this.pause() : this.play());
    else if (k === "first") { this.pause(); this.setCursor(0); this.i0 = 0; this.draw(); }
    else if (k === "step") { this.pause(); this.setCursor(this.cursor + 1, true); }
    else if (k === "last") { this.pause(); this.setCursor(N - 1, true); }
    else if (k === "plus") this.zoom(1 / 1.5);
    else if (k === "minus") this.zoom(1.5);
    else if (k === "fit") { this.n = Math.max(MIN_N, this.cursor + 1); this.i0 = 0; this.draw(); }
  };
  onChange = (e) => { if (e.target.dataset.rp === "speed") this.speed = Number(e.target.value) || 10; };
  onKey = (e) => {
    if (e.key === " ") { e.preventDefault(); (this.playing ? this.pause() : this.play()); }
    else if (e.key === "ArrowRight") { e.preventDefault(); this.pause(); this.setCursor(this.cursor + 1, true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); this.pause(); this.setCursor(this.cursor - 1, true); }
    else if (e.key === "+" || e.key === "=") this.zoom(1 / 1.5);
    else if (e.key === "-") this.zoom(1.5);
  };

  /** Thu phóng quanh vị trí x (px) hoặc giữa màn: f > 1 là thu nhỏ (nhiều nến hơn). */
  zoom(f, x = null) {
    const step = this.step(), xi = x == null ? this.i0 + this.n / 2 : this.i0 + (x - PAD.l) / step;
    const n = Math.min(this.c.length, Math.max(MIN_N, Math.round(this.n * f)));
    this.i0 = xi - (xi - this.i0) * (n / this.n); this.n = n;
    this.clamp(); this.draw();
  }
  clamp() { this.i0 = Math.min(Math.max(0, this.c.length - this.n), Math.max(0, this.i0)); }
  step() { return (this.price.clientWidth - PAD.l - this.pr) / this.n; }

  onDown = (e) => {
    this.price.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    const ps = [...this.pointers.values()];
    if (ps.length === 1) this.drag = { x: e.offsetX, y: e.offsetY, i0: this.i0, moved: false };
    else if (ps.length === 2) this.pinch = { d: Math.abs(ps[0].x - ps[1].x) || 1, n: this.n, i0: this.i0, cx: (ps[0].x + ps[1].x) / 2 };
  };
  onMove = (e) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    const ps = [...this.pointers.values()];
    if (ps.length >= 2 && this.pinch) {
      const d = Math.abs(ps[0].x - ps[1].x) || 1, pw = this.price.clientWidth - PAD.l - this.pr;
      const n = Math.min(this.c.length, Math.max(MIN_N, this.pinch.n * this.pinch.d / d));
      const xi = this.pinch.i0 + (this.pinch.cx - PAD.l) / (pw / this.pinch.n);          // nến dưới điểm giữa hai ngón đứng yên
      this.n = n; this.i0 = xi - (this.pinch.cx - PAD.l) / (pw / n); this.clamp(); this.hover = null; this.draw();
    } else if (ps.length === 1 && this.drag) {
      const dx = e.offsetX - this.drag.x;
      if (Math.abs(dx) > 4 || Math.abs(e.offsetY - this.drag.y) > 4) this.drag.moved = true;
      if (this.drag.moved) { this.i0 = this.drag.i0 - dx / this.step(); this.clamp(); this.hover = null; this.price.style.cursor = "grabbing"; this.draw(); }
    } else if (e.pointerType === "mouse") { this.hover = { x: e.offsetX, y: e.offsetY }; this.draw(); }
  };
  onUp = (e) => {
    const tap = this.pointers.size === 1 && this.drag && !this.drag.moved;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) { this.drag = null; this.price.style.cursor = ""; }
    if (tap) this.tap(e.offsetX, e.offsetY);
  };
  onLeave = () => { if (!this.pointers.size && this.hover && !this.hover.pinned) { this.hover = null; this.draw(); } };
  onWheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) this.zoom(Math.pow(1.25, Math.sign(e.deltaY)), e.offsetX);
    else { this.i0 += e.deltaX / this.step(); this.clamp(); this.draw(); }
  };
  /** Bấm/chạm: gần mũi tên vào/ra thì chọn lệnh đó, không thì ghim con trỏ chữ thập vào nến đó. */
  tap(x, y) {
    const hit = (this.marks || []).find((m) => Math.hypot(m.x - x, m.y - y) < 14);
    this.sel = hit ? (this.sel === hit.t ? null : hit.t) : null;
    this.hover = hit ? null : { x, y, pinned: true };
    this.draw();
  }

  // ---------------------------------------------------------------- chạy lại
  play() {
    if (this.cursor >= this.c.length - 1) { this.cursor = 0; this.i0 = 0; }
    this.playing = true; this.acc = 0; this.lastT = performance.now();
    this.playBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON.pause}</svg>`; this.playBtn.title = this.playBtn.ariaLabel = "Tạm dừng"; this.playBtn.setAttribute("aria-pressed", "true");
    this.raf = requestAnimationFrame(this.tick);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false; cancelAnimationFrame(this.raf);
    this.playBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON.play}</svg>`; this.playBtn.title = this.playBtn.ariaLabel = "Chạy"; this.playBtn.setAttribute("aria-pressed", "false");
  }
  tick = (now) => {
    if (!this.playing) return;
    this.acc += ((now - this.lastT) / 1000) * this.speed; this.lastT = now;
    const k = Math.floor(this.acc);
    if (k) { this.acc -= k; this.setCursor(this.cursor + k, true); }
    if (this.cursor >= this.c.length - 1) { this.pause(); return; }
    this.raf = requestAnimationFrame(this.tick);
  };
  /** Đặt con trỏ; follow = cuộn màn để con trỏ luôn trong tầm nhìn (như MT5 cuộn theo nến mới). */
  setCursor(i, follow = false) {
    this.cursor = Math.min(this.c.length - 1, Math.max(0, Math.round(i)));
    if (follow) {
      if (this.cursor > this.i0 + this.n * 0.85) this.i0 = this.cursor - this.n * 0.85;
      else if (this.cursor < this.i0) this.i0 = this.cursor - this.n * 0.15;
      this.clamp();
    }
    this.scrub.value = this.cursor;
    this.draw();
  }
  /** Nhảy tới một lệnh (từ danh sách lệnh): con trỏ sau khi lệnh đóng, lệnh nằm giữa màn, được tô đậm. */
  focus(trade) {
    const t = this.trades.find((x) => x.open_timestamp === trade.open_timestamp && x.pair === trade.pair);
    if (!t) return;
    this.pause();
    const iOut = Number.isFinite(t.iOut) ? t.iOut : this.c.length - 1;
    this.n = Math.min(this.c.length, Math.max(40, Math.round((iOut - t.iIn + 1) * 3)));
    this.i0 = (t.iIn + iOut) / 2 - this.n / 2; this.clamp();
    this.sel = t; this.hover = null;
    this.setCursor(Math.min(this.c.length - 1, Math.floor(iOut) + 2));
  }

  // ---------------------------------------------------------------- vẽ
  /** Lề phải vừa nhãn dài nhất (giá hoặc tiền), tối thiểu this.pr mặc định. */
  padR(ctx, labels) { return Math.max(56, ...labels.map((t) => ctx.measureText(t).width + 10)); }
  colorsOf() {
    const key = document.documentElement.dataset.dark || "";
    if (this.colors?.key === key) return this.colors;
    const s = getComputedStyle(document.documentElement), v = (n) => s.getPropertyValue(n).trim();
    return (this.colors = { key, up: v("--up"), down: v("--down"), text: v("--text"), muted: v("--muted"), line: v("--line"), line2: v("--line-2"), accent: v("--accent"), warn: v("--warn") });
  }
  resize() {
    for (const cv of [this.price, this.equity]) {
      const r = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) continue;
      if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
      cv.getContext("2d").setTransform(r, 0, 0, r, 0, 0);
    }
    this.draw();
  }
  draw() {
    if (!this.price?.isConnected) return;
    this.drawPrice(); this.drawEquity(); this.paintStats();
  }

  drawPrice() {
    const cv = this.price, ctx = cv.getContext("2d"), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const col = this.colorsOf(), c = this.c, ms = this.ms, n = this.n, i0 = this.i0;
    ctx.font = "11px system-ui, -apple-system, sans-serif"; ctx.lineWidth = 1;
    this.pr = this.padR(ctx, [this.fmt.price(c[0][2]), this.fmt.price(c.at(-1)[2])]);
    const pw = W - PAD.l - this.pr, ph = H - PAD.t - PAD.b, step = pw / n;
    const X = (i) => PAD.l + (i - i0 + 0.5) * step;
    const first = Math.max(0, Math.floor(i0)), last = Math.min(this.cursor, c.length - 1, Math.ceil(i0 + n));
    let lo = Infinity, hi = -Infinity;
    for (let i = first; i <= last; i++) { if (c[i][3] < lo) lo = c[i][3]; if (c[i][2] > hi) hi = c[i][2]; }
    const vis = this.trades.filter((t) => t.iIn <= this.cursor + 1 && t.iIn <= last + 1 && Math.min(t.iOut, this.cursor) >= first - 1);
    for (const t of vis) {
      lo = Math.min(lo, t.open_rate); hi = Math.max(hi, t.open_rate);
      if (t.iOut <= this.cursor && t.close_rate != null) { lo = Math.min(lo, t.close_rate); hi = Math.max(hi, t.close_rate); }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const m = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.06; lo -= m; hi += m;
    const Y = (v) => PAD.t + ((hi - v) / (hi - lo)) * ph;
    ctx.clearRect(0, 0, W, H);
    // lưới giá
    ctx.strokeStyle = col.line; ctx.fillStyle = col.muted; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const sy = niceStep((hi - lo) / 5);
    for (let v = Math.ceil(lo / sy) * sy; v <= hi; v += sy) { const y = Math.round(Y(v)) + 0.5; line(ctx, PAD.l, y, W - this.pr, y); ctx.fillText(this.fmt.price(v), W - this.pr + 4, y); }
    // lưới thời gian
    const tick = TICKS.find((t) => (t / ms) * step >= 72) || TICKS.at(-1);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let i = Math.max(1, first); i <= Math.min(c.length - 1, Math.ceil(i0 + n)); i++) {
      if (bucket(c[i][0], tick) === bucket(c[i - 1][0], tick)) continue;
      const x = Math.round(X(i) - step / 2) + 0.5;
      ctx.strokeStyle = col.line; line(ctx, x, PAD.t, x, H - PAD.b);
      ctx.fillStyle = col.muted; ctx.fillText(tickLabel(c[i][0], tick), x, H - 6);
    }
    // nến + EMA200
    const bw = Math.max(1, Math.min(step * 0.72, 16));
    for (let i = first; i <= last; i++) {
      const r = c[i], up = r[4] >= r[1], x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = ctx.fillStyle = up ? col.up : col.down;
      line(ctx, x, Y(r[2]), x, Y(r[3]));
      const y1 = Y(Math.max(r[1], r[4])), y2 = Y(Math.min(r[1], r[4]));
      if (bw >= 2) ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }
    ctx.strokeStyle = col.muted; ctx.lineWidth = 1.2; ctx.beginPath();
    let pen = false;
    for (let i = first; i <= last; i++) { const v = c[i][5]; if (v == null) { pen = false; continue; } ctx[pen ? "lineTo" : "moveTo"](X(i), Y(v)); pen = true; }
    ctx.stroke(); ctx.lineWidth = 1;
    // lệnh: đường nối vào → ra (đứt, xanh lãi / đỏ lỗ; đang mở = xám tới con trỏ), mũi tên vào (xanh dương) / ra (vàng).
    // Thu nhỏ nhiều (nến < 3px) thì mũi tên nhỏ dần rồi ẩn, chỉ còn đường nối — không che mất nến.
    this.marks = [];
    const ms_ = Math.min(6, Math.max(2, step * 0.9)), showMk = step >= 1.2;
    for (const t of vis) {
      const closed = t.iOut <= this.cursor && t.close_rate != null, win = (t.profit_abs ?? 0) > 0, sel = t === this.sel;
      const xi = X(t.iIn), yi = Y(t.open_rate), xo = closed ? X(t.iOut) : X(this.cursor) + step / 2, yo = closed ? Y(t.close_rate) : yi;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = closed ? (win ? col.up : col.down) : col.muted; ctx.lineWidth = sel ? 2.5 : 1.2;
      line(ctx, xi, yi, xo, yo); ctx.setLineDash([]); ctx.lineWidth = 1;
      if (!showMk && !sel) continue;
      tri(ctx, xi, yi, !t.is_short, IN, sel ? 8 : ms_); this.marks.push({ x: xi, y: yi, t });
      if (closed) { tri(ctx, xo, yo, !!t.is_short, OUT, sel ? 8 : ms_); this.marks.push({ x: xo, y: yo, t }); }
    }
    // con trỏ thời gian (khi chưa chạy tới cuối)
    if (this.cursor < c.length - 1) {
      const x = Math.round(X(this.cursor) + step / 2) + 0.5;
      ctx.strokeStyle = col.accent; ctx.lineWidth = 1.5; line(ctx, x, PAD.t, x, H - PAD.b); ctx.lineWidth = 1;
      ctx.fillStyle = col.accent; ctx.fillRect(x - 1, PAD.t, 2, 10);
    }
    // chữ thập + thông tin nến
    let infoHtml = "";
    if (this.hover) {
      const i = Math.min(last, Math.max(first, Math.round(i0 + (this.hover.x - PAD.l) / step - 0.5)));
      const r = c[i], x = Math.round(X(i)) + 0.5, y = Math.round(this.hover.y) + 0.5;
      ctx.setLineDash([3, 3]); ctx.strokeStyle = col.line2;
      line(ctx, x, PAD.t, x, H - PAD.b); if (y > PAD.t && y < H - PAD.b) line(ctx, PAD.l, y, W - this.pr, y);
      ctx.setLineDash([]);
      if (y > PAD.t && y < H - PAD.b) {
        const v = hi - ((y - PAD.t) / ph) * (hi - lo), txt = this.fmt.price(v);
        ctx.fillStyle = col.accent; ctx.fillRect(W - this.pr + 1, y - 8, this.pr - 2, 16);
        ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(txt, W - this.pr + 4, y);
      }
      const d = r[4] - r[1];
      infoHtml = `${esc(this.fmt.time(r[0]))} · O ${esc(this.fmt.price(r[1]))} H ${esc(this.fmt.price(r[2]))} L ${esc(this.fmt.price(r[3]))} C ${esc(this.fmt.price(r[4]))} <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${(100 * d / r[1]).toFixed(2)}%</span>${r[5] != null ? ` · EMA200 ${esc(this.fmt.price(r[5]))}` : ""}`;
    }
    if (this.sel) {
      const t = this.sel, closed = t.iOut <= this.cursor && t.close_rate != null;
      infoHtml = `<b class="${t.is_short ? "down" : "up"}">${t.is_short ? "Short" : "Long"}</b> ${esc(String(t.pair || "").split("/")[0])} · vào ${esc(this.fmt.time(t.open_timestamp))} @ ${esc(this.fmt.price(t.open_rate))}`
        + (closed ? ` → ra ${esc(this.fmt.time(t.close_timestamp))} @ ${esc(this.fmt.price(t.close_rate))} · <b class="${(t.profit_abs ?? 0) > 0 ? "up" : "down"}">${esc(this.fmt.money(t.profit_abs))}</b>${t.exit_reason ? ` · ${esc(t.exit_reason)}` : ""}` : " · đang mở");
    }
    this.info.innerHTML = infoHtml || `${c.length} nến ${esc(this.tf)} · ${this.trades.length} lệnh · kéo để xem, lăn chuột / hai ngón để phóng · bấm mũi tên để xem lệnh · <span style="color:${IN}">▲▼</span> vào · <span style="color:${OUT}">▲▼</span> ra · xám = EMA200`;
  }

  drawEquity() {
    const cv = this.equity, ctx = cv.getContext("2d"), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const col = this.colorsOf(), pts = this.eq, t0 = this.c[0][0], t1 = this.c.at(-1)[0] + this.ms, at = this.atMs();
    ctx.font = "11px system-ui, -apple-system, sans-serif"; ctx.lineWidth = 1;
    const padR = this.padR(ctx, pts.map((p) => this.fmt.num(p[1])));
    const pw = W - PAD.l - padR, padT = 6, padB = 6, ph = H - padT - padB;
    const X = (t) => PAD.l + ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0 || 1)) * pw;
    let lo = this.wallet, hi = this.wallet;
    for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const m = (hi - lo || this.wallet * 0.02 || 1) * 0.08; lo -= m; hi += m;
    const Y = (v) => padT + ((hi - v) / (hi - lo)) * ph;
    ctx.clearRect(0, 0, W, H);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = col.line2; const yb = Math.round(Y(this.wallet)) + 0.5; line(ctx, PAD.l, yb, W - padR, yb); ctx.setLineDash([]);
    const path = (upto, color, width) => {                                     // bậc thang: vốn chỉ đổi khi một lệnh đóng
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let py = Y(pts[0][1]); ctx.moveTo(X(pts[0][0]), py);
      for (let k = 1; k < pts.length && pts[k][0] <= upto; k++) { const x = X(pts[k][0]); ctx.lineTo(x, py); py = Y(pts[k][1]); ctx.lineTo(x, py); }
      ctx.lineTo(X(upto), py); ctx.stroke(); ctx.lineWidth = 1;
    };
    path(t1, col.line2, 1);                                                   // cả giai đoạn, mờ
    path(at, col.accent, 1.8);                                                 // tới con trỏ, đậm
    const bal = this.all.reduce((b, t) => (t.close_timestamp <= at ? b + (t.profit_abs || 0) : b), this.wallet);
    const x = X(at), y = Y(bal);
    ctx.fillStyle = col.accent; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = bal >= this.wallet ? col.up : col.down; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(this.fmt.num(bal), W - padR + 4, Math.min(H - 8, Math.max(8, y)));
    ctx.fillStyle = col.muted; ctx.fillText(this.fmt.num(this.wallet), W - padR + 4, Math.min(H - 8, Math.max(8, Math.abs(yb - y) < 14 ? yb + 14 : yb)));
  }

  paintStats() {
    const s = replayState(this.all, this.atMs(), this.wallet), pn = s.pnl >= 0 ? "up" : "down";
    const k = (label, val, c = "") => `<div class="kpi"><span class="kpi-label">${label}</span><b class="kpi-value ${c}">${val}</b></div>`;
    const [day, hm] = esc(this.fmt.time(this.c[this.cursor][0])).split(" ");
    this.stats.innerHTML = k("Time", `${day} <small>${hm || ""}</small>`)
      + k("Balance", `${esc(this.fmt.num(s.balance))} <small>${esc(this.cur)}</small>`, pn)
      + k("P&L", `${s.pnl >= 0 ? "+" : ""}${s.pnlPct.toFixed(1)}%`, pn)
      + k("Trades", `${s.closed}${s.winrate != null ? ` <small>(${Math.round(s.winrate)}% win)</small>` : ""}`)
      + k("Open", String(s.open))
      + k("Max DD", `${s.maxDd.toFixed(1)}%`, s.maxDd > 20 ? "down" : "");
  }
}
