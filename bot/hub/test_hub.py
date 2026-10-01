"""Kiểm thử hub (không cần freqtrade): python -m pytest bot/hub/test_hub.py"""
import asyncio
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
        "/balance": {"total": 1234.5, "total_bot": 990.5, "starting_capital": 1000, "stake": "USDT"},
        "/status": [{"trade_id": 3, "pair": "BTC/USDT:USDT", "is_short": False, "profit_pct": 1.2,
                     "stoploss_order_id": None, "orders": [{"ft_order_side": "stoploss", "status": "open"}]}],
        "/profit": {"profit_all_coin": 50, "trade_count": 3},
        "/daily": {"data": [{"date": "2026-09-27", "abs_profit": 5, "trade_count": 1}]},
        "/trades": {"trades": [{"trade_id": 1, "is_open": False, "close_timestamp": 1},
                               {"trade_id": 2, "is_open": False, "close_timestamp": 2}]},
        "/logs": {"logs": [["d", 1000, "x", "INFO", "hi"], ["d", 2000, "x", "WARNING", "careful"]]},  # freqtrade: mili giây
        "/health": {"last_process_ts": 99},
    }

    async def fake_call(self, method, path, **kw):
        return responses[path]

    monkeypatch.setattr(tune.FtClient, "call", fake_call)
    env = tmp_path / ".env"
    env.write_text("BOT_EXTRA_CONFIG=-c x\nBOT_DB=demo\n")
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"}, mode_file=str(env))
    j = c.get("/api/live", headers=TS).json()
    assert j["reachable"] and j["mode"] == "demo" and j["mode_warning"] is None and j["alerts"] is False and j["balance"]["total"] == 990.5 and j["balance"]["account_total"] == 1234.5
    assert j["open"][0]["stop_on_exchange"] is True and "orders" not in j["open"][0]
    assert [t["trade_id"] for t in j["closed"]] == [2, 1]
    assert j["logs"] == [{"t": 2, "level": "WARNING", "msg": "careful"}]
    assert "SECRET" not in json.dumps(j)


def test_live_mode_from_running_bot(tmp_path):
    """Chế độ lấy từ bot đang chạy; file trên đĩa khác thì cảnh báo (setup --api vừa đổi, chưa up -d)."""
    import live
    ex = tmp_path / ".env"
    ex.write_text("BOT_DB=demo\n")
    mode, warn = live.mode_of({"dry_run": True}, ex)
    assert mode == "paper" and "Demo" in warn
    mode, warn = live.mode_of({"dry_run": False, "demo_trading": False}, ex)
    assert mode == "live" and "TIỀN THẬT" in warn
    assert live.mode_of({"dry_run": False, "demo_trading": True}, ex) == ("demo", None)
    assert live.mode_of({"dry_run": False}, ex) == ("demo", None)          # freqtrade cũ: đọc file
    ex.write_text("BOT_DB=real\n")
    assert live.mode_of({"dry_run": False, "demo_trading": False}, ex) == ("live", None)
    ex.unlink()                                                             # setup --dryrun xoá .env
    assert live.mode_of({"dry_run": True}, ex) == ("paper", None)


