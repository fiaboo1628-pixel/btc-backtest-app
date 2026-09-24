"""
Trang "Chỉnh tham số" cho DonchianRevert — chạy cùng môi trường Python với freqtrade.

Kiến trúc:
    trình duyệt ──► tuner (file này, 127.0.0.1:8090, có mật khẩu)
                     ├─► LAB : freqtrade webserver  — backtest với tham số đang thử
                     └─► LIVE: freqtrade trade      — ghi tham số + reload_config

LAB và LIVE dùng HAI thư mục chiến lược khác nhau. Tuner chỉ ghi vào thư mục LIVE khi bạn
bấm "Áp dụng" (và luôn sao lưu file cũ trước khi ghi).

Chạy:
    python tuner/server.py -c tuner/tuner.json
"""
import argparse
import asyncio
import importlib.util
import json
import secrets
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent

# Nhãn tiếng Việt cho từng tham số. Tham số nào không có ở đây vẫn hiện, với tên gốc.
LABELS: dict[str, tuple[str, str]] = {
    "dc_period": ("Chu kỳ kênh Donchian", "Số nến 15m để tính đỉnh/đáy kênh."),
    "dc_long": ("Ngưỡng Long", "Vào Long khi vị trí giá trong kênh ≤ ngưỡng này (0 = đáy kênh)."),
    "dc_short": ("Ngưỡng Short", "Vào Short khi vị trí giá trong kênh ≥ ngưỡng này (1 = đỉnh kênh)."),
    "adx_min": ("ADX tối thiểu", "Chỉ vào lệnh khi ADX(14) lớn hơn mức này."),
    "vol_max": ("Volume tối đa (× TB 24h)", "Bỏ qua khi volume cao hơn mức này — tránh bán tháo/mua đuổi."),
    "atr_min_pct": ("ATR tối thiểu (% giá)", "Chỉ vào lệnh khi biến động đủ lớn (phí chỉ là phần nhỏ của R)."),
    "short_enabled": ("Cho phép Short", "Tắt để chỉ đánh Long."),
    "r_atr": ("Độ rộng stoploss (× ATR)", "1R = stoploss ban đầu = hệ số này × ATR của nến tín hiệu."),
    "trail_start_r": ("Kích hoạt trailing tại (R)", "Lãi chạm mức này (tính theo R) thì bật trailing."),
    "trail_dist_r": ("Khoảng trailing (R)", "Trailing bám đỉnh/đáy, cách một khoảng bằng ngần này R."),
    "trail_on": ("Bật trailing", "Tắt để chỉ còn SL ban đầu (và TP nếu có)."),
    "tp_r": ("Chốt lời cố định (R)", "Chốt lời khi lãi đạt ngần này R; 0 = tắt."),
    "risk_pct": ("Rủi ro mỗi lệnh (% vốn)", "Số % vốn mất nếu lệnh dính stoploss ban đầu."),
    "max_lev": ("Đòn bẩy tối đa", "Giới hạn đòn bẩy khi tính khối lượng theo rủi ro."),
}
SPACE_TITLES = {"buy": "Vào lệnh", "sell": "Thoát lệnh & rủi ro"}


# ----------------------------------------------------------------------------- cấu hình
def load_cfg(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    for side in ("lab", "live"):
        d = Path(cfg[side]["strategy_dir"])
        cfg[side]["strategy_dir"] = d if d.is_absolute() else (base / d).resolve()
    return cfg


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
def validate(schema: list[dict], values: dict[str, Any]) -> dict[str, dict]:
    """Kiểm tra giá trị nằm trong giới hạn; trả về {space: {name: value}}."""
    by_name = {s["name"]: s for s in schema}
    unknown = set(values) - set(by_name)
    if unknown:
        raise HTTPException(400, f"Tham số không tồn tại: {', '.join(sorted(unknown))}")
    grouped: dict[str, dict] = {}
    for name, s in by_name.items():
        v = values.get(name, s["default"])
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
            v = int(round(v)) if s["type"] == "int" else round(v, s["decimals"])
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
        "equity": eq,
        "stake_currency": s.get("stake_currency", "USDT"),
    }


# ----------------------------------------------------------------------------- app
class ParamsIn(BaseModel):
    params: dict[str, Any]


class BacktestIn(ParamsIn):
    timerange: str
    wallet: float = 1000


