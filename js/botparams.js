// Chuyển chiến lược của app sang tham số của bot freqtrade (nút "Send to bot") và ngược lại ("Use bot's values").
// Bot chỉ chỉnh được ngưỡng, không đổi được logic: chiến lược phải đúng KHUÔN của chiến lược bot đang chạy
// (tên lấy từ /api/tune/schema .strategy), nếu không thì báo lý do (tiếng Anh, hiện cho người dùng).
//
// TrendBreakout (khung 4h, bot hiện tại):
//   Long : dbrk(n) > 1 [, ema_dist(200) > 0]      Short: dbrk(n) < 0 [, ema_dist(200) < 0]   (bỏ trống Short = tắt Short)
//   ema_dist có ở cả hai phía hoặc không phía nào (ema_filter). Thoát: exitChannel = exit_period, 1R = r_atr × ATR(20),
//   không trailing / TP / giữ tối đa. Tài khoản: riskPct, maxLev, fixedLev. halt_on không gửi (giữ giá trị bot đang dùng).
// DonchianRevert (khung 15m, bot cũ — giữ khuôn để còn gửi được nếu quay lại):
//   Long : dpos(n) ≤ dc_long,  adx(14) > adx_min, vol_ratio(96) < vol_max, atr_pct(14) ≥ atr_min_pct
//   Short: dpos(n) ≥ dc_short, cùng adx/vol/atr như Long. vol_ratio > 0 được bỏ qua (bot đã lọc volume > 0).

export const DEFAULT_BOT = "TrendBreakout";

// Giới hạn và số chữ số thập phân (decimals=, 0 = số nguyên) theo *Parameter(...) trong bot/user_data/strategies/*.py
// (hub kiểm tra lại) — báo ngay trong app, thay vì để app cho chọn giá trị bot không nhận rồi hub từ chối lúc gửi.
export const BOT_LIMITS = {
  TrendBreakout: { entry_period: [10, 100], exit_period: [5, 50], r_atr: [1, 6], risk_pct: [0.1, 3], max_lev: [1, 10] },
  DonchianRevert: {
    dc_period: [10, 50], dc_long: [0, 0.3], dc_short: [0.7, 1], adx_min: [10, 50], vol_max: [0.3, 3],
    atr_min_pct: [0, 1.5], r_atr: [1, 6], trail_start_r: [0.5, 5], trail_dist_r: [0.1, 2], tp_r: [0, 10],
    risk_pct: [0.1, 3], max_lev: [1, 10],
  },
};
export const BOT_DECIMALS = {
  TrendBreakout: { entry_period: 0, exit_period: 0, r_atr: 1, risk_pct: 2, max_lev: 0 },
  DonchianRevert: {
    dc_period: 0, dc_long: 3, dc_short: 3, adx_min: 0, vol_max: 2, atr_min_pct: 2, r_atr: 1,
    trail_start_r: 1, trail_dist_r: 1, tp_r: 1, risk_pct: 2, max_lev: 0,
  },
};

const fail = (msg) => { throw new Error(msg); };

function checkLimits(bot, params) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) fail(`Missing value for ${k}`);
    const lim = BOT_LIMITS[bot][k];
    if (lim && (v < lim[0] || v > lim[1])) fail(`the bot accepts ${k} from ${lim[0]} to ${lim[1]} (now ${v})`);
    const dec = BOT_DECIMALS[bot][k];
    if (dec !== undefined && Math.abs(+v.toFixed(dec) - v) > 1e-9) {
      fail(dec ? `the bot takes ${k} with at most ${dec} decimals (now ${v})` : `the bot needs a whole number for ${k} (now ${v})`);
    }
  }
  return params;
}

function sameTf(conds, side, tradeTf) {
  conds.forEach((c, i) => {
    if ((c.tf || tradeTf) !== tradeTf) fail(`${side} #${i + 1}: the bot only uses ${tradeTf} candles for every condition`);
  });
}

