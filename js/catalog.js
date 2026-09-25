// Indicator catalog for the condition builder. Each entry returns one series over candles {o,h,l,c,v}.
import * as I from "./indicators.js";

const P = (key, label, def, min, max, step = 1) => ({ key, label, default: def, min, max, step });
const div = (a, b) => Float64Array.from(a, (x, i) => x / b[i]);

export const CATALOG = [
  {
    id: "dpos", group: "Price position", label: "Donchian position",
    help: "0 = N-bar channel low, 1 = channel high", range: [0, 1, 0.001],
    params: [P("n", "Bars", 20, 5, 100)],
    calc: (k, p) => I.donchianPos(k.h, k.l, k.c, p.n),
  },
  {
    id: "bb_pctb", group: "Price position", label: "Bollinger %B",
    help: "0 = lower band, 1 = upper band; <0 or >1 = outside", range: [-0.5, 1.5, 0.001],
    params: [P("n", "Bars", 20, 5, 100), P("k", "Std dev", 2, 1, 4, 0.1)],
    calc: (k, p) => { const b = I.bbands(k.c, p.n, p.k); return Float64Array.from(k.c, (x, i) => (x - b.lo[i]) / (b.up[i] - b.lo[i])); },
  },
  {
    id: "willr", group: "Price position", label: "Williams %R",
    help: "-100 = range low, 0 = range high", range: [-100, 0, 0.5],
    params: [P("n", "Bars", 14, 5, 100)],
    calc: (k, p) => I.willr(k.h, k.l, k.c, p.n),
  },
  {
    id: "rsi", group: "Oscillator", label: "RSI", help: "0–100; low = oversold, high = overbought", range: [0, 100, 0.5],
    params: [P("n", "Bars", 14, 2, 50)],
    calc: (k, p) => I.rsi(k.c, p.n),
  },
  {
    id: "stoch_k", group: "Oscillator", label: "Stochastic %K", help: "0–100", range: [0, 100, 0.5],
    params: [P("n", "Fast K", 5, 3, 30)],
    calc: (k, p) => I.stoch(k.h, k.l, k.c, p.n).k,
  },
  {
    id: "cci", group: "Oscillator", label: "CCI", help: "Usually within ±100–200", range: [-300, 300, 1],
    params: [P("n", "Bars", 20, 5, 100)],
    calc: (k, p) => I.cci(k.h, k.l, k.c, p.n),
  },
  {
    id: "mfi", group: "Oscillator", label: "MFI", help: "Volume-weighted RSI, 0–100", range: [0, 100, 0.5],
    params: [P("n", "Bars", 14, 5, 50)],
    calc: (k, p) => I.mfi(k.h, k.l, k.c, k.v, p.n),
  },
  {
    id: "roc", group: "Oscillator", label: "Rate of change %", help: "% change vs N bars ago", range: [-10, 10, 0.05],
    params: [P("n", "Bars", 4, 1, 100)],
    calc: (k, p) => I.roc(k.c, p.n),
  },
  {
    id: "adx", group: "Trend", label: "ADX", help: "Trend strength (not direction)", range: [0, 100, 0.5],
    params: [P("n", "Bars", 14, 5, 50)],
    calc: (k, p) => I.dmi(k.h, k.l, k.c, p.n).adx,
  },
  {
    id: "di_diff", group: "Trend", label: "+DI − −DI", help: ">0 = buyers stronger", range: [-60, 60, 0.5],
    params: [P("n", "Bars", 14, 5, 50)],
    calc: (k, p) => { const d = I.dmi(k.h, k.l, k.c, p.n); return Float64Array.from(d.pdi, (x, i) => x - d.mdi[i]); },
  },
  {
    id: "ema_dist", group: "Trend", label: "Distance to EMA (×ATR)",
    help: ">0 = price above EMA, in ATR(14) units", range: [-10, 10, 0.1],
    params: [P("n", "EMA", 50, 5, 300)],
    calc: (k, p) => { const e = I.ema(k.c, p.n), a = I.atr(k.h, k.l, k.c, 14); return Float64Array.from(k.c, (x, i) => (x - e[i]) / a[i]); },
  },
  {
    id: "ema_slope", group: "Trend", label: "EMA slope (×ATR)",
    help: "EMA change over M bars, in ATR(14) units", range: [-5, 5, 0.05],
    params: [P("n", "EMA", 50, 5, 300), P("m", "Over bars", 4, 1, 50)],
    calc: (k, p) => {
      const e = I.ema(k.c, p.n), a = I.atr(k.h, k.l, k.c, 14);
      return Float64Array.from(e, (x, i) => (i >= p.m ? (x - e[i - p.m]) / a[i] : NaN));
    },
  },
  {
    id: "macd_hist", group: "Trend", label: "MACD hist (×ATR)", help: "MACD(12,26,9) / ATR(14)", range: [-2, 2, 0.01],
    params: [],
    calc: (k) => div(I.macd(k.c).hist, I.atr(k.h, k.l, k.c, 14)),
  },
  {
    id: "atr_pct", group: "Volatility", label: "ATR % of price", help: "Average bar range", range: [0, 3, 0.01],
    params: [P("n", "Bars", 14, 5, 50)],
    calc: (k, p) => Float64Array.from(I.atr(k.h, k.l, k.c, p.n), (x, i) => (x / k.c[i]) * 100),
  },
  {
    id: "atr_ratio", group: "Volatility", label: "ATR vs baseline",
    help: "ATR(14) / its 100-bar mean; >1 = rising volatility", range: [0, 4, 0.01],
    params: [],
    calc: (k) => { const a = I.atr(k.h, k.l, k.c, 14); return div(a, I.sma(Float64Array.from(a, (x) => (Number.isNaN(x) ? 0 : x)), 100)); },
  },
  {
    id: "bb_width", group: "Volatility", label: "Bollinger width %", help: "(upper − lower) / middle", range: [0, 20, 0.05],
    params: [P("n", "Bars", 20, 5, 100)],
    calc: (k, p) => { const b = I.bbands(k.c, p.n, 2); return Float64Array.from(b.mid, (m, i) => ((b.up[i] - b.lo[i]) / m) * 100); },
  },
  {
    id: "ret_atr", group: "Volatility", label: "Last bar move (×ATR)",
    help: "Close change vs previous bar, in ATR units (breakout)", range: [-6, 6, 0.05],
    params: [],
    calc: (k) => { const a = I.atr(k.h, k.l, k.c, 14); return Float64Array.from(k.c, (x, i) => (i > 0 ? (x - k.c[i - 1]) / a[i - 1] : NaN)); },
  },
  {
    id: "msb_trend", group: "Structure", label: "MSB trend",
    help: "Market Structure Break (MSB-OB): 1 = bullish structure, -1 = bearish. Crosses = the MSB bar", range: [-1, 1, 1],
    params: [P("n", "ZigZag", 9, 2, 50), P("f", "Fib factor", 0.33, 0, 1, 0.01)],
    calc: (k, p) => I.msbOb(k.o, k.h, k.l, k.c, p.n, p.f).market,
  },
  {
    id: "msb_buob", group: "Structure", label: "Bu-OB position",
    help: "Close inside the latest bullish order block: 0 = box low, 1 = box high. Empty once broken", range: [-0.5, 3, 0.01],
    params: [P("n", "ZigZag", 9, 2, 50), P("f", "Fib factor", 0.33, 0, 1, 0.01)],
    calc: (k, p) => I.msbOb(k.o, k.h, k.l, k.c, p.n, p.f).buPos,
  },
  {
    id: "msb_beob", group: "Structure", label: "Be-OB position",
    help: "Close inside the latest bearish order block: 0 = box low, 1 = box high. Empty once broken", range: [-2, 1.5, 0.01],
    params: [P("n", "ZigZag", 9, 2, 50), P("f", "Fib factor", 0.33, 0, 1, 0.01)],
    calc: (k, p) => I.msbOb(k.o, k.h, k.l, k.c, p.n, p.f).bePos,
  },
  {
    id: "vol_ratio", group: "Volume", label: "Volume ratio",
    help: "Volume / N-bar mean (incl. current bar)", range: [0, 5, 0.01],
    params: [P("n", "Bars", 96, 10, 500)],
    calc: (k, p) => div(k.v, I.sma(k.v, p.n)),
  },
];

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((x) => [x.id, x]));

export function paramsWithDefaults(id, params = {}) {
  const def = CATALOG_BY_ID[id];
  return Object.fromEntries(def.params.map((p) => [p.key, params[p.key] ?? p.default]));
}
