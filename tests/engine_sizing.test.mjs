// Khối lượng và làm tròn như freqtrade: nâng lệnh quá nhỏ lên mức tối thiểu của sàn, đòn bẩy cố định,
// bước giá theo tháng suy từ nến.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest } from "../js/engine.js";
import { inferPriceSteps, stepsFor } from "../js/portfolio.js";

const H = 4 * 3600e3;
const flat = (px, n) => {
  const k = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < n; i++) { k.t.push(i * H); k.o.push(px); k.h.push(px * 1.001); k.l.push(px * 0.999); k.c.push(px); }
  return k;
};
const acc = { wallet: 1000, riskPct: 0.25, maxLev: 5, fixedLev: true, fee: 0, tradableRatio: 1, amountStep: 0.001, priceStep: 0.1 };
const exit = { rAtr: 2, trailStartR: 0 };

test("lệnh quá nhỏ: nâng lên khối lượng tối thiểu nếu phải nâng ≤ 30%, bỏ nếu hơn (validate_stake_amount)", () => {
  // BTC 65000, R = 2 × ATR 1465 = 2930 → rủi ro 2.5 USDT → 0.00085 BTC (< bước 0.001)
  // ký quỹ tối thiểu = max(5 × 1.105, 0.001 × 65000 × 1.05) / 5 = 13.65; ký quỹ muốn = 0.00085×65000/5 = 11.1 → ×1.3 ≥ 13.65 → nâng
  const k = flat(65000, 6); const sig = new Int8Array(6); sig[1] = 1;
  const t = backtest(k, sig, new Float64Array(6).fill(1465), { account: acc, exit }).trades[0];
  assert.ok(t, "có lệnh");
  assert.equal(t.amount, 0.001);
  assert.equal(t.leverage, 5);
  // rủi ro 0.1% → 0.00034 BTC, ký quỹ 4.4 × 1.3 < 13.65 → bỏ lệnh
  assert.equal(backtest(k, sig, new Float64Array(6).fill(1465), { account: { ...acc, riskPct: 0.1 }, exit }).trades.length, 0);
  // coin rẻ: giá trị tối thiểu 5 USDT quyết định (0.1 × 1 USDT), rủi ro 1% → 10 USDT/R(0.2) = 50 coin, không cần nâng
  const d = flat(1, 6);
  const td = backtest(d, sig, new Float64Array(6).fill(0.1), { account: { ...acc, riskPct: 1, amountStep: 1, priceStep: 0.0001 }, exit }).trades[0];
  assert.equal(td.amount, 50);
});

test("fixedLev: đòn bẩy luôn = trần, khối lượng (notional) không đổi so với đòn bẩy tự tính", () => {
  const k = flat(100, 6); const sig = new Int8Array(6); sig[1] = 1;
  const atr = new Float64Array(6).fill(0.5);                   // R = 1 = 1% giá → rủi ro 1% cần đòn bẩy 1
  const a = backtest(k, sig, atr, { account: { ...acc, riskPct: 1, fixedLev: false, amountStep: 0.0001 }, exit }).trades[0];
  const b = backtest(k, sig, atr, { account: { ...acc, riskPct: 1, fixedLev: true, amountStep: 0.0001 }, exit }).trades[0];
  assert.equal(a.leverage, 1); assert.equal(b.leverage, 5);
  assert.ok(Math.abs(a.amount - b.amount) < 1e-9);
  assert.ok(Math.abs(a.amount - 10) < 1e-9);                   // 1000 × 1% / R 1 = 10 coin
});

