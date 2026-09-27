"""
Dữ liệu nến trên máy chủ: tự tải từ Binance và cập nhật định kỳ, app lấy về qua mạng nhà/Tailscale
(nhanh hơn nhiều so với tải thẳng từ Binance trên điện thoại, và không bị giới hạn tốc độ).

Mỗi bộ dữ liệu là một file nhị phân: mỗi nến 6 số float64 little-endian (t, o, h, l, c, v), t tăng dần,
chỉ nối thêm vào cuối. Funding (futures) nằm trong file .funding.json cạnh đó.

    GET /api/data                                     → danh sách bộ dữ liệu + trạng thái cập nhật
    GET /api/data/{market}/{symbol}/{tf}?start=&limit= → nến có t ≥ start (nhị phân, tối đa `limit` nến)
    GET /api/data/{market}/{symbol}/funding?start=     → funding có t ≥ start (JSON)
    GET /api/binance/{target}/{path}                   → proxy chỉ-đọc tới Binance (như api/binance.js trên Vercel)
"""
import asyncio
import calendar
import json
import logging
import os
import re
import struct
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

log = logging.getLogger("hub.candles")

ROW = struct.Struct("<6d")
TF_MS = {"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
         "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "1d": 86_400_000}
MARKETS = {
    "futures": {"base": "https://fapi.binance.com", "klines": "/fapi/v1/klines",
                "funding": "/fapi/v1/fundingRate", "limit": 1500},
    "spot": {"base": "https://data-api.binance.vision", "klines": "/api/v3/klines",
             "funding": None, "limit": 1000},
}
MAX_ROWS = 400_000          # nến tối đa mỗi lần app hỏi (~19 MB chưa nén); app hỏi tiếp tới khi hết


class Dataset:
    def __init__(self, root: Path, market: str, symbol: str, tf: str, start: int):
        if market not in MARKETS or tf not in TF_MS or not re.fullmatch(r"[A-Z0-9]{2,20}", symbol):
            raise ValueError(f"Bộ dữ liệu không hợp lệ: {market} {symbol} {tf}")
        self.market, self.symbol, self.tf, self.start = market, symbol, tf, start
        self.ms = TF_MS[tf]
        self.path = root / f"{market}_{symbol}_{tf}.bin"
        self.funding_path = root / f"{market}_{symbol}.funding.json"
        self.status = "chưa tải"
        self.updated: float | None = None

    @property
    def id(self) -> str:
        return f"{self.market}:{self.symbol}:{self.tf}"

    def count(self) -> int:
        return self.path.stat().st_size // ROW.size if self.path.exists() else 0

    def _t_at(self, f, i: int) -> float:
        f.seek(i * ROW.size)
        return struct.unpack("<d", f.read(8))[0]

    def edges(self) -> tuple[int | None, int | None]:
        n = self.count()
        if not n:
            return None, None
        with self.path.open("rb") as f:
            return int(self._t_at(f, 0)), int(self._t_at(f, n - 1))

    def read(self, start: int, limit: int) -> tuple[bytes, int, bool]:
        """Nến có t ≥ start: (bytes, số nến, còn nữa không)."""
        n = self.count()
        if not n:
            return b"", 0, False
        with self.path.open("rb") as f:
            lo, hi = 0, n
            while lo < hi:                                   # tìm nến đầu tiên có t ≥ start
                mid = (lo + hi) // 2
                if self._t_at(f, mid) < start:
                    lo = mid + 1
                else:
                    hi = mid
            k = min(limit, n - lo)
            f.seek(lo * ROW.size)
            return f.read(k * ROW.size), k, lo + k < n

    def append(self, rows: list[tuple]) -> None:
        with self.path.open("ab") as f:
            f.write(b"".join(ROW.pack(*r) for r in rows))

    def funding(self) -> list[dict]:
        if not self.funding_path.exists():
            return []
        return json.loads(self.funding_path.read_text(encoding="utf-8"))

    def info(self) -> dict:
        first, last = self.edges()
        return {"id": self.id, "market": self.market, "symbol": self.symbol, "tf": self.tf,
                "count": self.count(), "first": first, "last": last, "status": self.status,
                "updated": int(self.updated * 1000) if self.updated else None}


class Store:
    def __init__(self, cfg: dict, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.every = int(cfg.get("update_every_s", 120))
        self.sets: dict[str, Dataset] = {}
        for d in cfg.get("datasets", []):
            start = calendar.timegm(time.strptime(d.get("from", "2021-01-01"), "%Y-%m-%d")) * 1000
            ds = Dataset(root, d["market"], d["symbol"].upper(), d["tf"], start)
            self.sets[ds.id] = ds
        self.bases = {m: os.environ.get(f"HUB_BINANCE_{m.upper()}", v["base"]) for m, v in MARKETS.items()}

    async def _get(self, cl: httpx.AsyncClient, url: str, params: dict):
        for attempt in range(6):
            try:
                r = await cl.get(url, params=params)
            except httpx.HTTPError as e:
                if attempt == 5:
                    raise
                log.warning("Binance lỗi mạng (%s), thử lại", e)
                await asyncio.sleep(5 * (attempt + 1))
                continue
            if r.status_code in (418, 429) or r.status_code >= 500:
                wait = int(r.headers.get("retry-after") or 0) or 10 * (attempt + 1)
                log.warning("Binance HTTP %s, chờ %ss", r.status_code, wait)
                await asyncio.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Binance không trả lời: {url}")

    async def update(self, ds: Dataset, cl: httpx.AsyncClient) -> int:
        m = MARKETS[ds.market]
        _, last = ds.edges()
        start = last + ds.ms if last is not None else ds.start // ds.ms * ds.ms
        last_closed = int(time.time() * 1000) // ds.ms * ds.ms - ds.ms
        added = 0
        while start <= last_closed:
            ds.status = "đang tải"
            rows = await self._get(cl, self.bases[ds.market] + m["klines"], {
                "symbol": ds.symbol, "interval": ds.tf, "startTime": start, "limit": m["limit"]})
            if not rows:
                break
            batch = [(r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]))
                     for r in rows if r[0] <= last_closed and r[0] >= start]
            if batch:
                ds.append(batch)
                added += len(batch)
            start = rows[-1][0] + ds.ms
            await asyncio.sleep(0.25)                         # ~4 yêu cầu/giây, rất xa giới hạn Binance
        if m["funding"]:
            await self.update_funding(ds, cl)
        ds.status, ds.updated = "ok", time.time()
        return added

    async def update_funding(self, ds: Dataset, cl: httpx.AsyncClient) -> None:
        m = MARKETS[ds.market]
        have = ds.funding()
        start = have[-1]["t"] + 1 if have else ds.start
        new = []
        while True:
            rows = await self._get(cl, self.bases[ds.market] + m["funding"],
                                   {"symbol": ds.symbol, "startTime": start, "limit": 1000})
            for r in rows:
                mark = float(r.get("markPrice") or 0)
                new.append({"t": r["fundingTime"], "rate": float(r["fundingRate"]), "mark": mark or None})
            if len(rows) < 1000:
                break
            start = rows[-1]["fundingTime"] + 1
            await asyncio.sleep(0.25)
        if new:
            tmp = ds.funding_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(have + new), encoding="utf-8")
            tmp.replace(ds.funding_path)

    async def run(self) -> None:
        """Vòng cập nhật nền: chạy mãi, lỗi của một bộ không làm dừng các bộ khác."""
        async with httpx.AsyncClient(timeout=20, headers={"accept": "application/json"}) as cl:
            while True:
                for ds in self.sets.values():
                    try:
                        n = await self.update(ds, cl)
                        if n:
                            log.info("%s: thêm %d nến (tổng %d)", ds.id, n, ds.count())
                    except Exception as e:  # noqa: BLE001
                        ds.status = f"lỗi: {type(e).__name__}: {str(e)[:120]}"
                        log.exception("Cập nhật %s lỗi", ds.id)
                await asyncio.sleep(self.every)


