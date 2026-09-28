// So từng giá trị chỉ báo JS với TA-Lib (fixture sinh từ Python). Chạy: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as I from "../js/indicators.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/talib_btc15m.json", import.meta.url)));
const { o, h, l, c, v } = fx.candles;
const ref = fx.talib;

function same(name, got, want, tol = 1e-6) {
  assert.equal(got.length, want.length, `${name}: độ dài`);
  let checked = 0;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === null) {
      assert.ok(Number.isNaN(got[i]), `${name}[${i}]: TA-Lib NaN, JS ${got[i]}`);
      continue;
    }
    const tolAbs = tol * Math.max(1, Math.abs(want[i]));
    assert.ok(Math.abs(got[i] - want[i]) <= tolAbs, `${name}[${i}]: JS ${got[i]} vs TA-Lib ${want[i]}`);
    checked++;
  }
  assert.ok(checked > 2000, `${name}: quá ít giá trị để so`);
}

test("SMA / EMA", () => { same("sma20", I.sma(c, 20), ref.sma20); same("ema50", I.ema(c, 50), ref.ema50); });
test("RSI", () => { same("rsi14", I.rsi(c, 14), ref.rsi14); same("rsi2", I.rsi(c, 2), ref.rsi2); });
test("ATR", () => same("atr14", I.atr(h, l, c, 14), ref.atr14));
test("ADX / DI", () => {
  const d = I.dmi(h, l, c, 14);
  same("adx14", d.adx, ref.adx14);
  // TA-Lib PLUS_DI/MINUS_DI có lookback n (không phải 2n-1): so từ vị trí đó trở đi
  for (const [k, arr] of [["pdi14", d.pdi], ["mdi14", d.mdi]]) {
    const want = ref[k], first = want.findIndex((x) => x !== null);
    same(k, arr.slice(first), want.slice(first));
  }
});
test("Bollinger", () => {
  const b = I.bbands(c, 20, 2);
  same("bbu", b.up, ref.bbu); same("bbm", b.mid, ref.bbm); same("bbl", b.lo, ref.bbl);
});
test("CCI / Williams %R / MFI", () => {
  same("cci20", I.cci(h, l, c, 20), ref.cci20);
  same("willr14", I.willr(h, l, c, 14), ref.willr14);
  same("mfi14", I.mfi(h, l, c, v, 14), ref.mfi14);
});
test("Stochastic", () => { const s = I.stoch(h, l, c); same("stochk", s.k, ref.stochk); same("stochd", s.d, ref.stochd); });
test("MACD", () => {
  const m = I.macd(c);
  same("macd", m.line, ref.macd); same("macdsig", m.signal, ref.macdsig); same("macdhist", m.hist, ref.macdhist);
});
test("ROC", () => same("roc4", I.roc(c, 4), ref.roc4));

test("donchianBreak: so với kênh của N nến trước, không tính nến hiện tại", () => {
  const h = [10, 11, 12, 11, 15, 9], l = [8, 9, 10, 9, 10, 5], c = [9, 10, 11, 10, 14, 6];
  const x = I.donchianBreak(h, l, c, 3);
  assert.ok(Number.isNaN(x[2]));
  assert.equal(x[3], (10 - 8) / (12 - 8));                // kênh nến 0–2
  assert.ok(x[4] > 1);                                     // 14 > đỉnh 12 của nến 1–3
  assert.ok(x[5] < 0);                                     // 6 < đáy 9 của nến 2–4
});
