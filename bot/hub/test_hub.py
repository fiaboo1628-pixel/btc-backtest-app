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
    assert c.get("/css/app.css", headers=TS).status_code == 200
    assert c.get("/icons/icon.svg", headers=TS).status_code == 200
    for bad in ("/bot/deploy/setup.py", "/README.md", "/.git/config", "/js/../bot/deploy/setup.py",
                "/js/%2e%2e/bot/deploy/setup.py", "/api/../bot/deploy/setup.py", "/package.json", "/docs/x.png"):
        assert c.get(bad, headers=TS).status_code == 404, bad


def test_features_without_bot(tmp_path):
    c = make_app(tmp_path)
    f = c.get("/api/hub", headers=TS).json()["features"]
    assert f == {"data": True, "live": False, "tune": False}
    r = c.get("/tune/", headers=TS, follow_redirects=False)                 # địa chỉ cũ → màn Backtest của app
    assert r.status_code == 307 and r.headers["location"] == "/#backtest"
    assert c.get("/tune", headers=TS, follow_redirects=False).status_code == 307
    assert c.get("/api/live", headers=TS).status_code in (404, 405)        # chưa cấu hình bot thì không có


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
    assert j["equity"] == [[1, 1000], [2, 1000]] and j["halt"]["halted"] is False
    assert "SECRET" not in json.dumps(j)
    t = c.get("/api/trades", headers=TS).json()
    assert t["reachable"] and [x["trade_id"] for x in t["trades"]] == [2, 1] and t["stats"]["n"] == 2
    assert t["expect"]["pf"] > 1 and "chưa đủ" in t["verdict"] and t["starting"] == 1000
    a = c.get("/api/alerts", headers=TS).json()
    assert a == {"channels": {"telegram": False, "devices": 0}, "active": [], "recent": []}


def test_live_halt_and_equity(tmp_path):
    """Sụt vốn tính như TrendBreakout.halt_reason; dừng khi quá 30% (halt_on bật) hoặc log đã báo dừng."""
    import live
    tr = lambda ts, p: {"close_timestamp": ts, "profit_abs": p}  # noqa: E731
    closed = [tr(3, -200), tr(1, 50), tr(2, -120)]                    # thứ tự đóng: +50, -120, -200
    assert live.equity_curve(1000, closed) == [[1, 1050], [2, 930], [3, 730]]
    dd = live.drawdown(1000, [50, -120, -200])
    assert dd == {"current_pct": round(100 * (1 - 730 / 1050), 2), "max_pct": round(100 * (1 - 730 / 1050), 2)}
    assert live.drawdown(0, []) == {"current_pct": 0.0, "max_pct": 0.0}
    h = live.halt_view(1000, closed, True, [])
    assert h["halted"] is True and h["max_dd_pct"] > 30 and h["threshold_pct"] == 30 and h["reduced"] is False
    assert live.halt_view(1000, closed, False, [])["halted"] is False          # người dùng đã tắt halt_on
    assert live.halt_view(1000, [tr(1, -50)], True, [])["halted"] is False
    assert live.halt_view(1000, [], True, [{"msg": "DỪNG VÀO LỆNH MỚI: sụt vốn 26% > 25%"}])["halted"] is True
    assert live.halt_view(1000, [], None, [])["halt_on"] is None
    # sụt hiện tại 20–30%: giảm nửa khối lượng, chưa dừng; hồi về dưới 20% thì hết giảm
    h = live.halt_view(1000, [tr(1, -250)], True, [])
    assert h["reduced"] is True and h["halted"] is False and h["reduce_pct"] == 20
    assert live.halt_view(1000, [tr(1, -250), tr(2, 100)], True, [])["reduced"] is False
    assert live.halt_view(1000, [tr(1, -250)], False, [])["reduced"] is False
    # halt_on đọc từ file tham số LIVE (trang Backtest ghi), không có file = mặc định bật
    assert live.halt_on_param(tmp_path, "TrendBreakout") is True
    (tmp_path / "TrendBreakout.json").write_text(json.dumps({"params": {"sell": {"halt_on": False}}}))
    assert live.halt_on_param(tmp_path, "TrendBreakout") is False
    assert live.halt_on_param(None, "TrendBreakout") is None


def test_alert_history_persists(tmp_path):
    import alerts
    now = [100.0]
    h = alerts.History(tmp_path / "a" / "alerts.json", keep=2, now=lambda: now[0])
    h.add("⚠️ một"); now[0] = 200; h.add("✅ Hết: một", ok=False); now[0] = 300; h.add("⚠️ hai")
    assert [x["msg"] for x in h.items] == ["⚠️ hai", "✅ Hết: một"] and h.items[1]["ok"] is False
    assert alerts.History(tmp_path / "a" / "alerts.json").items == h.items     # còn sau khi hub khởi động lại
    assert (tmp_path / "a" / "alerts.json").stat().st_mode & 0o777 == 0o600
    assert alerts.History(None).items == [] and alerts.History(tmp_path / "x.json").items == []


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


