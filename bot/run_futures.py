# Chạy freqtrade futures offline: giả lập market Binance USDT-M perpetual cho các cặp trong config.
import sys
from freqtrade.exchange.exchange import Exchange

# bước giá/khối lượng gần đúng của Binance; cặp không có ở đây dùng bước nhỏ (đủ cho nghiên cứu)
PREC = {"BTC": (0.001, 0.1), "ETH": (0.001, 0.01)}


def market(pair: str) -> dict:
    base = pair.split("/")[0]
    amount, price = PREC.get(base, (0.001, 1e-6))
    return {"id": f"{base}USDT", "symbol": pair, "base": base, "quote": "USDT", "settle": "USDT",
            "active": True, "spot": False, "margin": False, "swap": True, "future": False, "type": "swap",
            "contract": True, "linear": True, "inverse": False, "contractSize": 1.0,
            "precision": {"amount": amount, "price": price}, "info": {},
            "limits": {"amount": {"min": amount, "max": None}, "cost": {"min": 5, "max": None},
                       "price": {"min": None, "max": None}, "leverage": {"min": 1, "max": 125}}}


def fake_reload(self, force=False, *, load_leverage_tiers=True):
    pairs = self._config.get("exchange", {}).get("pair_whitelist") or ["BTC/USDT:USDT"]
    m = {p: market(p) for p in pairs}
    self._markets = m
    self._api.markets = m
    self._api_async.markets = m
    self._last_markets_refresh = 10**13
    self._leverage_tiers = {p: [{"minNotional": 0, "maxNotional": 10**9, "maintenanceMarginRate": 0.004,
                                 "maxLeverage": 125, "maintAmt": 0}] for p in pairs}


Exchange.reload_markets = fake_reload
Exchange.validate_timeframes = lambda self, tf: None
Exchange.fill_leverage_tiers = lambda self: None
from freqtrade.main import main  # noqa: E402

sys.exit(main(sys.argv[1:]))
