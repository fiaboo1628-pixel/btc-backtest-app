"""
Bảng theo dõi bot (tab Live của app): hub gọi API freqtrade của bot LIVE ở phía máy chủ rồi trả gọn một gói,
nên mật khẩu API của bot không bao giờ tới trình duyệt. Chỉ đọc — không vào/thoát lệnh từ đây.

    GET /api/live → trạng thái, số dư, lợi nhuận, lệnh đang mở, lệnh vừa đóng, lãi theo ngày, log cảnh báo
"""
import asyncio
import json
from pathlib import Path

from fastapi import APIRouter

from tune import FtClient


def trade_view(t: dict) -> dict:
    keep = ("trade_id", "pair", "is_short", "leverage", "amount", "stake_amount", "open_rate", "close_rate",
            "current_rate", "open_timestamp", "close_timestamp", "stop_loss_abs", "initial_stop_loss_abs",
            "profit_abs", "profit_pct", "profit_ratio", "exit_reason", "enter_tag", "is_open",
            "stoploss_order_id", "orders")
    out = {k: t.get(k) for k in keep if k in t}
    # chỉ giữ việc lệnh stop có nằm trên sàn không, bỏ chi tiết từng order
    orders = out.pop("orders", None) or []
    out["stop_on_exchange"] = bool(out.pop("stoploss_order_id", None)) or any(
        o.get("ft_order_side") == "stoploss" and o.get("status") in ("open", "new") for o in orders)
    return out


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
        logs = [{"t": row[1], "level": row[3], "msg": row[4][:300]}
                for row in (ok("logs") or {}).get("logs", []) if row[3] in ("WARNING", "ERROR", "CRITICAL")]
        mode, mode_warning = mode_of(conf, mode_file)
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
            "open": [trade_view(t) for t in (ok("status") or [])],
            "closed": [trade_view(t) for t in closed[:20]],
            "daily": [{"date": d.get("date"), "abs": d.get("abs_profit"), "trades": d.get("trade_count")}
                      for d in (ok("daily") or {}).get("data", [])],
            "last_process_ts": health.get("last_process_ts"),
            "logs": logs[-15:][::-1],
        }

    return r