test("hardStop: đòn bẩy ≤ floor(0.9 × |stoploss| / R%) như leverage() của bot, kể cả khi fixedLev", () => {
  const k = flat(100, 6); const sig = new Int8Array(6); sig[1] = 1;
  // R = 2 × 5 = 10 = 10% giá → cap = floor(0.9 × 0.5 / 0.1) = 4 < maxLev 5; notional không đổi (10 USDT/R → 1 coin)
  const a = { ...acc, riskPct: 1, amountStep: 0.0001, hardStop: 0.5 };
  const t = backtest(k, sig, new Float64Array(6).fill(5), { account: a, exit }).trades[0];
  assert.equal(t.leverage, 4); assert.ok(Math.abs(t.amount - 1) < 1e-9);
  // không fixedLev: cần đòn bẩy 1 → cap không chặn; R nhỏ (1%) → cap 45, giữ maxLev 5
  assert.equal(backtest(k, sig, new Float64Array(6).fill(5), { account: { ...a, fixedLev: false }, exit }).trades[0].leverage, 1);
  assert.equal(backtest(k, sig, new Float64Array(6).fill(0.5), { account: a, exit }).trades[0].leverage, 5);
  // hardStop 0 = tắt
  assert.equal(backtest(k, sig, new Float64Array(6).fill(5), { account: { ...a, hardStop: 0 }, exit }).trades[0].leverage, 5);
});

test("bước giá theo tháng từ số lẻ của nến, như get_tick_size_over_time; lệnh giữ bước của lúc vào", () => {
  const k = { t: [], o: [], h: [], l: [], c: [] };
  const m0 = Date.UTC(2024, 0, 1), m1 = Date.UTC(2024, 1, 1), m2 = Date.UTC(2024, 2, 1);
  const push = (t, px) => { k.t.push(t); k.o.push(px); k.h.push(px + 1); k.l.push(px - 1); k.c.push(px); };
  for (let i = 0; i < 10; i++) push(m0 + i * H, 100);           // tháng 1: giá nguyên → null
  for (let i = 0; i < 10; i++) push(m1 + i * H, 100.25);        // tháng 2: 2 chữ số lẻ
  for (let i = 0; i < 10; i++) push(m2 + i * H, 100.5);         // tháng 3: 1 chữ số lẻ
  assert.deepEqual(inferPriceSteps(k), [[m0, null], [m1, 0.01], [m2, 0.1]]);
  const s = stepsFor("XYZUSDT", k);
  assert.equal(s.priceStep, 0.01); assert.equal(s.amountStep, 0.001);
  // R = 3 × 0.13 = 0.39; stop làm tròn LÊN theo bước lúc vào lệnh (path[0] = stop ban đầu, cần trace):
  //   vào tháng 1 (chưa suy được bước) → bước dự phòng 0.1: 100 − 0.39 = 99.61 → 99.7
  //   vào tháng 2 (bước 0.01): 100.25 − 0.39 = 99.86 → 99.86
  //   vào tháng 3 (bước 0.1):  100.5 − 0.39 = 100.11 → 100.2
  const a = { ...acc, riskPct: 1, fixedLev: false, amountStep: 0.0001, priceStep: 0.1, priceSteps: inferPriceSteps(k) };
  const run = (at) => {
    const sig = new Int8Array(k.t.length); sig[at] = 1;
    return backtest(k, sig, new Float64Array(k.t.length).fill(0.13), { account: a, exit: { rAtr: 3, trailStartR: 0 }, trace: true }).trades[0];
  };
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  const t1 = run(1), t2 = run(11), t3 = run(21);
  assert.ok(near(t1.entry, 100) && near(t1.path[0][1], 99.7), `tháng 1: ${t1.entry} / stop ${t1.path[0][1]}`);
  assert.ok(near(t2.entry, 100.25) && near(t2.path[0][1], 99.86), `tháng 2: ${t2.entry} / stop ${t2.path[0][1]}`);
  assert.ok(near(t3.entry, 100.5) && near(t3.path[0][1], 100.2), `tháng 3: ${t3.entry} / stop ${t3.path[0][1]}`);
  // không có priceSteps → mọi lệnh dùng priceStep chung 0.1: vào 100.25 → 100.3, stop 99.91 → 100.0
  const sig = new Int8Array(k.t.length); sig[11] = 1;
  const t0 = backtest(k, sig, new Float64Array(k.t.length).fill(0.13), { account: { ...a, priceSteps: null }, exit: { rAtr: 3, trailStartR: 0 }, trace: true }).trades[0];
  assert.ok(near(t0.entry, 100.3) && near(t0.path[0][1], 100), `không priceSteps: ${t0.entry} / stop ${t0.path[0][1]}`);
});
