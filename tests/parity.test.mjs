// So bộ máy JS với freqtrade trên chiến lược mẫu DonchianRevert (BTC 15m, 01/2021 → 09/2026).
// Fixture lớn không commit; tạo bằng: python tools/export_parity.py (xem README). Thiếu fixture → bỏ qua.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildSignals } from "../js/rules.js";
import { backtest, stats } from "../js/engine.js";
import * as I from "../js/indicators.js";

const DATA = new URL("./fixtures/_btc15m_2020_2026.json", import.meta.url);
const REF = new URL("./fixtures/_ref_donchian_trades.json", import.meta.url);
const skip = !existsSync(DATA) || !existsSync(REF);

test("khớp freqtrade từng lệnh (DonchianRevert)", { skip }, () => {
  const fx = JSON.parse(readFileSync(DATA));
  const ref = JSON.parse(readFileSync(REF));
  const strat = JSON.parse(readFileSync(new URL("../presets/donchian_revert.json", import.meta.url)));
  const k = fx.candles;
  const startIdx = k.t.findIndex((t) => t >= Date.UTC(2021, 0, 1));
  const res = backtest(k, buildSignals(strat, k, k), I.atr(k.h, k.l, k.c, 14),
    { exit: strat.exit, account: strat.account, funding: fx.funding, startIdx });
  assert.equal(res.trades.length, ref.length, "số lệnh");
  res.trades.forEach((x, i) => {
    const r = ref[i];
    assert.equal(x.entryT, r.entryT, `lệnh ${i}: giờ vào`);
    assert.equal(x.dir, r.dir, `lệnh ${i}: chiều`);
    assert.equal(x.exitT, r.exitT, `lệnh ${i}: giờ ra`);
    assert.ok(Math.abs(x.exit - r.exit) < 0.1, `lệnh ${i}: giá ra ${x.exit} vs ${r.exit}`);
    assert.ok(Math.abs(x.pnl - r.pnl) < 0.01, `lệnh ${i}: lãi/lỗ ${x.pnl} vs ${r.pnl}`);
  });
  const s = stats(res, 1000, k.t[startIdx], k.t[k.t.length - 1]);
  const refPct = ref.reduce((a, x) => a + x.pnl, 0) / 10;
  assert.ok(Math.abs(s.profitPct - refPct) < 0.1, `lợi nhuận ${s.profitPct} vs ${refPct}`);
});
