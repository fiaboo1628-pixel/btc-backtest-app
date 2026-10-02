// Nút "Send to bot" / "Use bot's values": chiến lược app ↔ tham số freqtrade, theo khuôn của chiến lược bot đang chạy
// (TrendBreakout hiện tại; DonchianRevert giữ khuôn cũ).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toBotParams, fromBotParams, BOT_LIMITS, BOT_DECIMALS, DEFAULT_BOT } from "../js/botparams.js";
import { DEFAULT_EXIT, DEFAULT_ACCOUNT } from "../js/engine.js";

const preset = (f) => JSON.parse(readFileSync(new URL(`../presets/${f}`, import.meta.url)));
const full = (s) => ({ ...s, exit: { ...DEFAULT_EXIT, ...s.exit }, account: { ...DEFAULT_ACCOUNT, ...s.account } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const py = (bot) => readFileSync(new URL(`../bot/user_data/strategies/${bot}.py`, import.meta.url), "utf8");
// giá trị mặc định của một *Parameter trong file chiến lược
const pyDefault = (src, k) => {
  const m = src.match(new RegExp(`${k} = \\w+Parameter\\(.*default=([^,)]+)`));
  assert.ok(m, k);
  return m[1] === "True" ? true : m[1] === "False" ? false : Number(m[1]);
};

// ---------------------------------------------------------------- TrendBreakout (bot đang chạy)
const TB_DEFAULTS = {
  entry_period: 20, ema_filter: true, short_enabled: true, exit_period: 10, r_atr: 2, risk_pct: 0.25, max_lev: 5, fixed_lev: true,
};

test("bot mặc định là TrendBreakout; preset khớp đúng tham số mặc định của bot", () => {
  assert.equal(DEFAULT_BOT, "TrendBreakout");
  assert.deepEqual(toBotParams(full(preset("trend_breakout.json"))).params, TB_DEFAULTS);
  assert.deepEqual(toBotParams(full(preset("trend_breakout.json")), "TrendBreakout").params, TB_DEFAULTS);
});

test("mặc định trong TrendBreakout.py đúng như bảng trên (halt_on không gửi, giữ của bot)", () => {
  const src = py("TrendBreakout");
  for (const [k, v] of Object.entries(TB_DEFAULTS)) assert.equal(pyDefault(src, k), v, k);
  assert.equal(pyDefault(src, "halt_on"), true);
  assert.equal("halt_on" in TB_DEFAULTS, false);
});

test("TrendBreakout: tắt EMA, tắt Short, đổi kênh / stop / rủi ro", () => {
  const s = full(preset("trend_breakout.json"));
  s.long.splice(1, 1); s.short = [];
  s.long[0].params.n = 55; s.exit.exitChannel = 27; s.exit.rAtr = 1.5; s.account.riskPct = 0.5; s.account.maxLev = 3; s.account.fixedLev = false;
  assert.deepEqual(toBotParams(s).params, {
    entry_period: 55, ema_filter: false, short_enabled: false, exit_period: 27, r_atr: 1.5, risk_pct: 0.5, max_lev: 3, fixed_lev: false,
  });
});

test("TrendBreakout: không khớp khuôn thì báo lý do", () => {
  const base = full(preset("trend_breakout.json"));
  const bad = [
    [(s) => { s.tradeTf = "1h"; }, /4h candles/],
    [(s) => { s.long.push({ ind: "rsi", params: { n: 14 }, op: "<=", value: 30 }); }, /no "rsi"/],
    [(s) => { s.long[0].value = 0.9; }, /Donchian breakout > 1/],
    [(s) => { s.short[0].op = "<="; }, /Donchian breakout < 0/],
    [(s) => { s.long[1].params.n = 100; }, /EMA 200/],
    [(s) => { s.long[1].value = 0.5; }, /Distance to EMA > 0/],
    [(s) => { s.short.splice(1, 1); }, /both sides or neither/],
    [(s) => { s.short[0].params.n = 30; }, /same breakout length/],
    [(s) => { s.long[0].tf = "1d"; }, /4h candles for every condition/],
    [(s) => { s.exit.maxHoldBars = 10; }, /time exit/],
    [(s) => { s.exit.trailStartR = 2; }, /trailing/],
    [(s) => { s.exit.tpR = 3; }, /take-profit/],
    [(s) => { s.exit.exitChannel = 0; }, /Channel exit/],
    [(s) => { s.exit.atrN = 14; }, /ATR\(20\)/],
    [(s) => { s.long = []; }, /Long/],
    [(s) => { s.long = s.long.slice(1); }, /needs a Donchian breakout/],
    [(s) => { s.long[0].params.n = 120; s.short[0].params.n = 120; }, /entry_period from 10 to 100/],
    [(s) => { s.exit.exitChannel = 60; }, /exit_period from 5 to 50/],
    [(s) => { s.exit.rAtr = 2.25; }, /r_atr with at most 1 decimals/],
    [(s) => { s.account.riskPct = 0.125; }, /risk_pct with at most 2 decimals/],
    [(s) => { s.account.maxLev = 20; }, /max_lev from 1 to 10/],
  ];
  for (const [mut, re] of bad) {
    const s = clone(base); mut(s);
    assert.throws(() => toBotParams(s), re);
  }
  for (const f of ["donchian_revert.json", "bb_revert.json", "msb_ob_retest.json", "trend_1h_filter.json"]) {
    assert.throws(() => toBotParams(full(preset(f))), Error, f);
  }
  assert.throws(() => toBotParams(base, "Unknown"), /can't send parameters to a "Unknown" bot/);
});

test("TrendBreakout: fromBotParams rồi toBotParams ra đúng bộ số bot đang chạy", () => {
  const s = full(preset("trend_breakout.json"));
  const live = { ...TB_DEFAULTS, entry_period: 14, exit_period: 15, r_atr: 1.0, risk_pct: 0.2, max_lev: 4, halt_on: false };
  const { halt_on, ...sent } = live;
  assert.deepEqual(toBotParams(fromBotParams(s, live)).params, sent);
  // tắt EMA và Short trên bot → chiến lược mất điều kiện EMA và phía Short; bật lại thì dựng lại
  const off = fromBotParams(s, { ...live, ema_filter: false, short_enabled: false });
  assert.equal(off.long.length, 1); assert.equal(off.short.length, 0);
  assert.deepEqual(toBotParams(fromBotParams(off, live)).params, sent);
  // chiến lược khác khuôn thì báo lỗi, không ghi đè
  assert.throws(() => fromBotParams(full(preset("donchian_revert.json")), live), /4h candles/);
});

// ---------------------------------------------------------------- DonchianRevert (bot cũ, khuôn giữ lại)
const DR_DEFAULTS = {
  dc_period: 20, dc_long: 0.074, dc_short: 0.944, adx_min: 30, vol_max: 1.0, atr_min_pct: 0.4,
  short_enabled: true, r_atr: 3, trail_on: true, trail_start_r: 2, trail_dist_r: 1.0, tp_r: 0,
  risk_pct: 0.5, max_lev: 5,
};

test("DonchianRevert: preset khớp đúng tham số mặc định của bot cũ", () => {
  assert.deepEqual(toBotParams(full(preset("donchian_revert.json")), "DonchianRevert").params, DR_DEFAULTS);
  const src = py("DonchianRevert");
  for (const [k, v] of Object.entries(DR_DEFAULTS)) assert.equal(pyDefault(src, k), v, k);
});

test("DonchianRevert: chỉnh ngưỡng, tắt Short, tắt trailing; sai khuôn thì báo lý do", () => {
  const s = full(preset("donchian_revert.json"));
  s.long[0].value = 0.05; s.long[1].value = 25; s.short = []; s.exit.trailStartR = 0; s.account.riskPct = 0.75;
  const p = toBotParams(s, "DonchianRevert").params;
  assert.equal(p.dc_long, 0.05); assert.equal(p.adx_min, 25); assert.equal(p.short_enabled, false);
  assert.equal(p.trail_on, false); assert.equal("trail_start_r" in p, false); assert.equal("dc_short" in p, false);
  assert.equal(p.risk_pct, 0.75);
  const base = full(preset("donchian_revert.json"));
  for (const [mut, re] of [
    [(x) => { x.tradeTf = "1h"; }, /15m/],
    [(x) => { x.long[1].params.n = 20; }, /n = 14/],
    [(x) => { x.short[1].value = 35; }, /same adx_min/],
    [(x) => { x.exit.exitChannel = 10; }, /channel exit/],
    [(x) => { x.exit.trailStartR = 8; }, /trail_start_r from 0.5 to 5/],
    [(x) => { x.long[0].value = 0.0745; }, /dc_long with at most 3 decimals/],
  ]) { const x = clone(base); mut(x); assert.throws(() => toBotParams(x, "DonchianRevert"), re); }
  assert.throws(() => toBotParams(full(preset("trend_breakout.json")), "DonchianRevert"), /15m/);
});

test("DonchianRevert: fromBotParams rồi toBotParams ra đúng bộ số", () => {
  const s = full(preset("donchian_revert.json"));
  const live = { ...DR_DEFAULTS, dc_period: 25, dc_long: 0.05, dc_short: 0.95, adx_min: 28, vol_max: 1.2,
    atr_min_pct: 0.35, r_atr: 2.5, trail_start_r: 1.5, trail_dist_r: 0.3, tp_r: 4, risk_pct: 0.5, max_lev: 3 };
  assert.deepEqual(toBotParams(fromBotParams(s, live, "DonchianRevert"), "DonchianRevert").params, live);
  const noShort = fromBotParams(s, { ...live, short_enabled: false }, "DonchianRevert");
  assert.equal(noShort.short.length, 0);
  assert.deepEqual(toBotParams(fromBotParams(noShort, live, "DonchianRevert"), "DonchianRevert").params, live);
});

// ---------------------------------------------------------------- giới hạn và số lẻ khớp file chiến lược
test("giới hạn và số chữ số thập phân trong app khớp *Parameter trong file chiến lược", () => {
  for (const bot of Object.keys(BOT_LIMITS)) {
    const src = py(bot);
    for (const [k, [lo, hi]] of Object.entries(BOT_LIMITS[bot])) {
      const m = src.match(new RegExp(`${k} = \\w+Parameter\\(([^,]+), ([^,]+),`));
      assert.ok(m, `${bot}.${k}`);
      assert.deepEqual([Number(m[1]), Number(m[2])], [lo, hi], `${bot}.${k}`);
    }
    for (const [k, dec] of Object.entries(BOT_DECIMALS[bot])) {
      const d = src.match(new RegExp(`${k} = DecimalParameter\\(.*decimals=(\\d+)`));
      assert.equal(d ? Number(d[1]) : 0, dec, `${bot}.${k}`);
    }
  }
});
