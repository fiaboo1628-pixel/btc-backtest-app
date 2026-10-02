"""Tạo fixture cho tests/parity_trend.test.mjs: so backtest nhiều coin chung tài khoản của app với freqtrade từng lệnh
(TrendBreakout, 5 coin của bot, nến 4h, KHÔNG --timeframe-detail để so được từng lệnh).

Chạy trong GitHub Actions bằng .github/workflows/parity-trend.yml (máy làm việc thường không tải được data.binance.vision),
hoặc tay với freqtrade đã cài, từ thư mục bot/:

    python research/binance_vision.py --pairs BTC ETH SOL XRP DOGE --tf 4h --start 2024-01 --end 2026-08 --out /tmp/par/data
    W=/tmp/par && mkdir -p $W/ud/strategies && cp user_data/strategies/TrendBreakout.py $W/ud/strategies/
    python run_futures.py backtesting -c ../tools/parity_trend_cfg.json --userdir $W/ud --datadir $W/data \
        --strategy-path $W/ud/strategies --strategy TrendBreakout --timerange 20250901-20260831 --export trades \
        --backtest-directory $W/ud/backtest_results --cache none
    python ../tools/export_parity_trend.py $W ../tests/fixtures

Tham số chiến lược = mặc định trong TrendBreakout.py (không có file TrendBreakout.json). Fixture ghi cả bước giá /
khối lượng freqtrade đã dùng: bước giá freqtrade tự suy từ số chữ số thập phân của nến từng tháng (get_tick_size_over_time),
bước khối lượng do run_futures.py giả lập (0.001 cho mọi coin — không phải bước thật của Binance).
"""
import glob
import gzip
import json
import os
import sys

import pandas as pd
from freqtrade.data.btanalysis import load_backtest_data
from freqtrade.data.btanalysis.historic_precision import get_tick_size_over_time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bot"))
from run_futures import market  # noqa: E402  — bước giá/khối lượng giả lập dùng khi backtest

work = sys.argv[1] if len(sys.argv) > 1 else "/tmp/par"
out = sys.argv[2] if len(sys.argv) > 2 else "tests/fixtures"
STARTUP = 500                                                  # startup_candle_count của TrendBreakout
TF_MS = 4 * 3600_000

res = max(glob.glob(f"{work}/ud/backtest_results/*.zip"), key=os.path.getmtime)
t = load_backtest_data(res, strategy="TrendBreakout")
meta = json.load(open(res.replace(".zip", ".meta.json")))["TrendBreakout"]
cfg = json.load(open(f"{work}/cfg.json")) if os.path.exists(f"{work}/cfg.json") else {}
pairs = cfg.get("exchange", {}).get("pair_whitelist") or sorted(t.pair.unique())
ms = lambda ts: int(pd.Timestamp(ts).timestamp() * 1000)  # noqa: E731
start, end = meta["backtest_start_ts"] * 1000, meta["backtest_end_ts"] * 1000
data_from = start - STARTUP * TF_MS                           # freqtrade nạp đúng bấy nhiêu nến trước timerange

coins = []
F = f"{work}/data/futures/"
for pair in pairs:
    base = pair.split("/")[0]
    fn = f"{base}_USDT_USDT"
    d = pd.read_feather(F + f"{fn}-4h-futures.feather")
    d = d[(d.date >= pd.Timestamp(data_from, unit="ms", tz="UTC")) & (d.date < pd.Timestamp(end, unit="ms", tz="UTC"))]
    fr = pd.read_feather(F + f"{fn}-1h-funding_rate.feather")[["date", "open"]].rename(columns={"open": "rate"})
    mk = pd.read_feather(F + f"{fn}-1h-mark.feather")[["date", "open"]].rename(columns={"open": "mark"})
    x = fr.merge(mk, on="date")
    x = x[(x.rate != 0) & (x.date >= pd.Timestamp(data_from, unit="ms", tz="UTC")) & (x.date <= pd.Timestamp(end, unit="ms", tz="UTC"))]
    prec = market(pair)["precision"]
    ticks = get_tick_size_over_time(d.copy())                   # bước giá theo tháng, như freqtrade dùng khi backtest
    coins.append({
        "symbol": f"{base}USDT", "pair": pair, "amountStep": prec["amount"],
        # tháng không suy được (null): freqtrade dùng bước của market giả lập (run_futures.py)
        "priceSteps": [[ms(k), None if pd.isna(v) else float(v)] for k, v in ticks.items()], "priceStepFallback": prec["price"],
        "t0": ms(d.date.iloc[0]), "dt": [int((ms(v) - ms(d.date.iloc[0])) / TF_MS) for v in d.date],
        **{k: [float(v) for v in d[col]] for k, col in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"), ("v", "volume"))},
        "funding": [{"t": ms(r.date), "rate": float(r.rate), "mark": float(r.mark)} for r in x.itertuples()],
    })

ref = [{"pair": f"{r.pair.split('/')[0]}USDT", "entryT": ms(r.open_date), "exitT": ms(r.close_date), "dir": -1 if r.is_short else 1,
        "entry": r.open_rate, "exit": r.close_rate, "amount": r.amount, "leverage": r.leverage,
        "pnl": r.profit_abs, "reason": r.exit_reason} for r in t.sort_values(["close_date", "open_date"]).itertuples()]
fx = {"start": start, "end": end, "wallet": meta.get("starting_balance", 1000), "fee": cfg.get("fee", 0.0005),
      "maxOpen": cfg.get("max_open_trades", len(pairs)), "coins": coins, "trades": ref}
os.makedirs(out, exist_ok=True)
with gzip.open(f"{out}/parity_trend_4h.json.gz", "wt") as f:
    json.dump(fx, f, separators=(",", ":"))
print(f"{len(ref)} lệnh tham chiếu, {len(pairs)} coin, {sum(len(c['dt']) for c in coins)} nến 4h, "
      f"{sum(len(c['funding']) for c in coins)} mốc funding → {out}/parity_trend_4h.json.gz")