def test_tune_live_shows_coins_mode_and_data(tmp_path, monkeypatch):
    responses = {"/show_config": {"state": "running", "dry_run": False, "demo_trading": True, "timeframe": "4h",
                                  "max_open_trades": 5, "strategy": "TrendBreakout"},
                 "/status": [], "/profit": {"profit_all_percent": 0}, "/whitelist": {"whitelist": ["BTC/USDT:USDT"]}}

    async def fake_call(self, method, path, **kw):
        return responses[path]

    monkeypatch.setattr(tune.FtClient, "call", fake_call)
    monkeypatch.setattr(tune, "load_schema", lambda *a: [])
    lab = {"api_url": "http://x", "username": "u", "password": "p", "strategy_dir": tmp_path / "strategies_lab"}
    c = make_app(tmp_path, strategy="TrendBreakout", lab=lab, live={**lab, "strategy_dir": tmp_path / "s"},
                 mode_file=str(tmp_path / "none.env"))
    j = c.get("/api/tune/live", headers=TS).json()
    assert (j["mode"], j["pairs"], j["timeframe"], j["max_open_trades"]) == ("Demo", ["BTC/USDT:USDT"], "4h", 5)
    assert j["data"] == [{"pair": "BTC/USDT:USDT", "tf": tf, "from": None, "to": None} for tf in ("4h", "15m")]


def test_live_unreachable(tmp_path, monkeypatch):
    async def boom(self, method, path, **kw):
        raise tune.HTTPException(502, "down")

    monkeypatch.setattr(tune.FtClient, "call", boom)
    c = make_app(tmp_path, live={"api_url": "http://x", "username": "u", "password": "p"})
    assert c.get("/api/live", headers=TS).json() == {"reachable": False, "error": "down"}


def _bt_result(**extra):
    return {"strategy": {"TrendBreakout": {
        "starting_balance": 1000, "daily_profit": [["2025-01-01", 10], ["2025-01-02", -5]],
        "backtest_start": "2025-01-01 00:00:00", "backtest_end": "2025-12-31 00:00:00", "total_trades": 3,
        "profit_total": 0.05, "profit_total_abs": 50, "max_drawdown_account": 0.02, "winrate": 2 / 3, "market_change": 0.4,
        "results_per_pair": [
            {"key": "SOL/USDT:USDT", "trades": 2, "profit_total_abs": 60, "profit_total": 0.06, "profit_factor": 4.0,
             "winrate": 0.5, "sharpe": 1.2, "duration_avg": "1 day"},
            {"key": "BTC/USDT:USDT", "trades": 1, "profit_total_abs": -10, "profit_total": -0.01, "profit_factor": 0.0,
             "winrate": 0.0},
            {"key": "TOTAL", "trades": 3, "profit_total_abs": 50, "profit_total": 0.05, "profit_factor": 6.0, "winrate": 2 / 3},
        ], **extra}}}


def test_summarize_per_pair():
    s = tune.summarize(_bt_result(), "TrendBreakout")
    assert [p["pair"] for p in s["pairs"]] == ["SOL/USDT:USDT", "BTC/USDT:USDT"]          # bỏ TOTAL, giữ thứ tự freqtrade
    assert s["pairs"][0] == {"pair": "SOL/USDT:USDT", "trades": 2, "profit_abs": 60, "profit_pct": 6.0,
                             "profit_factor": 4.0, "winrate_pct": 50.0}                    # chỉ trường cần hiển thị
    assert s["equity"] == [["2025-01-01", 1010], ["2025-01-02", 1005]] and s["market_change_pct"] == 40
    assert tune.summarize(_bt_result(results_per_pair=[]), "TrendBreakout")["pairs"] == []


