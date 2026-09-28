// So bộ máy JS với freqtrade từng lệnh: DonchianRevert, BTC/USDT futures 15m, quản lý lệnh trên nến 1m
// (--timeframe-detail 1m), tham số mặc định, 01/02 → 20/03/2026. Fixture tạo bằng tools/export_parity.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resample } from "../js/timeframes.js";
import { buildSignals } from "../js/rules.js";
import { backtest, stats, DEFAULT_ACCOUNT } from "../js/engine.js";
import * as I from "../js/indicators.js";

const fx = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/parity_donchian_1m.json.gz", import.meta.url))));
const m = fx.candles1m;
const k1 = { t: m.dt.map((d) => m.t0 + d * 60e3), o: m.o.map((x) => x / 10), h: m.h.map((x) => x / 10),
  l: m.l.map((x) => x / 10), c: m.c.map((x) => x / 10), v: m.v };

test("khớp freqtrade từng lệnh (DonchianRevert, nến 1m detail)", () => {
  const strat = JSON.parse(readFileSync(new URL("../presets/donchian_revert.json", import.meta.url)));
  const k = resample(k1, "15m");
  const startIdx = k.t.findIndex((t) => t >= fx.start);
  const account = { ...DEFAULT_ACCOUNT, ...strat.account, fee: fx.fee, wallet: fx.wallet };
  const res = backtest(k, buildSignals(strat, k, k1), I.atr(k.h, k.l, k.c, 14),
    { exit: strat.exit, account, funding: fx.funding, startIdx, detail: k1, detailMs: 15 * 60e3 });
  assert.ok(fx.trades.length >= 10, "fixture có đủ lệnh");
  assert.equal(res.trades.length, fx.trades.length, "số lệnh");
  res.trades.forEach((x, i) => {
    const r = fx.trades[i];
    assert.equal(x.entryT, r.entryT, `lệnh ${i}: giờ vào`);
    assert.equal(x.dir, r.dir, `lệnh ${i}: chiều`);
    assert.equal(x.exitT, r.exitT, `lệnh ${i}: giờ ra`);
    assert.ok(Math.abs(x.entry - r.entry) < 1e-6, `lệnh ${i}: giá vào ${x.entry} vs ${r.entry}`);
    assert.ok(Math.abs(x.exit - r.exit) < 1e-6, `lệnh ${i}: giá ra ${x.exit} vs ${r.exit}`);
    assert.ok(Math.abs(x.amount - r.amount) < 1e-9, `lệnh ${i}: khối lượng ${x.amount} vs ${r.amount}`);
    assert.equal(x.leverage, r.leverage, `lệnh ${i}: đòn bẩy`);
    assert.ok(Math.abs(x.pnl - r.pnl) < 1e-6, `lệnh ${i}: lãi/lỗ ${x.pnl} vs ${r.pnl}`);
  });
  const s = stats(res, fx.wallet, k.t[startIdx], k.t[k.t.length - 1]);
  const refPct = fx.trades.reduce((a, x) => a + x.pnl, 0) / fx.wallet * 100;
  assert.ok(Math.abs(s.profitPct - refPct) < 1e-6, `lợi nhuận ${s.profitPct} vs ${refPct}`);
});
