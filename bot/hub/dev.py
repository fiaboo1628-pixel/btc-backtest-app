"""
Hub giả để xem/thử app mà không cần freqtrade hay bot: chạy đúng server.py nhưng bot LIVE/LAB là dữ liệu bịa.
Dùng để phát triển giao diện và chụp ảnh màn hình (tests/screenshots.mjs).

    uv run --no-project --with fastapi --with uvicorn --with httpx --with cryptography python bot/hub/dev.py [--scenario demo] [--port 8090]

Đăng nhập: admin / dev. Kịch bản (--scenario): demo (mặc định), live (tiền thật, một lệnh thiếu stop), paper,
halted (đã tự dừng vì sụt vốn), offline (bot không trả lời), empty (chưa có lệnh).
"""
import argparse
import asyncio
import random
import sys
import tempfile
import time
from pathlib import Path

import uvicorn
from fastapi import HTTPException

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import labdata  # noqa: E402
import server  # noqa: E402
import tune  # noqa: E402

REPO = HERE.parent.parent
PAIRS = ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "XRP/USDT:USDT", "DOGE/USDT:USDT"]
PRICE = {"BTC": 112000, "ETH": 4100, "SOL": 210, "XRP": 2.9, "DOGE": 0.24}
SCHEMA = [
    {"name": "entry_period", "space": "buy", "type": "int", "min": 10, "max": 100, "default": 20},
    {"name": "ema_filter", "space": "buy", "type": "bool", "default": True},
    {"name": "short_enabled", "space": "buy", "type": "bool", "default": True},
    {"name": "exit_period", "space": "sell", "type": "int", "min": 5, "max": 50, "default": 10},
    {"name": "r_atr", "space": "sell", "type": "decimal", "min": 1.0, "max": 6.0, "decimals": 1, "default": 2.0},
    {"name": "risk_pct", "space": "sell", "type": "decimal", "min": 0.1, "max": 3.0, "decimals": 2, "default": 0.25},
    {"name": "max_lev", "space": "sell", "type": "int", "min": 1, "max": 10, "default": 5},
    {"name": "fixed_lev", "space": "sell", "type": "bool", "default": True},
    {"name": "halt_on", "space": "sell", "type": "bool", "default": True},
]


def fake_schema(*_):
    out = []
    for s in SCHEMA:
        label, help_ = tune.LABELS.get(s["name"], (s["name"], ""))
        out.append({**s, "label": label, "help": help_})
    return out


def make_trades(n: int, start_ms: int, seed: int = 7, loser: bool = False) -> list[dict]:
    rnd = random.Random(seed)
    out, t = [], start_ms
    for i in range(n):
        pair = rnd.choice(PAIRS)
        coin = pair.split("/")[0]
        short = rnd.random() < 0.45
        t += rnd.randint(4, 64) * 3600 * 1000
        hold = rnd.randint(8, 120) * 3600 * 1000
        win = rnd.random() < (0.22 if loser else 0.34)
        r = rnd.uniform(0.8, 3.5) if win else -rnd.uniform(0.6, 1.05)
        pnl = round(r * 2.5, 2)                                  # 1R ≈ 0.25% của 1000 USDT
        px = PRICE[coin] * rnd.uniform(0.85, 1.15)
        move = px * 0.03 * r / 2 * (-1 if short else 1)
        out.append({
            "trade_id": i + 1, "pair": pair, "is_short": short, "leverage": 5, "amount": round(250 / px, 4), "stake_amount": 50,
            "open_rate": round(px, 4), "close_rate": round(px + move, 4), "open_timestamp": t, "close_timestamp": t + hold,
            "profit_abs": pnl, "profit_ratio": pnl / 50, "profit_pct": round(pnl / 50 * 100, 2),
            "exit_reason": rnd.choice(["exit_signal", "exit_signal", "stop_loss", "trailing_stop_loss"]) if not win else "exit_signal",
            "is_open": False, "stop_loss_abs": round(px - px * 0.03 * (-1 if short else 1), 4),
        })
    return out


