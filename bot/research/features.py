"""Tính bộ chỉ báo (đã chuẩn hoá để so sánh được) trên nến BTC 15m."""
import numpy as np, pandas as pd, talib as ta

def load(tf="15m"):
    d = pd.read_feather(f"user_data/data/binance/futures/BTC_USDT_USDT-{tf}-futures.feather").set_index("date")
    return d[d.index >= "2021-01-01"]

def features(d):
    o, h, l, c, v = d.open, d.high, d.low, d.close, d.volume
    f = pd.DataFrame(index=d.index)
    atr = ta.ATR(h, l, c, 14)
    # --- Xu hướng
    f["trend_ema50"] = (c - ta.EMA(c, 50)) / atr
    f["trend_ema200"] = (c - ta.EMA(c, 200)) / atr
    f["trend_ema_slope"] = ta.EMA(c, 50).diff(4) / atr
    f["adx"] = ta.ADX(h, l, c, 14)
    f["di_diff"] = ta.PLUS_DI(h, l, c, 14) - ta.MINUS_DI(h, l, c, 14)
    macd, sig, hist = ta.MACD(c)
    f["macd_hist"] = hist / atr
    # Supertrend-lite: vị trí so với kênh Donchian 20
    hh, ll = h.rolling(20).max(), l.rolling(20).min()
    f["donchian_pos"] = (c - ll) / (hh - ll)
    # --- Động lượng / dao động
    f["rsi14"] = ta.RSI(c, 14)
    f["rsi2"] = ta.RSI(c, 2)
    f["stoch_k"] = ta.STOCH(h, l, c)[0]
    f["cci"] = ta.CCI(h, l, c, 20)
    f["willr"] = ta.WILLR(h, l, c, 14)
    f["roc4"] = c.pct_change(4) * 100
    f["ret1_atr"] = c.diff() / atr.shift(1)          # cú bứt phá (tín hiệu VolatilitySystem)
    # --- Biến động
    up, mid, lo = ta.BBANDS(c, 20, 2, 2)
    f["bb_pctb"] = (c - lo) / (up - lo)
    f["bb_width"] = (up - lo) / mid
    f["atr_pct"] = atr / c * 100
    f["atr_ratio"] = atr / ta.SMA(atr, 100)           # biến động hiện tại so với nền
    # --- Khối lượng
    f["mfi"] = ta.MFI(h, l, c, v, 14)
    f["vol_ratio"] = v / v.rolling(96).mean()
    obv = ta.OBV(c, v)
    f["obv_slope"] = (obv - ta.EMA(obv, 20)) / v.rolling(96).mean()
    vwap = (c * v).rolling(96).sum() / v.rolling(96).sum()
    f["vwap_dist"] = (c - vwap) / atr
    # --- Thời gian (phiên Á/Âu/Mỹ)
    f["hour"] = d.index.hour
    # --- Khung lớn hơn (1h, 4h) — dùng nến ĐÃ ĐÓNG để tránh nhìn trước tương lai
    for tf, rule in [("1h", "1h"), ("4h", "4h")]:
        g = d.resample(rule, label="right", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
        a = ta.ATR(g.high, g.low, g.close, 14)
        t = pd.DataFrame({f"trend_ema50_{tf}": (g.close - ta.EMA(g.close, 50)) / a,
                          f"rsi14_{tf}": ta.RSI(g.close, 14)})
        # label="right": nến 1h 10:00-11:00 được gắn nhãn 11:00, chỉ dùng từ nến 15m mở lúc 11:00
        t.index = t.index - pd.Timedelta("15min")
        f = f.join(t.reindex(f.index, method="ffill"))
    return f

def fwd_returns(d, horizons=(1, 4, 16)):
    # lợi nhuận tương lai tính từ giá ĐÓNG của nến hiện tại
    return pd.DataFrame({f"fwd{h}": np.log(d.close.shift(-h) / d.close) * 100 for h in horizons})
