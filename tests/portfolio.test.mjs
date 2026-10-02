// Nhiều coin chung tài khoản: giới hạn số lệnh mở, vốn chung, thứ tự xử lý, tự dừng khi sụt vốn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest } from "../js/engine.js";
import { backtestPortfolio, perPair } from "../js/portfolio.js";

const H = 4 * 3600e3;
const acc = { wallet: 1000, riskPct: 1, maxLev: 5, fixedLev: true, fee: 0, tradableRatio: 1, amountStep: 0.0001, priceStep: 0.01 };
const exit = { rAtr: 2, trailStartR: 0, exitChannel: 0, atrN: 14 };

/** Coin giá phẳng ở `px`, n nến 4h bắt đầu từ t0; sig[k] = Long ở nến k; nến `dropAt` rơi xuống dưới stop. */
function coin(px, n, { t0 = 0, longAt = [], dropAt = [], riseAt = [] } = {}) {
  const c = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < n; i++) {
    c.t.push(t0 + i * H); c.o.push(px); c.h.push(px * 1.001); c.l.push(px * 0.999); c.c.push(px);
    if (dropAt.includes(i)) { c.l[i] = px * 0.9; c.c[i] = px * 0.95; }
    if (riseAt.includes(i)) { c.h[i] = px * 1.2; c.c[i] = px * 1.1; }
  }
  const sig = new Int8Array(n); for (const k of longAt) sig[k] = 1;
  return { c, sig, atr: new Float64Array(n).fill(px * 0.01) };     // R = 2% giá
}

test("một coin: portfolio ra đúng y hệt backtest() một coin", () => {
  const a = coin(100, 40, { longAt: [3, 20], dropAt: [8, 25] });
  const single = backtest(a.c, a.sig, a.atr, { exit, account: acc });
  const port = backtestPortfolio([{ name: "A", ...a }], { exit, account: acc });
  assert.equal(port.trades.length, 2);
  assert.deepEqual(port.trades.map((x) => [x.entryT, x.exitT, x.pnl, x.balance]), single.trades.map((x) => [x.entryT, x.exitT, x.pnl, x.balance]));
  assert.equal(port.trades[0].pair, "A");
});

test("tối đa N lệnh mở cùng lúc; cùng nến thì coin trước trong danh sách được vào", () => {
  const A = coin(100, 20, { longAt: [2], dropAt: [10] }), B = coin(50, 20, { longAt: [2], dropAt: [10] }), C = coin(10, 20, { longAt: [2], dropAt: [10] });
  const all = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }, { name: "C", ...C }], { exit, account: acc });
  assert.deepEqual(all.trades.map((x) => x.pair).sort(), ["A", "B", "C"]);
  const two = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }, { name: "C", ...C }], { exit, account: acc, maxOpen: 2 });
  assert.deepEqual(two.trades.map((x) => x.pair).sort(), ["A", "B"]);      // C bị từ chối: hết chỗ
  // C có tín hiệu lại sau khi A, B đã đóng → vào được
  const C2 = coin(10, 20, { longAt: [2, 12], dropAt: [16] });
  const later = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }, { name: "C", ...C2 }], { exit, account: acc, maxOpen: 2 });
  assert.deepEqual(later.trades.map((x) => x.pair), ["A", "B", "C"]);
});

test("vốn chung: lệnh sau tính khối lượng trên vốn đã cộng lãi/lỗ của lệnh trước (kể cả đóng trong cùng nến)", () => {
  // A thua ở nến 10 (−1% vốn); B vào lệnh ở nến 11 → vốn còn 990
  const A = coin(100, 30, { longAt: [2], dropAt: [10] }), B = coin(50, 30, { longAt: [10], dropAt: [20] });
  const r = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }], { exit, account: acc });
  const [a, b] = r.trades;
  assert.equal(a.pair, "A"); assert.ok(Math.abs(a.pnl + 10) < 1e-6, `A lỗ 1% = ${a.pnl}`);
  assert.equal(b.pair, "B");
  // rủi ro 1% của 990 = 9.9 → khối lượng = 9.9 / R(=1) = 9.9
  assert.ok(Math.abs(b.amount - 9.9) < 1e-9, `khối lượng B ${b.amount}`);
  // cùng nến: A thoát theo stop ở nến 10 và B vào ở nến 10 — coin đang có lệnh xử lý trước, nên B đã thấy vốn 990
  const B2 = coin(50, 30, { longAt: [9], dropAt: [20] });
  const same = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B2 }], { exit, account: acc });
  assert.equal(same.trades[1].entryT, 10 * H);
  assert.ok(Math.abs(same.trades[1].amount - 9.9) < 1e-9, `khối lượng B cùng nến ${same.trades[1].amount}`);
  // riêng từng coin thì B đã vào với 1000
  assert.ok(Math.abs(backtest(B.c, B.sig, B.atr, { exit, account: acc }).trades[0].amount - 10) < 1e-9);
});

test("tự dừng khi sụt vốn > 15%: không mở lệnh mới, lệnh đang mở vẫn quản lý", () => {
  // mỗi lệnh lỗ đúng 1R = 5% vốn (riskPct 5); 4 lệnh thua liên tiếp → sụt 18.5% → dừng
  const big = { ...acc, riskPct: 5 };
  const A = coin(100, 60, { longAt: [2, 12, 22, 32, 42, 52], dropAt: [6, 16, 26, 36, 46, 56] });
  const free = backtestPortfolio([{ name: "A", ...A }], { exit, account: big });
  assert.equal(free.trades.length, 6);
  const halt = backtestPortfolio([{ name: "A", ...A }], { exit, account: big, haltDD: 0.15 });
  assert.equal(halt.trades.length, 4);
  assert.equal(halt.halted, true);
  assert.equal(halt.haltedAt, halt.trades[3].exitT);
  // lệnh đang mở lúc chạm ngưỡng vẫn chạy tới stop của nó
  const B = coin(50, 60, { longAt: [33], dropAt: [50] });        // vào ở nến 34, trước khi A chạm ngưỡng ở nến 36
  const both = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }], { exit, account: big, haltDD: 0.15 });
  const b = both.trades.find((x) => x.pair === "B");
  assert.ok(b && b.reason === "stop_loss" && b.exitT === 50 * H, "B vào trước khi dừng, vẫn thoát theo stop");
  assert.equal(both.trades.filter((x) => x.pair === "A").length, 4);
});

test("coin có dữ liệu bắt đầu muộn vẫn vào lệnh đúng giờ; bảng từng coin", () => {
  const A = coin(100, 30, { longAt: [2], riseAt: [5], dropAt: [12] });
  const B = coin(50, 20, { t0: 10 * H, longAt: [3], dropAt: [8] });        // bắt đầu ở nến 10 của A
  const r = backtestPortfolio([{ name: "A", ...A }, { name: "B", ...B }], { exit, account: acc, from: 0 });
  const b = r.trades.find((x) => x.pair === "B");
  assert.equal(b.entryT, (10 + 4) * H);
  const tbl = perPair(r, ["A", "B"]);
  assert.equal(tbl[0].pair, "A"); assert.equal(tbl[0].trades, 1); assert.equal(tbl[1].trades, 1);
  assert.ok(tbl[1].pnl < 0 && tbl[1].winrate === 0);
});