def open_trade(tid: int, coin: str, short: bool, pnl: float, stop: bool) -> dict:
    px = PRICE[coin]
    now = int(time.time() * 1000)
    return {"trade_id": tid, "pair": f"{coin}/USDT:USDT", "is_short": short, "leverage": 5, "amount": 0.1,
            "stake_amount": 50, "open_rate": px, "current_rate": round(px * (1 + (-1 if short else 1) * pnl / 250), 4),
            "open_timestamp": now - 26 * 3600 * 1000, "stop_loss_abs": round(px * (1.03 if short else 0.97), 4),
            "profit_abs": pnl, "profit_pct": round(pnl / 50 * 100, 2), "is_open": True,
            "stoploss_order_id": "x1" if stop else None, "orders": []}


class FakeBots:
    def __init__(self, scenario: str):
        self.sc = scenario
        now = int(time.time() * 1000)
        self.start = 1000.0
        n = 0 if scenario == "empty" else 64
        self.closed = make_trades(n, now - 92 * 86400 * 1000, loser=(scenario == "halted"))
        self.closed = [t for t in self.closed if t["close_timestamp"] < now]
        self.closed_pnl = sum(t["profit_abs"] for t in self.closed)
        if scenario == "halted":
            self.closed_pnl = -280.0
            self.closed[-1]["profit_abs"] = self.closed[-1]["profit_abs"] - (sum(t["profit_abs"] for t in self.closed) + 280)
        self.open = [] if scenario in ("empty", "halted") else [
            open_trade(901, "BTC", False, 7.4, True), open_trade(902, "SOL", True, -2.1, scenario != "live")]
        self.bt = {"status": "not_started", "running": False, "progress": 0, "step": None, "status_msg": None, "result": None}
        self.bt_started = 0.0
        self.applied = 0

    def mode(self) -> dict:
        return {"paper": {"dry_run": True}, "live": {"dry_run": False, "demo_trading": False}}.get(self.sc, {"dry_run": False, "demo_trading": True})

    async def call(self, method: str, path: str, **kw):
        if self.sc == "offline":
            raise HTTPException(502, "freqtrade /show_config: connection refused")
        p = kw.get("params") or {}
        j = kw.get("json") or {}
        if path == "/show_config":
            return {"state": "running", "strategy": "TrendBreakout", "timeframe": "4h", "exchange": "binance",
                    "stake_currency": "USDT", "max_open_trades": 5, "bot_name": "TrendBreakout-dev", **self.mode()}
        if path == "/balance":
            total = self.start + self.closed_pnl
            return {"total": total + 230.5, "total_bot": round(total, 2), "starting_capital": self.start, "stake": "USDT"}
        if path == "/status":
            return self.open
        if path == "/profit":
            wins = sum(t["profit_abs"] > 0 for t in self.closed)
            win = sum(t["profit_abs"] for t in self.closed if t["profit_abs"] > 0)
            loss = -sum(t["profit_abs"] for t in self.closed if t["profit_abs"] < 0)
            unreal = sum(t["profit_abs"] for t in self.open)
            return {"profit_all_coin": round(self.closed_pnl + unreal, 2), "profit_all_percent": round((self.closed_pnl + unreal) / 10, 2),
                    "profit_closed_coin": round(self.closed_pnl, 2), "profit_closed_percent": round(self.closed_pnl / 10, 2),
                    "trade_count": len(self.closed) + len(self.open), "closed_trade_count": len(self.closed),
                    "winning_trades": wins, "losing_trades": len(self.closed) - wins,
                    "winrate": wins / len(self.closed) if self.closed else None, "max_drawdown": 0.061, "max_drawdown_abs": 61,
                    "profit_factor": (win / loss) if loss else None, "first_trade_timestamp": self.closed[0]["open_timestamp"] if self.closed else None,
                    "bot_start_timestamp": int(time.time() * 1000) - 96 * 86400 * 1000}
        if path == "/daily":
            days, now = [], int(time.time())
            for i in range(p.get("timescale", 30)):
                d = time.strftime("%Y-%m-%d", time.gmtime(now - i * 86400))
                day = [t for t in self.closed if time.strftime("%Y-%m-%d", time.gmtime(t["close_timestamp"] / 1000)) == d]
                days.append({"date": d, "abs_profit": round(sum(t["profit_abs"] for t in day), 2), "trade_count": len(day)})
            return {"data": days}
        if path == "/trades":
            return {"trades": self.closed + self.open}
        if path == "/logs":
            now = int(time.time() * 1000)
            rows = [["d", now - 3600_000, "freqtrade.worker", "INFO", "Bot heartbeat"],
                    ["d", now - 2 * 3600_000, "freqtrade.exchange", "WARNING", "Binance trả lời chậm (1.9 s)"]]
            if self.sc == "halted":
                rows.append(["d", now - 600_000, "TrendBreakout", "ERROR",
                             "DỪNG VÀO LỆNH MỚI: sụt vốn 28.0% > 25% — bỏ tín hiệu ETH/USDT:USDT long. Xem lại rồi tắt halt_on để chạy tiếp."])
            return {"logs": rows}
        if path == "/health":
            return {"last_process_ts": time.time() - 4}
        if path == "/whitelist":
            return {"whitelist": PAIRS}
        if path == "/reload_config":
            self.applied += 1
            return {"status": "Reloading config ..."}
        if path == "/backtest" and method == "GET":
            return self.poll_bt()
        if path == "/backtest" and method == "POST":
            self.bt = {"status": "running", "running": True, "progress": 0.0, "step": "Đang nạp nến", "status_msg": None}
            self.bt_started = time.time()
            self.bt_req = j
            return {"status": "running"}
        if path == "/backtest" and method == "DELETE":
            return {"status": "reset"}
        return {}

    def poll_bt(self) -> dict:
        if self.bt["running"]:
            el = time.time() - self.bt_started
            if el < 6:
                self.bt["progress"] = min(0.95, el / 6)
                self.bt["step"] = "Tính chỉ báo" if el < 2 else "Backtest"
            else:
                self.bt = {"status": "ended", "running": False, "progress": 1, "step": None, "status_msg": None,
                           "backtest_result": self.bt_result()}
        return self.bt

    def bt_result(self) -> dict:
        rnd = random.Random(hash(str(getattr(self, "bt_req", {}))) & 0xFFFF)
        wallet = float(self.bt_req.get("dry_run_wallet", 1000))
        tr = self.bt_req.get("timerange", "20210101-")
        y0 = int(tr[:4]); y1 = 2026
        daily, bal, t = [], wallet, time.mktime((y0, 1, 1, 0, 0, 0, 0, 0, 0))
        end = time.time() if not tr.split("-")[1] else time.mktime((int(tr.split("-")[1][:4]), int(tr.split("-")[1][4:6]), 1, 0, 0, 0, 0, 0, 0))
        years = {}
        while t < end:
            pnl = rnd.gauss(0.0005, 0.011) * bal
            bal += pnl
            d = time.strftime("%Y-%m-%d", time.gmtime(t))
            daily.append([d, round(pnl, 2)])
            y = years.setdefault(d[:4], {"date": f"01/01/{d[:4]}", "profit_abs": 0.0, "trades": 0, "profit_factor": 0})
            y["profit_abs"] += pnl; y["trades"] += 1 if rnd.random() < 0.6 else 0
            t += 86400
        for y in years.values():
            y["profit_abs"] = round(y["profit_abs"], 2); y["profit_factor"] = round(rnd.uniform(0.9, 2.1), 2)
        peak, dd = wallet, 0.0
        b = wallet
        for _, pnl in daily:
            b += pnl; peak = max(peak, b); dd = max(dd, 1 - b / peak)
        total = sum(y["trades"] for y in years.values())
        pairs = [{"key": p, "trades": max(1, total // 5 + rnd.randint(-10, 10)), "profit_total_abs": round(rnd.uniform(-60, 220), 2),
                  "profit_total": rnd.uniform(-0.06, 0.22), "profit_factor": round(rnd.uniform(0.7, 2.4), 2), "winrate": rnd.uniform(0.25, 0.42)}
                 for p in PAIRS] + [{"key": "TOTAL", "trades": total, "profit_total_abs": 0, "profit_total": 0, "profit_factor": 1, "winrate": 0.3}]
        return {"strategy": {"TrendBreakout": {
            "starting_balance": wallet, "daily_profit": daily, "backtest_start": f"{y0}-01-01 00:00:00",
            "backtest_end": time.strftime("%Y-%m-%d 00:00:00", time.gmtime(end)), "total_trades": total,
            "trade_count_long": total * 6 // 10, "trade_count_short": total - total * 6 // 10,
            "profit_total": (bal - wallet) / wallet, "profit_total_abs": round(bal - wallet, 2), "max_drawdown_account": dd,
            "winrate": 0.32, "profit_factor": round(rnd.uniform(1.0, 1.7), 2), "cagr": ((bal / wallet) ** (365 / max(1, len(daily))) - 1),
            "market_change": rnd.uniform(-0.2, 1.5), "periodic_breakdown": {"year": list(years.values())},
            "results_per_pair": pairs, "stake_currency": "USDT"}}}


def fake_ranges(data_dir, pairs, tfs):
    out = []
    for pair in pairs:
        for tf in tfs:
            frm = "2021-01-01" if tf == "4h" else "2023-06-01"
            if pair.startswith("DOGE") and tf == "15m":
                frm = "2024-02-01"
            out.append({"pair": pair, "tf": tf, "from": frm, "to": "2026-10-01 20:00" if tf == "4h" else "2026-10-01 23:45"})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Hub giả để xem app")
    ap.add_argument("--scenario", default="demo", choices=["demo", "live", "paper", "halted", "offline", "empty"])
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    bots = FakeBots(args.scenario)

    async def call(self, method, path, **kw):
        return await bots.call(method, path, **kw)

    tune.FtClient.call = call
    tune.load_schema = fake_schema
    tune.data_ranges = fake_ranges

    async def fake_download(self):
        await asyncio.sleep(1)

    labdata.Updater.download = fake_download
    labdata.EVERY_S = 3600

    tmp = Path(tempfile.mkdtemp(prefix="hub-dev-"))
    env = tmp / ".env"
    if args.scenario in ("demo", "halted", "empty"):
        env.write_text("BOT_DB=demo\n")
    elif args.scenario == "live":
        env.write_text("BOT_DB=real\n")
    (tmp / "lab").mkdir(); (tmp / "live").mkdir(); (tmp / "data" / "binance").mkdir(parents=True)
    cfg = {
        "strategy": "TrendBreakout",
        "hub": {"username": "admin", "password": "dev", "trust_tailscale": False, "host": args.host, "port": args.port},
        "app_dir": str(REPO), "mode_file": str(env), "bot_config": str(REPO / "bot" / "deploy" / "config.base.json"),
        "data": {"dir": str(tmp / "data"), "datasets": []},
        "lab": {"api_url": "http://lab", "username": "u", "password": "p", "strategy_dir": tmp / "lab"},
        "live": {"api_url": "http://live", "username": "u", "password": "p", "strategy_dir": tmp / "live"},
        "paper": {"api_url": "http://paper", "username": "u", "password": "p"},
    }
    app = server.create_app(cfg)
    # vài cảnh báo mẫu cho màn Cảnh báo
    import alerts
    hist = alerts.History(tmp / "data" / "alerts.json")
    now = time.time()
    for dt, msg in ((3 * 86400, "[bot] ⚠️ Bot không trả lời API (connection refused)"), (3 * 86400 - 240, "[bot] ✅ Hết: Bot không trả lời API (connection refused)"),
                    (86400, "[hub] ⚠️ Không cập nhật được nến cho LAB 2 lần liền: download-data lỗi (mã 1): mạng lỗi"),
                    (80000, "[hub] ✅ Hết: nến cho LAB đã cập nhật lại được")):
        hist.now = lambda dt=dt: now - dt
        hist.add(msg)
    hist.items.sort(key=lambda x: -x["t"])

    @app.get("/api/alerts", include_in_schema=False)
    async def alerts_dev():
        return {"channels": {"telegram": args.scenario == "live", "devices": 1 if args.scenario == "live" else 0},
                "active": ["Lệnh #902 SOL/USDT:USDT Short đang mở mà KHÔNG có stop trên sàn"] if args.scenario == "live" else [],
                "recent": hist.items}

    app.router.routes.insert(0, app.router.routes.pop())        # ghi đè route /api/alerts thật
    print(f"Hub giả ({args.scenario}): http://{args.host}:{args.port}  đăng nhập admin / dev")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