def test_watchdog_alerts_once_and_on_recovery():
    """Báo khi sự cố bắt đầu và khi hết; không lặp mỗi phút; thiếu stop phải thấy 2 lần liền mới báo."""
    import alerts
    now = [1000.0]
    r = {"/show_config": {"state": "running", "dry_run": False}, "/health": {"last_process_ts": 995},
         "/status": [], "/logs": {"logs": []}}
    down = [False]

    class Fake:
        async def call(self, method, path, **kw):
            if down[0]:
                raise RuntimeError("connection refused")
            return r[path]

    w = alerts.Watchdog(Fake(), None, now=lambda: now[0])
    run = lambda: asyncio.run(w.check())  # noqa: E731
    assert run() == []
    r["/status"] = [{"trade_id": 7, "pair": "BTC/USDT:USDT", "is_short": False, "orders": []}]
    assert run() == []                                                      # lần 1: có thể đang dời stop
    msgs = run()
    assert len(msgs) == 1 and "#7" in msgs[0] and "KHÔNG có stop" in msgs[0]
    assert run() == []                                                      # không lặp
    r["/status"][0]["orders"] = [{"ft_order_side": "stoploss", "status": "open"}]
    assert run()[0].startswith("✅")
    now[0] = 1000 + 400                                                     # bot kẹt
    assert "không xử lý" in run()[0]
    r["/health"]["last_process_ts"] = now[0]
    run()
    r["/logs"]["logs"] = [["d", 999_000, "x", "ERROR", "log cũ trước lúc hub khởi động"],      # freqtrade: mili giây
                          ["d", (now[0] + 1) * 1000, "x", "ERROR", "Unable to place a stoploss order"],
                          ["d", (now[0] + 2) * 1000, "x", "WARNING", "meh"]]
    assert run() == ["ERROR: Unable to place a stoploss order"]
    assert run() == []                                                      # log cũ không báo lại
    down[0] = True
    assert run() == [] and run() == []                                      # restart ngắn: chưa báo
    assert "không trả lời" in run()[0]
    down[0] = False
    assert run()[0].startswith("✅")


def test_watchdog_keeps_open_issues_while_bot_down():
    """Bot im lặng không có nghĩa lệnh thiếu stop đã ổn: không được báo "Hết" cho nó."""
    import alerts
    r = {"/show_config": {"state": "running", "dry_run": False}, "/health": {}, "/logs": {"logs": []},
         "/status": [{"trade_id": 7, "pair": "BTC/USDT:USDT", "orders": []}]}
    down = [False]

    class Fake:
        async def call(self, method, path, **kw):
            if down[0]:
                raise RuntimeError("connection refused")
            return r[path]

    w = alerts.Watchdog(Fake(), None)
    run = lambda: asyncio.run(w.check())  # noqa: E731
    run()
    assert "#7" in run()[0]
    down[0] = True
    run(), run()
    msgs = run()
    assert len(msgs) == 1 and "không trả lời" in msgs[0]                 # chỉ báo bot im, không "Hết" lệnh #7
    assert run() == []
    down[0] = False
    msgs = run()                                                            # bot trả lời lại, lệnh #7 vẫn thiếu stop
    assert len(msgs) == 1 and msgs[0].startswith("✅") and "không trả lời" in msgs[0]


def test_watchdog_retries_unsent_alerts():
    """Gửi hỏng (Telegram timeout/429) thì giữ tin, vòng sau gửi lại đúng thứ tự."""
    import alerts
    got, fail = [], [True]

    async def send(msg):
        if fail[0]:
            raise RuntimeError("timeout")
        got.append(msg)

    w = alerts.Watchdog(None, send)
    w.outbox = ["⚠️ a", "✅ Hết: a"]
    asyncio.run(w.flush())
    assert got == [] and len(w.outbox) == 2
    fail[0] = False
    asyncio.run(w.flush())
    assert got == ["[bot] ⚠️ a", "[bot] ✅ Hết: a"] and w.outbox == []


def test_hub_starts_with_half_configured_telegram(tmp_path):
    """alerts có token mà thiếu chat_id: hub vẫn chạy, chỉ tắt Telegram."""
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "a", "password": "b"},
                 alerts={"telegram_token": "t"})
    assert c.get("/api/hub", headers=BASIC).json()["features"]["live"]


def test_parse_cap_rejects_ambiguous_separators():
    sys.path.insert(0, str(HERE.parent / "deploy"))
    import setup
    assert setup.parse_cap("300") == 300 and setup.parse_cap("300.5") == 300.5 and setup.parse_cap("1000") == 1000
    assert setup.parse_cap("") is None
    for bad in ("300,5", "1,000", "1.000", "10.000.000", "-5", "abc", "inf"):
        with pytest.raises(SystemExit):
            setup.parse_cap(bad)


