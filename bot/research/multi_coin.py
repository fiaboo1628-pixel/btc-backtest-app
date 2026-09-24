"""
Backtest DonchianRevert trên nhiều coin: từng coin riêng (1 lệnh/lúc) và cả danh mục (nhiều lệnh cùng lúc).
In bảng markdown (và ghi vào $GITHUB_STEP_SUMMARY nếu có).

  python research/multi_coin.py --pairs BTC ETH SOL --datadir user_data/data/binance --timerange 20210101-
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
STRAT = ROOT / "user_data" / "strategies" / "DonchianRevert.py"


def backtest(pairs: list[str], max_open: int, params: dict, a, tag: str) -> dict:
    work = Path(tempfile.mkdtemp(prefix=f"bt_{tag}_"))
    sdir = work / "strategies"
    sdir.mkdir()
    shutil.copy(STRAT, sdir)
    (sdir / "DonchianRevert.json").write_text(json.dumps({"strategy_name": "DonchianRevert", "params": params}))
    cfg = json.loads((ROOT / "cfg_fut.json").read_text())
    cfg["exchange"]["pair_whitelist"] = [f"{p}/USDT:USDT" for p in pairs]
    cfg["max_open_trades"] = max_open
    (work / "cfg.json").write_text(json.dumps(cfg))
    (work / "results").mkdir()
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "backtesting", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", a.datadir, "--strategy-path", str(sdir),
           "--strategy", "DonchianRevert", "--timerange", a.timerange, "--export", "trades",
           "--backtest-directory", str(work / "results"), "--cache", "none"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    zips = sorted((work / "results").glob("*.zip"))
    if r.returncode or not zips:
        print(r.stdout[-3000:], r.stderr[-3000:], file=sys.stderr)
        return {"tag": tag, "error": True}
    with zipfile.ZipFile(zips[-1]) as z:
        name = next(n for n in z.namelist() if n.endswith(".json") and "config" not in n)
        res = json.load(z.open(name))["strategy"]["DonchianRevert"]
    shutil.rmtree(work, ignore_errors=True)
    t = pd.DataFrame(res["trades"])
    out = {"tag": tag, "trades": res["total_trades"], "profit": res["profit_total"] * 100,
           "dd": res["max_drawdown_account"] * 100, "pf": res.get("profit_factor") or 0}
    if len(t):
        t["m"] = pd.to_datetime(t.close_date).dt.tz_localize(None).dt.to_period("M")
        start, end = t["m"].min(), t["m"].max()
        m = t.groupby("m").profit_abs.sum().reindex(pd.period_range(start, end, freq="M"), fill_value=0)
        y = t.groupby(pd.to_datetime(t.close_date).dt.year).profit_abs.sum()
        out.update(per_month=len(t) / len(m), months_up=100 * (m > 0).mean(),
                   years_up=f"{(y > 0).sum()}/{len(y)}",
                   years=" ".join(f"{k % 100:02d}:{v:+.0f}" for k, v in y.items()))
    return out


def table(rows: list[dict]) -> str:
    h = ("| | Lệnh | Lệnh/tháng | Lãi % | DD % | PF | Tháng lãi % | Năm lãi | Lãi theo năm (USDT) |\n"
         "|---|---|---|---|---|---|---|---|---|\n")
    for r in rows:
        if r.get("error"):
            h += f"| {r['tag']} | lỗi | | | | | | | |\n"
            continue
        h += (f"| {r['tag']} | {r['trades']} | {r.get('per_month', 0):.1f} | {r['profit']:+.1f} | {r['dd']:.1f} | "
              f"{r['pf']:.2f} | {r.get('months_up', 0):.0f} | {r.get('years_up', '')} | {r.get('years', '')} |\n")
    return h


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", nargs="+", required=True)
    ap.add_argument("--datadir", default="user_data/data/binance")
    ap.add_argument("--timerange", default="20210101-")
    ap.add_argument("--max-open", type=int, nargs="+", default=[3, 5])
    ap.add_argument("--risk", type=float, default=1.0)
    ap.add_argument("--buy", default="{}", help='tham số buy dạng JSON, ví dụ \'{"htf_trend": true}\'')
    ap.add_argument("--sell", default="{}", help='tham số sell dạng JSON, ví dụ \'{"r_atr": 2.0}\'')
    a = ap.parse_args()
    buy, sell = json.loads(a.buy), {"risk_pct": a.risk, **json.loads(a.sell)}
    single = {"buy": buy, "sell": sell}
    rows = [backtest([p], 1, single, a, p) for p in a.pairs]
    print(table(rows), flush=True)
    port = {"buy": buy, "sell": {**sell, "fixed_lev": True}}
    prow = [backtest(a.pairs, n, port, a, f"Danh mục {len(a.pairs)} coin, tối đa {n} lệnh") for n in a.max_open]
    md = (f"## Từng coin (1 lệnh/lúc, rủi ro {a.risk}%/lệnh, {a.timerange})\n\n{table(rows)}\n"
          f"## Danh mục\n\n{table(prow)}")
    print(table(prow))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)
    Path("research_result.md").write_text(md)


if __name__ == "__main__":
    main()