def test_bt_trades_newest_first_same_fields_as_bot():
    tr = [{"pair": "SOL/USDT:USDT", "is_short": False, "leverage": 5.0, "open_timestamp": 1000, "close_timestamp": 5000,
           "open_rate": 10, "close_rate": 12, "profit_abs": 4.2, "profit_ratio": 0.1, "exit_reason": "exit_signal", "fee_open": 0.0004},
          {"pair": "BTC/USDT:USDT", "is_short": True, "leverage": 5.0, "open_date": "2025-01-02 00:00:00+00:00",
           "close_date": "2025-01-03 04:00:00+00:00", "open_rate": 100, "close_rate": 103, "profit_abs": -5, "profit_ratio": -0.15,
           "exit_reason": "stop_loss"}]
    out = tune.bt_trades(_bt_result(trades=tr), "TrendBreakout")
    assert [t["pair"] for t in out] == ["BTC/USDT:USDT", "SOL/USDT:USDT"]                 # đóng sau đứng trước
    assert out[0]["close_timestamp"] == 1735876800000 and out[0]["is_short"] is True      # không có *_timestamp: đọc *_date
    assert set(out[1]) == {"pair", "is_short", "leverage", "open_timestamp", "close_timestamp", "open_rate", "close_rate",
                           "profit_abs", "profit_ratio", "exit_reason"}                    # bỏ trường thừa (phí…)
    assert tune.bt_trades(_bt_result(), "TrendBreakout") == []


def _ranges(monkeypatch, have):
    """Giả nến LAB: have = {(cặp, khung): (từ, tới)}; không có trong have = chưa có file."""
    def fake(data_dir, pairs, tfs):
        return [{"pair": p, "tf": tf, "from": have.get((p, tf), (None, None))[0], "to": have.get((p, tf), (None, None))[1]}
                for p in pairs for tf in tfs]
    monkeypatch.setattr(tune, "data_ranges", fake)


def test_data_ranges_reads_feather(tmp_path):
    pd = pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")
    pd.DataFrame({"date": pd.to_datetime(["2021-01-01 00:00", "2026-09-30 20:00"], utc=True)}).to_feather(
        tmp_path / "BTC_USDT_USDT-4h-futures.feather")
    assert tune.data_ranges(tmp_path, ["BTC/USDT:USDT"], ["4h", "15m"]) == [
        {"pair": "BTC/USDT:USDT", "tf": "4h", "from": "2021-01-01", "to": "2026-09-30 20:00"},
        {"pair": "BTC/USDT:USDT", "tf": "15m", "from": None, "to": None}]


def _tune_app(tmp_path, monkeypatch, responses, calls, pairs=("BTC/USDT:USDT",)):
    async def fake_call(self, method, path, **kw):
        calls.append((method, path, kw.get("json")))
        return responses.get((method, path), {})

    monkeypatch.setattr(tune.FtClient, "call", fake_call)
    monkeypatch.setattr(tune, "load_schema", lambda *a: [])
    bot = tmp_path / "config.base.json"
    bot.write_text(json.dumps({"timeframe": "4h", "exchange": {"pair_whitelist": list(pairs)}}))
    lab = {"api_url": "http://x", "username": "u", "password": "p", "strategy_dir": tmp_path / "user_data" / "strategies_lab"}
    lab["strategy_dir"].mkdir(parents=True)
    return make_app(tmp_path, strategy="TrendBreakout", lab=lab, live={**lab, "strategy_dir": tmp_path / "s"},
                    bot_config=str(bot), lab_data_update=False), tmp_path / "user_data" / "data" / "binance" / "futures"


def test_backtest_sends_timeframe_detail(tmp_path, monkeypatch):
    calls = []
    c, _ = _tune_app(tmp_path, monkeypatch, {("GET", "/show_config"): {"timeframe": "4h"}}, calls)
    _ranges(monkeypatch, {("BTC/USDT:USDT", "4h"): ("2021-01-01", "2026-09-30 20:00"),
                          ("BTC/USDT:USDT", "15m"): ("2023-01-01", "2026-09-30 23:45")})
    r = c.post("/api/tune/backtest", json={"params": {}, "timerange": "20220101-"}, headers=TS)
    assert r.status_code == 200, r.text
    post = [j for m, p, j in calls if (m, p) == ("POST", "/backtest")]
    assert post == [{"strategy": "TrendBreakout", "timerange": "20220101-", "enable_protections": False,
                     "dry_run_wallet": 1000, "timeframe_detail": "15m"}]
    assert r.json()["warnings"] == ["BTC: nến 15m chỉ có từ 2023-01-01, trước đó khớp lệnh theo nến 4h"]


def test_backtest_refuses_when_a_coin_lacks_15m(tmp_path, monkeypatch):
    calls = []
    c, _ = _tune_app(tmp_path, monkeypatch, {("GET", "/show_config"): {"timeframe": "4h"}}, calls,
                     pairs=("BTC/USDT:USDT", "SOL/USDT:USDT"))
    full = ("2021-01-01", "2026-09-30 20:00")
    _ranges(monkeypatch, {("BTC/USDT:USDT", "4h"): full, ("SOL/USDT:USDT", "4h"): full, ("BTC/USDT:USDT", "15m"): full})
    r = c.post("/api/tune/backtest", json={"params": {}, "timerange": "20210101-"}, headers=TS)
    assert r.status_code == 400 and "Thiếu nến 15m của SOL" in r.json()["detail"]
    assert not [1 for m, p, _ in calls if m == "POST"]                # không chạy backtest lệch


