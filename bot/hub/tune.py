"""
Chỉnh tham số chiến lược của bot (hub.json "strategy"; trước là trang "tuner" riêng): backtest thử trên LAB, áp dụng cho LIVE.

    LAB : freqtrade webserver — backtest với tham số đang thử (thư mục strategies_lab/)
    LIVE: freqtrade trade     — ghi tham số + reload_config (thư mục strategies/, luôn sao lưu bản cũ)

Mọi đường dẫn nằm dưới /api/tune/ của hub.
"""
import asyncio
import importlib.util
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

DETAIL_TF = "15m"              # nến chi tiết để khớp lệnh trong nến tín hiệu (--timeframe-detail)

# Nhãn ngắn (tiếng Anh, hiện trên form) + giải thích tiếng Việt cho từng tham số. Tham số nào không có ở đây vẫn hiện, với tên gốc.
LABELS: dict[str, tuple[str, str]] = {
    # TrendBreakout
    "entry_period": ("Entry channel (bars)", "Long khi đóng cửa trên đỉnh, Short khi dưới đáy của ngần này nến trước."),
    "ema_filter": ("EMA200 filter", "Chỉ Long khi giá trên EMA200, chỉ Short khi dưới."),
    "exit_period": ("Exit channel (bars)", "Thoát khi đóng cửa thủng đáy (Long) / vượt đỉnh (Short) của ngần này nến."),
    "fixed_lev": ("Fixed leverage", "Bật: luôn dùng đòn bẩy tối đa để ký quỹ mỗi lệnh nhỏ (rủi ro/lệnh không đổi). "
                                     "Nên bật khi chạy nhiều coin."),
    # DonchianRevert
    "dc_period": ("Donchian period", "Số nến 15m để tính đỉnh/đáy kênh."),
    "dc_long": ("Long threshold", "Vào Long khi vị trí giá trong kênh ≤ ngưỡng này (0 = đáy kênh)."),
    "dc_short": ("Short threshold", "Vào Short khi vị trí giá trong kênh ≥ ngưỡng này (1 = đỉnh kênh)."),
    "adx_min": ("Min ADX", "Chỉ vào lệnh khi ADX(14) lớn hơn mức này."),
    "vol_max": ("Max volume (× 24h avg)", "Bỏ qua khi volume cao hơn mức này — tránh bán tháo/mua đuổi."),
    "atr_min_pct": ("Min ATR (% price)", "Chỉ vào lệnh khi biến động đủ lớn (phí chỉ là phần nhỏ của R)."),
    "short_enabled": ("Allow short", "Tắt để chỉ đánh Long."),
    "r_atr": ("Stop width (× ATR)", "1R = stoploss ban đầu = hệ số này × ATR của nến tín hiệu."),
    "trail_start_r": ("Trailing start (R)", "Lãi chạm mức này (tính theo R) thì bật trailing."),
    "trail_dist_r": ("Trailing distance (R)", "Trailing bám đỉnh/đáy, cách một khoảng bằng ngần này R."),
    "trail_on": ("Trailing stop", "Tắt để chỉ còn SL ban đầu (và TP nếu có)."),
    "tp_r": ("Take profit (R)", "Chốt lời khi lãi đạt ngần này R; 0 = tắt."),
    "risk_pct": ("Risk per trade (%)", "Số % vốn mất nếu lệnh dính stoploss ban đầu."),
    "max_lev": ("Max leverage", "Giới hạn đòn bẩy khi tính khối lượng theo rủi ro."),
    "halt_on": ("Auto-halt", "Sụt vốn > 20%: rủi ro mỗi lệnh còn một nửa; > 30%: ngừng vào lệnh mới. Đã dừng thì tắt để chạy tiếp "
                                          "(sau khi xem lại)."),
}
SPACE_TITLES = {"buy": "Entry", "sell": "Exit & risk"}


