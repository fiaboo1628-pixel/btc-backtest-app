// Nút "Send to bot": chiến lược app → tham số DonchianRevert của freqtrade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toBotParams, fromBotParams, BOT_LIMITS, BOT_DECIMALS } from "../js/botparams.js";
import { DEFAULT_EXIT, DEFAULT_ACCOUNT } from "../js/engine.js";

const preset = (f) => JSON.parse(readFileSync(new URL(`../presets/${f}`, import.meta.url)));
const full = (s) => ({ ...s, exit: { ...DEFAULT_EXIT, ...s.exit }, account: { ...DEFAULT_ACCOUNT, ...s.account } });
const clone = (x) => JSON.parse(JSON.stringify(x));

// giá trị mặc định trong bot/user_data/strategies/DonchianRevert.py
const BOT_DEFAULTS = {
  dc_period: 20, dc_long: 0.074, dc_short: 0.944, adx_min: 30, vol_max: 1.0, atr_min_pct: 0.4,
  short_enabled: true, r_atr: 3, trail_on: true, trail_start_r: 2, trail_dist_r: 1.0, tp_r: 0,
  risk_pct: 1, max_lev: 5,
};

test("preset DonchianRevert khớp đúng tham số mặc định của bot", () => {
  assert.deepEqual(toBotParams(full(preset("donchian_revert.json"))).params, BOT_DEFAULTS);
});

test("mặc định trong DonchianRevert.py đúng như bảng trên", () => {
  const py = readFileSync(new URL("../bot/user_data/strategies/DonchianRevert.py", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(BOT_DEFAULTS)) {
    const m = py.match(new RegExp(`${k} = \\w+Parameter\\(.*default=([^,)]+)`));
    assert.ok(m, k);
    const d = m[1] === "True" ? true : m[1] === "False" ? false : Number(m[1]);
    assert.equal(d, v, k);
  }
});

test("chỉnh ngưỡng, tắt Short, tắt trailing", () => {
  const s = full(preset("donchian_revert.json"));
  s.long[0].value = 0.05; s.long[1].value = 25; s.long[1 + 0].params.n = 14;
  s.short = []; s.exit.trailStartR = 0; s.account.riskPct = 0.5;
  const p = toBotParams(s).params;
  assert.equal(p.dc_long, 0.05); assert.equal(p.adx_min, 25); assert.equal(p.short_enabled, false);
  assert.equal(p.trail_on, false); assert.equal("trail_start_r" in p, false); assert.equal("trail_dist_r" in p, false); assert.equal("dc_short" in p, false);
  assert.equal(p.risk_pct, 0.5);
});

test("không khớp khuôn thì báo lý do", () => {
  const base = full(preset("donchian_revert.json"));
  const bad = [
    [(s) => { s.tradeTf = "1h"; }, /15m/],
    [(s) => { s.long.push({ ind: "rsi", params: { n: 14 }, op: "<=", value: 30 }); }, /no "rsi"/],
    [(s) => { s.long[1].params.n = 20; }, /n = 14/],
    [(s) => { s.short[1].value = 35; }, /same adx_min/],
    [(s) => { s.short[0].params.n = 30; }, /same Donchian/],
    [(s) => { s.long[0].tf = "1h"; }, /15m candles/],
    [(s) => { s.exit.maxHoldBars = 10; }, /time exit/],
    [(s) => { s.long.splice(1, 1); s.short.splice(1, 1); }, /missing the adx/],
    [(s) => { s.long = []; }, /Long/],
    [(s) => { s.exit.trailStartR = 8; }, /trail_start_r from 0.5 to 5/],
    [(s) => { s.exit.trailDistR = 3; }, /trail_dist_r from 0.1 to 2/],
    [(s) => { s.account.maxLev = 20; }, /max_lev from 1 to 10/],
    [(s) => { s.long[0].params.n = 20.5; s.short[0].params.n = 20.5; }, /whole number for dc_period/],
    [(s) => { s.long[0].value = 0.0745; }, /dc_long with at most 3 decimals/],
    [(s) => { s.exit.rAtr = 2.25; }, /r_atr with at most 1 decimals/],
  ];
  for (const [mut, re] of bad) {
    const s = clone(base); mut(s);
    assert.throws(() => toBotParams(s), re);
  }
  for (const f of ["bb_revert.json", "msb_ob_retest.json", "trend_1h_filter.json"]) {
    assert.throws(() => toBotParams(full(preset(f))), Error, f);
  }
});

test("giới hạn trong app khớp giới hạn trong DonchianRevert.py", () => {
  const py = readFileSync(new URL("../bot/user_data/strategies/DonchianRevert.py", import.meta.url), "utf8");
  for (const [k, [lo, hi]] of Object.entries(BOT_LIMITS)) {
    const m = py.match(new RegExp(`${k} = \\w+Parameter\\(([^,]+), ([^,]+),`));
    assert.ok(m, k);
    assert.deepEqual([Number(m[1]), Number(m[2])], [lo, hi], k);
  }
});

test("số chữ số thập phân trong app khớp DonchianRevert.py", () => {
  const py = readFileSync(new URL("../bot/user_data/strategies/DonchianRevert.py", import.meta.url), "utf8");
  for (const [k, dec] of Object.entries(BOT_DECIMALS)) {
    const m = py.match(new RegExp(`${k} = (\\w+)Parameter\\(.*?(?:decimals=(\\d+))?[,)]`));
    assert.ok(m, k);
    const d = py.match(new RegExp(`${k} = DecimalParameter\\(.*decimals=(\\d+)`));
    assert.equal(d ? Number(d[1]) : 0, dec, k);
  }
});

test("Lấy tham số bot: fromBotParams rồi toBotParams ra đúng bộ số bot đang chạy", () => {
  const s = full(preset("donchian_revert.json"));
  const live = { ...BOT_DEFAULTS, dc_period: 25, dc_long: 0.05, dc_short: 0.95, adx_min: 28, vol_max: 1.2,
    atr_min_pct: 0.35, r_atr: 2.5, trail_start_r: 1.5, trail_dist_r: 0.3, tp_r: 4, risk_pct: 0.5, max_lev: 3 };
  assert.deepEqual(toBotParams(fromBotParams(s, live)).params, live);
  // tắt Short rồi bật lại: phía Short được dựng đối xứng với Long
  const noShort = fromBotParams(s, { ...live, short_enabled: false });
  assert.equal(noShort.short.length, 0);
  assert.deepEqual(toBotParams(fromBotParams(noShort, live)).params, live);
  // tắt trailing
  const p = toBotParams(fromBotParams(s, { ...live, trail_on: false })).params;
  assert.equal(p.trail_on, false);
  // chiến lược sai khuôn thì báo lỗi
  assert.throws(() => fromBotParams({ ...s, tradeTf: "1h" }, live), /15m/);
});
