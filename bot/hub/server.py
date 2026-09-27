"""
Hub: một cổng duy nhất trên máy chủ nhà cho cả hệ thống, mở qua Tailscale (PC ở nhà, điện thoại khi ra ngoài).

    /            app backtest (cùng mã với bản Vercel), thêm tab Live + nút "Gửi sang bot" khi chạy trên hub
    /tune/       trang Chỉnh tham số: backtest bằng freqtrade (LAB) và áp dụng cho bot (LIVE)
    /api/hub     hub có những gì (app dùng để bật tab Live, nguồn dữ liệu máy chủ...)
    /api/data    nến trên máy chủ, tự cập nhật (candles.py)
    /api/live    trạng thái bot (live.py)
    /api/tune/*  chỉnh tham số (tune.py)

Đăng nhập: qua `tailscale serve` thì Tailscale đã xác thực người dùng (header Tailscale-User-Login),
không phải gõ mật khẩu; truy cập kiểu khác (localhost, SSH tunnel) thì hỏi mật khẩu trong hub.json.
Header đó ai cũng tự gắn được, nên chỉ tin khi request tới từ phía `tailscale serve` (loopback, hoặc gateway
của Docker khi hub chạy trong container) — container khác cùng mạng Docker không giả được.

    python hub/server.py -c hub.json
"""
import argparse
import asyncio
import base64
import contextlib
import ipaddress
import json
import logging
import secrets
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import candles  # noqa: E402
import live  # noqa: E402
import tune  # noqa: E402

log = logging.getLogger("hub")

# Chỉ phục vụ đúng các file của app — thư mục gốc repo còn chứa bot/ (có secrets), không được lộ ra.
APP_FILES = {"index.html", "sw.js", "manifest.webmanifest"}
APP_DIRS = {"css", "js", "icons", "vendor", "presets"}