def load_schema(strategy_file: Path, class_name: str) -> list[dict]:
    """Đọc tham số (tên, space, min/max, mặc định) trực tiếp từ class chiến lược."""
    from freqtrade.strategy.parameters import (
        BooleanParameter, CategoricalParameter, DecimalParameter, IntParameter,
    )

    spec = importlib.util.spec_from_file_location(f"_tuner_{class_name}", strategy_file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    cls = getattr(mod, class_name)
    out = []
    for name in dir(cls):
        p = getattr(cls, name)
        if isinstance(p, BooleanParameter):
            item = {"type": "bool", "default": bool(p.value)}
        elif isinstance(p, CategoricalParameter):
            continue
        elif isinstance(p, DecimalParameter):
            item = {"type": "decimal", "min": float(p.low), "max": float(p.high),
                    "decimals": p.decimals, "default": float(p.value)}
        elif isinstance(p, IntParameter):
            item = {"type": "int", "min": int(p.low), "max": int(p.high), "default": int(p.value)}
        else:
            continue
        label, help_ = LABELS.get(name, (name, ""))
        out.append({"name": name, "space": p.space, "label": label, "help": help_, **item})
    order = list(LABELS)
    out.sort(key=lambda x: (x["space"] != "buy", order.index(x["name"]) if x["name"] in order else 99))
    return out


# ----------------------------------------------------------------------------- tham số
def validate(schema: list[dict], values: dict[str, Any], base: dict[str, Any] | None = None) -> dict[str, dict]:
    """Kiểm tra giá trị nằm trong giới hạn và đúng bước; trả về {space: {name: value}}.
    Tham số không gửi lấy từ `base` (giá trị đang chạy), không phải mặc định trong code — gửi một phần
    không được lặng lẽ đặt lại các tham số khác. Giá trị lệch bước thì báo lỗi, không tự làm tròn."""
    by_name = {s["name"]: s for s in schema}
    unknown = set(values) - set(by_name)
    if unknown:
        raise HTTPException(400, f"Tham số không tồn tại: {', '.join(sorted(unknown))}")
    base = base or {}
    grouped: dict[str, dict] = {}
    for name, s in by_name.items():
        v = values.get(name, base.get(name, s["default"]))
        if s["type"] == "bool":
            if not isinstance(v, bool):
                raise HTTPException(400, f"{s['label']}: phải là bật/tắt")
        else:
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{s['label']}: không phải số") from None
            if not s["min"] <= v <= s["max"]:
                raise HTTPException(400, f"{s['label']}: phải trong khoảng {s['min']}–{s['max']}")
            r = int(round(v)) if s["type"] == "int" else round(v, s["decimals"])
            if abs(r - v) > 1e-9:
                step = "số nguyên" if s["type"] == "int" else f"tối đa {s['decimals']} chữ số thập phân"
                raise HTTPException(400, f"{s['label']}: {v:g} không hợp lệ, bot nhận {step}")
            v = r
        grouped.setdefault(s["space"], {})[name] = v
    return grouped


def params_file(strategy_dir: Path, class_name: str) -> Path:
    return strategy_dir / f"{class_name}.json"


def read_params(schema: list[dict], strategy_dir: Path, class_name: str) -> dict[str, Any]:
    vals = {s["name"]: s["default"] for s in schema}
    f = params_file(strategy_dir, class_name)
    if f.is_file():
        data = json.loads(f.read_text(encoding="utf-8"))
        for space in data.get("params", {}).values():
            vals.update({k: v for k, v in space.items() if k in vals})
    return vals


def write_params(grouped: dict, strategy_dir: Path, class_name: str, backup: bool) -> Path:
    f = params_file(strategy_dir, class_name)
    if backup and f.is_file():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        bdir = strategy_dir / "param_backups"
        bdir.mkdir(exist_ok=True)
        shutil.copy2(f, bdir / f"{class_name}.{stamp}.json")
    payload = {
        "strategy_name": class_name,
        "params": grouped,
        "ft_stratparam_v": 1,
        "export_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S%z"),
    }
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(f)
    return f


