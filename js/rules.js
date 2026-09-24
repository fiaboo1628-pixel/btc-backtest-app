// Biến bộ điều kiện (VÀ) thành tín hiệu Long/Short trên khung giao dịch.
import { CATALOG_BY_ID, paramsWithDefaults } from "./catalog.js";
import { TF_MS, resample, alignToBase } from "./timeframes.js";

export const OPS = {
  "<=": { label: "≤", test: (x, v) => x <= v },
  ">=": { label: "≥", test: (x, v) => x >= v },
  "<": { label: "<", test: (x, v) => x < v },
  ">": { label: ">", test: (x, v) => x > v },
  "crossAbove": { label: "crosses ↑", test: (x, v, prev) => prev < v && x >= v },
  "crossBelow": { label: "crosses ↓", test: (x, v, prev) => prev > v && x <= v },
};

/**
 * Chiến lược:
 * { tradeTf: "15m", long: [cond...], short: [cond...], exit: {...}, account: {...} }
 * cond = { ind: "dpos", params: {n: 20}, tf: "15m" | "1h" | ..., op: "<=", value: 0.074 }
 * (tf bỏ trống = khung giao dịch)
 */
export function validateStrategy(s) {
  const errs = [];
  if (!TF_MS[s.tradeTf]) errs.push(`Invalid timeframe: ${s.tradeTf}`);
  for (const side of ["long", "short"]) {
    for (const [i, cond] of (s[side] || []).entries()) {
      const where = `${side === "long" ? "Long" : "Short"} #${i + 1}`;
      if (!CATALOG_BY_ID[cond.ind]) errs.push(`${where}: unknown indicator "${cond.ind}"`);
      if (!OPS[cond.op]) errs.push(`${where}: invalid operator`);
      if (!Number.isFinite(cond.value)) errs.push(`${where}: value must be a number`);
      const tf = cond.tf || s.tradeTf;
      if (!TF_MS[tf] || TF_MS[tf] < TF_MS[s.tradeTf]) errs.push(`${where}: condition TF must be ≥ trade TF`);
    }
  }
  return errs;
}

/**
 * @param base    nến khung giao dịch
 * @param source  nến gốc để ghép khung lớn (thường chính là dữ liệu đã tải, khung nhỏ nhất)
 * @returns Int8Array: 1 = Long, -1 = Short, 0 = không (Long và Short cùng lúc → bỏ, như freqtrade)
 */
export function buildSignals(strategy, base, source) {
  const n = base.t.length;
  const cache = new Map();
  const htfCandles = new Map();
  const series = (cond) => {
    const tf = cond.tf || strategy.tradeTf;
    const params = paramsWithDefaults(cond.ind, cond.params);
    const key = `${cond.ind}|${tf}|${JSON.stringify(params)}`;
    if (!cache.has(key)) {
      let vals;
      if (tf === strategy.tradeTf) vals = CATALOG_BY_ID[cond.ind].calc(base, params);
      else {
        if (!htfCandles.has(tf)) htfCandles.set(tf, resample(source, tf));
        const htf = htfCandles.get(tf);
        vals = alignToBase(base, strategy.tradeTf, htf, tf, CATALOG_BY_ID[cond.ind].calc(htf, params));
      }
      cache.set(key, vals);
    }
    return cache.get(key);
  };
  const sideMask = (conds) => {
    if (!conds || !conds.length) return null;
    const m = new Uint8Array(n).fill(1);
    for (const cond of conds) {
      const x = series(cond), op = OPS[cond.op];
      for (let i = 0; i < n; i++) {
        if (!m[i]) continue;
        const cur = x[i], prev = i > 0 ? x[i - 1] : NaN;
        if (Number.isNaN(cur) || !op.test(cur, cond.value, prev)) m[i] = 0;
      }
    }
    return m;
  };
  const L = sideMask(strategy.long), S = sideMask(strategy.short);
  const sig = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const l = L ? L[i] : 0, s = S ? S[i] : 0;
    sig[i] = l && !s ? 1 : s && !l ? -1 : 0;
  }
  return sig;
}
