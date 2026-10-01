"""
Nghiên cứu chiến lược thứ hai: TrendBreakout (theo xu hướng) chạy song song DonchianRevert (đánh hồi, BTC 15m).

Với mỗi cấu hình (khung, kênh vào, lọc EMA200) chạy một backtest danh mục nhiều coin, rồi ghép lệnh với
DonchianRevert BTC để xem: tương quan lãi theo tháng, lãi/DD khi chạy cả hai trên cùng một tài khoản.
Phí mặc định 0.05%/chiều (taker); --fee cao hơn để tính cả trượt giá. In bảng markdown, ghi research_trend.md.

  python research/trend.py --pairs BTC ETH SOL BNB XRP --datadir data/binance --timerange 20210101-
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
SDIR = ROOT / "user_data" / "strategies"
START = 1000.0


def backtest(strategy: str, tf: str, pairs: list[str], max_open: int, params: dict, a, detail: str | None):
    work = Path(tempfile.mkdtemp(prefix=f"bt_{strategy}_"))
    sdir = work / "strategies"
    sdir.mkdir()
    shutil.copy(SDIR / f"{strategy}.py", sdir)
    (sdir / f"{strategy}.json").write_text(json.dumps({"strategy_name": strategy, "params": params}))
    cfg = json.loads((ROOT / "cfg_fut.json").read_text())
    cfg["exchange"]["pair_whitelist"] = [f"{p}/USDT:USDT" for p in pairs]
    cfg.update(max_open_trades=max_open, timeframe=tf, fee=a.fee, dry_run_wallet=START)
    (work / "cfg.json").write_text(json.dumps(cfg))
    (work / "results").mkdir()
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "backtesting", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", a.datadir, "--strategy-path", str(sdir),
           "--strategy", strategy, "--timerange", a.timerange, "--export", "trades",
           "--backtest-directory", str(work / "results"), "--cache", "none"]
    if detail:
        cmd += ["--timeframe-detail", detail]
    r = subprocess.run(cmd, capture_output=True, text=True)
    zips = sorted((work / "results").glob("*.zip"))
    if r.returncode or not zips:
        print(r.stdout[-3000:], r.stderr[-3000:], file=sys.stderr)
        return None
    with zipfile.ZipFile(zips[-1]) as z:
        name = next(n for n in z.namelist() if n.endswith(".json") and "config" not in n)
        res = json.load(z.open(name))["strategy"][strategy]
    shutil.rmtree(work, ignore_errors=True)
    t = pd.DataFrame(res["trades"])
    if len(t):
        t["close_date"] = pd.to_datetime(t.close_date, utc=True)
    return t


def stats(t: pd.DataFrame, months: pd.PeriodIndex) -> dict:
    """Lãi/DD tính trên vốn START, cộng dồn profit_abs theo thời điểm đóng lệnh (DD theo lệnh đóng)."""
    if t is None or not len(t):
        return {"trades": 0}
    t = t.sort_values("close_date")
    eq = START + t.profit_abs.cumsum()
    dd = ((eq.cummax() - eq) / eq.cummax()).max() * 100
    win, loss = t.profit_abs[t.profit_abs > 0].sum(), -t.profit_abs[t.profit_abs < 0].sum()
    y = t.groupby(t.close_date.dt.year).profit_abs.sum()
    y_start = START + y.cumsum().shift(fill_value=0.0)      # vốn đầu mỗi năm
    m = monthly(t, months)
    return {"trades": len(t), "per_month": len(t) / len(months), "profit": (eq.iloc[-1] / START - 1) * 100,
            "dd": dd, "pf": win / loss if loss else float("inf"), "months_up": 100 * (m > 0).mean(),
            "years_up": f"{(y > 0).sum()}/{len(y)}",
            "years": " ".join(f"{k % 100:02d}:{v / y_start[k] * 100:+.0f}%" for k, v in y.items())}


def monthly(t: pd.DataFrame, months: pd.PeriodIndex) -> pd.Series:
    if t is None or not len(t):
        return pd.Series(0.0, index=months)
    m = t.close_date.dt.tz_localize(None).dt.to_period("M")
    return t.groupby(m).profit_abs.sum().reindex(months, fill_value=0.0)


def yearly(t: pd.DataFrame) -> pd.Series:
    """Lãi mỗi năm, % vốn đầu năm (vốn START + lãi cộng dồn các năm trước)."""
    y = t.groupby(t.close_date.dt.year).profit_abs.sum()
    return y / (START + y.cumsum().shift(fill_value=0.0)) * 100


def walk_forward(cfg_years: dict[str, pd.Series]) -> str:
    """Mỗi năm Y dùng cấu hình có lãi kép tốt nhất trên các năm < Y (chỉ nhìn quá khứ), ghi lãi năm Y của nó.
    So với trung bình mọi cấu hình năm đó (= chọn đại) để biết việc chọn có thêm gì không."""
    df = pd.DataFrame(cfg_years).fillna(0.0)          # hàng = năm, cột = cấu hình
    out = "| Năm | Cấu hình được chọn (từ các năm trước) | Lãi năm đó | Trung bình mọi cấu hình | Cấu hình tệ nhất |\n|---|---|---|---|---|\n"
    chosen = []
    for i, y in enumerate(df.index[1:], start=1):
        past = (1 + df.iloc[:i] / 100).prod()
        best = past.idxmax()
        r = df.loc[y, best]
        chosen.append(r)
        out += f"| {y} | {best} | {r:+.0f}% | {df.loc[y].mean():+.0f}% | {df.loc[y].min():+.0f}% |\n"
    tot = ((1 + pd.Series(chosen) / 100).prod() - 1) * 100
    out += f"| {df.index[1]}–{df.index[-1]} | cộng dồn | {tot:+.0f}% | | |\n"
    return out


def lookahead(pairs: list[str], a) -> str:
    """freqtrade lookahead-analysis: chạy lại backtest với dữ liệu cắt ở từng tín hiệu; lệch = nhìn trước tương lai."""
    work = Path(tempfile.mkdtemp(prefix="la_"))
    sdir = work / "strategies"
    sdir.mkdir()
    shutil.copy(SDIR / "TrendBreakout.py", sdir)
    # fixed_lev như khi nghiên cứu. Đòn bẩy tự tính + ví 1 tỷ của lookahead-analysis + market giả (không giới hạn vị thế)
    # làm vài lệnh ăn hết ví, lần chạy đủ cặp bỏ lệnh mà lần chạy cắt một cặp lại vào → báo nhầm "nhìn trước".
    (sdir / "TrendBreakout.json").write_text(json.dumps(
        {"strategy_name": "TrendBreakout", "params": {"sell": {"fixed_lev": True}}}))
    cfg = json.loads((ROOT / "cfg_fut.json").read_text())
    cfg["exchange"]["pair_whitelist"] = [f"{p}/USDT:USDT" for p in pairs]
    cfg.update(max_open_trades=len(pairs), timeframe="4h", fee=a.fee, dry_run_wallet=START)
    cfg["entry_pricing"]["price_side"] = cfg["exit_pricing"]["price_side"] = "other"   # lệnh market
    (work / "cfg.json").write_text(json.dumps(cfg))
    out = work / "la.csv"
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "lookahead-analysis", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", a.datadir, "--strategy-path", str(sdir),
           "--strategy", "TrendBreakout", "--timerange", "20230101-20250101", "--allow-limit-orders",
           "--minimum-trade-amount", "20", "--targeted-trade-amount", "40",
           "--lookahead-analysis-exportfilename", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if not out.exists():
        return "Look-ahead: không chạy được\n\n```\n" + (r.stdout[-2000:] + r.stderr[-2000:]) + "\n```\n"
    res = pd.read_csv(out)
    # lệnh nào bị báo lệch và cột chỉ báo nào (nếu có) — để phân biệt lệch thật với báo nhầm
    flagged = [ln.split(" - ", 3)[-1] for ln in (r.stdout + r.stderr).splitlines()
               if "lookahead-bias in trade" in ln or "look ahead bias in column" in ln]
    md = "Look-ahead (freqtrade lookahead-analysis, 2023–2024):\n\n" + res.to_markdown(index=False) + "\n"
    if flagged:
        md += "\n```\n" + "\n".join(flagged) + "\n```\n"
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "recursive-analysis", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", a.datadir, "--strategy-path", str(sdir),
           "--strategy", "TrendBreakout", "--timerange", "20240101-20240301", "-p", f"{pairs[0]}/USDT:USDT",
           "--startup-candle", "500", "1000"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = [ln for ln in r.stdout.splitlines() if "|" in ln or "No variance" in ln or "variance" in ln.lower()]
    md += "\nRecursive-analysis (chỉ báo đệ quy lệch bao nhiêu khi đổi số nến khởi động):\n\n```\n" + (
        "\n".join(tail[-30:]) or (r.stdout[-1500:] + r.stderr[-1500:])) + "\n```\n"
    shutil.rmtree(work, ignore_errors=True)
    return md


def row(tag: str, s: dict, extra: str = "") -> str:
    if not s.get("trades"):
        return f"| {tag} | 0 | | | | | | | | {extra} |\n"
    return (f"| {tag} | {s['trades']} | {s['per_month']:.1f} | {s['profit']:+.1f} | {s['dd']:.1f} | {s['pf']:.2f} | "
            f"{s['months_up']:.0f} | {s['years_up']} | {s['years']} | {extra} |\n")


HEAD = ("| | Lệnh | Lệnh/tháng | Lãi % | DD % | PF | Tháng lãi % | Năm lãi | Lãi từng năm (% vốn đầu năm) | Ghi chú |\n"
        "|---|---|---|---|---|---|---|---|---|---|\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", nargs="+", required=True)
    ap.add_argument("--datadir", default="user_data/data/binance")
    ap.add_argument("--timerange", default="20210101-")
    ap.add_argument("--tfs", nargs="+", default=["4h", "1h"])
    ap.add_argument("--entries", type=int, nargs="+", default=[20, 55])
    ap.add_argument("--risk", type=float, default=1.0)
    ap.add_argument("--fee", type=float, default=0.0005, help="phí mỗi chiều (có thể cộng trượt giá ước tính)")
    ap.add_argument("--lookahead", action="store_true", help="chạy thêm freqtrade lookahead-analysis")
    ap.add_argument("--checks-only", action="store_true", help="chỉ chạy look-ahead + recursive-analysis")
    a = ap.parse_args()

    if a.checks_only:
        md = "## Kiểm tra nhìn trước tương lai\n\n" + lookahead(a.pairs[:3], a)
        print(md, flush=True)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
                f.write(md)
        Path("research_trend.md").write_text(md)
        return

    base = backtest("DonchianRevert", "15m", ["BTC"], 1, {"sell": {"risk_pct": a.risk}}, a, None)
    if base is None or not len(base):
        sys.exit("DonchianRevert BTC không chạy được")
    first = pd.Timestamp(a.timerange.split("-")[0]).to_period("M")
    months = pd.period_range(first, base.close_date.max().tz_localize(None).to_period("M"), freq="M")
    base_m = monthly(base, months)

    md = f"## TrendBreakout: danh mục {' '.join(a.pairs)}, rủi ro {a.risk}%/lệnh, phí {a.fee:.2%}/chiều, {a.timerange}\n\n"
    md += ("Mỗi dòng TrendBreakout là một backtest danh mục (tối đa 1 lệnh mỗi coin). Dòng \"+ Revert\" là chạy thêm "
           "DonchianRevert BTC trên cùng tài khoản (cộng lãi USDT của hai bên, không tính lãi kép chéo). "
           "Tương quan = tương quan lãi theo tháng với DonchianRevert.\n\n" + HEAD)
    md += row("DonchianRevert BTC 15m (hiện tại)", stats(base, months))
    print(md, flush=True)
    per_pair, cfg_years = [], {}
    for tf in a.tfs:
        detail = "15m" if tf != "15m" else None
        for n in a.entries:
            for ema in (False, True):
                tag = f"Trend {tf} kênh {n}/{n // 2}{' +EMA200' if ema else ''}"
                p = {"buy": {"entry_period": n, "ema_filter": ema},
                     "sell": {"exit_period": n // 2, "risk_pct": a.risk, "fixed_lev": True}}
                t = backtest("TrendBreakout", tf, a.pairs, len(a.pairs), p, a, detail)
                if t is None:
                    line = f"| {tag} | lỗi | | | | | | | | |\n"
                    md += line
                    print(line, flush=True)
                    continue
                s = stats(t, months)
                if len(t):
                    cfg_years[tag] = yearly(t)
                corr = monthly(t, months).corr(base_m)
                both = pd.concat([t[["close_date", "profit_abs"]], base[["close_date", "profit_abs"]]])
                line = row(tag, s, f"tương quan {corr:+.2f}") + row(f"↳ + Revert BTC", stats(both, months))
                md += line
                print(line, flush=True)
                if len(t):
                    g = t.groupby("pair").profit_abs.agg(["count", "sum"])
                    per_pair.append(f"| {tag} | " + " | ".join(
                        f"{g.loc[f'{c}/USDT:USDT', 'sum']:+.0f} ({g.loc[f'{c}/USDT:USDT', 'count']:.0f})"
                        if f"{c}/USDT:USDT" in g.index else "0 (0)" for c in a.pairs) + " |\n")
    md += ("\n## Lãi USDT theo coin (số lệnh)\n\n| | " + " | ".join(a.pairs) + " |\n|---|"
           + "---|" * len(a.pairs) + "\n" + "".join(per_pair))
    print(md.split("## Lãi USDT theo coin")[1])
    if len(cfg_years) > 1:
        wf = "\n## Walk-forward: chọn cấu hình chỉ bằng dữ liệu các năm trước\n\n" + walk_forward(cfg_years)
        md += wf
        print(wf, flush=True)
    if a.lookahead:
        la = "\n## Kiểm tra nhìn trước tương lai\n\n" + lookahead(a.pairs[:3], a)
        md += la
        print(la, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)
    Path("research_trend.md").write_text(md)


if __name__ == "__main__":
    main()
