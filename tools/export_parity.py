"""Tạo fixture cho tests/parity.test.mjs: so bộ máy JS với freqtrade từng lệnh (DonchianRevert, nến 1m detail).

Chạy trong image freqtrade (không cần cài gì trên máy), từ một thư mục làm việc trống:

    W=/tmp/parity && mkdir -p $W/ud/strategies && cp bot/user_data/strategies/DonchianRevert.py $W/ud/strategies/
    cp tools/parity_cfg.json $W/cfg.json
    FT="docker run --rm -u $(id -u):$(id -g) -v $W:/w -v $PWD/tools:/tools:ro -w /w freqtradeorg/freqtrade:2026.8"
    $FT download-data -c cfg.json --userdir ud --timerange 20260101-20260321 --timeframes 1m 15m --trading-mode futures
    $FT backtesting -c cfg.json --userdir ud --timerange 20260201-20260320 --timeframe-detail 1m --export trades
    docker run --rm -u $(id -u):$(id -g) -v $W:/w -v $PWD/tests/fixtures:/out -v $PWD/tools:/tools:ro -w /w \
        --entrypoint python freqtradeorg/freqtrade:2026.8 /tools/export_parity.py /out

Tham số chiến lược = mặc định trong DonchianRevert.py (không có file DonchianRevert.json).
"""
import glob
import gzip
import json
import os
import sys

import pandas as pd
from freqtrade.data.btanalysis import load_backtest_data

out = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures"
F = "ud/data/binance/futures/"
res = max(glob.glob("ud/backtest_results/*.zip"), key=os.path.getmtime)
t = load_backtest_data(res, strategy="DonchianRevert")
meta = json.load(open(res.replace(".zip", ".meta.json")))["DonchianRevert"]
ms = lambda ts: int(pd.Timestamp(ts).timestamp() * 1000)  # noqa: E731
start, end = meta["backtest_start_ts"] * 1000, meta["backtest_end_ts"] * 1000
data_from = start - 200 * 15 * 60_000                        # startup_candle_count = 200 nến 15m, như freqtrade nạp

d = pd.read_feather(F + "BTC_USDT_USDT-1m-futures.feather")
d = d[(d.date >= pd.Timestamp(data_from, unit="ms", tz="UTC")) & (d.date < pd.Timestamp(end, unit="ms", tz="UTC"))]
# giá BTCUSDT có bước 0.1 → lưu số nguyên ×10 cho gọn
candles = {"t0": ms(d.date.iloc[0]), "dt": [int((ms(x) - ms(d.date.iloc[0])) / 60_000) for x in d.date],
           **{k: [round(v * 10) for v in d[col]] for k, col in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"))},
           "v": [round(v, 3) for v in d.volume]}
fr = pd.read_feather(F + "BTC_USDT_USDT-1h-funding_rate.feather")[["date", "funding_rate"]].rename(columns={"funding_rate": "rate"})
mk = pd.read_feather(F + "BTC_USDT_USDT-1h-mark.feather")[["date", "open"]].rename(columns={"open": "mark"})
x = fr.merge(mk, on="date")
x = x[(x.rate != 0) & (x.date >= pd.Timestamp(data_from, unit="ms", tz="UTC")) & (x.date <= pd.Timestamp(end, unit="ms", tz="UTC"))]
funding = [{"t": ms(r.date), "rate": float(r.rate), "mark": float(r.mark)} for r in x.itertuples()]
ref = [{"entryT": ms(r.open_date), "exitT": ms(r.close_date), "dir": -1 if r.is_short else 1,
        "entry": r.open_rate, "exit": r.close_rate, "amount": r.amount, "leverage": r.leverage,
        "pnl": r.profit_abs, "reason": r.exit_reason} for r in t.itertuples()]
fx = {"start": start, "wallet": meta.get("starting_balance", 1000), "fee": 0.0005,
      "candles1m": candles, "funding": funding, "trades": ref}
with gzip.open(f"{out}/parity_donchian_1m.json.gz", "wt") as f:
    json.dump(fx, f, separators=(",", ":"))
print(f"{len(ref)} lệnh tham chiếu, {len(d)} nến 1m, {len(funding)} mốc funding")
