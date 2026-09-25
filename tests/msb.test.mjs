// Chỉ báo Market Structure Break & Order Block (MSB-OB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { msbOb } from "../js/indicators.js";

function walk(n, seed = 7) {
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const o = [], h = [], l = [], c = [];
  let p = 30000;
  for (let i = 0; i < n; i++) {
    const a = p; p *= 1 + (r() - 0.5) * 0.006;
    o.push(a); c.push(p); h.push(Math.max(a, p) * (1 + r() * 0.001)); l.push(Math.min(a, p) * (1 - r() * 0.001));
  }
  return { o, h, l, c };
}
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

test("MSB-OB không nhìn trước: tính trên phần đầu dữ liệu cho cùng giá trị", () => {
  const k = walk(6000), full = msbOb(k.o, k.h, k.l, k.c, 9, 0.33);
  for (const cut of [500, 2345, 5999]) {
    const part = msbOb(k.o.slice(0, cut), k.h.slice(0, cut), k.l.slice(0, cut), k.c.slice(0, cut), 9, 0.33);
    for (const key of ["market", "buPos", "bePos"])
      for (let i = 0; i < cut; i++) assert.ok(same(part[key][i], full[key][i]), `${key}[${i}] @${cut}`);
  }
});

test("MSB-OB: xu hướng chỉ là ±1, có đổi chiều; vùng OB hết hiệu lực khi bị phá", () => {
  const k = walk(6000), m = msbOb(k.o, k.h, k.l, k.c, 9, 0.33);
  let flips = 0;
  for (let i = 1; i < m.market.length; i++) {
    const x = m.market[i];
    assert.ok(Number.isNaN(x) || x === 1 || x === -1);
    if (!Number.isNaN(m.market[i - 1]) && x !== m.market[i - 1]) flips++;
    // Bu-OB đã bị đóng cửa dưới đáy thì nến sau không còn giá trị (trừ khi có MSB tăng mới)
    if (m.buPos[i - 1] < 0 && !(m.market[i] === 1 && m.market[i - 1] === -1)) assert.ok(Number.isNaN(m.buPos[i]), `buPos[${i}]`);
    if (m.bePos[i - 1] > 1 && !(m.market[i] === -1 && m.market[i - 1] === 1)) assert.ok(Number.isNaN(m.bePos[i]), `bePos[${i}]`);
  }
  assert.ok(flips > 20, `quá ít MSB: ${flips}`);
});