def test_validate_keeps_live_values_and_rejects_off_step():
    """Send to bot gửi một phần: phần còn lại giữ giá trị đang chạy; giá trị lệch bước bị từ chối, không làm tròn."""
    schema = [
        {"name": "fixed_lev", "space": "sell", "label": "fixed", "type": "bool", "default": False},
        {"name": "r_atr", "space": "sell", "label": "R", "type": "decimal", "min": 1.0, "max": 6.0, "decimals": 1,
         "default": 3.0},
        {"name": "adx_min", "space": "buy", "label": "ADX", "type": "int", "min": 10, "max": 50, "default": 30},
    ]
    g = tune.validate(schema, {"r_atr": 2.5}, base={"fixed_lev": True, "adx_min": 25})
    assert g == {"sell": {"fixed_lev": True, "r_atr": 2.5}, "buy": {"adx_min": 25}}
    for bad in ({"r_atr": 2.25}, {"adx_min": 30.5}):
        with pytest.raises(tune.HTTPException) as e:
            tune.validate(schema, bad)
        assert e.value.status_code == 400
    assert tune.validate(schema, {"r_atr": 2.2000000000000002})["sell"]["r_atr"] == 2.2


def test_live_unreachable(tmp_path, monkeypatch):
    async def boom(self, method, path, **kw):
        raise tune.HTTPException(502, "down")

    monkeypatch.setattr(tune.FtClient, "call", boom)
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"})
    assert c.get("/api/live", headers=TS).json() == {"reachable": False, "error": "down"}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))


def test_push_encrypt_decrypts_per_rfc8291_and_vapid_verifies(tmp_path):
    """Máy nhận (khoá riêng của trình duyệt) giải mã được tin theo RFC 8291; chữ ký VAPID hợp lệ với khoá công khai."""
    import push
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    ua = ec.generate_private_key(ec.SECP256R1())                           # "trình duyệt"
    ua_pub = push._pub_bytes(ua.public_key())
    auth = b"0123456789abcdef"
    body = push.encrypt(b'{"title":"t","body":"x"}', push.b64u(ua_pub), push.b64u(auth))

    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_pub, ct = body[21:21 + idlen], body[21 + idlen:]
    assert rs == 4096 and idlen == 65
    hk = lambda salt, ikm, info, n: HKDF(hashes.SHA256(), n, salt, info).derive(ikm)  # noqa: E731
    shared = ua.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ikm = hk(auth, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    plain = AESGCM(hk(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)).decrypt(
        hk(salt, ikm, b"Content-Encoding: nonce\x00", 12), ct, None)
    assert plain == b'{"title":"t","body":"x"}\x02'

    p = push.Push(tmp_path / "push.json")
    h = push.vapid_header(p.key, "https://web.push.apple.com/abc", "mailto:x@y", now=1000)
    t, k = h.removeprefix("vapid t=").split(", k=")
    head, claims, sig = t.split(".")
    assert json.loads(push.unb64u(claims)) == {"aud": "https://web.push.apple.com", "exp": 1000 + 43200, "sub": "mailto:x@y"}
    raw = push.unb64u(sig)
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), push.unb64u(k))
    pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
               f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))       # ném lỗi nếu sai
    assert k == p.public_key