def test_backtest_no_detail_for_15m_strategy(tmp_path, monkeypatch):
    calls = []
    c, _ = _tune_app(tmp_path, monkeypatch, {("GET", "/show_config"): {"timeframe": "15m"}}, calls)
    assert c.post("/api/tune/backtest", json={"params": {}, "timerange": "20210101-"}, headers=TS).status_code == 200
    assert "timeframe_detail" not in [j for m, p, j in calls if (m, p) == ("POST", "/backtest")][0]


def test_backtest_error_shown_not_swallowed(tmp_path, monkeypatch):
    calls = []
    c, _ = _tune_app(tmp_path, monkeypatch, {("GET", "/backtest"): {
        "status": "error", "running": False, "status_msg": "Backtest failed with No data found. Terminating."}}, calls)
    j = c.get("/api/tune/backtest", headers=TS).json()
    assert j["status"] == "error" and "No data found" in j["message"] and "LAB không có nến" in j["message"]


def test_backtest_trades_kept_for_last_run_only(tmp_path, monkeypatch):
    tr = [{"pair": "SOL/USDT:USDT", "is_short": False, "open_timestamp": 1, "close_timestamp": 2, "profit_abs": 1}]
    resp = {("GET", "/show_config"): {"timeframe": "15m"},
            ("GET", "/backtest"): {"status": "ended", "running": False, "backtest_result": _bt_result(trades=tr)}}
    c, _ = _tune_app(tmp_path, monkeypatch, resp, [])
    assert c.get("/api/tune/trades", headers=TS).json() == {"at": None, "trades": []}         # chưa chạy lần nào
    assert c.post("/api/tune/backtest", json={"params": {}, "timerange": "20210101-"}, headers=TS).status_code == 200
    j = c.get("/api/tune/backtest", headers=TS).json()
    assert "trades" not in j["last"]                                       # lúc chờ không kéo theo cả nghìn lệnh
    t = c.get("/api/tune/trades", headers=TS).json()
    assert t["at"] == j["last"]["at"] and [x["pair"] for x in t["trades"]] == ["SOL/USDT:USDT"]


def test_trade_candles_window(tmp_path, monkeypatch):
    import pandas as pd

    c, futures = _tune_app(tmp_path, monkeypatch, {}, [])
    futures.mkdir(parents=True)
    n, h4 = 300, 4 * 3600_000
    pd.DataFrame({"date": pd.date_range("2024-01-01", periods=n, freq="4h", tz="UTC"),
                  **{k: [float(i) for i in range(n)] for k in ("open", "high", "low", "close")},
                  "volume": 1.0}).to_feather(futures / "BTC_USDT_USDT-4h-futures.feather")
    t0 = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp() * 1000)
    j = c.get(f"/api/tune/candles?pair=BTC/USDT:USDT&start={t0 + 150 * h4 + 60_000}&end={t0 + 160 * h4}", headers=TS).json()
    rows = j["candles"]
    assert j["tf"] == "4h" and len(rows) == 80 + 11 + 20 and rows[0][0] == t0 + 70 * h4 and rows[0][1] == 70.0
    assert rows[80][0] == t0 + 150 * h4 and 0 < rows[80][5] < 150 and rows[80][6] > 0   # nến chứa giờ vào lệnh; EMA chậm hơn giá
    assert c.get(f"/api/tune/candles?pair=ETH/USDT:USDT&start={t0}&end={t0}", headers=TS).status_code == 400


def test_labdata_command_and_temp_config(tmp_path):
    import labdata

    bot = json.loads((REPO / "bot" / "deploy" / "config.base.json").read_text())
    cmd = labdata.build_command(bot, Path("/tmp/x.json"), Path("/freqtrade/user_data/data/binance"))
    assert cmd[:8] == ["freqtrade", "download-data", "-c", "/tmp/x.json", "--userdir", "/freqtrade/user_data",
                       "--datadir", "/freqtrade/user_data/data/binance"]
    assert cmd[cmd.index("-p") + 1:cmd.index("-t")] == bot["exchange"]["pair_whitelist"]
    assert cmd[cmd.index("-t") + 1:] == ["4h", "15m"] and "--erase" not in cmd
    tmp = labdata.temp_config(bot)
    assert "api_server" not in tmp and "api_server" in bot and tmp["exchange"] == bot["exchange"]
    assert labdata.build_command({**bot, "timeframe": "15m"}, Path("c"), Path("d"))[-2:] == ["-t", "15m"]


