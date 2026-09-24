// Khung thời gian và ghép nến từ khung nhỏ lên khung lớn.

export const TF_MS = {
  "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3,
  "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "1d": 86400e3,
};
export const TF_LIST = Object.keys(TF_MS);

/** Ghép nến {t,o,h,l,c,v} sang khung `tf` (nến lớn gắn nhãn giờ mở, như freqtrade/pandas). */
export function resample(src, tf) {
  const ms = TF_MS[tf];
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let cur = -1;
  for (let i = 0; i < src.t.length; i++) {
    const b = Math.floor(src.t[i] / ms) * ms;
    if (b !== cur) {
      cur = b;
      t.push(b); o.push(src.o[i]); h.push(src.h[i]); l.push(src.l[i]); c.push(src.c[i]); v.push(src.v[i]);
    } else {
      const k = t.length - 1;
      if (src.h[i] > h[k]) h[k] = src.h[i];
      if (src.l[i] < l[k]) l[k] = src.l[i];
      c[k] = src.c[i];
      v[k] += src.v[i];
    }
  }
  return { t, o, h, l, c, v };
}

/**
 * Đưa giá trị chỉ báo của khung lớn (`htf`) về từng nến khung giao dịch (`base`).
 * Chỉ dùng nến khung lớn ĐÃ ĐÓNG: nến lớn mở lúc D (dài H) chỉ có hiệu lực từ nến nhỏ
 * mở lúc D + H - B (tức nến nhỏ đóng cùng lúc với nến lớn) — giống @informative của freqtrade.
 */
export function alignToBase(base, baseTf, htf, htfTf, values) {
  const B = TF_MS[baseTf], H = TF_MS[htfTf];
  const out = new Float64Array(base.t.length).fill(NaN);
  let j = -1;
  for (let i = 0; i < base.t.length; i++) {
    while (j + 1 < htf.t.length && htf.t[j + 1] + H - B <= base.t[i]) j++;
    if (j >= 0) out[i] = values[j];
  }
  return out;
}
