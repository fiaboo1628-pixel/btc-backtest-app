"""Dựng dữ liệu BTC 15m/1h (định dạng freqtrade futures) từ nến 1 phút Bitstamp.
Nguồn: https://github.com/ff137/bitstamp-btcusd-minute-data
  git clone --depth 1 https://github.com/ff137/bitstamp-btcusd-minute-data.git
Funding giả định +0.01%/8h (00/08/16 UTC). Thay bằng dữ liệu Binance thật nếu có:
  freqtrade download-data --exchange binance --trading-mode futures --pairs BTC/USDT:USDT --timeframes 15m 1h
"""
import os, pandas as pd
SRC = "bitstamp-btcusd-minute-data/data/"
OUT = "user_data/data/binance/futures/"
os.makedirs(OUT, exist_ok=True)
a = pd.read_csv(SRC + "historical/btcusd_bitstamp_1min_2012-2025.csv.gz")
a = a[a.timestamp >= pd.Timestamp("2020-10-01", tz="UTC").timestamp()]
b = pd.read_csv(SRC + "updates/btcusd_bitstamp_1min_latest.csv")
d = pd.concat([a, b]).drop_duplicates("timestamp").sort_values("timestamp")
d["date"] = pd.to_datetime(d.timestamp, unit="s", utc=True)
d = d.set_index("date").drop(columns="timestamp")
agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
for tf, rule in [("15m", "15min"), ("1h", "1h")]:
    o = d.resample(rule, label="left", closed="left").agg(agg).dropna().reset_index()
    o.to_feather(f"{OUT}BTC_USDT_USDT-{tf}-futures.feather")
    if tf == "1h":
        o.to_feather(f"{OUT}BTC_USDT_USDT-1h-mark.feather")
        f = o[["date"]].copy()
        f["open"] = f.date.dt.hour.isin([0, 8, 16]) * 0.0001
        for c in ["high", "low", "close"]:
            f[c] = f["open"]
        f["volume"] = 0.0
        f.to_feather(f"{OUT}BTC_USDT_USDT-1h-funding_rate.feather")
print("OK", os.listdir(OUT))