// ---------------------------------------------------------------- TrendBreakout
const TB = {
  tf: "4h",
  read(conds, side, tradeTf) {
    sameTf(conds, side, tradeTf);
    const out = {};
    const brkOp = side === "Long" ? ">" : "<", brkVal = side === "Long" ? 1 : 0;
    const emaOp = side === "Long" ? ">" : "<";
    for (const [i, c] of conds.entries()) {
      const where = `${side} #${i + 1}`;
      if (c.ind === "dbrk") {
        if (c.op !== brkOp || c.value !== brkVal) fail(`${where}: bot ${side} needs Donchian breakout ${brkOp} ${brkVal}`);
        if ("n" in out) fail(`${where}: only one Donchian breakout condition per side`);
        out.n = c.params?.n;
      } else if (c.ind === "ema_dist") {
        if ((c.params?.n ?? 50) !== 200) fail(`${where}: the bot filters with EMA 200`);
        if (c.op !== emaOp || c.value !== 0) fail(`${where}: bot ${side} needs Distance to EMA ${emaOp} 0`);
        if (out.ema) fail(`${where}: EMA filter appears twice`);
        out.ema = true;
      } else fail(`${where}: the bot has no "${c.ind}" condition`);
    }
    if (!("n" in out)) fail(`${side} needs a Donchian breakout condition`);
    return out;
  },
  to(s) {
    const L = TB.read(s.long, "Long", s.tradeTf);
    const S = s.short?.length ? TB.read(s.short, "Short", s.tradeTf) : null;
    if (S && S.n !== L.n) fail("Long and Short must use the same breakout length");
    if (S && !!S.ema !== !!L.ema) fail("EMA filter must be on both sides or neither (bot has one switch)");
    const ex = s.exit || {}, acc = s.account || {};
    if (ex.maxHoldBars > 0) fail("The bot has no time exit: set Max bars to 0");
    if (ex.trailStartR > 0) fail("The bot has no trailing stop: set Trail at to 0");
    if (ex.tpR > 0) fail("The bot has no take-profit: set Take profit to 0");
    if (!(ex.exitChannel > 0)) fail("The bot exits on the channel: set Channel exit (exit_period)");
    if ((ex.atrN ?? 14) !== 20) fail("The bot measures R with ATR(20): set ATR bars to 20");
    return checkLimits("TrendBreakout", {
      entry_period: L.n, ema_filter: !!L.ema, short_enabled: !!S,
      exit_period: ex.exitChannel, r_atr: ex.rAtr, risk_pct: acc.riskPct, max_lev: acc.maxLev, fixed_lev: !!acc.fixedLev,
    });
  },
  from(s, p) {
    const out = JSON.parse(JSON.stringify(s));
    const side = (sign) => {
      const brk = { ind: "dbrk", params: { n: p.entry_period }, op: sign > 0 ? ">" : "<", value: sign > 0 ? 1 : 0 };
      const ema = { ind: "ema_dist", params: { n: 200 }, op: sign > 0 ? ">" : "<", value: 0 };
      return p.ema_filter ? [brk, ema] : [brk];
    };
    out.long = side(1);
    out.short = p.short_enabled ? side(-1) : [];
    out.exit = { ...out.exit, rAtr: p.r_atr, atrN: 20, trailStartR: 0, tpR: 0, maxHoldBars: 0, exitChannel: p.exit_period };
    out.account = { ...out.account, riskPct: p.risk_pct, maxLev: p.max_lev, fixedLev: !!p.fixed_lev };
    return out;
  },
};

