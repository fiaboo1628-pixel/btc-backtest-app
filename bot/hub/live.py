"""
Theo dõi bot (màn Tổng quan và Lịch sử lệnh của app): hub gọi API freqtrade của bot LIVE ở phía máy chủ rồi trả
gọn một gói, nên mật khẩu API của bot không bao giờ tới trình duyệt. Chỉ đọc — không vào/thoát lệnh từ đây.

    GET /api/live   → trạng thái, chế độ, số dư, lợi nhuận, sụt vốn so với ngưỡng tự dừng, lệnh đang mở,
                      lệnh vừa đóng, lãi theo ngày, đường vốn, log cảnh báo
    GET /api/trades → mọi lệnh đã đóng + thống kê so với kỳ vọng backtest (weekly.py)
"""
import asyncio
import json
from pathlib import Path

from fastapi import APIRouter

import weekly
from tune import FtClient

# Ngưỡng tự dừng vào lệnh mới của chiến lược (TrendBreakout.HALT_DD); không import chiến lược vì cần talib.
HALT_DD_PCT = 25.0
HALT_LOG = "DỪNG VÀO LỆNH MỚI"          # dòng log ERROR của chiến lược khi đã dừng


def has_stop(t: dict) -> bool:
    """Lệnh có stop nằm trên sàn không (màn Tổng quan và watchdog dùng chung một cách đánh giá)."""
    return bool(t.get("stoploss_order_id")) or any(
        o.get("ft_order_side") == "stoploss" and o.get("status") in ("open", "new") for o in t.get("orders") or [])


def trade_view(t: dict) -> dict:
    keep = ("trade_id", "pair", "is_short", "leverage", "amount", "stake_amount", "open_rate", "close_rate",
            "current_rate", "open_timestamp", "close_timestamp", "stop_loss_abs", "initial_stop_loss_abs",
            "profit_abs", "profit_pct", "profit_ratio", "exit_reason", "enter_tag", "is_open")
    out = {k: t.get(k) for k in keep if k in t}
    out["stop_on_exchange"] = has_stop(t)          # chỉ giữ việc stop có trên sàn không, bỏ chi tiết từng order
    return out


def equity_curve(start: float, closed: list[dict]) -> list[list]:
    """Vốn sau từng lệnh đóng: [[giờ đóng (ms), vốn], ...], bắt đầu từ vốn ban đầu. closed theo thứ tự đóng."""
    eq, out = start, []
    for t in sorted(closed, key=lambda t: t.get("close_timestamp") or 0):
        eq += t.get("profit_abs") or 0.0
        out.append([t.get("close_timestamp"), round(eq, 2)])
    return out


def drawdown(start: float, profits: list[float]) -> dict:
    """Sụt vốn trên vốn đã chốt, cùng cách tính với TrendBreakout.halt_reason: hiện tại và lớn nhất (%)."""
    eq = peak = start
    worst = 0.0
    for p in profits:
        eq += p
        peak = max(peak, eq)
        worst = max(worst, 1 - eq / peak if peak else 0.0)
    cur = (1 - eq / peak) if peak else 0.0
    return {"current_pct": round(100 * cur, 2), "max_pct": round(100 * worst, 2)}


def halt_on_param(strategy_dir: Path | None, strategy: str | None) -> bool | None:
    """halt_on trong <strategy>.json của bot LIVE; không có file thì mặc định True (như trong code chiến lược);
    không biết chiến lược thì None."""
    if not strategy_dir or not strategy:
        return None
    f = Path(strategy_dir) / f"{strategy}.json"
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return None
    for space in data.get("params", {}).values():
        if isinstance(space, dict) and "halt_on" in space:
            return bool(space["halt_on"])
    return True


def halt_view(start: float, closed: list[dict], halt_on: bool | None, logs: list[dict]) -> dict:
    """Bot có đang tự dừng vào lệnh mới không, và còn cách ngưỡng bao xa."""
    dd = drawdown(start or 0.0, [t.get("profit_abs") or 0.0 for t in closed])
    over = dd["max_pct"] > HALT_DD_PCT
    logged = any(HALT_LOG in (l.get("msg") or "") for l in logs)
    return {"threshold_pct": HALT_DD_PCT, "current_dd_pct": dd["current_pct"], "max_dd_pct": dd["max_pct"],
            "halt_on": halt_on, "halted": bool(halt_on is not False and (over or logged))}


def disk_mode(mode_file: Path) -> str | None:
    """Chế độ ghi trên đĩa, đọc từ .env của compose (setup --api ghi BOT_DB=demo/real, --dryrun xoá file).
    Không đọc secrets/exchange.json: hub không được thấy API key sàn."""
    try:
        text = mode_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "paper"
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("BOT_DB="):
            return {"demo": "demo", "real": "live"}.get(line.split("=", 1)[1].strip())
    return "paper"


NAMES = {"paper": "dry-run", "demo": "Demo", "live": "TIỀN THẬT"}


