import { test } from "node:test";
import assert from "node:assert/strict";
import { resample, alignToBase, TF_MS } from "../js/timeframes.js";
import { buildSignals } from "../js/rules.js";

const T0 = Date.UTC(2025, 0, 1);
const M15 = TF_MS["15m"];
// 8 nến 15m = 2 nến 1h; giá tăng dần để dễ kiểm tra
const base = { t: [], o: [], h: [], l: [], c: [], v: [] };
for (let i = 0; i < 8; i++) {
  base.t.push(T0 + i * M15); base.o.push(100 + i); base.h.push(101 + i); base.l.push(99 + i); base.c.push(100.5 + i); base.v.push(1 + i);
}

test("ghép nến 15m → 1h đúng OHLCV", () => {
  const h = resample(base, "1h");
  assert.deepEqual(h.t, [T0, T0 + 3600e3]);
  assert.deepEqual(h.o, [100, 104]); assert.deepEqual(h.h, [104, 108]);
  assert.deepEqual(h.l, [99, 103]); assert.deepEqual(h.c, [103.5, 107.5]);
  assert.deepEqual(h.v, [1 + 2 + 3 + 4, 5 + 6 + 7 + 8]);
});

test("khung lớn chỉ dùng nến đã đóng (không nhìn trước tương lai)", () => {
  const h = resample(base, "1h");
  const x = alignToBase(base, "15m", h, "1h", [10, 20]);
  // nến 1h đầu (00:00–01:00) đóng lúc 01:00 = lúc nến 15m 00:45 đóng → có hiệu lực từ nến 00:45
  assert.deepEqual(Array.from(x), [NaN, NaN, NaN, 10, 10, 10, 10, 20]);
});

test("Long và Short cùng lúc thì bỏ tín hiệu (như freqtrade)", () => {
  const s = { tradeTf: "15m", long: [{ ind: "roc", params: { n: 1 }, op: ">", value: 0 }], short: [{ ind: "roc", params: { n: 1 }, op: ">", value: 0 }] };
  assert.ok(buildSignals(s, base, base).every((v) => v === 0));
  const onlyLong = buildSignals({ ...s, short: [] }, base, base);
  assert.deepEqual(Array.from(onlyLong), [0, 1, 1, 1, 1, 1, 1, 1]);
});