# ----------------------------------------------------------------------------- proxy Binance (giống api/binance.js)
PROXY_TARGETS = {
    "fapi": ("https://fapi.binance.com", {"/fapi/v1/klines", "/fapi/v1/fundingRate"}),
    "spot": ("https://data-api.binance.vision", {"/api/v3/klines"}),
}
PROXY_PARAMS = {
    "symbol": re.compile(r"^[A-Z0-9]{2,20}$"),
    "interval": re.compile(r"^(1|3|5|15|30)m$|^(1|2|4|6|8|12)h$|^(1|3)d$|^1w$|^1M$"),
    "startTime": re.compile(r"^\d{1,13}$"),
    "endTime": re.compile(r"^\d{1,13}$"),
    "limit": re.compile(r"^\d{1,4}$"),
}


def router(store: Store) -> APIRouter:
    r = APIRouter()

    def get_ds(market: str, symbol: str, tf: str) -> Dataset:
        ds = store.sets.get(f"{market}:{symbol.upper()}:{tf}")
        if not ds:
            raise HTTPException(404, "Máy chủ không có bộ dữ liệu này")
        return ds

    @r.get("/api/data")
    async def list_data():
        return {"datasets": [d.info() for d in store.sets.values()]}

    @r.get("/api/data/{market}/{symbol}/funding")
    async def funding(market: str, symbol: str, start: int = 0):
        ds = next((d for d in store.sets.values() if d.market == market and d.symbol == symbol.upper()), None)
        if not ds:
            raise HTTPException(404, "Máy chủ không có bộ dữ liệu này")
        return [f for f in ds.funding() if f["t"] >= start]

    @r.get("/api/data/{market}/{symbol}/{tf}")
    async def candles(market: str, symbol: str, tf: str, start: int = 0, limit: int = MAX_ROWS):
        ds = get_ds(market, symbol, tf)
        body, n, more = await asyncio.to_thread(ds.read, start, max(1, min(limit, MAX_ROWS)))
        return Response(body, media_type="application/octet-stream", headers={
            "x-count": str(n), "x-more": "1" if more else "0", "cache-control": "no-store"})

    @r.get("/api/binance/{target}/{path:path}")
    async def proxy(target: str, path: str, request: Request):
        if target not in PROXY_TARGETS:
            raise HTTPException(404, "Path not allowed")
        base, paths = PROXY_TARGETS[target]
        path = "/" + path.lstrip("/")
        if path not in paths:
            raise HTTPException(404, "Path not allowed")
        q = {}
        for k, rx in PROXY_PARAMS.items():
            v = request.query_params.get(k)
            if v is None:
                continue
            if not rx.match(v):
                raise HTTPException(400, f"Invalid {k}")
            q[k] = v
        if "symbol" not in q:
            raise HTTPException(400, "Missing symbol")
        if int(q.get("limit", 0)) > 1500:
            q["limit"] = "1500"
        async with httpx.AsyncClient(timeout=15) as cl:
            try:
                up = await cl.get(base + path, params=q, headers={"accept": "application/json"})
            except httpx.HTTPError as e:
                raise HTTPException(502, f"Binance unreachable: {e}") from None
        headers = {"cache-control": "no-store"}
        if up.headers.get("retry-after"):
            headers["retry-after"] = up.headers["retry-after"]
        return Response(up.content, status_code=up.status_code,
                        media_type=up.headers.get("content-type", "application/json"), headers=headers)

    return r
