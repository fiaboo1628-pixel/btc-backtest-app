"""
Kiểm tra end-to-end trên Binance DEMO, đi qua đúng code đặt lệnh của freqtrade mà bot dùng:
kết nối + key → One-way mode → ký quỹ/đòn bẩy → vào lệnh market nhỏ → đặt stop trên sàn (reduce-only)
→ dời stop (như trailing) → đóng lệnh, dọn sạch. In báo cáo gọn để gửi lại (không có key).

    docker compose stop live                 # tạm dừng bot để nó không đụng vào lệnh thử
    docker compose run --rm check
    docker compose start live

Chỉ chạy với key Demo (secrets/exchange.json có "demo_trading": true, tạo bằng `setup --api` chọn d).
Lệnh thử ~110 USDT, đòn bẩy 2, đóng ngay; luôn dọn vị thế + lệnh stop kể cả khi lỗi giữa chừng.
"""
import json
import math
import sys
import time
import traceback
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
USER_DATA = Path("/freqtrade/user_data")   # thư mục user_data trong container freqtrade
PAIR = "BTC/USDT:USDT"
NOTIONAL = 110.0          # USDT; Binance yêu cầu lệnh BTCUSDT tối thiểu 100 USDT
LEVERAGE = 2.0

steps: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> bool:
    steps.append((name, ok, detail))
    print(f"[{'OK ' if ok else 'LỖI'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def report(ex=None) -> None:
    import ccxt
    import freqtrade

    print("\n" + "=" * 60)
    print("BÁO CÁO demo_check (dán phần này cho người review; không chứa key)")
    print(f"freqtrade {freqtrade.__version__} · ccxt {ccxt.__version__} · {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    if ex is not None:
        print(f"sàn: {ex.name} · fapi: {ex._api.urls.get('api', {}).get('fapiPrivate')}")
    for name, ok, detail in steps:
        print(f"  {'✅' if ok else '❌'} {name}" + (f": {detail}" if detail else ""))
    failed = [s for s in steps if not s[1]]
    print("KẾT QUẢ:", "ĐẠT — sẵn sàng chạy bot trên Demo" if not failed else f"CÓ {len(failed)} BƯỚC LỖI")
    print("=" * 60)


def last_price(ex) -> float:
    t = ex.fetch_ticker(PAIR)
    return float(t.get("last") or t.get("close") or t.get("ask"))


def load_config() -> dict:
    from freqtrade.configuration import Configuration
    from freqtrade.enums import RunMode

    secret = DEPLOY / "secrets" / "exchange.json"
    if not secret.exists():
        raise SystemExit("Chưa có secrets/exchange.json — chạy: docker compose run --rm setup --api (chọn d)")
    if not json.loads(secret.read_text(encoding="utf-8")).get("exchange", {}).get("demo_trading"):
        raise SystemExit("Key hiện tại là tài khoản THẬT. demo_check chỉ chạy trên Demo — không đặt lệnh.")
    files = ["config.base.json", "config.live.json", "config.exchange.json", "secrets/exchange.json"]
    args = {"config": [str(DEPLOY / f) for f in files]}
    if USER_DATA.is_dir():
        args["user_data_dir"] = str(USER_DATA)
    return Configuration(args, RunMode.OTHER).get_config()


def main() -> int:
    try:
        config = load_config()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        step("Đọc cấu hình", False, repr(e))
        report()
        return 1
    step("Đọc cấu hình", True, f"dry_run={config['dry_run']}, stoploss_on_exchange="
         f"{config.get('order_types', {}).get('stoploss_on_exchange')}")

    from freqtrade.enums import MarginMode
    from freqtrade.resolvers import ExchangeResolver

    ex = None
    position_open = False
    stop_ids: list[str] = []
    amount = 0.0
    try:
        # 1) kết nối, đọc thị trường, xác thực key
        try:
            ex = ExchangeResolver.load_exchange(config, validate=True, load_leverage_tiers=True)
            demo_url = "demo-fapi" in str(ex._api.urls.get("api", {}).get("fapiPrivate", ""))
            step("Kết nối Binance", demo_url, "đang dùng máy chủ Demo" if demo_url
                 else "KHÔNG phải máy chủ Demo — dừng để an toàn")
            if not demo_url:
                return 1
        except Exception as e:  # noqa: BLE001
            step("Kết nối Binance", False, f"{type(e).__name__}: {e}")
            return 1

        try:
            bal = ex.get_balances()
            usdt = bal.get("USDT", {})
            step("Key + số dư", True, f"USDT free={usdt.get('free')}, total={usdt.get('total')}")
        except Exception as e:  # noqa: BLE001
            step("Key + số dư", False, f"{type(e).__name__}: {e} (sai key? key không bật Futures?)")
            return 1

        # 2) One-way mode (bot không dùng Hedge mode)
        try:
            dual = ex._api.fapiPrivateGetPositionSideDual()
            hedge = str(dual.get("dualSidePosition")).lower() == "true"
            step("Chế độ vị thế One-way", not hedge,
                 "Hedge mode đang bật — tắt trong Binance: Futures → ⚙ → Position Mode → One-way" if hedge else "")
            if hedge:
                return 1
        except Exception as e:  # noqa: BLE001
            step("Chế độ vị thế One-way", False, f"{type(e).__name__}: {e}")

        # 3) không có vị thế/lệnh sẵn trên cặp này (bot phải đang dừng)
        try:
            pos = [p for p in ex.fetch_positions(PAIR) if float(p.get("contracts") or 0) != 0]
            opens = ex._api.fetch_open_orders(PAIR)
            try:
                opens += ex._api.fetch_open_orders(PAIR, params={"stop": True})
            except Exception:  # noqa: BLE001
                pass
            clean = not pos and not opens
            step("Chưa có vị thế/lệnh BTC", clean,
                 "" if clean else f"{len(pos)} vị thế, {len(opens)} lệnh — dừng bot "
                 "(docker compose stop live) và đóng tay trước khi thử")
            if not clean:
                return 1
        except Exception as e:  # noqa: BLE001
            step("Chưa có vị thế/lệnh BTC", False, f"{type(e).__name__}: {e}")
            return 1

        # 4) ký quỹ isolated + đòn bẩy
        try:
            ex.set_margin_mode(PAIR, MarginMode.ISOLATED, accept_fail=True)
            ex._set_leverage(LEVERAGE, PAIR)
            step("Ký quỹ isolated + đòn bẩy", True, f"x{LEVERAGE:g}")
        except Exception as e:  # noqa: BLE001
            step("Ký quỹ isolated + đòn bẩy", False, f"{type(e).__name__}: {e}")
            return 1

        # 5) vào lệnh market (Long) nhỏ
        price = last_price(ex)
        amount = ex.amount_to_precision(PAIR, math.ceil(NOTIONAL / price * 1000) / 1000)
        t0 = time.time()
        try:
            o = ex.create_order(pair=PAIR, ordertype="market", side="buy", amount=amount,
                                rate=price, leverage=LEVERAGE)
            position_open = True
            time.sleep(1.5)
            o = ex.fetch_order(o["id"], PAIR)
            fill = float(o.get("average") or o.get("price") or 0)
            slip = (fill / price - 1) * 1e4 if fill else float("nan")
            step("Vào lệnh market", o.get("status") == "closed",
                 f"{amount} BTC @ {fill} (giá tham chiếu {price}, lệch {slip:+.1f} bps, {time.time() - t0:.1f}s)")
        except Exception as e:  # noqa: BLE001
            step("Vào lệnh market", False, f"{type(e).__name__}: {e}")
            return 1

        # 6) đặt stop trên sàn, đúng loại lệnh bot dùng (order_types trong config.live.json)
        order_types = config["order_types"]
        stop1 = ex.price_to_precision(PAIR, fill * 0.97)
        try:
            s = ex.create_stoploss(pair=PAIR, amount=amount, stop_price=stop1, order_types=order_types,
                                   side="sell", leverage=LEVERAGE)
            stop_ids.append(s["id"])
            time.sleep(1)
            chk = ex.fetch_stoploss_order(s["id"], PAIR)
            ok = chk.get("status") == "open"
            step("Đặt stop trên sàn", ok, f"id {s['id']}, loại {chk.get('type')}, giá kích hoạt "
                 f"{chk.get('stopPrice') or stop1}, trạng thái {chk.get('status')}, "
                 f"reduceOnly={chk.get('reduceOnly')}")
            if not ok:
                return 1
        except Exception as e:  # noqa: BLE001
            step("Đặt stop trên sàn", False, f"{type(e).__name__}: {e}")
            return 1

        # 7) dời stop lên (freqtrade làm vậy khi trailing: huỷ stop cũ, đặt stop mới)
        stop2 = ex.price_to_precision(PAIR, fill * 0.98)
        try:
            ex.cancel_stoploss_order(stop_ids[-1], PAIR)
            old = ex.fetch_stoploss_order(stop_ids[-1], PAIR)
            s2 = ex.create_stoploss(pair=PAIR, amount=amount, stop_price=stop2, order_types=order_types,
                                    side="sell", leverage=LEVERAGE)
            stop_ids.append(s2["id"])
            time.sleep(1)
            chk2 = ex.fetch_stoploss_order(s2["id"], PAIR)
            ok = old.get("status") in ("canceled", "cancelled") and chk2.get("status") == "open"
            step("Dời stop (trailing)", ok, f"{stop1} → {stop2}; stop cũ: {old.get('status')}, "
                 f"stop mới: {chk2.get('status')}")
        except Exception as e:  # noqa: BLE001
            step("Dời stop (trailing)", False, f"{type(e).__name__}: {e}")

        # 8) stop vẫn nằm trên sàn khi không có bot: đọc bằng kết nối mới hoàn toàn
        try:
            ex2 = ExchangeResolver.load_exchange(config, validate=False)
            chk3 = ex2.fetch_stoploss_order(stop_ids[-1], PAIR)
            step("Stop còn trên sàn (kết nối mới)", chk3.get("status") == "open", f"trạng thái {chk3.get('status')}")
        except Exception as e:  # noqa: BLE001
            step("Stop còn trên sàn (kết nối mới)", False, f"{type(e).__name__}: {e}")
        return 0

    except Exception as e:  # noqa: BLE001
        step("Lỗi không lường trước", False, f"{type(e).__name__}: {e}")
        traceback.print_exc()
        return 1

    finally:
        # 9) dọn sạch: huỷ stop, đóng vị thế bằng market reduce-only, kiểm tra lại
        if ex is not None:
            for sid in stop_ids:
                try:
                    ex.cancel_stoploss_order(sid, PAIR)
                except Exception:  # noqa: BLE001
                    pass
            if position_open:
                try:
                    price = last_price(ex)
                    ex.create_order(pair=PAIR, ordertype="market", side="sell", amount=amount, rate=price,
                                    leverage=LEVERAGE, reduceOnly=True)
                    time.sleep(1.5)
                except Exception as e:  # noqa: BLE001
                    step("Đóng lệnh thử", False, f"{type(e).__name__}: {e} — ĐÓNG TAY trong app Binance Demo")
            try:
                left = [p for p in ex.fetch_positions(PAIR) if float(p.get("contracts") or 0) != 0]
                opens = ex._api.fetch_open_orders(PAIR)
                try:
                    opens += ex._api.fetch_open_orders(PAIR, params={"stop": True})
                except Exception:  # noqa: BLE001
                    pass
                step("Dọn sạch", not left and not opens,
                     "" if not left and not opens else f"còn {len(left)} vị thế, {len(opens)} lệnh — xử lý tay")
            except Exception as e:  # noqa: BLE001
                step("Dọn sạch", False, f"{type(e).__name__}: {e}")
        report(ex)


if __name__ == "__main__":
    main()
    sys.exit(0 if steps and all(ok for _, ok, _ in steps) else 1)