def load_cfg(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    cfg.setdefault("hub", cfg.pop("tuner", {}))              # hub.json cũ (tuner.json) vẫn đọc được
    base = path.parent
    rel = lambda p: p if Path(p).is_absolute() else (base / p).resolve()  # noqa: E731 — tính từ thư mục hub.json
    for side in ("lab", "live"):
        if side in cfg and "strategy_dir" in cfg[side]:
            cfg[side]["strategy_dir"] = Path(rel(cfg[side]["strategy_dir"]))
    for key in ("app_dir", "exchange_file"):
        if key in cfg:
            cfg[key] = str(rel(cfg[key]))
    if "dir" in cfg.get("data", {}):
        cfg["data"]["dir"] = str(rel(cfg["data"]["dir"]))
    return cfg


def default_gateway() -> str | None:
    """Gateway mặc định (Linux). Trong container Docker, `tailscale serve` → 127.0.0.1:8090 của máy tới hub
    qua docker-proxy, nên địa chỉ nguồn là gateway của mạng Docker."""
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            f = line.split()
            if len(f) > 2 and f[1] == "00000000":
                return str(ipaddress.IPv4Address(bytes.fromhex(f[2])[::-1]))
    except (OSError, ValueError):
        pass
    return None


def tailscale_proxies(h: dict) -> list:
    """Nơi được phép gửi header Tailscale-User-Login: `tailscale_proxies` trong hub.json, mặc định loopback + gateway."""
    nets = h.get("tailscale_proxies")
    if nets is None:
        nets = ["127.0.0.0/8", "::1"] + ([gw] if (gw := default_gateway()) else [])
    return [ipaddress.ip_network(n, strict=False) for n in nets]


def from_proxy(request: Request, proxies: list) -> bool:
    try:
        ip = ipaddress.ip_address(request.client.host if request.client else "")
    except ValueError:
        return False
    return any(ip in n for n in proxies)


def same_origin(request: Request) -> bool:
    """Chặn trang web khác (trình duyệt tự gửi kèm đăng nhập) gọi các API ghi — ví dụ đổi tham số bot LIVE."""
    site = request.headers.get("sec-fetch-site")
    if site:
        return site in ("same-origin", "none")
    origin = request.headers.get("origin")
    if not origin:
        return True                                            # không phải trình duyệt (curl, script)
    hosts = {request.headers.get("host"), request.headers.get("x-forwarded-host")}
    return origin.split("://", 1)[-1] in hosts


def check_auth(request: Request, h: dict, proxies: list | None = None) -> str | None:
    """Trả về tên người dùng nếu được phép, None nếu không."""
    login = request.headers.get("tailscale-user-login")
    if login and h.get("trust_tailscale", True) and from_proxy(request, proxies or []):
        allowed = h.get("allowed_logins") or []
        if not allowed or login in allowed:
            return login
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("basic ") and h.get("password"):
        try:
            user, _, pw = base64.b64decode(auth[6:]).decode().partition(":")
        except (ValueError, UnicodeDecodeError):
            return None
        ok_u = secrets.compare_digest(user.encode(), str(h.get("username", "admin")).encode())
        ok_p = secrets.compare_digest(pw.encode(), str(h["password"]).encode())
        if ok_u and ok_p:
            return user
    return None


def create_app(cfg: dict) -> FastAPI:
    h = cfg.get("hub", {})
    app_dir = Path(cfg.get("app_dir", HERE.parent.parent)).resolve()
    features = {"data": False, "live": False, "tune": False}
    store = None
    proxies = tailscale_proxies(h)
    if h.get("trust_tailscale", True) and not h.get("allowed_logins"):
        log.warning("allowed_logins trống: mọi tài khoản Tailscale thấy được máy này đều vào được hub")

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(store.run()) if store and store.sets else None
        yield
        if task:
            task.cancel()

    app = FastAPI(title="Hub", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

    @app.middleware("http")
    async def auth_mw(request: Request, call_next):
        user = check_auth(request, h, proxies)
        if user is None:
            return JSONResponse({"detail": "Cần đăng nhập"}, status_code=401,
                                headers={"WWW-Authenticate": 'Basic realm="hub"'})
        if request.method not in ("GET", "HEAD", "OPTIONS") and not same_origin(request):
            return JSONResponse({"detail": "Chặn yêu cầu từ trang khác"}, status_code=403)
        request.state.user = user
        return await call_next(request)

    if "data" in cfg:
        store = candles.Store(cfg["data"], Path(cfg["data"].get("dir", HERE / "data")))
        app.include_router(candles.router(store))
        features["data"] = True
    if "live" in cfg:
        app.include_router(live.router(cfg))
        features["live"] = True
    if "lab" in cfg and "live" in cfg:
        try:
            app.include_router(tune.router(cfg))
            features["tune"] = True
        except Exception as e:  # noqa: BLE001 — thiếu freqtrade/chiến lược thì hub vẫn chạy phần còn lại
            log.warning("Tắt Chỉnh tham số: %s", e)

    @app.get("/api/hub")
    async def hub_info(request: Request):
        return {"hub": 1, "user": request.state.user, "features": features,
                "strategy": cfg.get("strategy"),
                "datasets": [d.info() for d in store.sets.values()] if store else []}

    @app.get("/tune")
    async def tune_redirect():
        return RedirectResponse("/tune/")

    @app.get("/tune/")
    async def tune_page():
        if not features["tune"]:
            raise HTTPException(404, "Chỉnh tham số chưa bật (thiếu LAB/LIVE)")
        return FileResponse(HERE / "static" / "tune.html")

    @app.get("/")
    async def index():
        return FileResponse(app_dir / "index.html", headers={"cache-control": "no-cache"})

    @app.get("/{path:path}")
    async def app_file(path: str):
        parts = Path(path).parts
        if ".." in parts or not parts:
            return Response(status_code=404)
        f = (app_dir / path).resolve()
        if len(parts) == 1:
            allowed = parts[0] in APP_FILES and f == app_dir / parts[0]
        else:                                                  # chặn cả symlink/.. trỏ ra ngoài thư mục được phép
            allowed = parts[0] in APP_DIRS and f.is_relative_to(app_dir / parts[0])
        if not allowed or not f.is_file():
            return Response(status_code=404)
        return FileResponse(f, headers={"cache-control": "no-cache"})

    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="Hub: app backtest + dữ liệu + bot")
    ap.add_argument("-c", "--config", default=str(HERE / "hub.json"))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)       # không in từng lần gọi Binance/bot
    cfg = load_cfg(Path(args.config))
    h = cfg["hub"]
    uvicorn.run(create_app(cfg), host=h.get("host", "127.0.0.1"), port=int(h.get("port", 8090)))


if __name__ == "__main__":
    main()
