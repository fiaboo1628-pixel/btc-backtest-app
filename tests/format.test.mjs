import { test } from "node:test";
import assert from "node:assert/strict";
import * as f from "../js/format.js";

test("số kiểu Việt, không có thì gạch", () => {
  assert.equal(f.fmt(1234.5), "1.234,50");
  assert.equal(f.fmt(0.1234, 3), "0,123");
  assert.equal(f.fmt(null), "–");
  assert.equal(f.fmt("abc"), "–");
  assert.equal(f.money(990.5), "990,50 USDT");
  assert.equal(f.money(1000, "USDT", 0), "1.000 USDT");
  assert.equal(f.pct(12.345, 1), "12,3%");
});

test("luôn có dấu khi là lãi/lỗ, số 0 không dấu", () => {
  assert.equal(f.signed(1.234), "+1,23");
  assert.equal(f.signed(-1.234), "-1,23");
  assert.equal(f.signed(0), "0,00");
  assert.equal(f.signed(-0.001), "0,00");               // làm tròn về 0 thì không ghi "-0,00"
  assert.equal(f.signedPct(3.5), "+3,50%");
  assert.equal(f.signedMoney(-12, "USDT"), "-12,00 USDT");
  assert.equal(f.signedMoney(null), "–");
  assert.equal(f.cls(5), "up"); assert.equal(f.cls(-5), "down"); assert.equal(f.cls(0), ""); assert.equal(f.cls(null), "");
});

test("giá coin chọn số lẻ theo độ lớn", () => {
  assert.equal(f.price(65432.123), "65.432,1");
  assert.equal(f.price(123.456), "123,46");
  assert.equal(f.price(2.3456), "2,346");
  assert.equal(f.price(0.12345), "0,12345");
  assert.equal(f.price(undefined), "–");
});

test("ngày giờ, trước đây, độ dài", () => {
  const t = new Date(2026, 9, 2, 14, 5).getTime();
  const now = new Date(2026, 11, 31);
  assert.equal(f.dateTime(t, now), "02/10 14:05");
  assert.equal(f.dateTime(new Date(2024, 3, 26, 8, 0).getTime(), now), "26/04/2024 08:00");   // khác năm: thêm năm
  assert.equal(f.dateOnly(t), "02/10/2026");
  assert.equal(f.dateTime(null), "–");
  assert.equal(f.isoDay("2026-10-02 20:00"), "02/10/2026");
  assert.equal(f.isoDay(""), "–");
  assert.equal(f.ago(t - 5000, t), "5 giây trước");
  assert.equal(f.ago(t - 3 * 60000, t), "3 phút trước");
  assert.equal(f.ago(t - 2 * 3600e3, t), "2 giờ trước");
  assert.equal(f.ago(t - 4 * 86400e3, t), "4 ngày trước");
  assert.equal(f.duration(45 * 60000), "45m");
  assert.equal(f.duration(3 * 3600e3), "3h");
  assert.equal(f.duration((2 * 24 + 4) * 3600e3), "2d 4h");
  assert.equal(f.duration(-1), "–");
});

test("coin, chiều, lý do thoát, chế độ", () => {
  assert.equal(f.coin("BTC/USDT:USDT"), "BTC");
  assert.equal(f.side(true), "Short");
  assert.equal(f.exitReason("exit_signal"), "Signal");
  assert.equal(f.exitReason("stop_loss"), "Stop loss");
  assert.equal(f.exitReason("weird"), "weird");
  assert.equal(f.modeInfo("live").name, "LIVE");
  assert.equal(f.modeInfo("TIỀN THẬT").cls, "mode-live");        // tên cũ hub trả về vẫn hiểu
  assert.equal(f.modeInfo("Demo").cls, "mode-demo");          // tên trong /api/tune/live cũng hiểu
  assert.equal(f.modeInfo("dry-run").cls, "mode-paper");
  assert.equal(f.modeInfo(undefined).cls, "mode-unknown");
  assert.equal(f.ymd("2021-01-01"), "20210101");
});