# ----------------------------------------------------------------------------- freqtrade API
class FtClient:
    def __init__(self, c: dict):
        self.base = c["api_url"].rstrip("/") + "/api/v1"
        self.auth = (c["username"], c["password"])

    async def call(self, method: str, path: str, **kw) -> Any:
        async with httpx.AsyncClient(timeout=15, auth=self.auth) as cl:
            r = await cl.request(method, self.base + path, **kw)
        if r.status_code >= 400:
            raise HTTPException(502, f"freqtrade {path}: HTTP {r.status_code} {r.text[:200]}")
        return r.json()


def lab_datadir(cfg: dict) -> Path:
    """datadir mặc định của LAB (freqtrade): user_data/data/binance; nến futures nằm trong thư mục con futures/."""
    return Path(cfg["lab"]["strategy_dir"]).parent / "data" / "binance"


def tf_seconds(tf: str) -> int:
    return int(tf[:-1]) * {"m": 60, "h": 3600, "d": 86400, "w": 604800}[tf[-1]]


def detail_problems(rows: list[dict], tf: str, timerange: str) -> tuple[list[str], list[str]]:
    """So nến 15m với nến tín hiệu của từng coin (rows từ data_ranges). Trả về (lỗi, cảnh báo).
    freqtrade KHÔNG báo lỗi khi một coin thiếu nến chi tiết — nó lặng lẽ khớp lệnh theo nến tín hiệu cho coin đó
    (chỉ báo "No data found" khi thiếu cả) — nên hub tự kiểm tra trước khi chạy."""
    by = {(r["pair"], r["tf"]): r for r in rows}
    tr_from, _, tr_to = timerange.partition("-")
    day = lambda s: f"{s[:4]}-{s[4:6]}-{s[6:8]}" if s else ""  # noqa: E731
    missing, warns = [], []
    for pair in dict.fromkeys(r["pair"] for r in rows):
        coin = pair.split("/")[0]
        main, det = by.get((pair, tf)), by.get((pair, DETAIL_TF))
        if not det or not det["from"]:
            missing.append(coin)
            continue
        if not main or not main["from"]:
            continue                                 # thiếu nến tín hiệu: freqtrade tự báo
        start = max(main["from"], day(tr_from))
        end = min(main["to"][:10], day(tr_to) or main["to"][:10])
        if det["from"] > start:
            warns.append(f"{coin}: nến {DETAIL_TF} chỉ có từ {det['from']}, trước đó khớp lệnh theo nến {tf}")
        if det["to"][:10] < end:
            warns.append(f"{coin}: nến {DETAIL_TF} chỉ tới {det['to'][:10]}, sau đó khớp lệnh theo nến {tf}")
    errors = [f"Thiếu nến {DETAIL_TF} của {', '.join(missing)}: freqtrade sẽ không báo lỗi mà lặng lẽ khớp lệnh "
              f"theo nến {tf} cho các coin này, kết quả lệch với các coin khác. Chờ hub tự tải nến "
              "(mỗi ngày, xem khung \"Bot đang chạy\") rồi chạy lại."] if missing else []
    return errors, warns


def data_ranges(data_dir: Path, pairs: list[str], tfs: list[str]) -> list[dict]:
    """Nến LAB có sẵn cho từng cặp/khung: ngày đầu, ngày cuối (None = chưa có file)."""
    out = []
    for pair in pairs:
        for tf in tfs:
            f = data_dir / f"{pair.replace('/', '_').replace(':', '_')}-{tf}-futures.feather"
            row = {"pair": pair, "tf": tf, "from": None, "to": None}
            if f.is_file():
                import pandas as pd                  # có sẵn trong image freqtrade

                d = pd.read_feather(f, columns=["date"])["date"]
                if len(d):
                    row.update({"from": d.iloc[0].strftime("%Y-%m-%d"), "to": d.iloc[-1].strftime("%Y-%m-%d %H:%M")})
            out.append(row)
    return out