def mode_of(conf: dict, mode_file: Path) -> tuple[str, str | None]:
    """Chế độ của process bot ĐANG CHẠY (/show_config), không phải file trên đĩa — setup --api ghi đè file
    ngay, còn bot cũ vẫn chạy tới lần `up -d` sau. Trả thêm cảnh báo khi file trên đĩa khác bot đang chạy."""
    if conf.get("dry_run"):
        mode = "paper"
    elif conf.get("demo_trading") is None:             # freqtrade cũ không trả demo_trading: đành tin file
        d = disk_mode(mode_file)
        return (d if d in ("demo", "live") else "live"), None
    else:
        mode = "demo" if conf["demo_trading"] else "live"
    on_disk = disk_mode(mode_file)
    if on_disk is not None and on_disk != mode:
        return mode, (f"Bot đang chạy {NAMES[mode]} nhưng cấu hình trên đĩa là {NAMES[on_disk]} — "
                      "cần `docker compose up -d` để áp dụng")
    return mode, None


def router(cfg: dict, has_alerts=lambda: False) -> APIRouter:
    live = FtClient(cfg["live"])
    mode_file = Path(cfg.get("mode_file", "/deploy/.env"))
    strategy_dir = cfg["live"].get("strategy_dir")
    r = APIRouter()

    @r.get("/api/live")
    async def summary():
        calls = {
            "config": ("/show_config", {}), "balance": ("/balance", {}), "status": ("/status", {}),
            "profit": ("/profit", {}), "daily": ("/daily", {"timescale": 30}),
            "trades": ("/trades", {"limit": 500}), "logs": ("/logs", {"limit": 200}), "health": ("/health", {}),
        }
        res = await asyncio.gather(*(live.call("GET", p, params=q) for p, q in calls.values()),
                                   return_exceptions=True)
        got = dict(zip(calls, res))
        conf = got["config"]
        if isinstance(conf, Exception):
            return {"reachable": False, "error": str(getattr(conf, "detail", conf))[:200]}
        ok = lambda k: None if isinstance(got[k], Exception) else got[k]  # noqa: E731

        bal, prof, health = ok("balance") or {}, ok("profit") or {}, ok("health") or {}
        closed = [t for t in (ok("trades") or {}).get("trades", []) if not t.get("is_open")]
        closed.sort(key=lambda t: t.get("close_timestamp") or 0, reverse=True)
        logs = [{"t": row[1] / 1000, "level": row[3], "msg": row[4][:300]}
                for row in (ok("logs") or {}).get("logs", []) if row[3] in ("WARNING", "ERROR", "CRITICAL")]
        mode, mode_warning = mode_of(conf, mode_file)
        start = bal.get("starting_capital") or 0.0
        return {
            "reachable": True,
            "mode": mode,
            "mode_warning": mode_warning,
            "alerts": has_alerts(),
            "state": conf.get("state"),
            "strategy": conf.get("strategy"),
            "timeframe": conf.get("timeframe"),
            "exchange": conf.get("exchange"),
            "stake_currency": conf.get("stake_currency"),
            "bot_name": conf.get("bot_name"),
            "balance": {"total": bal.get("total_bot", bal.get("total")),  # phần bot dùng (stake), không cộng BTC/USDC khác của tài khoản
                        "account_total": bal.get("total"), "starting": bal.get("starting_capital"),
                        "currency": bal.get("stake")},
            "profit": {k: prof.get(k) for k in (
                "profit_all_coin", "profit_all_percent", "profit_closed_coin", "profit_closed_percent",
                "trade_count", "closed_trade_count", "winning_trades", "losing_trades", "winrate",
                "max_drawdown", "max_drawdown_abs", "profit_factor", "first_trade_timestamp",
                "bot_start_timestamp")},
            "halt": halt_view(start, closed, halt_on_param(strategy_dir, conf.get("strategy")), logs),
            "open": [trade_view(t) for t in (ok("status") or [])],
            "closed": [trade_view(t) for t in closed[:20]],
            "equity": equity_curve(start, closed),
            "daily": [{"date": d.get("date"), "abs": d.get("abs_profit"), "trades": d.get("trade_count")}
                      for d in (ok("daily") or {}).get("data", [])],
            "last_process_ts": health.get("last_process_ts"),
            "logs": logs[-15:][::-1],
        }

    @r.get("/api/trades")
    async def trades():
        """Mọi lệnh đã đóng (mới nhất trước) + thống kê, so với kỳ vọng từ backtest (weekly.EXPECT)."""
        got, bal, prof = await asyncio.gather(
            live.call("GET", "/trades", params={"limit": 500}), live.call("GET", "/balance"),
            live.call("GET", "/profit"), return_exceptions=True)
        if isinstance(got, Exception):
            return {"reachable": False, "error": str(getattr(got, "detail", got))[:200]}
        bal = {} if isinstance(bal, Exception) else bal
        prof = {} if isinstance(prof, Exception) else prof
        closed = [t for t in got.get("trades", []) if not t.get("is_open")]
        start = bal.get("starting_capital") or 0.0
        st = weekly.stats(closed, start)
        closed.sort(key=lambda t: t.get("close_timestamp") or 0, reverse=True)
        return {
            "reachable": True,
            "trades": [trade_view(t) for t in closed],
            "stats": st,
            "verdict": weekly.verdict(st),
            "expect": weekly.EXPECT,
            "min_trades": weekly.MIN_TRADES,
            "starting": start,
            "since": prof.get("bot_start_timestamp") or prof.get("first_trade_timestamp"),
            "stake_currency": bal.get("stake"),
        }

    return r

