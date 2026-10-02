"""
Báo cáo tuần: bot có giữ được lợi thế của backtest ngoài dữ liệu đã dùng để chọn tham số không
(bot/research/robustness_trend_2026-10.md). Thứ Hai 08:00 giờ VN gửi tóm tắt về điện thoại; GET /api/weekly xem bất cứ lúc nào.

  - Demo (live) và paper: số lệnh, thắng, profit factor, lãi, sụt vốn — so với backtest TrendBreakout 5 coin.
  - Demo so với paper: paper chạy dry-run trên nến sàn thật, cùng cách freqtrade backtest, nên chính là "lệnh mô phỏng".
    Lệnh Demo không có ở paper (hoặc ngược lại) là do nến demo-fapi khác sàn thật hoặc khớp lệnh khác.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

log = logging.getLogger("hub.weekly")

# Backtest freqtrade TrendBreakout 5 coin 04/2020 → 09/2026 (1470 lệnh / 78 tháng). PF 1.55 lạc quan (5 coin chọn
# sau khi đã thấy kết quả) — 10 coin cho 1.33, nên verdict lấy 1.1 làm mốc "đúng kỳ vọng".
# Kỳ vọng theo bộ tham số live (SL 3×ATR, rủi ro 1%): backtest 5 coin vốn 500, 2021-01 → 2026-10, 1276 lệnh / 69 tháng.
EXPECT = {"per_month": 18, "win_pct": 35, "pf": 1.43, "dd_pct": 24}
MIN_TRADES = 30          # ít hơn thì PF/tỉ lệ thắng chủ yếu là nhiễu
MATCH_S = 4 * 3600       # cùng cặp, cùng chiều, giờ vào lệch ≤ 1 nến 4h thì coi là cùng một tín hiệu
VN = timezone(timedelta(hours=7))


def stats(trades: list[dict], start: float) -> dict:
    """trades: lệnh đã đóng (API freqtrade /trades). Sụt vốn tính trên vốn đã chốt."""
    closed = sorted((t for t in trades if not t.get("is_open")), key=lambda t: t["close_timestamp"])
    pnl = [t.get("profit_abs") or 0.0 for t in closed]
    win = sum(p for p in pnl if p > 0)
    loss = -sum(p for p in pnl if p < 0)
    eq = peak = start
    dd = 0.0
    for p in pnl:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
    return {"n": len(pnl), "wins": sum(p > 0 for p in pnl),
            "win_pct": 100 * sum(p > 0 for p in pnl) / len(pnl) if pnl else None,
            "pf": win / loss if loss else None,
            "pnl": sum(pnl), "pnl_pct": 100 * sum(pnl) / start if start else None, "dd_pct": 100 * dd}


def match(a: list[dict], b: list[dict]) -> int:
    """Số lệnh của a có lệnh cùng cặp, cùng chiều ở b, giờ vào lệch ≤ MATCH_S (mỗi lệnh b chỉ ghép một lần)."""
    used, n = set(), 0
    for t in a:
        for i, u in enumerate(b):
            if (i not in used and u.get("pair") == t.get("pair") and u.get("is_short") == t.get("is_short")
                    and abs(u["open_timestamp"] - t["open_timestamp"]) <= MATCH_S * 1000):
                used.add(i)
                n += 1
                break
    return n


def verdict(s: dict) -> str:
    if s["n"] < MIN_TRADES:
        return f"mới {s['n']}/{MIN_TRADES} lệnh, chưa đủ để kết luận"
    if s["pf"] is None or s["pf"] >= 1.1:
        return "đúng kỳ vọng backtest"
    if s["pf"] >= 1:
        return "lãi nhưng yếu hơn backtest"
    return "đang thua — sụt vốn quá 20% thì giảm nửa khối lượng, quá 30% thì bot tự dừng"


def _line(name: str, s: dict) -> str:
    if not s["n"]:
        return f"{name}: chưa có lệnh đóng"
    pf = f"{s['pf']:.2f}" if s["pf"] is not None else "∞"
    return (f"{name}: {s['n']} lệnh, thắng {s['win_pct']:.0f}%, PF {pf}, "
            f"{s['pnl_pct']:+.1f}%, DD {s['dd_pct']:.1f}% — {verdict(s)}")


async def build(live, paper) -> dict:
    """live/paper: tune.FtClient (paper có thể None)."""
    out, trades = {}, {}
    for name, cl in (("demo", live), ("paper", paper)):
        if cl is None:
            continue
        try:
            got, bal, prof = await asyncio.gather(cl.call("GET", "/trades", params={"limit": 500}),
                                                  cl.call("GET", "/balance"), cl.call("GET", "/profit"))
        except Exception as e:  # noqa: BLE001 — một bot không trả lời thì vẫn báo phần còn lại
            out[name] = {"error": str(getattr(e, "detail", e))[:200]}
            continue
        trades[name] = [t for t in got.get("trades", []) if not t.get("is_open")]
        out[name] = stats(trades[name], bal.get("starting_capital") or 0.0)
        out[name]["since"] = prof.get("bot_start_timestamp") or 0   # lần chạy đầu của DB, freqtrade lưu lại
    label = {"demo": "Live", "paper": "Paper"}
    lines = [_line(label[k], v) if "error" not in v else f"{label[k]}: không đọc được ({v['error']})"
             for k, v in out.items()]
    if "demo" in trades and "paper" in trades:
        d, p = trades["demo"], trades["paper"]
        since = max(out["demo"]["since"], out["paper"]["since"])
        d = [t for t in d if t["open_timestamp"] >= since]          # chỉ so giai đoạn cả hai cùng chạy
        p = [t for t in p if t["open_timestamp"] >= since]
        m = match(d, p)
        out["match"] = {"demo": len(d), "paper": len(p), "both": m}
        if d or p:
            lines.append(f"Demo/paper trùng {m} lệnh (Demo {len(d)}, paper {len(p)})")
    lines.append(f"Backtest: ~{EXPECT['per_month']} lệnh/tháng, thắng {EXPECT['win_pct']}%, PF {EXPECT['pf']}")
    out["text"] = "\n".join(lines)
    return out


def next_run(now: datetime) -> datetime:
    """Thứ Hai 08:00 giờ VN kế tiếp."""
    t = now.astimezone(VN).replace(hour=8, minute=0, second=0, microsecond=0)
    t += timedelta(days=(7 - t.weekday()) % 7)
    return t if t > now else t + timedelta(days=7)


async def run(live, paper, send: Callable[[str], Awaitable[None]]) -> None:
    while True:
        await asyncio.sleep((next_run(datetime.now(timezone.utc)) - datetime.now(timezone.utc)).total_seconds())
        try:
            await send("Báo cáo tuần\n" + (await build(live, paper))["text"])
        except Exception:  # noqa: BLE001 — lỗi một tuần không được giết vòng lặp
            log.exception("Báo cáo tuần lỗi")
