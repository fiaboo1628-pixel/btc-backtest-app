import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../js/model.js";

const day = (h) => new Date(2026, 9, 2, h).getTime();

test("lãi hôm nay chỉ tính lệnh đóng hôm nay theo giờ máy", () => {
  const now = new Date(2026, 9, 2, 15);
  const closed = [
    { close_timestamp: day(9), profit_abs: 10 }, { close_timestamp: day(14), profit_abs: -4 },
    { close_timestamp: day(-5), profit_abs: 100 },                      // hôm qua
  ];
  assert.deepEqual(m.todayPnl(closed, now), { abs: 6, trades: 2 });
  assert.deepEqual(m.todayPnl([], now), { abs: 0, trades: 0 });
  assert.equal(m.openPnl([{ profit_abs: 1.5 }, { profit_abs: -0.5 }, {}]), 1);
});

test("trạng thái bot: một dòng trả lời bot đang làm gì", () => {
  const now = 1_000_000;
  assert.equal(m.botStatus(null).kind, "offline");
  assert.equal(m.botStatus({ reachable: false, error: "x" }).detail, "x");
  assert.equal(m.botStatus({ reachable: true, state: "stopped" }).kind, "stopped");
  assert.equal(m.botStatus({ reachable: true, state: "running", halt: { halted: true, threshold_pct: 15 } }, now).kind, "halted");
  assert.equal(m.botStatus({ reachable: true, state: "running", last_process_ts: now - 600 }, now).kind, "stale");
  assert.equal(m.botStatus({ reachable: true, state: "running", last_process_ts: now - 10 }, now).kind, "running");
});

test("thống kê nhóm lệnh và số lệnh mỗi tháng", () => {
  const s = m.tradeStats([{ profit_abs: 10 }, { profit_abs: -5 }, { profit_abs: 20 }, { profit_abs: 0 }]);
  assert.equal(s.n, 4); assert.equal(s.wins, 2); assert.equal(s.pnl, 25); assert.equal(s.winrate, 50); assert.equal(s.pf, 6);
  assert.equal(m.tradeStats([{ profit_abs: 3 }]).pf, Infinity);
  assert.equal(m.tradeStats([]).pf, null);
  const now = Date.UTC(2026, 9, 2);
  assert.equal(Math.round(m.perMonth(38, now - 2 * 30.44 * 86400e3, now)), 19);
  assert.equal(m.perMonth(3, now - 86400e3, now), null);
  assert.equal(m.perMonth(3, null, now), null);
  assert.deepEqual(m.coinsOf([{ pair: "ETH/USDT:USDT" }, { pair: "BTC/USDT:USDT" }, { pair: "ETH/USDT:USDT" }]), ["ETH", "BTC"]);
});

test("tóm tắt nến LAB: khoảng mọi coin đều có, coin thiếu", () => {
  const rows = [
    { pair: "BTC/USDT:USDT", tf: "4h", from: "2021-01-01", to: "2026-09-30 20:00" },
    { pair: "SOL/USDT:USDT", tf: "4h", from: "2022-03-01", to: "2026-09-29 20:00" },
    { pair: "BTC/USDT:USDT", tf: "15m", from: "2023-01-01", to: "2026-09-30 23:45" },
    { pair: "SOL/USDT:USDT", tf: "15m", from: null, to: null },
  ];
  const s = m.dataSummary(rows, "4h");
  assert.equal(s.length, 2);
  assert.equal(s[0].tf, "4h"); assert.equal(s[0].role, "signal");
  assert.equal(s[0].from, "2022-03-01"); assert.equal(s[0].to, "2026-09-29 20:00"); assert.deepEqual(s[0].missing, []);
  assert.equal(s[1].role, "detail"); assert.deepEqual(s[1].missing, ["SOL"]); assert.equal(s[1].from, "2023-01-01");
  assert.deepEqual(m.dataSummary([], "4h"), []);
});

const schema = [
  { name: "entry_period", type: "int", min: 10, max: 100, default: 20, label: "Kênh vào lệnh" },
  { name: "r_atr", type: "decimal", min: 1, max: 6, decimals: 1, default: 2, label: "Stop (× ATR)" },
  { name: "halt_on", type: "bool", default: true, label: "Tự dừng" },
];

test("so hai bộ tham số, ép đúng bước", () => {
  const live = { entry_period: 20, r_atr: 2, halt_on: true };
  const d = m.diffParams(schema, live, { entry_period: 25, r_atr: 2, halt_on: false });
  assert.deepEqual(d, [{ name: "entry_period", label: "Kênh vào lệnh", from: 20, to: 25 }, { name: "halt_on", label: "Tự dừng", from: "on", to: "off" }]);
  assert.equal(m.sameParams(schema, live, { ...live }), true);
  assert.equal(m.sameParams(schema, live, { ...live, r_atr: 2.5 }), false);
  assert.equal(m.clampParam(schema[0], 150), 100);
  assert.equal(m.clampParam(schema[0], 12.6), 13);
  assert.equal(m.clampParam(schema[1], 2.26), 2.3);
  assert.equal(m.clampParam(schema[1], "abc"), 2);
  assert.equal(m.clampParam(schema[2], 0), false);
});

test("khoảng thời gian backtest", () => {
  const r = m.rangePresets(new Date(Date.UTC(2026, 9, 2)));
  assert.equal(r.find((x) => x.id === "1y").from, "2025-10-02");
  assert.equal(m.timerange("2021-01-01", ""), "20210101-");
  assert.equal(m.timerange("2021-01-01", "2025-01-01"), "20210101-20250101");
  assert.equal(m.pfVerdict(1.6), "tốt"); assert.equal(m.pfVerdict(0.9), "lỗ"); assert.equal(m.pfVerdict(null), "");
});

test("nến của lệnh backtest: vị trí vào/ra, kênh thoát, SL ban đầu", () => {
  const H = 4 * 3600_000;
  const rows = [10, 12, 11, 14, 13, 9].map((c, i) => [i * H, c, c + 1, c - 1, c, c, 2]);
  const long = m.tradeLevels(rows, { open_timestamp: 2 * H + 60_000, close_timestamp: 5 * H, open_rate: 11, is_short: false }, 2, 3);
  assert.equal(long.iIn, 2); assert.equal(long.iOut, 5);
  assert.deepEqual(long.exit, [null, null, 9, 10, 10, 12]);   // đáy (low) 2 nến trước
  assert.equal(long.stop, 11 - 3 * 2);
  const short = m.tradeLevels(rows, { open_timestamp: 0, close_timestamp: H, open_rate: 10, is_short: true }, 2, 3);
  assert.equal(short.exit[2], 13); assert.equal(short.stop, null);   // nến đầu: chưa có nến tín hiệu
});
