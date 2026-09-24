"""
Tải dữ liệu Binance USDT-M Futures thật từ kho công khai data.binance.vision (không cần API, không bị chặn
như api.binance.com) và ghi ra định dạng freqtrade futures:
  <BASE>_USDT_USDT-15m-futures.feather, -1h-mark.feather, -1h-funding_rate.feather

  python research/binance_vision.py --pairs BTC ETH SOL --start 2020-10 --end 2026-08 --out user_data/data/binance
"""
import argparse
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import pandas as pd

BASE = "https://data.binance.vision/data/futures/um/monthly"
KCOLS = ["date", "open", "high", "low", "close", "volume"]


def months(start: str, end: str) -> list[str]:
    return [p.strftime("%Y-%m") for p in pd.period_range(start, end, freq="M")]


def fetch_csv(url: str) -> pd.DataFrame | None:
    try:
        with urlopen(url, timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
    except HTTPError as e:
        if e.code == 404:
            return None                      # coin chưa niêm yết tháng đó
        raise
    raw = z.read(z.namelist()[0]).decode()
    first = raw.split(",", 1)[0]
    return pd.read_csv(io.StringIO(raw), header=0 if not first[:1].isdigit() else None)


def to_ms(s: pd.Series) -> pd.Series:
    s = s.astype("int64")
    return s.where(s < 10**14, s // 1000)    # vài file dùng micro-giây


def klines(sym: str, kind: str, tf: str, ms: list[str]) -> pd.DataFrame:
    urls = [f"{BASE}/{kind}/{sym}/{tf}/{sym}-{tf}-{m}.zip" for m in ms]
    with ThreadPoolExecutor(8) as ex:
        parts = [p for p in ex.map(fetch_csv, urls) if p is not None]
    if not parts:
        return pd.DataFrame(columns=KCOLS)
    d = pd.concat([p.iloc[:, :6].set_axis(KCOLS, axis=1) for p in parts])
    d["date"] = pd.to_datetime(to_ms(d["date"]), unit="ms", utc=True).astype("datetime64[ms, UTC]")
    d[KCOLS[1:]] = d[KCOLS[1:]].astype(float)
    return d.drop_duplicates("date").sort_values("date").reset_index(drop=True)


def funding(sym: str, ms: list[str], grid: pd.Series) -> pd.DataFrame:
    urls = [f"{BASE}/fundingRate/{sym}/{sym}-fundingRate-{m}.zip" for m in ms]
    with ThreadPoolExecutor(8) as ex:
        parts = [p for p in ex.map(fetch_csv, urls) if p is not None]
    f = pd.DataFrame({"date": grid})
    f["open"] = 0.0
    if parts:
        r = pd.concat(parts)
        t = pd.to_datetime(to_ms(r.iloc[:, 0]), unit="ms", utc=True).dt.floor("h").astype("datetime64[ms, UTC]")
        rate = pd.Series(r.iloc[:, -1].astype(float).values, index=t).groupby(level=0).last()
        f["open"] = f["date"].map(rate).fillna(0.0)
    for c in ["high", "low", "close"]:
        f[c] = f["open"]
    f["volume"] = 0.0
    return f


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", nargs="+", default=["BTC"])
    ap.add_argument("--start", default="2020-10")
    ap.add_argument("--end", required=True, help="tháng cuối đã trọn vẹn, ví dụ 2026-08")
    ap.add_argument("--tf", default="15m")
    ap.add_argument("--out", default="user_data/data/binance")
    a = ap.parse_args()
    out = Path(a.out) / "futures"
    out.mkdir(parents=True, exist_ok=True)
    ms = months(a.start, a.end)
    for base in a.pairs:
        sym = f"{base}USDT"
        k = klines(sym, "klines", a.tf, ms)
        if k.empty:
            print(f"{sym}: không có dữ liệu")
            continue
        k.to_feather(out / f"{base}_USDT_USDT-{a.tf}-futures.feather")
        mark = klines(sym, "markPriceKlines", "1h", ms)
        mark.to_feather(out / f"{base}_USDT_USDT-1h-mark.feather")
        funding(sym, ms, mark["date"]).to_feather(out / f"{base}_USDT_USDT-1h-funding_rate.feather")
        print(f"{sym}: {len(k)} nến {a.tf} ({k.date.iloc[0]:%Y-%m-%d} → {k.date.iloc[-1]:%Y-%m-%d}), "
              f"{len(mark)} nến mark 1h")


if __name__ == "__main__":
    main()
