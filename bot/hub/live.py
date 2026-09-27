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


def mode_of(dry_run: bool | None, exchange_file: Path) -> str:
    if dry_run:
        return "paper"
    try:
        demo = json.loads(exchange_file.read_text(encoding="utf-8")).get("exchange", {}).get("demo_trading")
    except (OSError, ValueError):
        demo = None
    return "demo" if demo else "live"


def router(cfg: dict) -> APIRouter:
    live = FtClient(cfg["live"])
    exchange_file = Path(cfg.get("exchange_file", "/deploy/secrets/exchange.json"))
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
        return {
            "reachable": True,
            "mode": mode_of(conf.get("dry_run"), exchange_file),
            "state": conf.get("state"),
            "strategy": conf.get("strategy"),
            "timeframe": conf.get("timeframe"),
            "exchange": conf.get("exchange"),
            "stake_currency": conf.get("stake_currency"),
            "bot_name": conf.get("bot_name"),
            "balance": {"total": bal.get("total"), "starting": bal.get("starting_capital"),
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

