// Một chỗ định dạng số, tiền, phần trăm, ngày giờ cho cả app — kiểu Việt (1.234,56), luôn có dấu +/- khi là lãi/lỗ
// để không chỉ dựa vào màu. Không có DOM: tests/format.test.mjs chạy bằng node --test.

const VI = "vi-VN";
const num = (n) => (n == null || n === "" || Number.isNaN(Number(n))) ? null : Number(n);

/** 1234.5 → "1.234,50"; null/NaN → "–". */
export function fmt(n, d = 2) {
  const v = num(n);
  if (v === null) return "–";
  const r = Number(v.toFixed(d)) || 0;             // -0,001 làm tròn thành 0, không ghi "-0,00"
  return r.toLocaleString(VI, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Số tiền kèm đơn vị: "1.234,50 USDT". */
export function money(n, cur = "USDT", d = 2) {
  const v = num(n);
  return v === null ? "–" : `${fmt(v, d)} ${cur}`;
}

/** Phần trăm không dấu: "12,3%". */
export function pct(n, d = 2) {
  const v = num(n);
  return v === null ? "–" : `${fmt(v, d)}%`;
}

/** Luôn có dấu: +1,23 / -1,23 / 0,00 (số 0 không dấu). */
export function signed(n, d = 2) {
  const v = num(n);
  if (v === null) return "–";
  const r = Number(v.toFixed(d)) || 0;            // -0,001 làm tròn 2 số = 0 → không ghi dấu trừ
  return (r > 0 ? "+" : "") + fmt(r, d);
}
export const signedPct = (n, d = 2) => (num(n) === null ? "–" : `${signed(n, d)}%`);
export const signedMoney = (n, cur = "USDT", d = 2) => (num(n) === null ? "–" : `${signed(n, d)} ${cur}`);

/** Lớp CSS theo dấu: up / down / "" (0 hoặc không có). */
export function cls(n) {
  const v = num(n);
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}

/** Giá coin: BTC cần 1 số lẻ, DOGE cần 5. Tự chọn theo độ lớn. */
export function price(n) {
  const v = num(n);
  if (v === null) return "–";
  const d = v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 5 : 6;
  return fmt(v, d);
}

const pad = (x) => String(x).padStart(2, "0");

/** ms (hoặc Date) → "02/10 14:05" theo giờ máy người xem. */
export function dateTime(ms) {
  if (ms == null) return "–";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "–";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ms → "02/10/2026". */
export function dateOnly(ms) {
  if (ms == null) return "–";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "–";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** "2026-10-02" (chuỗi ISO ngày của freqtrade) → "02/10/2026"; chuỗi lạ thì trả nguyên. */
export function isoDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || "–");
}

/** Khoảng thời gian đã qua: "5 giây trước", "3 phút trước", "2 giờ trước", "4 ngày trước". */
export function ago(ms, now = Date.now()) {
  if (ms == null) return "–";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

/** Độ dài, gọn kiểu bảng lệnh: "45m", "3h", "2d 4h". */
export function duration(ms) {
  if (ms == null || ms < 0) return "–";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

/** "BTC/USDT:USDT" → "BTC". */
export const coin = (pair) => String(pair || "").split("/")[0] || "–";

export const side = (isShort) => (isShort ? "Short" : "Long");

const EXIT = {
  exit_signal: "Signal", stop_loss: "Stop loss", stoploss: "Stop loss", trailing_stop_loss: "Trailing stop",
  roi: "Take profit", force_exit: "Manual", force_sell: "Manual", emergency_exit: "Emergency",
  liquidation: "Liquidation", custom_exit: "Rule exit", partial_exit: "Partial",
};
/** Lý do thoát lệnh của freqtrade → nhãn ngắn; không biết thì trả mã gốc. */
export const exitReason = (code) => (code ? (EXIT[code] || code) : "–");

const MODES = {
  paper: { name: "Dry-run", cls: "mode-paper", help: "Lệnh giả trong bot, không lên sàn, ví ảo." },
  demo: { name: "Demo", cls: "mode-demo", help: "Binance Demo: lệnh đặt thật trên sàn demo, tiền ảo." },
  live: { name: "LIVE", cls: "mode-live", help: "Tiền thật trên Binance." },
};
/** Chế độ bot (từ /api/live.mode hoặc tên trong /api/tune/live) → tên ngắn, lớp màu, giải thích (tiếng Việt). */
export function modeInfo(mode) {
  const key = { "dry-run": "paper", Demo: "demo", "TIỀN THẬT": "live", LIVE: "live" }[mode] || mode;
  return MODES[key] || { name: mode || "?", cls: "mode-unknown", help: "" };
}

/** "2021-01-01" → "20210101" cho --timerange của freqtrade. */
export const ymd = (iso) => String(iso || "").replaceAll("-", "");
