"""Kiểm thử hub (không cần freqtrade): python -m pytest bot/hub/test_hub.py"""
import base64
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import candles  # noqa: E402
import server  # noqa: E402
import tune  # noqa: E402

REPO = HERE.parent.parent
BASIC = {"authorization": "Basic " + base64.b64encode(b"admin:pw").decode()}
TS = {"tailscale-user-login": "me@example.com"}


def make_app(tmp_path, client="127.0.0.1", **extra):
    cfg = {"strategy": "DonchianRevert",
           "hub": {"username": "admin", "password": "pw", "trust_tailscale": True},
           "app_dir": str(REPO),
           "data": {"dir": str(tmp_path / "data"), "datasets": [
               {"market": "futures", "symbol": "BTCUSDT", "tf": "15m", "from": "2024-01-01"}]},
           **extra}
    return TestClient(server.create_app(cfg), client=(client, 50000))


def test_auth(tmp_path):
    c = make_app(tmp_path)
    assert c.get("/api/hub").status_code == 401
    assert c.get("/api/hub", headers={"authorization": "Basic " + base64.b64encode(b"admin:x").decode()}).status_code == 401
    assert c.get("/api/hub", headers=BASIC).json()["user"] == "admin"
    assert c.get("/api/hub", headers=TS).json()["user"] == "me@example.com"


def test_allowed_logins(tmp_path):
    c = make_app(tmp_path, hub={"password": "pw", "allowed_logins": ["boss@x.com"]})
    assert c.get("/api/hub", headers=TS).status_code == 401
    assert c.get("/api/hub", headers={"tailscale-user-login": "boss@x.com"}).status_code == 200


def test_tailscale_header_only_from_proxy(tmp_path):
    """Container khác trong mạng Docker (hay bất kỳ ai tới thẳng cổng 8090) không giả được header Tailscale."""
    c = make_app(tmp_path, client="172.18.0.5", hub={"password": "pw", "tailscale_proxies": ["172.18.0.1"]})
    assert c.get("/api/hub", headers=TS).status_code == 401
    assert c.get("/api/hub", headers=BASIC).status_code == 200
    c = make_app(tmp_path, client="172.18.0.1", hub={"password": "pw", "tailscale_proxies": ["172.18.0.1"]})
    assert c.get("/api/hub", headers=TS).status_code == 200


def test_default_gateway_parsing(tmp_path, monkeypatch):
    route = "Iface Destination Gateway\neth0 000012AC 00000000\neth0 00000000 010012AC\n"
    real = server.Path.read_text
    monkeypatch.setattr(server.Path, "read_text",
                        lambda self, *a, **k: route if str(self) == "/proc/net/route" else real(self, *a, **k))
    assert server.default_gateway() == "172.18.0.1"


def test_cross_site_write_blocked(tmp_path):
    c = make_app(tmp_path)
    h = {**TS, "content-type": "application/json"}
    assert c.post("/api/tune/apply", json={}, headers={**h, "sec-fetch-site": "cross-site"}).status_code == 403
    assert c.post("/api/tune/apply", json={}, headers={**h, "origin": "https://evil.example"}).status_code == 403
    # cùng trang: qua được bước chặn (405 vì bản thử này không bật Chỉnh tham số)
    assert c.post("/api/tune/apply", json={}, headers={**h, "sec-fetch-site": "same-origin"}).status_code == 405
    assert c.post("/api/tune/apply", json={}, headers={**h, "origin": "http://testserver"}).status_code == 405
    assert c.get("/api/hub", headers={**TS, "sec-fetch-site": "cross-site"}).status_code == 200


def test_tailscale_can_be_disabled(tmp_path):
    c = make_app(tmp_path, hub={"password": "pw", "trust_tailscale": False})
    assert c.get("/api/hub", headers=TS).status_code == 401


def test_static_whitelist(tmp_path):
    c = make_app(tmp_path)
    assert c.get("/", headers=TS).status_code == 200
    assert c.get("/js/app.js", headers=TS).status_code == 200
    assert c.get("/presets/index.json", headers=TS).status_code == 200
    for bad in ("/bot/deploy/setup.py", "/README.md", "/.git/config", "/js/../bot/deploy/setup.py",
                "/js/%2e%2e/bot/deploy/setup.py", "/api/../bot/deploy/setup.py", "/vercel.json"):
        assert c.get(bad, headers=TS).status_code == 404, bad


def test_features_without_bot(tmp_path):
    c = make_app(tmp_path)
    f = c.get("/api/hub", headers=TS).json()["features"]
    assert f == {"data": True, "live": False, "tune": False}
    assert c.get("/tune/", headers=TS).status_code == 404


def test_dataset_read(tmp_path):
    ds = candles.Dataset(tmp_path, "futures", "BTCUSDT", "15m", 0)
    rows = [(i * 900_000, 1.0 + i, 2.0 + i, 0.5 + i, 1.5 + i, 10.0 * i) for i in range(100)]
    ds.append(rows[:60]); ds.append(rows[60:])
    assert ds.count() == 100 and ds.edges() == (0, 99 * 900_000)
    body, n, more = ds.read(10 * 900_000, 30)
    assert n == 30 and more
    got = [candles.ROW.unpack_from(body, i * 48) for i in range(n)]
    assert got == rows[10:40]
    body, n, more = ds.read(10 * 900_000 + 1, 1000)            # giữa hai nến → lấy từ nến sau
    assert n == 89 and not more and candles.ROW.unpack_from(body)[0] == 11 * 900_000
    assert ds.read(10**15, 10) == (b"", 0, False)