// ---------------------------------------------------------------- DonchianRevert
const DR_RULES = {
  dpos: { n: null },                        // n = dc_period, phải giống nhau hai phía
  adx: { n: 14, op: ">", key: "adx_min" },
  vol_ratio: { n: 96, op: "<", key: "vol_max" },
  atr_pct: { n: 14, op: ">=", key: "atr_min_pct" },
};
const DR = {
  tf: "15m",
  read(conds, side, tradeTf) {
    sameTf(conds, side, tradeTf);
    const out = {};
    for (const [i, c] of conds.entries()) {
      const where = `${side} #${i + 1}`;
      const rule = DR_RULES[c.ind];
      if (!rule) fail(`${where}: the bot has no "${c.ind}" condition`);
      const n = c.params?.n;
      if (c.ind === "vol_ratio" && c.op === ">" && c.value === 0) continue;  // volume > 0: bot tự lọc
      if (c.ind === "dpos") {
        const op = side === "Long" ? "<=" : ">=";
        if (c.op !== op) fail(`${where}: bot ${side} needs Donchian position ${op} value`);
        if (out.dpos) fail(`${where}: only one Donchian condition per side`);
        out.dpos = { n, value: c.value };
        continue;
      }
      if (n !== rule.n) fail(`${where}: the bot uses ${c.ind} with n = ${rule.n}`);
      if (c.op !== rule.op) fail(`${where}: the bot needs ${c.ind} ${rule.op} value`);
      if (rule.key in out) fail(`${where}: ${c.ind} appears twice`);
      out[rule.key] = c.value;
    }
    return out;
  },
  to(s) {
    const L = DR.read(s.long, "Long", s.tradeTf);
    const S = s.short?.length ? DR.read(s.short, "Short", s.tradeTf) : null;
    if (!L.dpos) fail("Long needs a Donchian position ≤ condition");
    for (const k of ["adx_min", "vol_max", "atr_min_pct"]) {
      if (!(k in L)) fail(`Long is missing the ${k.replace("_min", "").replace("_max", "")} condition`);
      if (S && S[k] !== L[k]) fail(`Long and Short must use the same ${k} (bot has one value)`);
    }
    if (S && !S.dpos) fail("Short needs a Donchian position ≥ condition");
    if (S && S.dpos.n !== L.dpos.n) fail("Long and Short must use the same Donchian length");
    const ex = s.exit || {}, acc = s.account || {};
    if (ex.maxHoldBars > 0) fail("The bot has no time exit: set Max hold to 0");
    if (ex.exitChannel > 0) fail("The bot has no channel exit: set Channel exit to 0");
    if ((ex.atrN ?? 14) !== 14) fail("The bot measures R with ATR(14): set ATR bars to 14");
    const params = {
      dc_period: L.dpos.n, dc_long: L.dpos.value, adx_min: L.adx_min, vol_max: L.vol_max, atr_min_pct: L.atr_min_pct,
      short_enabled: !!S,
      r_atr: ex.rAtr, trail_on: ex.trailStartR > 0, tp_r: ex.tpR || 0,
      risk_pct: acc.riskPct, max_lev: acc.maxLev,
    };
    if (S) params.dc_short = S.dpos.value;
    if (ex.trailStartR > 0) { params.trail_start_r = ex.trailStartR; params.trail_dist_r = ex.trailDistR; }
    return checkLimits("DonchianRevert", params);
  },
  from(s, p) {
    const out = JSON.parse(JSON.stringify(s));
    const key = { adx: "adx_min", vol_ratio: "vol_max", atr_pct: "atr_min_pct" };
    const setSide = (conds, dposKey) => conds.map((c) => {
      if (c.ind === "dpos") return { ...c, params: { ...c.params, n: p.dc_period }, value: p[dposKey] };
      if (c.ind === "vol_ratio" && c.op === ">" && c.value === 0) return c;
      return key[c.ind] in p ? { ...c, value: p[key[c.ind]] } : c;
    });
    out.long = setSide(out.long, "dc_long");
    if (p.short_enabled) {
      // bot bật Short mà chiến lược chưa có: tạo phía Short đối xứng với Long
      const base = out.short?.length ? out.short : out.long.map((c) => (c.ind === "dpos" ? { ...c, op: ">=" } : c));
      out.short = setSide(base, "dc_short");
    } else out.short = [];
    out.exit = { ...out.exit, rAtr: p.r_atr, trailStartR: p.trail_on ? p.trail_start_r : 0, trailDistR: p.trail_dist_r, tpR: p.tp_r || 0 };
    out.account = { ...out.account, riskPct: p.risk_pct, maxLev: p.max_lev };
    return out;
  },
};

export const TEMPLATES = { TrendBreakout: TB, DonchianRevert: DR };

function template(bot) {
  const t = TEMPLATES[bot];
  if (!t) fail(`The app can't send parameters to a "${bot}" bot`);
  return t;
}

/**
 * @param s    chiến lược của app
 * @param bot  tên chiến lược bot đang chạy (/api/tune/schema .strategy)
 * @returns {{params: object}} — ném lỗi (tiếng Anh, hiện cho người dùng) nếu không khớp khuôn.
 */
export function toBotParams(s, bot = DEFAULT_BOT) {
  const t = template(bot);
  if (s.tradeTf !== t.tf) fail(`The ${bot} bot trades ${t.tf} candles (strategy uses ${s.tradeTf})`);
  if (!s.long?.length) fail("The bot always trades Long: add the Long conditions");
  return { params: t.to(s) };
}

/** Ngược lại toBotParams: đặt tham số bot đang chạy (p, từ /api/tune/schema .live) vào chiến lược s cùng khuôn,
 *  để backtest trong app đúng bộ số bot đang dùng. Ném lỗi nếu s không đúng khuôn của bot. */
export function fromBotParams(s, p, bot = DEFAULT_BOT) {
  toBotParams(s, bot);                                          // kiểm khuôn (ném lỗi với lý do)
  return template(bot).from(s, p);
}
