// So backtest nhiều coin chung tài khoản của app với freqtrade từng lệnh: TrendBreakout, 5 coin của bot, nến 4h,
// không nến chi tiết (để so được từng lệnh), tham số mặc định. Fixture tạo bằng tools/export_parity_trend.py
// (workflow parity-trend). Đặt PARITY_TREND_FIXTURE để thử với fixture khác.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildSignals } from "../js/rules.js";
import { stats, DEFAULT_ACCOUNT } from "../js/engine.js";
import { backtestPortfolio, inferPriceSteps } from "../js/portfolio.js";
import * as I from "../js/indicators.js";

const path = process.env.PARITY_TREND_FIXTURE || new URL("./fixtures/parity_trend_4h.json.gz", import.meta.url);
const H = 4 * 3600e3;

test("khớp freqtrade từng lệnh (TrendBreakout, 5 coin chung tài khoản, nến 4h)", { skip: !existsSync(path) && "chưa có fixture" }, () => {
  const fx = JSON.parse(gunzipSync(readFileSync(path)));
  const strat = JSON.parse(readFileSync(new URL("../presets/trend_breakout.json", import.meta.url)));
  // fixture chạy với phí/bước giá của lần backtest, không theo preset
  const account = { ...DEFAULT_ACCOUNT, ...strat.account, fee: fx.fee, wallet: fx.wallet, slippage: 0 };
  const pairs = fx.coins.map((k) => {
    const c = { t: k.dt.map((d) => k.t0 + d * H), o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
    // freqtrade suy bước giá từ số lẻ của nến theo từng tháng (tháng toàn số nguyên → bước của sàn); app suy y như vậy
    assert.deepEqual(inferPriceSteps(c), k.priceSteps, `${k.symbol}: bước giá theo tháng app suy khác freqtrade`);
    return { name: k.symbol, c, sig: buildSignals(strat, c, c), atr: I.atr(c.h, c.l, c.c, strat.exit.atrN), funding: k.funding,
      account: { priceSteps: k.priceSteps, priceStep: k.priceStepFallback, amountStep: k.amountStep } };
  });
  // freqtrade bỏ nến đầu của khoảng (chỉ lấy tín hiệu), xử lý tới hết nến tại mốc cuối (chỉ thoát, không vào lệnh mới);
  // app vẫn có thể vào lệnh ở nến cuối — lệnh đó đóng ngay vì hết dữ liệu ("end") nên không so
  const res = backtestPortfolio(pairs, { exit: strat.exit, account, maxOpen: fx.maxOpen, from: fx.start + H, to: fx.end + H });
  const key = (x) => `${x.pair} ${x.dir > 0 ? "L" : "S"} ${x.entryT}`;
  const ref = new Map(fx.trades.filter((x) => x.reason !== "force_exit").map((x) => [key(x), x]));
  const mine = res.trades.filter((x) => x.reason !== "end");
  assert.ok(ref.size >= 20, "fixture có đủ lệnh");
  const missing = [...ref.keys()].filter((k) => !mine.some((x) => key(x) === k));
  const extra = mine.filter((x) => !ref.has(key(x))).map(key);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, "lệnh trùng coin + chiều + giờ vào");
  for (const x of mine) {
    const r = ref.get(key(x)), id = key(x);
    assert.equal(x.exitT, r.exitT, `${id}: giờ ra`);
    assert.ok(Math.abs(x.entry - r.entry) < 1e-6, `${id}: giá vào ${x.entry} vs ${r.entry}`);
    assert.ok(Math.abs(x.exit - r.exit) < 1e-6, `${id}: giá ra ${x.exit} vs ${r.exit}`);
    assert.ok(Math.abs(x.amount - r.amount) < 1e-9, `${id}: khối lượng ${x.amount} vs ${r.amount}`);
    assert.equal(x.leverage, r.leverage, `${id}: đòn bẩy`);
    assert.ok(Math.abs(x.pnl - r.pnl) < 1e-4, `${id}: lãi/lỗ ${x.pnl} vs ${r.pnl}`);
  }
  // lệnh còn mở khi hết dữ liệu: freqtrade đóng ở giá MỞ nến cuối (force_exit), app ở giá đóng ("end") → chỉ so coin + chiều
  // (bỏ lệnh app vào ngay nến cuối — freqtrade không vào lệnh ở nến cuối)
  const left = fx.trades.filter((x) => x.reason === "force_exit").map((x) => `${x.pair} ${x.dir}`).sort();
  assert.deepEqual(res.trades.filter((x) => x.reason === "end" && x.entryT < fx.end).map((x) => `${x.pair} ${x.dir}`).sort(), left,
    "lệnh còn mở cuối kỳ");
  const sum = (xs) => xs.reduce((a, x) => a + x.pnl, 0);
  assert.ok(Math.abs(sum(mine) - sum([...ref.values()])) < 1e-3, `tổng lãi/lỗ các lệnh đã đóng ${sum(mine)} vs ${sum([...ref.values()])}`);
  assert.ok(stats(res, fx.wallet, fx.start, fx.end).profitPct > 0 === fx.trades.reduce((a, x) => a + x.pnl, 0) > 0, "cùng dấu lợi nhuận");
});
