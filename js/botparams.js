// Chuyển chiến lược của app sang tham số của bot DonchianRevert (freqtrade), cho nút "Send to bot".
// Bot chỉ chỉnh được ngưỡng, không đổi được logic: chiến lược phải đúng khuôn DonchianRevert, nếu không thì báo lý do.
//
// Khuôn (khung 15m, mọi điều kiện trên khung giao dịch):
//   Long : dpos(n) ≤ dc_long,  adx(14) > adx_min, vol_ratio(96) < vol_max, atr_pct(14) ≥ atr_min_pct
//   Short: dpos(n) ≥ dc_short, cùng adx/vol/atr như Long (bỏ trống Short = tắt Short)
//   vol_ratio > 0 được bỏ qua (bot đã lọc volume > 0).

const RULES = {
  dpos: { n: null },                        // n = dc_period, phải giống nhau hai phía
  adx: { n: 14, op: ">", key: "adx_min" },
  vol_ratio: { n: 96, op: "<", key: "vol_max" },
  atr_pct: { n: 14, op: ">=", key: "atr_min_pct" },
};

// Giới hạn tham số trong bot/user_data/strategies/DonchianRevert.py (hub cũng kiểm tra lại) — báo ngay
// trong app, thay vì để app cho chọn giá trị bot không nhận rồi hub từ chối lúc gửi.
export const BOT_LIMITS = {
  dc_period: [10, 50], dc_long: [0, 0.3], dc_short: [0.7, 1], adx_min: [10, 50], vol_max: [0.3, 3],
  atr_min_pct: [0, 1.5], r_atr: [1, 6], trail_start_r: [0.5, 5], trail_dist_r: [0.1, 2], tp_r: [0, 10],
  risk_pct: [0.1, 3], max_lev: [1, 10],
};
const INT_PARAMS = new Set(["dc_period", "adx_min", "max_lev"]);

function readSide(conds, side, tradeTf) {
  const out = {};
  for (const [i, c] of conds.entries()) {
    const where = `${side} #${i + 1}`;
    if ((c.tf || tradeTf) !== tradeTf) throw new Error(`${where}: the bot only uses ${tradeTf} candles for every condition`);
    const rule = RULES[c.ind];
    if (!rule) throw new Error(`${where}: the bot has no "${c.ind}" condition`);
    const n = c.params?.n;
    if (c.ind === "vol_ratio" && c.op === ">" && c.value === 0) continue;  // volume > 0: bot tự lọc
    if (c.ind === "dpos") {
      const op = side === "Long" ? "<=" : ">=";
      if (c.op !== op) throw new Error(`${where}: bot ${side} needs Donchian position ${op} value`);
      if (out.dpos) throw new Error(`${where}: only one Donchian condition per side`);
      out.dpos = { n, value: c.value };
      continue;
    }
    if (n !== rule.n) throw new Error(`${where}: the bot uses ${c.ind} with n = ${rule.n}`);
    if (c.op !== rule.op) throw new Error(`${where}: the bot needs ${c.ind} ${rule.op} value`);
    if (rule.key in out) throw new Error(`${where}: ${c.ind} appears twice`);
    out[rule.key] = c.value;
  }
  return out;
}

/** @returns {{params: object}} — ném lỗi (tiếng Anh, hiện cho người dùng) nếu không khớp khuôn. */
export function toBotParams(s, botTf = "15m") {
  if (s.tradeTf !== botTf) throw new Error(`The bot trades ${botTf} candles (strategy uses ${s.tradeTf})`);
  if (!s.long?.length) throw new Error("The bot always trades Long: add the Long conditions");
  const L = readSide(s.long, "Long", s.tradeTf);
  const S = s.short?.length ? readSide(s.short, "Short", s.tradeTf) : null;
  if (!L.dpos) throw new Error("Long needs a Donchian position ≤ condition");
  for (const k of ["adx_min", "vol_max", "atr_min_pct"]) {
    if (!(k in L)) throw new Error(`Long is missing the ${k.replace("_min", "").replace("_max", "")} condition`);
    if (S && S[k] !== L[k]) throw new Error(`Long and Short must use the same ${k} (bot has one value)`);
  }
  if (S && !S.dpos) throw new Error("Short needs a Donchian position ≥ condition");
  if (S && S.dpos.n !== L.dpos.n) throw new Error("Long and Short must use the same Donchian length");
  const ex = s.exit || {}, acc = s.account || {};
  if (ex.maxHoldBars > 0) throw new Error("The bot has no time exit: set Max hold to 0");

  const params = {
    dc_period: L.dpos.n, dc_long: L.dpos.value, adx_min: L.adx_min, vol_max: L.vol_max, atr_min_pct: L.atr_min_pct,
    short_enabled: !!S,
    r_atr: ex.rAtr, trail_on: ex.trailStartR > 0, tp_r: ex.tpR || 0,
    risk_pct: acc.riskPct, max_lev: acc.maxLev,
  };
  if (S) params.dc_short = S.dpos.value;
  if (ex.trailStartR > 0) { params.trail_start_r = ex.trailStartR; params.trail_dist_r = ex.trailDistR; }
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) throw new Error(`Missing value for ${k}`);
    const lim = BOT_LIMITS[k];
    if (lim && (v < lim[0] || v > lim[1])) throw new Error(`the bot accepts ${k} from ${lim[0]} to ${lim[1]} (now ${v})`);
    if (INT_PARAMS.has(k) && !Number.isInteger(v)) throw new Error(`the bot needs a whole number for ${k} (now ${v})`);
  }
  return { params };
}