def create_app(cfg: dict) -> FastAPI:
    strat = cfg["strategy"]
    lab_dir: Path = cfg["lab"]["strategy_dir"]
    live_dir: Path = cfg["live"]["strategy_dir"]
    schema = load_schema(lab_dir / f"{strat}.py", strat)
    lab, live = FtClient(cfg["lab"]), FtClient(cfg["live"])
    state: dict[str, Any] = {"pending": None, "history": [], "failed": False}
    lock = asyncio.Lock()

    app = FastAPI(title="Tuner", docs_url=None, redoc_url=None, openapi_url=None)
    security = HTTPBasic()

    def auth(c: HTTPBasicCredentials = Depends(security)):
        ok_u = secrets.compare_digest(c.username.encode(), cfg["tuner"]["username"].encode())
        ok_p = secrets.compare_digest(c.password.encode(), cfg["tuner"]["password"].encode())
        if not (ok_u and ok_p):
            raise HTTPException(401, "Sai mật khẩu", headers={"WWW-Authenticate": "Basic"})

    @app.get("/", dependencies=[Depends(auth)])
    async def index():
        return FileResponse(HERE / "static" / "index.html")

    @app.get("/api/schema", dependencies=[Depends(auth)])
    async def get_schema():
        return {
            "strategy": strat,
            "spaces": SPACE_TITLES,
            "params": schema,
            "lab": read_params(schema, lab_dir, strat),
            "live": read_params(schema, live_dir, strat),
        }

    @app.post("/api/backtest", dependencies=[Depends(auth)])
    async def start_backtest(body: BacktestIn):
        grouped = validate(schema, body.params)
        async with lock:
            cur = await lab.call("GET", "/backtest")
            if cur.get("running"):
                raise HTTPException(409, "Đang có backtest chạy, chờ xong đã.")
            write_params(grouped, lab_dir, strat, backup=False)
            await lab.call("DELETE", "/backtest")        # bỏ kết quả cũ trong bộ nhớ
            await lab.call("POST", "/backtest", json={
                "strategy": strat, "timerange": body.timerange,
                "enable_protections": False, "dry_run_wallet": body.wallet,
            })
            flat = {k: v for sp in grouped.values() for k, v in sp.items()}
            state["pending"] = {"params": flat, "timerange": body.timerange}
            state["failed"] = False
        return {"ok": True}

    @app.get("/api/backtest", dependencies=[Depends(auth)])
    async def poll_backtest():
        r = await lab.call("GET", "/backtest")
        out = {"status": r["status"], "running": r["running"], "progress": r.get("progress"),
               "step": r.get("step"), "message": r.get("status_msg")}
        if r["status"] == "ended" and r.get("backtest_result") and state["pending"]:
            summ = summarize(r["backtest_result"], strat)
            entry = {**state["pending"], "result": summ,
                     "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            state["history"].insert(0, entry)
            del state["history"][20:]
            state["pending"] = None
        elif r["status"] == "error" and state["pending"]:
            state["pending"] = None                  # lần chạy hỏng: bỏ, không ghi vào lịch sử
            state["failed"] = True
        # lần chạy gần nhất bị lỗi thì không trả kết quả cũ, tránh hiểu nhầm là kết quả mới
        if state["history"] and not state["failed"]:
            out["last"] = state["history"][0]
        return out

    @app.get("/api/history", dependencies=[Depends(auth)])
    async def history():
        return [{k: v for k, v in h.items() if k != "result"} | {
            "result": {k: v for k, v in h["result"].items() if k != "equity"}}
            for h in state["history"]]

    @app.post("/api/apply", dependencies=[Depends(auth)])
    async def apply_live(body: ParamsIn):
        grouped = validate(schema, body.params)
        f = write_params(grouped, live_dir, strat, backup=True)
        try:
            await live.call("POST", "/reload_config")
            reloaded, msg = True, "Đã ghi tham số và nạp lại bot."
        except (HTTPException, httpx.HTTPError) as e:
            reloaded = False
            msg = f"Đã ghi {f.name} nhưng KHÔNG nạp lại được bot: {getattr(e, 'detail', e)}"
        return {"ok": True, "reloaded": reloaded, "message": msg}

    @app.get("/api/live", dependencies=[Depends(auth)])
    async def live_status():
        try:
            conf, trades, profit = await asyncio.gather(
                live.call("GET", "/show_config"), live.call("GET", "/status"),
                live.call("GET", "/profit"))
        except (HTTPException, httpx.HTTPError) as e:
            return {"reachable": False, "error": str(getattr(e, "detail", e))[:200]}
        return {
            "reachable": True,
            "state": conf.get("state"),
            "dry_run": conf.get("dry_run"),
            "strategy": conf.get("strategy"),
            "open_trades": len(trades),
            "profit_pct": profit.get("profit_all_percent"),
            "profit_abs": profit.get("profit_all_coin"),
            "stake_currency": conf.get("stake_currency"),
        }

    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="Trang chỉnh tham số DonchianRevert")
    ap.add_argument("-c", "--config", default=str(HERE / "tuner.json"))
    args = ap.parse_args()
    cfg = load_cfg(Path(args.config))
    t = cfg["tuner"]
    uvicorn.run(create_app(cfg), host=t.get("host", "127.0.0.1"), port=int(t.get("port", 8090)))


if __name__ == "__main__":
    main()