def test_push_subscribe_persists_and_drops_gone_devices(tmp_path, monkeypatch):
    import push
    from cryptography.hazmat.primitives.asymmetric import ec
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"})
    key = c.get("/api/push/key", headers=TS).json()
    assert key["devices"] == 0 and len(push.unb64u(key["key"])) == 65
    ua = push._pub_bytes(ec.generate_private_key(ec.SECP256R1()).public_key())
    sub = {"endpoint": "https://web.push.apple.com/dev1", "keys": {"p256dh": push.b64u(ua), "auth": push.b64u(b"a" * 16)}}
    assert c.post("/api/push/subscribe", json=sub, headers={**TS, "x-forwarded-host": "hub.example.ts.net"}).json()["devices"] == 1
    assert c.post("/api/push/subscribe", json=sub, headers=TS).json()["devices"] == 1          # không trùng
    assert c.post("/api/push/subscribe", json={**sub, "endpoint": "http://evil"}, headers=TS).status_code == 400
    saved = json.loads((tmp_path / "data" / "push.json").read_text())
    assert saved["subs"][0]["endpoint"] == sub["endpoint"] and "BEGIN PRIVATE KEY" in saved["vapid_private"]
    assert saved["subject"] == "https://hub.example.ts.net"                  # Apple từ chối mailto:@localhost
    assert (tmp_path / "data" / "push.json").stat().st_mode & 0o777 == 0o600

    sent = []

    class Resp:
        def __init__(self, code): self.status_code, self.text = code, ""

    async def fake_post(self, url, content=None, headers=None):
        sent.append((url, headers))
        return Resp(410)                                                      # máy đã huỷ đăng ký

    monkeypatch.setattr(push.httpx.AsyncClient, "post", fake_post)
    assert c.post("/api/push/test", headers=TS).json() == {"sent": 0, "devices": 0}
    assert sent[0][0] == sub["endpoint"] and sent[0][1]["Content-Encoding"] == "aes128gcm"
    claims = sent[0][1]["Authorization"].split("t=")[1].split(",")[0].split(".")[1]
    assert json.loads(push.unb64u(claims))["sub"] == "https://hub.example.ts.net"
    assert c.get("/api/live", headers=TS).status_code in (200, 502)          # router live vẫn gắn được


def test_weekly_report():
    import weekly
    from datetime import datetime, timezone

    def tr(open_min, pnl, short=False, pair="BTC/USDT:USDT"):
        return {"is_open": False, "is_short": short, "pair": pair, "open_timestamp": open_min * 60_000,
                "close_timestamp": (open_min + 60) * 60_000, "profit_abs": pnl}

    s = weekly.stats([tr(0, 100), tr(100, -150), tr(200, 50), {"is_open": True}], 1000)
    assert (s["n"], s["wins"], round(s["pf"], 3), s["pnl"]) == (3, 2, 1.0, 0)
    assert round(s["dd_pct"], 2) == round(150 / 1100 * 100, 2)
    assert "chưa đủ" in weekly.verdict(s)
    # cùng cặp, cùng chiều, lệch ≤ 1 nến 4h mới ghép; mỗi lệnh paper chỉ ghép một lần
    assert weekly.match([tr(0, 1), tr(10, 1), tr(500, 1, short=True)], [tr(15, 1), tr(500, 1)]) == 1
    assert weekly.match([tr(0, 1, pair="ETH/USDT:USDT"), tr(500, 1)], [tr(0, 1), tr(741, 1)]) == 0
    assert weekly.next_run(datetime(2026, 10, 1, 12, tzinfo=timezone.utc)) == datetime(2026, 10, 5, 1, tzinfo=timezone.utc)
    assert weekly.next_run(datetime(2026, 10, 5, 1, tzinfo=timezone.utc)) == datetime(2026, 10, 12, 1, tzinfo=timezone.utc)

    class Fake:
        def __init__(self, trades, start=0): self.trades, self.start = trades, start
        async def call(self, method, path, **kw):
            return {"/trades": {"trades": self.trades}, "/balance": {"starting_capital": 1000},
                    "/profit": {"bot_start_timestamp": self.start}}[path]

    class Down:
        async def call(self, *a, **kw): raise RuntimeError("timeout")

    out = asyncio.run(weekly.build(Fake([tr(0, 10), tr(300, -5)]), Fake([tr(5, 8)])))
    assert out["match"] == {"demo": 2, "paper": 1, "both": 1}
    # Demo chạy trước paper: lệnh lúc paper chưa chạy không tính vào phần so
    out = asyncio.run(weekly.build(Fake([tr(0, 10), tr(300, -5)]), Fake([tr(305, -4)], start=200 * 60_000)))
    assert out["match"] == {"demo": 1, "paper": 1, "both": 1}
    assert "Demo: 2 lệnh" in out["text"] and "PF 2.00" in out["text"]
    out = asyncio.run(weekly.build(Fake([]), Down()))
    assert "Paper: không đọc được" in out["text"] and "match" not in out
