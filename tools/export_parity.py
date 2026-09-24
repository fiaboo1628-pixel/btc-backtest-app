"""Tạo fixture lớn cho tests/parity.test.mjs (so bộ máy JS với freqtrade).

Cần: freqtrade + dữ liệu từ sat-hach-trainer/trading/donchian_btc (build_data.py, run_futures.py).
Chạy trong thư mục donchian_btc sau khi đã có dữ liệu và backtest xuất trades:

    python run_futures.py backtesting -c cfg_fut.json --userdir user_data --datadir user_data/data/binance \
        --timerange 20210101- --strategy DonchianRevert --export trades
    python <app>/tools/export_parity.py <app>/tests/fixtures
"""
import glob
import json
import os
import sys

import pandas as pd
from freqtrade.data.btanalysis import load_backtest_data

out = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures"
F = "user_data/data/binance/futures/"
res = max(glob.glob("user_data/backtest_results/*.zip"), key=os.path.getmtime)
t = load_backtest_data(res, strategy="DonchianRevert")
ms = lambda ts: int(pd.Timestamp(ts).timestamp() * 1000)  # noqa: E731
ref = [{"entryT": ms(r.open_date), "exitT": ms(r.close_date), "dir": -1 if r.is_short else 1,
        "entry": r.open_rate, "exit": r.close_rate, "amount": r.amount, "pnl": r.profit_abs,
        "reason": r.exit_reason} for r in t.itertuples()]
json.dump(ref, open(f"{out}/_ref_donchian_trades.json", "w"))

d = pd.read_feather(F + "BTC_USDT_USDT-15m-futures.feather")
d = d[d.date >= "2020-10-01"]
candles = {"t": [ms(x) for x in d.date], "o": d.open.tolist(), "h": d.high.tolist(),
           "l": d.low.tolist(), "c": d.close.tolist(), "v": d.volume.tolist()}
fr = pd.read_feather(F + "BTC_USDT_USDT-1h-funding_rate.feather")[["date", "open"]].rename(columns={"open": "rate"})
mk = pd.read_feather(F + "BTC_USDT_USDT-1h-mark.feather")[["date", "open"]].rename(columns={"open": "mark"})
x = fr.merge(mk, on="date")
x = x[(x.rate != 0) & (x.date >= "2020-10-01")]
funding = [{"t": ms(r.date), "rate": float(r.rate), "mark": float(r.mark)} for r in x.itertuples()]
json.dump({"candles": candles, "funding": funding}, open(f"{out}/_btc15m_2020_2026.json", "w"))
print(f"{len(ref)} lệnh tham chiếu, {len(candles['t'])} nến, {len(funding)} mốc funding")