def candle_window(data_dir: Path, pair: str, tf: str, start_ms: int, end_ms: int,
                  before: int = 80, after: int = 20, cap: int = 600) -> list[list]:
    """Nến LAB quanh một lệnh backtest: [[ms, open, high, low, close, ema200, atr20], ...]; EMA/ATR tính trên cả file (đủ nến khởi động)."""
    f = data_dir / f"{pair.replace('/', '_').replace(':', '_')}-{tf}-futures.feather"
    if not f.is_file():
        return []
    import pandas as pd

    df = pd.read_feather(f, columns=["date", "open", "high", "low", "close"])
    df["ema"] = df["close"].ewm(span=200, adjust=False).mean()
    tr = pd.concat([df["high"] - df["low"], (df["high"] - df["close"].shift()).abs(), (df["low"] - df["close"].shift()).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / 20, adjust=False).mean()            # Wilder, như ta.ATR(20) của chiến lược
    ms = (pd.to_datetime(df["date"], utc=True) - pd.Timestamp(0, tz="UTC")) // pd.Timedelta("1ms")
    i0 = max(0, int(ms.searchsorted(start_ms, "right")) - 1 - before)
    i1 = min(len(df), int(ms.searchsorted(end_ms, "right")) + after, i0 + cap)
    w = df.iloc[i0:i1]
    return [[int(t), *(round(float(x), 8) for x in row)] for t, row in
            zip(ms.iloc[i0:i1], w[["open", "high", "low", "close", "ema", "atr"]].itertuples(index=False))]


def bot_pairs(cfg: dict) -> list[str]:
    """Cặp của bot (LAB dùng chung config.base.json); không đọc được thì []."""
    try:
        return json.loads(Path(cfg["bot_config"]).read_text(encoding="utf-8"))["exchange"]["pair_whitelist"]
    except (KeyError, OSError, ValueError):
        return []


def summarize(res: dict, strategy: str) -> dict:
    s = res["strategy"][strategy]
    eq, bal = [], s["starting_balance"]
    for day, pnl in s.get("daily_profit", []):
        bal += pnl
        eq.append([day, round(bal, 2)])
    return {
        "timerange": f"{s['backtest_start'][:10]} → {s['backtest_end'][:10]}",
        "trades": s["total_trades"],
        "trades_long": s.get("trade_count_long"),
        "trades_short": s.get("trade_count_short"),
        "profit_pct": s["profit_total"] * 100,
        "profit_abs": s["profit_total_abs"],
        "max_dd_pct": s["max_drawdown_account"] * 100,
        "winrate_pct": s["winrate"] * 100,
        "profit_factor": s.get("profit_factor"),
        "cagr_pct": (s.get("cagr") or 0) * 100,
        "market_change_pct": (s.get("market_change") or 0) * 100,
        "years": [
            {"year": y["date"][-4:], "profit_abs": y["profit_abs"], "trades": y["trades"],
             "profit_factor": y.get("profit_factor")}
            for y in s.get("periodic_breakdown", {}).get("year", [])
        ],
        "pairs": [
            {"pair": p["key"], "trades": p["trades"], "profit_abs": p["profit_total_abs"],
             "profit_pct": p["profit_total"] * 100, "profit_factor": p.get("profit_factor"),
             "winrate_pct": p["winrate"] * 100}
            for p in s.get("results_per_pair", []) if p.get("key") != "TOTAL"
        ],
        "equity": eq,
        "stake_currency": s.get("stake_currency", "USDT"),
    }


def bt_trades(res: dict, strategy: str) -> list[dict]:
    """Từng lệnh của lần backtest, mới nhất trước, cùng tên trường với /api/trades của bot (app dùng chung cách vẽ)."""
    def ms(t: dict, k: str) -> int | None:
        if t.get(f"{k}_timestamp") is not None:
            return int(t[f"{k}_timestamp"])
        d = t.get(f"{k}_date")
        return int(datetime.fromisoformat(str(d).replace(" ", "T")).timestamp() * 1000) if d else None
    out = [{"pair": t["pair"], "is_short": bool(t.get("is_short")), "leverage": t.get("leverage"),
            "open_timestamp": ms(t, "open"), "close_timestamp": ms(t, "close"),
            "open_rate": t.get("open_rate"), "close_rate": t.get("close_rate"),
            "profit_abs": t.get("profit_abs"), "profit_ratio": t.get("profit_ratio"), "exit_reason": t.get("exit_reason")}
           for t in res["strategy"][strategy].get("trades", [])]
    return sorted(out, key=lambda t: t["close_timestamp"] or 0, reverse=True)


# ----------------------------------------------------------------------------- router
class ParamsIn(BaseModel):
    params: dict[str, Any]


class BacktestIn(ParamsIn):
    timerange: str
    wallet: float = 1000


def router(cfg: dict, updater=None) -> APIRouter:
    """updater: labdata.Updater (tự tải nến cho LAB) hoặc None khi tắt."""
    strat = cfg["strategy"]
    lab_dir: Path = cfg["lab"]["strategy_dir"]
    live_dir: Path = cfg["live"]["strategy_dir"]
    schema = load_schema(lab_dir / f"{strat}.py", strat)
    lab, live = FtClient(cfg["lab"]), FtClient(cfg["live"])
    mode_file = Path(cfg.get("mode_file", "/deploy/.env"))
    data_dir = lab_datadir(cfg) / "futures"
    state: dict[str, Any] = {"pending": None, "history": [], "failed": False, "trades": None}
    lock = asyncio.Lock()
    r = APIRouter(prefix="/api/tune")

    @r.get("/schema")
    async def get_schema():
        return {
            "strategy": strat,
            "spaces": SPACE_TITLES,
            "params": schema,
            "lab": read_params(schema, lab_dir, strat),
            "live": read_params(schema, live_dir, strat),
        }

    @r.post("/backtest")
    async def start_backtest(body: BacktestIn):
        grouped = validate(schema, body.params, base=read_params(schema, lab_dir, strat))
        if updater and updater.running:
            raise HTTPException(409, "Hub đang tải nến mới cho LAB, chờ xong rồi chạy (thường vài phút).")
        async with lock:
            cur = await lab.call("GET", "/backtest")
            if cur.get("running"):
                raise HTTPException(409, "Đang có backtest chạy, chờ xong đã.")
            tf = (await lab.call("GET", "/show_config")).get("timeframe")
            req = {"strategy": strat, "timerange": body.timerange,
                   "enable_protections": False, "dry_run_wallet": body.wallet}
            warns: list[str] = []
            if tf and tf_seconds(tf) > tf_seconds(DETAIL_TF):  # freqtrade đòi khung chi tiết nhỏ hơn khung chiến lược
                pairs = bot_pairs(cfg)
                if pairs:
                    rows = await asyncio.to_thread(data_ranges, data_dir, pairs, [tf, DETAIL_TF])
                    errors, warns = detail_problems(rows, tf, body.timerange)
                    if errors:
                        raise HTTPException(400, errors[0])
                req["timeframe_detail"] = DETAIL_TF
            write_params(grouped, lab_dir, strat, backup=False)
            await lab.call("DELETE", "/backtest")        # bỏ kết quả cũ trong bộ nhớ
            await lab.call("POST", "/backtest", json=req)
            flat = {k: v for sp in grouped.values() for k, v in sp.items()}
            state["pending"] = {"params": flat, "timerange": body.timerange, "wallet": body.wallet,
                                "detail": req.get("timeframe_detail"), "warnings": warns}
            state["failed"] = False
        return {"ok": True, "warnings": warns}

    @r.get("/backtest")
    async def poll_backtest():
        r = await lab.call("GET", "/backtest")
        out = {"status": r["status"], "running": r["running"], "progress": r.get("progress"),
               "step": r.get("step"), "message": r.get("status_msg")}
        if r["status"] == "ended" and r.get("backtest_result") and state["pending"]:
            summ = summarize(r["backtest_result"], strat)
            entry = {**state["pending"], "result": summ,
                     "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            state["history"].insert(0, entry)
            state["trades"] = {"at": entry["at"], "trades": bt_trades(r["backtest_result"], strat)}   # chỉ giữ lần gần nhất
            del state["history"][20:]
            state["pending"] = None
        elif r["status"] == "error" and state["pending"]:
            state["pending"] = None                  # lần chạy hỏng: bỏ, không ghi vào lịch sử
            state["failed"] = True
        if r["status"] == "error" and "No data found" in (r.get("status_msg") or ""):
            out["message"] = (f"{r.get('status_msg')} — LAB không có nến cho khoảng thời gian/khung này "
                              "(xem \"Dữ liệu backtest\" ở khung Bot đang chạy).")
        # lần chạy gần nhất bị lỗi thì không trả kết quả cũ, tránh hiểu nhầm là kết quả mới
        if state["history"] and not state["failed"]:
            out["last"] = state["history"][0]
        return out

    @r.get("/trades")
    async def last_trades():
        """Danh sách lệnh của lần backtest xong gần nhất (tách khỏi /backtest để lúc chờ không phải tải lại cả nghìn lệnh)."""
        return state["trades"] or {"at": None, "trades": []}

    @r.get("/candles")
    async def trade_candles(pair: str, start: int, end: int):
        """Nến khung của bot quanh một lệnh backtest (màn Backtest bấm vào lệnh để xem)."""
        if pair not in bot_pairs(cfg):
            raise HTTPException(400, "Coin không thuộc bot")
        tf = json.loads(Path(cfg["bot_config"]).read_text(encoding="utf-8"))["timeframe"]
        rows = await asyncio.to_thread(candle_window, data_dir, pair, tf, start, end)
        if not rows:
            raise HTTPException(404, f"LAB không có nến {tf} của {pair}")
        return {"tf": tf, "candles": rows}

    @r.get("/history")
    async def history():
        return [{k: v for k, v in h.items() if k != "result"} | {
            "result": {k: v for k, v in h["result"].items() if k != "equity"}}
            for h in state["history"]]

    @r.post("/apply")
    async def apply_live(body: ParamsIn):
        grouped = validate(schema, body.params, base=read_params(schema, live_dir, strat))
        f = write_params(grouped, live_dir, strat, backup=True)
        try:
            await live.call("POST", "/reload_config")
            reloaded, msg = True, "Đã ghi tham số và nạp lại bot."
        except (HTTPException, httpx.HTTPError) as e:
            reloaded = False
            msg = f"Đã ghi {f.name} nhưng KHÔNG nạp lại được bot: {getattr(e, 'detail', e)}"
        return {"ok": True, "reloaded": reloaded, "message": msg}

    @r.get("/live")
    async def live_status():
        from live import NAMES, mode_of      # live.py import tune.py: import ở đây tránh vòng lặp

        try:
            conf, trades, profit, wl = await asyncio.gather(
                live.call("GET", "/show_config"), live.call("GET", "/status"),
                live.call("GET", "/profit"), live.call("GET", "/whitelist"))
        except (HTTPException, httpx.HTTPError) as e:
            return {"reachable": False, "error": str(getattr(e, "detail", e))[:200]}
        mode, _ = mode_of(conf, mode_file)
        pairs = wl.get("whitelist", [])
        tf = conf.get("timeframe")
        return {
            "reachable": True,
            "state": conf.get("state"),
            "dry_run": conf.get("dry_run"),
            "mode": NAMES[mode],
            "pairs": pairs,
            "timeframe": tf,
            "max_open_trades": conf.get("max_open_trades"),
            "data_dir": "bot/user_data/data/binance/futures",
            "data": await asyncio.to_thread(data_ranges, data_dir, pairs,
                                            [tf, DETAIL_TF] if tf != DETAIL_TF else [tf]),
            "data_update": updater.status() if updater else {"enabled": False},
            "strategy": conf.get("strategy"),
            "open_trades": len(trades),
            "profit_pct": profit.get("profit_all_percent"),
            "profit_abs": profit.get("profit_all_coin"),
            "stake_currency": conf.get("stake_currency"),
        }

    return r