def test_data_endpoints(tmp_path):
    c = make_app(tmp_path)
    st = c.get("/api/data", headers=TS).json()["datasets"][0]
    assert st["id"] == "futures:BTCUSDT:15m" and st["count"] == 0
    ds = candles.Dataset(tmp_path / "data", "futures", "BTCUSDT", "15m", 0)
    ds.append([(900_000 * i, 1, 2, 0, 1, 5) for i in range(5)])
    ds.funding_path.write_text(json.dumps([{"t": 1, "rate": 0.0001, "mark": 5.0}, {"t": 9, "rate": 0.0, "mark": 5}]))
    r = c.get("/api/data/futures/BTCUSDT/15m?start=900000&limit=2", headers=TS)
    assert r.headers["x-count"] == "2" and r.headers["x-more"] == "1" and len(r.content) == 96
    assert c.get("/api/data/futures/BTCUSDT/funding?start=5", headers=TS).json() == [{"t": 9, "rate": 0.0, "mark": 5}]
    assert c.get("/api/data/futures/ETHUSDT/15m", headers=TS).status_code == 404


def test_proxy_validation(tmp_path):
    c = make_app(tmp_path)
    assert c.get("/api/binance/fapi/fapi/v1/order?symbol=BTCUSDT", headers=TS).status_code == 404
    assert c.get("/api/binance/evil/x?symbol=BTCUSDT", headers=TS).status_code == 404
    assert c.get("/api/binance/fapi/fapi/v1/klines?symbol=btc;rm", headers=TS).status_code == 400
    assert c.get("/api/binance/fapi/fapi/v1/klines", headers=TS).status_code == 400


def test_store_update(tmp_path, monkeypatch):
    """Tải nến + funding qua Binance giả: bỏ nến chưa đóng, lần sau chỉ tải phần mới."""
    now = 100 * 900_000 + 5
    monkeypatch.setattr(candles.time, "time", lambda: now / 1000)
    calls = []

    async def fake_get(self, cl, url, params):
        calls.append((url, dict(params)))
        if url.endswith("fundingRate"):
            return [{"fundingTime": 28_800_000, "fundingRate": "0.0001", "markPrice": ""}] \
                if params["startTime"] <= 28_800_000 else []
        s = params["startTime"]
        return [[t, "1", "2", "0.5", "1.5", "3"] for t in range(s, min(s + 1500 * 900_000, now + 900_000), 900_000)]

    monkeypatch.setattr(candles.Store, "_get", fake_get)
    monkeypatch.setattr(candles.asyncio, "sleep", lambda s: _noop())
    st = candles.Store({"datasets": [{"market": "futures", "symbol": "BTCUSDT", "tf": "15m", "from": "1970-01-01"}]},
                       tmp_path)
    ds = st.sets["futures:BTCUSDT:15m"]
    import asyncio
    assert asyncio.run(st.update(ds, None)) == 100                # 0 … 99; nến 100 đang chạy thì bỏ
    assert ds.edges() == (0, 99 * 900_000)
    assert ds.funding() == [{"t": 28_800_000, "rate": 0.0001, "mark": None}]
    now += 2 * 900_000
    assert asyncio.run(st.update(ds, None)) == 2
    assert ds.count() == 102 and len(ds.funding()) == 1


async def _noop():
    return None


def test_live_summary(tmp_path, monkeypatch):
    responses = {
        "/show_config": {"state": "running", "dry_run": False, "strategy": "DonchianRevert", "stake_currency": "USDT"},
        "/balance": {"total": 1234.5, "starting_capital": 1000, "stake": "USDT"},
        "/status": [{"trade_id": 3, "pair": "BTC/USDT:USDT", "is_short": False, "profit_pct": 1.2,
                     "stoploss_order_id": None, "orders": [{"ft_order_side": "stoploss", "status": "open"}]}],
        "/profit": {"profit_all_coin": 50, "trade_count": 3},
        "/daily": {"data": [{"date": "2026-09-27", "abs_profit": 5, "trade_count": 1}]},
        "/trades": {"trades": [{"trade_id": 1, "is_open": False, "close_timestamp": 1},
                               {"trade_id": 2, "is_open": False, "close_timestamp": 2}]},
        "/logs": {"logs": [["d", 1, "x", "INFO", "hi"], ["d", 2, "x", "WARNING", "careful"]]},
        "/health": {"last_process_ts": 99},
    }

    async def fake_call(self, method, path, **kw):
        return responses[path]

    monkeypatch.setattr(tune.FtClient, "call", fake_call)
    ex = tmp_path / "exchange.json"
    ex.write_text(json.dumps({"exchange": {"demo_trading": True, "key": "SECRET"}}))
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"}, exchange_file=str(ex))
    j = c.get("/api/live", headers=TS).json()
    assert j["reachable"] and j["mode"] == "demo" and j["balance"]["total"] == 1234.5
    assert j["open"][0]["stop_on_exchange"] is True and "orders" not in j["open"][0]
    assert [t["trade_id"] for t in j["closed"]] == [2, 1]
    assert j["logs"] == [{"t": 2, "level": "WARNING", "msg": "careful"}]
    assert "SECRET" not in json.dumps(j)


def test_live_unreachable(tmp_path, monkeypatch):
    async def boom(self, method, path, **kw):
        raise tune.HTTPException(502, "down")

    monkeypatch.setattr(tune.FtClient, "call", boom)
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"})
    assert c.get("/api/live", headers=TS).json() == {"reachable": False, "error": "down"}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
