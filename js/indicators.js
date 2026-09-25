// Chỉ báo kỹ thuật, tính giống TA-Lib (thư viện freqtrade dùng) để backtest trên web khớp với bot.
// Mọi hàm nhận mảng số, trả về Float64Array cùng độ dài; vị trí chưa đủ dữ liệu là NaN.

const nanArray = (n) => new Float64Array(n).fill(NaN);

export function sma(src, n) {
  const out = nanArray(src.length);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// EMA kiểu TA-Lib: giá trị đầu tiên = SMA của n phần tử đầu (tính từ `start`).
export function ema(src, n, start = 0) {
  const out = nanArray(src.length);
  const k = 2 / (n + 1);
  if (src.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += src[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < src.length; i++) {
    prev = (src[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(c, n) {
  const out = nanArray(c.length);
  if (c.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = gain + loss === 0 ? 0 : (100 * gain) / (gain + loss);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = gain + loss === 0 ? 0 : (100 * gain) / (gain + loss);
  }
  return out;
}

export function trueRange(h, l, c) {
  const out = nanArray(c.length);
  for (let i = 1; i < c.length; i++) {
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return out;
}

export function atr(h, l, c, n) {
  const out = nanArray(c.length);
  if (c.length <= n) return out;
  const tr = trueRange(h, l, c);
  let prev = 0;
  for (let i = 1; i <= n; i++) prev += tr[i];
  prev /= n;
  out[n] = prev;
  for (let i = n + 1; i < c.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

// ADX, +DI, -DI theo đúng thuật toán TA-Lib (làm mượt Wilder).
export function dmi(h, l, c, n) {
  const len = c.length;
  const adx = nanArray(len), pdi = nanArray(len), mdi = nanArray(len);
  if (len <= 2 * n) return { adx, pdi, mdi };
  let pDM = 0, mDM = 0, tr = 0;
  const step = (i) => {
    const up = h[i] - h[i - 1], down = l[i - 1] - l[i];
    let p = 0, m = 0;
    if (down > 0 && up < down) m = down;
    else if (up > 0 && up > down) p = up;
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    return [p, m, t];
  };
  for (let i = 1; i < n; i++) {
    const [p, m, t] = step(i);
    pDM += p; mDM += m; tr += t;
  }
  let sumDX = 0, i = n;
  const smooth = (idx) => {
    const [p, m, t] = step(idx);
    pDM = pDM - pDM / n + p;
    mDM = mDM - mDM / n + m;
    tr = tr - tr / n + t;
    if (tr === 0) return null;
    const P = (100 * pDM) / tr, M = (100 * mDM) / tr;
    pdi[idx] = P; mdi[idx] = M;
    return P + M === 0 ? null : (100 * Math.abs(M - P)) / (P + M);
  };
  for (; i < 2 * n; i++) {
    const dx = smooth(i);
    if (dx !== null) sumDX += dx;
  }
  let prevADX = sumDX / n;
  adx[2 * n - 1] = prevADX;
  for (i = 2 * n; i < len; i++) {
    const dx = smooth(i);
    if (dx !== null) prevADX = (prevADX * (n - 1) + dx) / n;
    adx[i] = prevADX;
  }
  return { adx, pdi, mdi };
}

export function bbands(c, n, k) {
  const len = c.length;
  const mid = sma(c, n), up = nanArray(len), lo = nanArray(len);
  for (let i = n - 1; i < len; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
  }
  return { up, mid, lo };
}

export function cci(h, l, c, n) {
  const len = c.length, out = nanArray(len);
  const tp = Float64Array.from({ length: len }, (_, i) => (h[i] + l[i] + c[i]) / 3);
  const m = sma(tp, n);
  for (let i = n - 1; i < len; i++) {
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

function rollingMax(src, n) {
  const out = nanArray(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (src[j] > m) m = src[j];
    out[i] = m;
  }
  return out;
}
function rollingMin(src, n) {
  const out = nanArray(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = Infinity;
    for (let j = i - n + 1; j <= i; j++) if (src[j] < m) m = src[j];
    out[i] = m;
  }
  return out;
}

export function willr(h, l, c, n) {
  const hh = rollingMax(h, n), ll = rollingMin(l, n), out = nanArray(c.length);
  for (let i = n - 1; i < c.length; i++) {
    const d = hh[i] - ll[i];
    out[i] = d === 0 ? 0 : (-100 * (hh[i] - c[i])) / d;
  }
  return out;
}

// Vị trí giá trong kênh Donchian: 0 = đáy kênh, 1 = đỉnh kênh (giống pandas rolling trong chiến lược).
export function donchianPos(h, l, c, n) {
  const hh = rollingMax(h, n), ll = rollingMin(l, n), out = nanArray(c.length);
  for (let i = n - 1; i < c.length; i++) out[i] = (c[i] - ll[i]) / (hh[i] - ll[i]);
  return out;
}

export function stoch(h, l, c, fastK = 5, slowK = 3, slowD = 3) {
  const hh = rollingMax(h, fastK), ll = rollingMin(l, fastK), raw = nanArray(c.length);
  for (let i = fastK - 1; i < c.length; i++) {
    const d = hh[i] - ll[i];
    raw[i] = d === 0 ? 0 : (100 * (c[i] - ll[i])) / d;
  }
  const k = smaFrom(raw, slowK, fastK - 1);
  const firstD = fastK - 1 + slowK - 1 + slowD - 1;
  const d = smaFrom(k, slowD, fastK - 1 + slowK - 1);
  for (let i = 0; i < Math.min(firstD, k.length); i++) k[i] = NaN; // TA-Lib: %K bắt đầu cùng %D
  return { k, d };
}
function smaFrom(src, n, start) {
  const out = nanArray(src.length);
  let sum = 0;
  for (let i = start; i < src.length; i++) {
    sum += src[i];
    if (i - start >= n) sum -= src[i - n];
    if (i - start >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function mfi(h, l, c, v, n) {
  const len = c.length, out = nanArray(len);
  const tp = Float64Array.from({ length: len }, (_, i) => (h[i] + l[i] + c[i]) / 3);
  const pos = new Float64Array(len), neg = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const mf = tp[i] * v[i];
    if (tp[i] > tp[i - 1]) pos[i] = mf; else if (tp[i] < tp[i - 1]) neg[i] = mf;
  }
  let sp = 0, sn = 0;
  for (let i = 1; i < len; i++) {
    sp += pos[i]; sn += neg[i];
    if (i > n) { sp -= pos[i - n]; sn -= neg[i - n]; }
    if (i >= n) out[i] = sp + sn < 1 ? 0 : (100 * sp) / (sp + sn);
  }
  return out;
}

export function macd(c, fast = 12, slow = 26, signal = 9) {
  const len = c.length;
  const eFast = ema(c, fast, slow - fast), eSlow = ema(c, slow);
  const line = nanArray(len);
  for (let i = slow - 1; i < len; i++) line[i] = eFast[i] - eSlow[i];
  const sig = ema(line, signal, slow - 1);
  const hist = nanArray(len);
  const first = slow + signal - 2;
  for (let i = first; i < len; i++) hist[i] = line[i] - sig[i];
  for (let i = 0; i < first; i++) { line[i] = NaN; }
  return { line, signal: sig, hist };
}

export function roc(c, n) {
  const out = nanArray(c.length);
  for (let i = n; i < c.length; i++) out[i] = (c[i] / c[i - n] - 1) * 100;
  return out;
}

/**
 * Market Structure Break & Order Block (EmreKb, TradingView "MSB-OB"), chuyển từng bước từ Pine v5.
 * Chỉ dùng nến đã đóng tới i (không nhìn trước). Trả:
 *  - market: 1 = cấu trúc tăng, -1 = giảm (NaN cho tới MSB đầu tiên)
 *  - buPos / bePos: vị trí giá đóng cửa trong vùng Bu-OB / Be-OB mới nhất (0 = đáy hộp, 1 = đỉnh hộp);
 *    NaN khi chưa có hộp hoặc hộp đã bị phá (Bu-OB: đóng cửa dưới đáy; Be-OB: đóng cửa trên đỉnh)
 * Khác bản gốc: chỉ theo dõi hộp mới nhất mỗi loại (bản gốc giữ nhiều hộp để vẽ).
 */
export function msbOb(o, h, l, c, len = 9, fib = 0.33) {
  const n = c.length;
  const market = nanArray(n), buPos = nanArray(n), bePos = nanArray(n);
  // mảng đỉnh/đáy zigzag (Pine khởi tạo bằng na)
  const hp = [NaN, NaN], hix = [NaN, NaN], lp = [NaN, NaN], lix = [NaN, NaN];
  const l0iHist = new Float64Array(n), h0iHist = new Float64Array(n);
  let trend = 1, mkt = 1, seen = false;
  let lastUp = -1, lastDown = -1;           // nến gần nhất có to_up / to_down
  let runLow = NaN, runHigh = NaN;          // ta.lowest/ta.highest trên cửa sổ động
  let lowEq = -1, highEq = -1;              // ta.barssince(low_val == low) / (high_val == high)
  let buIdx = 0, beIdx = 0, buKey = "", beKey = "";
  let buBox = null, beBox = null;
  const last = (a, k) => a[a.length - 1 - k];
  // for i = a to b của Pine (đếm lùi khi a > b); giữ chỉ số cuối cùng thoả điều kiện
  const scan = (a, b, want, prev) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return prev;
    const d = a <= b ? 1 : -1;
    for (let k = a; d > 0 ? k <= b : k >= b; k += d) if (want(k)) prev = k;
    return prev;
  };

  for (let i = 0; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    if (i >= len - 1) for (let k = i - len + 1; k <= i; k++) { if (h[k] > hh) hh = h[k]; if (l[k] < ll) ll = l[k]; }
    const toUp = i >= len - 1 && h[i] >= hh, toDown = i >= len - 1 && l[i] <= ll;

    // low_val = ta.lowest(max(ta.barssince(to_up[1]), 1)) → cửa sổ bắt đầu ở lastUp + 2
    if (lastUp < 0 || i <= lastUp + 1) runLow = l[i];
    else runLow = i === lastUp + 2 ? l[i] : Math.min(runLow, l[i]);
    if (lastDown < 0 || i <= lastDown + 1) runHigh = h[i];
    else runHigh = i === lastDown + 2 ? h[i] : Math.max(runHigh, h[i]);
    if (runLow === l[i]) lowEq = i;
    if (runHigh === h[i]) highEq = i;
    if (toUp) lastUp = i;
    if (toDown) lastDown = i;

    const prevTrend = trend;
    trend = trend === 1 && toDown ? -1 : trend === -1 && toUp ? 1 : trend;
    if (i > 0 && trend !== prevTrend) {
      if (trend === 1) { lp.push(runLow); lix.push(lowEq); }
      else { hp.push(runHigh); hix.push(highEq); }
    }
    const h0 = last(hp, 0), h0i = last(hix, 0), h1 = last(hp, 1), h1i = last(hix, 1);
    const l0 = last(lp, 0), l0i = last(lix, 0), l1 = last(lp, 1), l1i = last(lix, 1);
    l0iHist[i] = l0i; h0iHist[i] = h0i;

    // bộ chặn valuewhen(ta.change(market) != 0) của bản gốc luôn na (market chưa gán lại khi gọi) → bỏ
    const prevMkt = mkt;
    mkt = mkt === 1 && l0 < l1 && l0 < l1 - Math.abs(h0 - l1) * fib ? -1
      : mkt === -1 && h0 > h1 && h0 > h1 + Math.abs(h1 - l0) * fib ? 1 : mkt;

    // nến Order Block: nến giảm cuối cùng trong [h1i, l0i[len]] / nến tăng cuối cùng trong [l1i, h0i[len]]
    const l0iLag = i >= len ? l0iHist[i - len] : NaN, h0iLag = i >= len ? h0iHist[i - len] : NaN;
    if (i === 0) { buIdx = 0; beIdx = 0; }
    const bk = `${h1i}|${l0iLag}`, ek = `${l1i}|${h0iLag}`;
    if (bk !== buKey) { buIdx = scan(h1i, l0iLag, (k) => o[k] > c[k], buIdx); buKey = bk; }
    if (ek !== beKey) { beIdx = scan(l1i, h0iLag, (k) => o[k] < c[k], beIdx); beKey = ek; }

    if (mkt !== prevMkt) {
      seen = true;
      if (mkt === 1) buBox = { top: h[buIdx], bottom: l[buIdx] };
      else beBox = { top: h[beIdx], bottom: l[beIdx] };
    }
    if (seen) market[i] = mkt;
    const pos = (b) => (c[i] - b.bottom) / Math.max(b.top - b.bottom, 1e-12);
    if (buBox) { buPos[i] = pos(buBox); if (c[i] < buBox.bottom) buBox = null; }
    if (beBox) { bePos[i] = pos(beBox); if (c[i] > beBox.top) beBox = null; }
  }
  return { market, buPos, bePos };
}
