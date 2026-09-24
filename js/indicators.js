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
