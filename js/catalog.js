// Thư viện chỉ báo cho bộ lắp ghép điều kiện. Mỗi chỉ báo trả về một chuỗi số trên nến {o,h,l,c,v}.
import * as I from "./indicators.js";

const P = (key, label, def, min, max, step = 1) => ({ key, label, default: def, min, max, step });
const div = (a, b) => Float64Array.from(a, (x, i) => x / b[i]);

export const CATALOG = [
  {
    id: "dpos", group: "Vị trí giá", label: "Vị trí trong kênh Donchian",
    help: "0 = đáy kênh N nến, 1 = đỉnh kênh.", range: [0, 1, 0.001],
    params: [P("n", "Số nến", 20, 5, 100)],
    calc: (k, p) => I.donchianPos(k.h, k.l, k.c, p.n),
  },
  {
    id: "bb_pctb", group: "Vị trí giá", label: "Bollinger %B",
    help: "0 = dải dưới, 1 = dải trên; <0 hoặc >1 là ra ngoài dải.", range: [-0.5, 1.5, 0.001],
    params: [P("n", "Số nến", 20, 5, 100), P("k", "Độ lệch chuẩn", 2, 1, 4, 0.1)],
    calc: (k, p) => { const b = I.bbands(k.c, p.n, p.k); return Float64Array.from(k.c, (x, i) => (x - b.lo[i]) / (b.up[i] - b.lo[i])); },
  },
  {
    id: "willr", group: "Vị trí giá", label: "Williams %R",
    help: "-100 = đáy vùng, 0 = đỉnh vùng.", range: [-100, 0, 0.5],
    params: [P("n", "Số nến", 14, 5, 100)],
    calc: (k, p) => I.willr(k.h, k.l, k.c, p.n),
  },
  {
    id: "rsi", group: "Dao động", label: "RSI", help: "0–100; thấp = quá bán, cao = quá mua.", range: [0, 100, 0.5],
    params: [P("n", "Số nến", 14, 2, 50)],
    calc: (k, p) => I.rsi(k.c, p.n),
  },
  {
    id: "stoch_k", group: "Dao động", label: "Stochastic %K", help: "0–100.", range: [0, 100, 0.5],
    params: [P("n", "Fast K", 5, 3, 30)],
    calc: (k, p) => I.stoch(k.h, k.l, k.c, p.n).k,
  },
  {
    id: "cci", group: "Dao động", label: "CCI", help: "Thường dao động ±100–200.", range: [-300, 300, 1],
    params: [P("n", "Số nến", 20, 5, 100)],
    calc: (k, p) => I.cci(k.h, k.l, k.c, p.n),
  },
  {
    id: "mfi", group: "Dao động", label: "MFI", help: "RSI có tính khối lượng, 0–100.", range: [0, 100, 0.5],
    params: [P("n", "Số nến", 14, 5, 50)],
    calc: (k, p) => I.mfi(k.h, k.l, k.c, k.v, p.n),
  },
  {
    id: "roc", group: "Dao động", label: "Thay đổi giá (%)", help: "% thay đổi so với N nến trước.", range: [-10, 10, 0.05],
    params: [P("n", "Số nến", 4, 1, 100)],
    calc: (k, p) => I.roc(k.c, p.n),
  },
  {
    id: "adx", group: "Xu hướng", label: "ADX", help: "Độ mạnh xu hướng (không chỉ hướng).", range: [0, 100, 0.5],
    params: [P("n", "Số nến", 14, 5, 50)],
    calc: (k, p) => I.dmi(k.h, k.l, k.c, p.n).adx,
  },
  {
    id: "di_diff", group: "Xu hướng", label: "+DI − −DI", help: ">0 = bên mua mạnh hơn.", range: [-60, 60, 0.5],
    params: [P("n", "Số nến", 14, 5, 50)],
    calc: (k, p) => { const d = I.dmi(k.h, k.l, k.c, p.n); return Float64Array.from(d.pdi, (x, i) => x - d.mdi[i]); },
  },
  {
    id: "ema_dist", group: "Xu hướng", label: "Khoảng cách tới EMA (×ATR)",
    help: ">0 = giá trên EMA; đo bằng số ATR(14).", range: [-10, 10, 0.1],
    params: [P("n", "Chu kỳ EMA", 50, 5, 300)],
    calc: (k, p) => { const e = I.ema(k.c, p.n), a = I.atr(k.h, k.l, k.c, 14); return Float64Array.from(k.c, (x, i) => (x - e[i]) / a[i]); },
  },
  {
    id: "ema_slope", group: "Xu hướng", label: "Độ dốc EMA (×ATR)",
    help: "EMA thay đổi bao nhiêu ATR(14) sau M nến.", range: [-5, 5, 0.05],
    params: [P("n", "Chu kỳ EMA", 50, 5, 300), P("m", "Sau M nến", 4, 1, 50)],
    calc: (k, p) => {
      const e = I.ema(k.c, p.n), a = I.atr(k.h, k.l, k.c, 14);
      return Float64Array.from(e, (x, i) => (i >= p.m ? (x - e[i - p.m]) / a[i] : NaN));
    },
  },
  {
    id: "macd_hist", group: "Xu hướng", label: "MACD histogram (×ATR)", help: "MACD(12,26,9) chia ATR(14).", range: [-2, 2, 0.01],
    params: [],
    calc: (k) => div(I.macd(k.c).hist, I.atr(k.h, k.l, k.c, 14)),
  },
  {
    id: "atr_pct", group: "Biến động", label: "ATR (% giá)", help: "Biên độ trung bình mỗi nến.", range: [0, 3, 0.01],
    params: [P("n", "Số nến", 14, 5, 50)],
    calc: (k, p) => Float64Array.from(I.atr(k.h, k.l, k.c, p.n), (x, i) => (x / k.c[i]) * 100),
  },
  {
    id: "atr_ratio", group: "Biến động", label: "ATR so với nền",
    help: "ATR(14) chia trung bình 100 nến của nó; >1 = biến động đang tăng.", range: [0, 4, 0.01],
    params: [],
    calc: (k) => { const a = I.atr(k.h, k.l, k.c, 14); return div(a, I.sma(Float64Array.from(a, (x) => (Number.isNaN(x) ? 0 : x)), 100)); },
  },
  {
    id: "bb_width", group: "Biến động", label: "Độ rộng Bollinger (%)", help: "(dải trên − dải dưới) / dải giữa.", range: [0, 20, 0.05],
    params: [P("n", "Số nến", 20, 5, 100)],
    calc: (k, p) => { const b = I.bbands(k.c, p.n, 2); return Float64Array.from(b.mid, (m, i) => ((b.up[i] - b.lo[i]) / m) * 100); },
  },
  {
    id: "ret_atr", group: "Biến động", label: "Biên độ nến vừa đóng (×ATR)",
    help: "Giá đóng thay đổi bao nhiêu ATR so với nến trước (bứt phá).", range: [-6, 6, 0.05],
    params: [],
    calc: (k) => { const a = I.atr(k.h, k.l, k.c, 14); return Float64Array.from(k.c, (x, i) => (i > 0 ? (x - k.c[i - 1]) / a[i - 1] : NaN)); },
  },
  {
    id: "vol_ratio", group: "Khối lượng", label: "Khối lượng so với trung bình",
    help: "Volume chia trung bình N nến (tính cả nến hiện tại).", range: [0, 5, 0.01],
    params: [P("n", "Số nến", 96, 10, 500)],
    calc: (k, p) => div(k.v, I.sma(k.v, p.n)),
  },
];

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((x) => [x.id, x]));

export function paramsWithDefaults(id, params = {}) {
  const def = CATALOG_BY_ID[id];
  return Object.fromEntries(def.params.map((p) => [p.key, params[p.key] ?? p.default]));
}
