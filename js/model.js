// Ánh xạ dữ liệu API của hub → thứ hiển thị. Chỉ hàm thuần (không DOM) để test bằng node --test.
import { coin } from "./format.js";

/** Lãi/lỗ các lệnh ĐÓNG trong ngày hôm nay (theo giờ máy người xem). Lệnh đang mở không tính. */
export function todayPnl(closed, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let sum = 0, n = 0;
  for (const t of closed || []) {
    if ((t.close_timestamp || 0) >= start) { sum += t.profit_abs || 0; n++; }
  }
  return { abs: sum, trades: n };
}

/** Lãi/lỗ chưa chốt của các lệnh đang mở. */
export function openPnl(open) {
  let sum = 0;
  for (const t of open || []) sum += t.profit_abs || 0;
  return sum;
}

const STALE_S = 300;

/**
 * Trạng thái bot để trả lời "bot đang làm gì" bằng một dòng.
 * kind: offline | halted | stopped | stale | running
 */
export function botStatus(live, nowS = Date.now() / 1000) {
  if (!live || !live.reachable) {
    return { kind: "offline", label: "Không liên lạc được bot", detail: live?.error || "" };
  }
  if (live.state !== "running") {
    return { kind: "stopped", label: "Bot đã dừng", detail: `Trạng thái: ${live.state || "?"} — không vào/thoát lệnh.` };
  }
  if (live.halt?.halted) {
    return { kind: "halted", label: "Tự dừng vào lệnh mới", detail:
      `Sụt vốn đã quá ${live.halt.threshold_pct}% — bot giữ lệnh đang mở nhưng không vào lệnh mới. Xem lại rồi tắt "Tự dừng" ở màn Backtest nếu muốn chạy tiếp.` };
  }
  if (live.last_process_ts && nowS - live.last_process_ts > STALE_S) {
    const m = Math.round((nowS - live.last_process_ts) / 60);
    return { kind: "stale", label: "Bot không xử lý nến", detail: `${m} phút chưa thấy bot làm việc — kiểm tra máy chủ.` };
  }
  return { kind: "running", label: "Đang chạy", detail: "" };
}

/** Thống kê một nhóm lệnh đã đóng (sau khi lọc theo coin trên màn Lịch sử). */
export function tradeStats(trades) {
  let n = 0, wins = 0, win = 0, loss = 0, pnl = 0;
  for (const t of trades || []) {
    const p = t.profit_abs || 0;
    n++; pnl += p;
    if (p > 0) { wins++; win += p; } else loss += -p;
  }
  return {
    n, wins, pnl,
    winrate: n ? (100 * wins) / n : null,
    pf: loss > 0 ? win / loss : (win > 0 ? Infinity : null),
  };
}

/** Số lệnh mỗi tháng kể từ `sinceMs` (để so với kỳ vọng ~19 lệnh/tháng). */
export function perMonth(n, sinceMs, now = Date.now()) {
  if (!sinceMs || now <= sinceMs) return null;
  const months = (now - sinceMs) / (30.44 * 86400e3);
  return months < 0.25 ? null : n / months;                   // dưới ~1 tuần thì chưa có nghĩa
}

/** Danh sách coin xuất hiện trong lệnh, theo thứ tự xuất hiện. */
export function coinsOf(trades) {
  return [...new Set((trades || []).map((t) => coin(t.pair)))];
}

/**
 * Tóm tắt nến LAB từ /api/tune/live.data: mỗi khung → từ ngày (muộn nhất giữa các coin), tới ngày (sớm nhất),
 * coin thiếu. Khoảng "từ → tới" là khoảng mọi coin đều có nến.
 */
export function dataSummary(rows, timeframe) {
  const out = [];
  for (const tf of [...new Set((rows || []).map((d) => d.tf))]) {
    const list = rows.filter((d) => d.tf === tf);
    const ok = list.filter((d) => d.from);
    out.push({
      tf, role: tf === timeframe ? "signal" : "detail",
      from: ok.length ? ok.map((d) => d.from).sort().at(-1) : null,
      to: ok.length ? ok.map((d) => d.to).sort()[0] : null,
      missing: list.filter((d) => !d.from).map((d) => coin(d.pair)),
      coins: list.map((d) => ({ coin: coin(d.pair), from: d.from, to: d.to })),
    });
  }
  return out;
}

const show = (p, x) => (p.type === "bool" ? (x ? "bật" : "tắt") : x);

/** Khác nhau giữa hai bộ tham số theo schema: [{name, label, from, to}]. */
export function diffParams(schema, from, to) {
  const out = [];
  for (const p of schema || []) {
    if (from?.[p.name] !== to?.[p.name]) out.push({ name: p.name, label: p.label, from: show(p, from?.[p.name]), to: show(p, to?.[p.name]) });
  }
  return out;
}

export const sameParams = (schema, a, b) => (schema || []).every((p) => a?.[p.name] === b?.[p.name]);

/** Ép giá trị vào đúng khoảng và bước của tham số. */
export function clampParam(p, v) {
  if (p.type === "bool") return !!v;
  let x = Number(v);
  if (Number.isNaN(x)) x = p.default;
  x = Math.min(p.max, Math.max(p.min, x));
  return p.type === "int" ? Math.round(x) : Number(x.toFixed(p.decimals ?? 2));
}

/** Khoảng thời gian backtest có sẵn. `now` để test. */
export function rangePresets(now = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const y1 = new Date(now); y1.setFullYear(y1.getFullYear() - 1);
  return [
    { id: "all", label: "2021 → nay", from: "2021-01-01", to: "" },
    { id: "is", label: "2021–2024", from: "2021-01-01", to: "2025-01-01" },
    { id: "oos", label: "2025 → nay", from: "2025-01-01", to: "" },
    { id: "1y", label: "12 tháng", from: iso(y1), to: "" },
  ];
}

/** "2021-01-01", "" → "20210101-" (freqtrade --timerange). */
export const timerange = (from, to) => `${String(from || "").replaceAll("-", "")}-${String(to || "").replaceAll("-", "")}`;

/** Lời phán về một bộ kết quả backtest so với kỳ vọng (EXPECT của hub). */
export function pfVerdict(pf) {
  if (pf == null) return "";
  if (pf >= 1.3) return "tốt";
  if (pf >= 1.1) return "đúng kỳ vọng";
  if (pf >= 1) return "yếu";
  return "lỗ";
}