def test_labdata_updater_runs_and_alerts_after_two_failures(tmp_path):
    import labdata

    bot = tmp_path / "config.base.json"
    bot.write_text(json.dumps({"timeframe": "4h", "api_server": {"enabled": True},
                               "exchange": {"name": "binance", "pair_whitelist": ["BTC/USDT:USDT"]}}))
    seen, files, sent, results = [], [], [], [(1, "x - freqtrade - ERROR - mạng lỗi"), (0, "ok - ERROR - Pair X not available"),
                                   (1, ""), (0, "ok")]

    async def fake_exec(cmd, timeout):
        cfg_file = Path(cmd[cmd.index("-c") + 1])
        seen.append(json.loads(cfg_file.read_text()))               # config tạm tồn tại lúc chạy
        files.append(cfg_file)
        return results.pop(0)

    async def notify(msg):
        sent.append(msg)

    u = labdata.Updater(bot, tmp_path / "data", notify, exec_=fake_exec)
    (tmp_path / "data").mkdir()
    assert asyncio.run(u.once()) is False and sent == [] and u.status()["last_error"].endswith("mạng lỗi")
    assert asyncio.run(u.once()) is False and len(sent) == 1 and "2 lần" in sent[0]   # dòng ERROR dù mã 0
    assert asyncio.run(u.once()) is False and len(sent) == 1                          # không báo lặp
    assert asyncio.run(u.once()) is True and "Hết" in sent[1] and u.status()["last_error"] is None
    assert "api_server" not in seen[0] and u.last_ok
    assert not any(f.exists() for f in files)                                       # xoá config tạm
    assert labdata.Updater(bot, tmp_path / "data").last_ok == u.last_ok             # nhớ qua lần khởi động lại


def test_tune_live_reports_last_update(tmp_path, monkeypatch):
    responses = {("GET", "/show_config"): {"state": "running", "timeframe": "4h", "strategy": "TrendBreakout"},
                 ("GET", "/status"): [], ("GET", "/profit"): {}, ("GET", "/whitelist"): {"whitelist": []}}
    c, data = _tune_app(tmp_path, monkeypatch, responses, [])
    assert c.get("/api/tune/live", headers=TS).json()["data_update"] == {"enabled": False}
    data.parent.mkdir(parents=True)
    (data.parent / "hub_download.json").write_text(json.dumps({"last_ok": "2026-10-01T00:00:00+00:00"}))
    lab = {"api_url": "http://x", "username": "u", "password": "p", "strategy_dir": tmp_path / "user_data" / "strategies_lab"}
    c = make_app(tmp_path, strategy="TrendBreakout", lab=lab, live={**lab, "strategy_dir": tmp_path / "s"},
                 bot_config=str(tmp_path / "config.base.json"))
    u = c.get("/api/tune/live", headers=TS).json()["data_update"]
    assert u == {"enabled": True, "running": False, "last_ok": "2026-10-01T00:00:00+00:00", "last_error": None}


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
    assert "Live: 2 lệnh" in out["text"] and "PF 2.00" in out["text"]
    out = asyncio.run(weekly.build(Fake([]), Down()))
    assert "Paper: không đọc được" in out["text"] and "match" not in out


def test_strategy_soft_halt_matches_hub():
    """Hàm halt/giảm khối lượng của TrendBreakout (chạy riêng, không cần talib) và ngưỡng khớp với hub."""
    import ast

    import live
    src = (Path(__file__).resolve().parents[1] / "user_data/strategies/TrendBreakout.py").read_text(encoding="utf-8")
    keep = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef)
            or isinstance(n, ast.Assign) and all(getattr(t, "id", "").isupper() for t in n.targets)]
    ns: dict = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "TrendBreakout", "exec"), ns)
    assert ns["HALT_DD"] * 100 == live.HALT_DD_PCT and ns["REDUCE_DD"] * 100 == live.REDUCE_DD_PCT
    assert ns["risk_scale"](1000, [-150]) == 1.0                    # sụt 15%
    assert ns["risk_scale"](1000, [-250]) == 0.5                    # sụt 25%: nửa khối lượng
    assert ns["risk_scale"](1000, [-250, 100]) == 1.0               # hồi về sụt 15%
    assert ns["halt_reason"](1000, [-250]) is None
    assert ns["halt_reason"](1000, [-310, 200]) is not None         # đã chạm 31% thì dừng hẳn dù đã hồi
