// Bộ máy backtest: chế độ nến chi tiết (detail) và TP cố định.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest } from "../js/engine.js";

const M = 60e3;
// 15 phút = 15 nến 1m; tạo nến 15m từ các nến 1m
const agg = (m, n) => {
  const k = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < m.t.length; i += n) {
    k.t.push(m.t[i]); k.o.push(m.o[i]); k.c.push(m.c[i + n - 1]);
    k.h.push(Math.max(...m.h.slice(i, i + n))); k.l.push(Math.min(...m.l.slice(i, i + n)));
  }
  return k;
};
const acc = { wallet: 1000, riskPct: 1, maxLev: 5, fee: 0, tradableRatio: 1, amountStep: 0.001, priceStep: 0.1 };

test("detail = chính nến giao dịch → kết quả y hệt không dùng detail", () => {
  const n = 200, k = { t: [], o: [], h: [], l: [], c: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p; p += Math.sin(i / 5) * 2 + (i % 7 === 0 ? -3 : 1);
    k.t.push(i * 15 * M); k.o.push(o); k.c.push(p); k.h.push(Math.max(o, p) + 1); k.l.push(Math.min(o, p) - 1);
  }
  const sig = new Int8Array(n); for (let i = 5; i < n; i += 17) sig[i] = i % 2 ? 1 : -1;
  const atr = new Float64Array(n).fill(1.5);
  const a = backtest(k, sig, atr, { account: acc });
  const b = backtest(k, sig, atr, { account: acc, detail: k, detailMs: 15 * M });
  assert.deepEqual(b.trades.map((x) => [x.entryT, x.exitT, x.exit]), a.trades.map((x) => [x.entryT, x.exitT, x.exit]));
});

test("detail: đáy đến trước đỉnh trong nến → không bị coi là bán đúng đỉnh", () => {
  // Long vào ở 100, R = 3 (atr 1 × 3). Nến 15m thứ 2: 1m đầu xuống 99, sau đó lên 110 rồi đóng 109.
  const m = { t: [], o: [], h: [], l: [], c: [] };
  const push = (o, h, l, c) => { m.t.push(m.t.length * M); m.o.push(o); m.h.push(h); m.l.push(l); m.c.push(c); };
  for (let i = 0; i < 15; i++) push(100, 100.2, 99.8, 100);            // nến tín hiệu
  for (let i = 0; i < 15; i++) push(100, 100.2, 99.8, 100);            // vào lệnh ở 100
  // phút đầu xuống 99, rồi tăng đều (mỗi nến 1m biên độ nhỏ hơn khoảng trail 0.9), đỉnh 110 ở phút cuối
  push(100, 100, 99, 99);
  for (let i = 0; i < 13; i++) { const o = 99 + i * 0.7; push(o, o + 0.75, o - 0.05, o + 0.7); }
  push(109.8, 110, 109.8, 110);
  push(109.6, 109.8, 104, 104); for (let i = 0; i < 14; i++) push(104, 104.2, 103.8, 104); // sau đó rơi
  const k = agg(m, 15);
  const sig = new Int8Array(k.t.length); sig[0] = 1;
  const atr = new Float64Array(k.t.length).fill(1);
  const ex = { rAtr: 3, trailStartR: 2, trailDistR: 0.3 };
  const coarse = backtest(k, sig, atr, { account: acc, exit: ex }).trades[0];
  const fine = backtest(k, sig, atr, { account: acc, exit: ex, detail: m, detailMs: 15 * M }).trades[0];
  // chỉ nến 15m: dời stop lên 110 - 0.9 rồi coi low 99 là chạm → thoát 109.1 ngay trong nến đó (lạc quan)
  assert.equal(coarse.exitT, k.t[2]);
  // nến 1m: stop chỉ lên 109.1 ở phút cuối, bị chạm ở nến 15m sau
  assert.equal(fine.exitT, k.t[3]);
  assert.ok(Math.abs(fine.exit - 109.1) < 1e-9);
});

test("TP cố định và tắt trailing", () => {
  const k = { t: [0, 1, 2, 3].map((i) => i * 15 * M), o: [100, 100, 101, 106], h: [100, 101, 113, 107], l: [100, 99, 100, 100], c: [100, 101, 106, 101] };
  const sig = new Int8Array(4); sig[0] = 1;
  const atr = new Float64Array(4).fill(1);
  const tr = backtest(k, sig, atr, { account: acc, exit: { rAtr: 3, trailStartR: 0, tpR: 4 } }).trades[0];
  assert.equal(tr.reason, "take_profit");
  assert.equal(tr.exit, 112);
  assert.equal(tr.exitT, k.t[2]);
});

test("đòn bẩy nguyên, làm tròn lên (Binance làm tròn xuống đòn bẩy lẻ) — khối lượng vẫn đúng 1R", () => {
  // giá 100, ATR 0.1 × rAtr 3 → R = 0.3% giá; rủi ro 1% → cần đòn bẩy 3.33 → 4
  const n = 10, k = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < n; i++) { k.t.push(i * 15 * M); k.o.push(100); k.h.push(100.05); k.l.push(99.95); k.c.push(100); }
  const sig = new Int8Array(n); sig[1] = 1;
  const atr = new Float64Array(n).fill(0.1);
  const t = backtest(k, sig, atr, { account: { ...acc, amountStep: 0.0001 } }).trades[0];
  assert.equal(t.leverage, 4);
  assert.ok(Math.abs(t.amount * 100 - 1000 / 0.3) < 1, `notional ${t.amount * 100}`);   // notional = vốn × 1% / R%
});

test("thoát theo kênh: Long đóng dưới đáy N nến trước → thoát ở giá mở nến sau", () => {
  const k = { t: [], o: [], h: [], l: [], c: [] };
  const push = (o, h, l, c) => { k.t.push(k.t.length * 15 * M); k.o.push(o); k.h.push(h); k.l.push(l); k.c.push(c); };
  for (let i = 0; i < 5; i++) push(100, 101, 99, 100);   // 0–4
  push(100, 102, 99.5, 101);                               // 5: vào Long ở 100 (tín hiệu ở nến 4)
  push(101, 101.5, 100, 100.5);                            // 6
  push(100.5, 100.8, 98.5, 98.8);                          // 7: đóng 98.8 < đáy 3 nến trước (99.5, 100 → min 99) → tín hiệu thoát
  push(98.7, 99, 98, 98.5);                                // 8: thoát ở giá mở 98.7
  push(98.5, 99, 98, 98.5);
  const sig = new Int8Array(k.t.length); sig[4] = 1;
  const atr = new Float64Array(k.t.length).fill(1);       // stop = 100 − 3 = 97, không chạm
  const r = backtest(k, sig, atr, { account: acc, exit: { rAtr: 3, trailStartR: 0, exitChannel: 3 } });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, "exit_signal");
  assert.equal(r.trades[0].exitT, k.t[8]);
  assert.equal(r.trades[0].exit, 98.7);
  // tắt thoát theo kênh → lệnh giữ tới cuối dữ liệu
  const off = backtest(k, sig, atr, { account: acc, exit: { rAtr: 3, trailStartR: 0 } });
  assert.equal(off.trades[0].reason, "end");
});
