"""
Kiểm tra độ bền DonchianRevert trên dữ liệu Binance USDT-M perpetual thật (data.binance.vision).
Không sửa chiến lược: mọi biến thể tham số chạy trên bản sao, ghi đè bằng DonchianRevert.json.

  python research/binance_vision.py --pairs BTC ETH SOL BNB --tf 1m 15m --start 2020-01 --end 2026-09 --out data/binance
  python research/robustness.py --datadir data/binance --bitstamp bitstamp-btcusd-minute-data --out robustness_out

Các bước (đều dùng nến chi tiết 1m, phí 0.05%/chiều, trừ khi ghi khác):
  0. Đối chiếu bộ mô phỏng nhanh (fastsim.py) với freqtrade trên cùng dữ liệu
  1. Baseline tham số hiện tại (freqtrade) + so với dữ liệu Bitstamp spot cũ
  2. Walk-forward: tối ưu 8 tham số trên 2 năm, kiểm tra 6 tháng kế tiếp, trượt 6 tháng
  3. Độ nhạy ±20% từng tham số + bảng 2 chiều dc_long×dc_short, adx_min×atr_min_pct
  4. Chi phí xấu: phí 0.07%/chiều + trượt giá 0.02%/chiều
  5. ETH, SOL, BNB với tham số giữ nguyên
  6. Monte Carlo: xáo thứ tự lệnh 1000 lần → phân bố max drawdown, chuỗi thua dài nhất
Kết quả: <out>/result.md (bảng số) và <out>/result.json.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fastsim as fs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STRAT = ROOT / "user_data" / "strategies" / "DonchianRevert.py"
FEE = 0.0005
START = "2020-01-03"                 # 200 nến khởi động sau 2020-01-01
SEED = 20261001
MK: dict[str, fs.Market] = {}        # dữ liệu đã nạp, dùng chung cho các tiến trình con (fork)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- freqtrade

def freqtrade(pair: str, params: dict, timerange: str, fee: float, datadir: str, tag: str) -> dict:
    """Backtest bằng freqtrade thật (--timeframe-detail 1m). params = {"buy": {...}, "sell": {...}}."""
    work = Path(tempfile.mkdtemp(prefix=f"rb_{tag}_"))
    sdir = work / "strategies"
    sdir.mkdir()
    shutil.copy(STRAT, sdir)
    (sdir / "DonchianRevert.json").write_text(json.dumps({"strategy_name": "DonchianRevert", "params": params}))
    cfg = json.loads((ROOT / "cfg_fut.json").read_text())
    cfg["exchange"]["pair_whitelist"] = [f"{pair}/USDT:USDT"]
    (work / "cfg.json").write_text(json.dumps(cfg))
    (work / "results").mkdir()
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "backtesting", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", datadir, "--strategy-path", str(sdir),
           "--strategy", "DonchianRevert", "--timerange", timerange, "--timeframe-detail", "1m",
           "--fee", str(fee), "--export", "trades", "--backtest-directory", str(work / "results"),
           "--cache", "none"]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    zips = sorted((work / "results").glob("*.zip"))
    if r.returncode or not zips:
        print(r.stdout[-3000:], r.stderr[-3000:], file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)
        return {"tag": tag, "error": True}
    with zipfile.ZipFile(zips[-1]) as z:
        name = next(n for n in z.namelist() if n.endswith(".json") and "config" not in n)
        res = json.load(z.open(name))["strategy"]["DonchianRevert"]
    shutil.rmtree(work, ignore_errors=True)
    t = pd.DataFrame(res["trades"])
    if len(t):
        t["open_date"] = pd.to_datetime(t.open_date, utc=True)
        t["close_date"] = pd.to_datetime(t.close_date, utc=True)
        t["equity_before"] = 1000 + t.profit_abs.cumsum() - t.profit_abs
        t["ret"] = t.profit_abs / t.equity_before
    log(f"freqtrade {tag}: {len(t)} lệnh, {res['profit_total'] * 100:+.1f}% ({time.time() - t0:.0f}s)")
    return {"tag": tag, "trades": t, "ft_dd": res["max_drawdown_account"] * 100,
            "ft_profit": res["profit_total"] * 100, "ft_pf": res.get("profit_factor") or 0}


def ft_params(p: dict) -> dict:
    return {"buy": {k: p[k] for k in fs.BUY}, "sell": {k: p[k] for k in fs.SELL}}


def ft_job(args):
    return freqtrade(*args)


# ---------------------------------------------------------------- tiện ích

def fmt_stats(s: dict) -> str:
    return f"{s['profit']:+.1f}% | {s['dd']:.1f}% | {s['pf']:.2f} | {s['trades']} | {s['win']:.0f}%"


def stats_row(name: str, t: pd.DataFrame, extra: str = "") -> str:
    s = fs.stats(t)
    y = fs.yearly(t)
    ys = " · ".join(f"{k}: {v:+.1f}" for k, v in y.items())
    return f"| {name} | {fmt_stats(s)} | {ys} |{extra}\n"


STATS_HDR = "| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm (% vốn đầu năm) |\n|---|---|---|---|---|---|---|\n"


def cagr(t: pd.DataFrame, start, end) -> float:
    yrs = (pd.Timestamp(end, tz="UTC") - pd.Timestamp(start, tz="UTC")).days / 365.25
    if t.empty:
        return 0.0
    return 100 * ((1 + fs.stats(t)["profit"] / 100) ** (1 / yrs) - 1)


def data_end(mk: fs.Market) -> pd.Timestamp:
    return pd.Timestamp(mk.t15[-1], tz="UTC").floor("D")


# ---------------------------------------------------------------- 0 + 1: baseline

def step_baseline(a, end: str) -> tuple[str, dict, pd.DataFrame]:
    mk = MK["BTC"]
    tr = f"{START.replace('-', '')}-{end.replace('-', '')}"
    jobs = [("BTC", ft_params(fs.DEFAULTS), tr, FEE, a.datadir, "baseline"),
            ("BTC", ft_params(fs.DEFAULTS), tr, 0.0009, a.datadir, "cost")]
    jobs += [(c, ft_params(fs.DEFAULTS), tr, FEE, a.datadir, f"coin_{c}") for c in a.coins if c != "BTC"]
    with ProcessPoolExecutor(a.ft_workers, mp_context=mp.get_context("fork")) as ex:
        ft = {r["tag"]: r for r in ex.map(ft_job, jobs)}
    base = ft["baseline"]
    bt = base["trades"]
    sim = fs.run(mk, fs.DEFAULTS, START, end, fee=FEE)
    # đối chiếu từng lệnh
    bt["open_date"] = bt.open_date.astype("datetime64[ns, UTC]")
    bt["close_date"] = bt.close_date.astype("datetime64[ns, UTC]")
    m = bt.merge(sim, on="open_date", how="outer", suffixes=("_ft", "_sim"), indicator=True)
    both = m[m._merge == "both"]
    same_exit = (both.close_date_ft == both.close_date_sim).mean() * 100
    md = "## 0. Đối chiếu bộ mô phỏng nhanh với freqtrade (BTC, tham số hiện tại, phí 0.05%)\n\n"
    md += STATS_HDR
    md += stats_row("freqtrade", bt)
    md += stats_row("fastsim", sim)
    md += (f"\nLệnh trùng giờ vào: {len(both)}/{len(bt)} (freqtrade) — {len(sim)} (fastsim); "
           f"trong số trùng, {same_exit:.1f}% trùng giờ ra. "
           f"Chênh lãi trung bình mỗi lệnh {np.abs(both.profit_abs_ft - both.profit_abs_sim).mean():.2f} USDT. "
           f"freqtrade tự báo: lãi {base['ft_profit']:+.1f}%, DD {base['ft_dd']:.1f}%, PF {base['ft_pf']:.2f}.\n\n")

    md += f"## 1. Baseline — tham số hiện tại, Binance BTCUSDT perpetual ({START} → {end})\n\n"
    md += "freqtrade, `--timeframe-detail 1m`, phí 0.05%/chiều, funding thật, vốn 1000 USDT, rủi ro 1%/lệnh.\n\n"
    md += STATS_HDR + stats_row("Binance perp", bt)
    yr = bt.groupby(bt.close_date.dt.year).profit_abs.agg(["sum", "count"])
    md += "\n| Năm | Lãi USDT | Số lệnh |\n|---|---|---|\n"
    md += "".join(f"| {k} | {v['sum']:+.0f} | {int(v['count'])} |\n" for k, v in yr.iterrows())
    md += (f"\nLãi kép bình quân năm: {cagr(bt, START, end):+.1f}%/năm. Long {bt[~bt.is_short].profit_abs.sum():+.0f} "
           f"USDT ({(~bt.is_short).sum()} lệnh), Short {bt[bt.is_short].profit_abs.sum():+.0f} USDT "
           f"({bt.is_short.sum()} lệnh). Funding cộng dồn {bt.funding_fees.sum():+.1f} USDT.\n\n")

    # Bitstamp so với Binance (điểm yếu 1)
    if "BTC_BITSTAMP" in MK:
        bs = MK["BTC_BITSTAMP"]
        w0, w1 = "2021-01-01", min(end, str(data_end(bs).date()))
        rows = [("Bitstamp spot, phí 0.035% (như README)", bs, 0.00035),
                ("Binance perp, phí 0.035%", mk, 0.00035),
                ("Bitstamp spot, phí 0.05%", bs, FEE),
                ("Binance perp, phí 0.05%", mk, FEE)]
        md += f"### Điểm yếu 1: Bitstamp spot so với Binance perpetual ({w0} → {w1}, fastsim)\n\n" + STATS_HDR
        res = {}
        for name, mkt, fee in rows:
            res[name] = fs.run(mkt, fs.DEFAULTS, w0, w1, fee=fee)
            md += stats_row(name, res[name])
        a_, b_ = res["Bitstamp spot, phí 0.05%"], res["Binance perp, phí 0.05%"]
        ta = set(a_.open_date)
        tb = set(b_.open_date)
        near = sum(any(abs((x - y).total_seconds()) <= 3600 for y in tb) for x in ta)
        md += (f"\nLệnh vào cùng nến 15m trên cả hai nguồn: {len(ta & tb)} "
               f"(Bitstamp {len(ta)}, Binance {len(tb)}); lệch ≤ 1 giờ: {near}. Phần còn lại là tín hiệu chỉ có ở "
               f"một sàn (Donchian/ADX/volume tính trên dữ liệu khác nhau).\n\n")
    return md, ft, bt


# ---------------------------------------------------------------- 2: walk-forward

def sample(rng: np.random.Generator) -> dict:
    p = {}
    for k, (lo, hi, dec) in fs.SPACE.items():
        p[k] = rng.uniform(lo, hi)
    return fs.clamp(p)


OBJECTIVES = {
    "calmar": "lãi % / max(DD %, 5)",            # DD sàn 5% để bộ ít lệnh, DD nhỏ nhờ may không thắng
    "profit": "tổng lãi %",
}


def objective(t: pd.DataFrame, min_trades: int, kind: str) -> float:
    s = fs.stats(t)
    if s["trades"] < min_trades:
        return -1e6 + s["trades"]
    if kind == "profit":
        return s["profit"]
    return s["profit"] / max(s["dd"], 5.0) if s["profit"] > 0 else s["profit"]


def optimize(args):
    """Tìm tham số tốt nhất trên cửa sổ train: ngẫu nhiên + tinh chỉnh quanh top 10."""
    pair, t0, t1, n_rand, n_local, min_trades, seed, kind = args
    mk = MK[pair]
    rng = np.random.default_rng(seed)
    cand = [dict(fs.DEFAULTS)] + [sample(rng) for _ in range(n_rand)]
    scored = [(objective(fs.run(mk, p, t0, t1, fee=FEE), min_trades, kind), p) for p in cand]
    scored.sort(key=lambda x: -x[0])
    top = [p for _, p in scored[:10]]
    for i in range(n_local):
        b = top[i % len(top)]
        q = {k: v + rng.normal(0, 0.08) * (fs.SPACE[k][1] - fs.SPACE[k][0]) for k, v in b.items()}
        q = fs.clamp(q)
        scored.append((objective(fs.run(mk, q, t0, t1, fee=FEE), min_trades, kind), q))
    scored.sort(key=lambda x: -x[0])
    best_score, best = scored[0]
    return {"train": (t0, t1), "best": best, "score": best_score,
            "train_stats": fs.stats(fs.run(mk, best, t0, t1, fee=FEE)),
            "train_default": fs.stats(fs.run(mk, fs.DEFAULTS, t0, t1, fee=FEE))}


def chain(parts: list[pd.DataFrame]) -> pd.DataFrame:
    """Ghép lệnh của các đoạn kiểm tra thành một chuỗi lãi kép (mỗi đoạn tính lại theo vốn cuối đoạn trước)."""
    rows, eq = [], 1000.0
    for t in parts:
        if t.empty:
            continue
        t = t.copy()
        scale = eq / 1000.0
        t["profit_abs"] *= scale
        t["equity_before"] *= scale
        eq += t.profit_abs.sum()
        rows.append(t)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=["profit_abs", "close_date"])


def step_walkforward(a, end: str, kind: str) -> tuple[str, pd.DataFrame, list]:
    tests = []
    t = pd.Timestamp("2022-01-01")
    while t < pd.Timestamp(end):
        tests.append((t, min(t + pd.DateOffset(months=6), pd.Timestamp(end))))
        t += pd.DateOffset(months=6)
    jobs = [("BTC", str(max(pd.Timestamp(START), s - pd.DateOffset(years=2)).date()), str(s.date()),
             a.wf_rand, a.wf_local, a.wf_min_trades, SEED + i, kind) for i, (s, _) in enumerate(tests)]
    log(f"walk-forward: {len(jobs)} cửa sổ × {a.wf_rand + a.wf_local + 1} bộ tham số")
    with ProcessPoolExecutor(a.workers, mp_context=mp.get_context("fork")) as ex:
        opt = list(ex.map(optimize, jobs))
    mk = MK["BTC"]
    oos, dflt, rows, ftjobs = [], [], [], []
    for (s, e), o in zip(tests, opt):
        s_, e_ = str(s.date()), str(e.date())
        to = fs.run(mk, o["best"], s_, e_, fee=FEE)
        td = fs.run(mk, fs.DEFAULTS, s_, e_, fee=FEE)
        oos.append(to)
        dflt.append(td)
        so, sd = fs.stats(to), fs.stats(td)
        rows.append((s_, e_, o, so, sd))
        ftjobs.append(("BTC", ft_params(o["best"]), f"{s_.replace('-', '')}-{e_.replace('-', '')}", FEE, a.datadir,
                       f"wf_{kind}_{s_}"))
    with ProcessPoolExecutor(a.ft_workers, mp_context=mp.get_context("fork")) as ex:
        ftres = list(ex.map(ft_job, ftjobs))
    oos_c, dflt_c = chain(oos), chain(dflt)
    ft_c = chain([r["trades"] for r in ftres if not r.get("error")])
    o0, o1 = str(tests[0][0].date()), end

    md = (f"### Hàm mục tiêu: {OBJECTIVES[kind]}\n\n"
          f"Mỗi cửa sổ train: {a.wf_rand} bộ ngẫu nhiên + {a.wf_local} bộ tinh chỉnh quanh top 10 trên toàn miền "
          f"tham số của chiến lược. Hàm mục tiêu: {OBJECTIVES[kind]}, cần ≥ {a.wf_min_trades} lệnh trong 2 năm. Tham số tốt "
          f"nhất được chạy trên 6 tháng ngay sau (chưa từng thấy). Kết quả test ghép lãi kép.\n\n")
    md += STATS_HDR
    md += stats_row("**Walk-forward OOS (fastsim)**", oos_c)
    md += stats_row("Walk-forward OOS (freqtrade, cùng tham số)", ft_c)
    md += stats_row("Tham số hiện tại, cùng giai đoạn", dflt_c)
    md += (f"\nLãi kép năm: walk-forward {cagr(oos_c, o0, o1):+.1f}%/năm · tham số hiện tại "
           f"{cagr(dflt_c, o0, o1):+.1f}%/năm.\n\n")
    md += ("| Test | Train lãi/DD | Test lãi/DD/lệnh (WF) | Test lãi/DD/lệnh (hiện tại) | dc_long | dc_short | adx_min | "
           "vol_max | atr_min_pct | r_atr | trail_start_r | trail_dist_r |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    for (s_, e_, o, so, sd), fr in zip(rows, ftres):
        b, ts = o["best"], o["train_stats"]
        md += (f"| {s_[:7]}→{e_[:7]} | {ts['profit']:+.0f}% / {ts['dd']:.0f}% | {so['profit']:+.1f}% / {so['dd']:.1f}% / "
               f"{so['trades']} | {sd['profit']:+.1f}% / {sd['dd']:.1f}% / {sd['trades']} | {b['dc_long']} | {b['dc_short']} | "
               f"{b['adx_min']} | {b['vol_max']} | {b['atr_min_pct']} | {b['r_atr']} | {b['trail_start_r']} | "
               f"{b['trail_dist_r']} |\n")
    n_pos = sum(r[3]["profit"] > 0 for r in rows)
    n_beat = sum(r[3]["profit"] > r[4]["profit"] for r in rows)
    md += (f"\nĐoạn test có lãi: {n_pos}/{len(rows)}. Walk-forward hơn tham số hiện tại ở {n_beat}/{len(rows)} đoạn. "
           f"Hiệu suất train trung bình {np.mean([r[2]['train_stats']['profit'] for r in rows]):+.0f}%/2 năm so với test "
           f"{np.mean([r[3]['profit'] for r in rows]):+.1f}%/6 tháng.\n\n")
    return md, oos_c, rows


# ---------------------------------------------------------------- 3: độ nhạy

def perturb(k: str, f: float) -> float:
    v = fs.DEFAULTS[k]
    if k == "dc_short":
        return round(1 - (1 - v) * f, 3)                # ±20% khoảng cách tới đỉnh kênh
    return v * f


def step_sensitivity(a, end: str) -> str:
    mk = MK["BTC"]
    base = fs.stats(fs.run(mk, fs.DEFAULTS, START, end, fee=FEE))
    md = (f"## 3. Độ nhạy tham số (BTC, {START} → {end}, fastsim, phí 0.05%)\n\n"
          f"Baseline: {fmt_stats(base)} (lãi | DD | PF | lệnh | thắng). dc_short lệch theo khoảng cách tới 1 "
          f"(0.944 → 1 − 0.056 × 0.8/1.2).\n\n"
          "| Tham số | Giá trị −20% | Lãi / DD / PF (−20%) | Giá trị +20% | Lãi / DD / PF (+20%) |\n|---|---|---|---|---|\n")
    worst = []
    for k in fs.SPACE:
        cells = []
        for f in (0.8, 1.2):
            p = fs.clamp({**fs.DEFAULTS, k: perturb(k, f)})
            s = fs.stats(fs.run(mk, p, START, end, fee=FEE))
            cells += [str(p[k]), f"{s['profit']:+.1f}% / {s['dd']:.1f}% / {s['pf']:.2f}"]
            worst.append((s["profit"], k, p[k]))
        md += f"| {k} | " + " | ".join(cells) + " |\n"
    w = min(worst)
    md += f"\nTệ nhất: {w[1]} = {w[2]} → {w[0]:+.1f}% (baseline {base['profit']:+.1f}%).\n\n"

    # mọi tham số cùng lệch ngẫu nhiên ±20%
    rng = np.random.default_rng(SEED)
    res = []
    for _ in range(a.sens_joint):
        p = fs.clamp({k: perturb(k, rng.uniform(0.8, 1.2)) for k in fs.SPACE})
        res.append(fs.stats(fs.run(mk, p, START, end, fee=FEE)))
    pr = np.array([r["profit"] for r in res])
    pf = np.array([r["pf"] for r in res])
    dd = np.array([r["dd"] for r in res])
    md += (f"Lệch đồng thời cả 8 tham số, mỗi tham số ngẫu nhiên trong ±20% ({a.sens_joint} lần): lãi p5/p50/p95 = "
           f"{np.percentile(pr, 5):+.0f}% / {np.percentile(pr, 50):+.0f}% / {np.percentile(pr, 95):+.0f}%, "
           f"có lãi {100 * (pr > 0).mean():.0f}% số lần, PF p5 {np.percentile(pf, 5):.2f}, "
           f"DD p95 {np.percentile(dd, 95):.1f}%.\n\n")

    def grid(kx, xs, ky, ys, title):
        out = f"### {title}\n\nÔ: tổng lãi % / PF. **Đậm** = tham số hiện tại.\n\n| {ky} \\ {kx} | " + \
              " | ".join(str(x) for x in xs) + " |\n|---|" + "---|" * len(xs) + "\n"
        for y in ys:
            out += f"| {y} |"
            for x in xs:
                s = fs.stats(fs.run(mk, {**fs.DEFAULTS, kx: x, ky: y}, START, end, fee=FEE))
                c = f"{s['profit']:+.0f} / {s['pf']:.2f}"
                out += f" **{c}** |" if (x == fs.DEFAULTS[kx] and y == fs.DEFAULTS[ky]) else f" {c} |"
            out += "\n"
        return out + "\n"

    md += grid("dc_long", [0.03, 0.045, 0.06, 0.074, 0.09, 0.11, 0.13, 0.15], "dc_short",
               [0.85, 0.87, 0.89, 0.91, 0.926, 0.944, 0.96, 0.97], "dc_long × dc_short")
    md += grid("atr_min_pct", [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.8], "adx_min",
               [15, 20, 24, 27, 30, 33, 36, 40, 45], "adx_min × atr_min_pct")
    return md


# ---------------------------------------------------------------- 4: chi phí

def step_costs(a, end: str, ft: dict) -> str:
    mk = MK["BTC"]
    md = (f"## 4. Chi phí xấu (BTC, {START} → {end})\n\n" + STATS_HDR)
    md += stats_row("freqtrade, phí 0.05% (baseline)", ft["baseline"]["trades"])
    md += stats_row("freqtrade, phí 0.09% (= 0.07% phí + 0.02% trượt)", ft["cost"]["trades"])
    md += stats_row("fastsim, phí 0.07% + trượt 0.02% trên giá", fs.run(mk, fs.DEFAULTS, START, end, fee=0.0007,
                                                                      slip=0.0002))
    md += "\nfastsim, lãi tổng % (PF) theo phí × trượt giá mỗi chiều:\n\n| Phí \\ trượt | 0 | 0.02% | 0.05% | 0.10% |\n|---|---|---|---|---|\n"
    for fee in (0.0002, 0.00035, 0.0005, 0.0007, 0.001):
        md += f"| {fee * 100:.3f}% |"
        for slip in (0, 0.0002, 0.0005, 0.001):
            s = fs.stats(fs.run(mk, fs.DEFAULTS, START, end, fee=fee, slip=slip))
            md += f" {s['profit']:+.0f}% ({s['pf']:.2f}) |"
        md += "\n"
    return md + "\n"


# ---------------------------------------------------------------- 5: coin khác

def step_coins(a, end: str, ft: dict) -> str:
    md = (f"## 5. Coin khác, tham số giữ nguyên ({START} → {end}, freqtrade, phí 0.05%, 1 lệnh/lúc)\n\n" + STATS_HDR)
    md += stats_row("BTC", ft["baseline"]["trades"])
    for c in a.coins:
        if c == "BTC":
            continue
        r = ft.get(f"coin_{c}", {})
        if r.get("error") or "trades" not in r:
            md += f"| {c} | lỗi | | | | | |\n"
            continue
        first = r["trades"].open_date.min()
        md += stats_row(f"{c} (từ {first:%Y-%m})", r["trades"])
    return md + "\n"


# ---------------------------------------------------------------- 6: Monte Carlo

def mc_paths(ret: np.ndarray, n: int, rng: np.random.Generator, scale: float = 1.0):
    dds, streaks, finals = [], [], []
    for _ in range(n):
        r = rng.permutation(ret) * scale
        eq = np.cumprod(1 + r)
        peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
        dds.append(((peak - eq) / peak).max() * 100)
        loss = r < 0
        best = cur = 0
        for x in loss:
            cur = cur + 1 if x else 0
            best = max(best, cur)
        streaks.append(best)
        finals.append(eq[-1])
    return np.array(dds), np.array(streaks), np.array(finals)


def step_montecarlo(a, bt: pd.DataFrame, oos: pd.DataFrame) -> str:
    rng = np.random.default_rng(SEED)
    md = f"## 6. Monte Carlo ({a.mc} lần xáo thứ tự lệnh)\n\n"
    md += ("Mỗi lần xáo, lãi/lỗ của từng lệnh giữ nguyên (theo % vốn lúc vào lệnh) nhưng thứ tự ngẫu nhiên. "
           "Lãi cuối không đổi; drawdown và chuỗi thua thay đổi.\n\n")
    md += "| Chuỗi lệnh | Rủi ro/lệnh | DD thực tế | DD p50 | DD p95 | DD p99 | DD tệ nhất |\n|---|---|---|---|---|---|---|\n"
    streak_md = ("| Chuỗi lệnh | Số lệnh | Thắng | Chuỗi thua thực tế | p50 | p95 | P(≥8) | P(≥10) | P(≥12) | P(≥15) |\n"
                 "|---|---|---|---|---|---|---|---|---|---|\n")
    for name, t in [("Baseline (freqtrade)", bt), ("Walk-forward OOS", oos)]:
        if t.empty:
            continue
        ret = t.ret.to_numpy() if "ret" in t else (t.profit_abs / t.equity_before).to_numpy()
        loss = ret < 0
        best = cur = 0
        for x in loss:
            cur = cur + 1 if x else 0
            best = max(best, cur)
        eq = np.cumprod(1 + ret)
        peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
        real_dd = ((peak - eq) / peak).max() * 100
        for risk in (0.5, 1.0, 1.5, 2.0):
            dds, st, _ = mc_paths(ret, a.mc, rng, risk / 1.0)
            real = f"{real_dd:.1f}%" if risk == 1.0 else ""
            md += (f"| {name} | {risk}% | {real} | {np.percentile(dds, 50):.1f}% | {np.percentile(dds, 95):.1f}% | "
                   f"{np.percentile(dds, 99):.1f}% | {dds.max():.1f}% |\n")
            if risk == 1.0:
                streak_md += (f"| {name} | {len(ret)} | {100 * (ret > 0).mean():.0f}% | {best} | {np.percentile(st, 50):.0f} | "
                              f"{np.percentile(st, 95):.0f} | {100 * (st >= 8).mean():.0f}% | {100 * (st >= 10).mean():.0f}% | "
                              f"{100 * (st >= 12).mean():.0f}% | {100 * (st >= 15).mean():.0f}% |\n")
    md += ("\nRủi ro khác 1%: nhân lãi/lỗ mỗi lệnh theo tỉ lệ (gần đúng, vì phí cũng tỉ lệ với khối lượng).\n\n"
           "Chuỗi thua dài nhất (không phụ thuộc mức rủi ro), phân bố qua các lần xáo:\n\n" + streak_md + "\n")

    # bootstrap 12 tháng: rút có hoàn lại số lệnh của 1 năm
    md += "Bootstrap 12 tháng (rút có hoàn lại số lệnh trung bình của 1 năm, 10 000 lần, rủi ro 1%):\n\n"
    md += "| Chuỗi lệnh | Lệnh/năm | Lãi năm p5 | p50 | p95 | P(năm lỗ) | P(năm lỗ > 10%) |\n|---|---|---|---|---|---|---|\n"
    for name, t in [("Baseline (freqtrade)", bt), ("Walk-forward OOS", oos)]:
        if t.empty:
            continue
        ret = (t.profit_abs / t.equity_before).to_numpy()
        yrs = (t.close_date.max() - t.open_date.min()).days / 365.25
        n = int(round(len(ret) / yrs))
        fin = np.prod(1 + rng.choice(ret, size=(10000, n)), axis=1) - 1
        md += (f"| {name} | {n} | {100 * np.percentile(fin, 5):+.1f}% | {100 * np.percentile(fin, 50):+.1f}% | "
               f"{100 * np.percentile(fin, 95):+.1f}% | {100 * (fin < 0).mean():.0f}% | {100 * (fin < -0.1).mean():.0f}% |\n")
    return md + "\n"


# ---------------------------------------------------------------- vốn tối thiểu

def step_capital(end: str) -> str:
    """Bước khối lượng 0.001 BTC làm tròn xuống: vốn nhỏ thì rủi ro thực tế thấp hơn 1% khá nhiều."""
    mk = MK["BTC"]
    sig = fs.signals(mk, fs.DEFAULTS)
    i1 = i1e = int(np.searchsorted(mk.t15, pd.Timestamp(end, tz="UTC").value))
    i0 = int(np.searchsorted(mk.t15, (pd.Timestamp(end, tz="UTC") - pd.DateOffset(years=1)).value))
    idx = np.where(sig[i0 - 1:i1 - 1] != 0)[0] + i0
    r_pct = mk.atr[idx - 1] * fs.DEFAULTS["r_atr"] / mk.o[idx]
    px = mk.c[i1e - 1]
    md = (f"## Vốn tối thiểu (bước khối lượng Binance 0.001 BTC, lệnh tối thiểu 100 USDT, giá BTC {end} ≈ {px:,.0f} USDT)\n\n"
          f"1R trong 12 tháng gần nhất: trung vị {np.median(r_pct) * 100:.2f}% giá, p90 {np.percentile(r_pct, 90) * 100:.2f}%.\n\n"
          "| Vốn (USDT) | Khối lượng trung vị (BTC) | Rủi ro thực tế trung bình (mục tiêu 1%) | Lệnh bị bỏ (< 0.001 BTC hoặc < 100 USDT) |\n|---|---|---|---|\n")
    for eq in (300, 500, 1000, 2000, 3000, 5000, 10000):
        want = eq * 0.99 * 0.01 / r_pct / px
        got = np.floor(want * 1000) / 1000
        got = np.where(got * px >= 100, got, 0)                 # Binance: giá trị lệnh tối thiểu 100 USDT
        real = np.where(got > 0, got / want, 0) * 1.0
        md += (f"| {eq:,} | {np.median(got):.3f} | {100 * real[got > 0].mean() if (got > 0).any() else 0:.0f}% của 1% | "
               f"{100 * (got == 0).mean():.0f}% |\n")
    return md + "\n"


# ---------------------------------------------------------------- dữ liệu

def build_bitstamp(src: str, out: Path) -> None:
    d = out / "futures"
    if (d / "BTC_USDT_USDT-1m-futures.feather").exists():
        return
    d.mkdir(parents=True, exist_ok=True)
    s = Path(src) / "data"
    a = pd.read_csv(s / "historical" / "btcusd_bitstamp_1min_2012-2025.csv.gz")
    a = a[a.timestamp >= pd.Timestamp("2019-12-01", tz="UTC").timestamp()]
    b = pd.read_csv(s / "updates" / "btcusd_bitstamp_1min_latest.csv")
    m = pd.concat([a, b]).drop_duplicates("timestamp").sort_values("timestamp")
    m["date"] = pd.to_datetime(m.timestamp, unit="s", utc=True).astype("datetime64[ms, UTC]")
    m = m.set_index("date")[["open", "high", "low", "close", "volume"]]
    m.reset_index().to_feather(d / "BTC_USDT_USDT-1m-futures.feather")
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    for tf, rule in (("15m", "15min"), ("1h", "1h")):
        o = m.resample(rule, label="left", closed="left").agg(agg).dropna().reset_index()
        o.to_feather(d / f"BTC_USDT_USDT-{tf}-futures.feather")
        if tf == "1h":
            o.to_feather(d / "BTC_USDT_USDT-1h-mark.feather")
            f = o[["date"]].copy()
            f["open"] = f.date.dt.hour.isin([0, 8, 16]) * 0.0001          # funding giả định như build_data.py
            for c in ("high", "low", "close"):
                f[c] = f["open"]
            f["volume"] = 0.0
            f.to_feather(d / "BTC_USDT_USDT-1h-funding_rate.feather")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datadir", default="data/binance")
    ap.add_argument("--bitstamp", help="thư mục clone bitstamp-btcusd-minute-data (bỏ trống = bỏ qua so sánh)")
    ap.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "BNB"])
    ap.add_argument("--end", help="ngày kết thúc (mặc định: hết dữ liệu BTC)")
    ap.add_argument("--out", default="robustness_out")
    ap.add_argument("--steps", default="baseline,wf,sens,cost,coins,mc,capital")
    ap.add_argument("--wf-rand", type=int, default=5000)
    ap.add_argument("--wf-local", type=int, default=2000)
    ap.add_argument("--wf-min-trades", type=int, default=60)
    ap.add_argument("--wf-objectives", nargs="+", default=["calmar", "profit"], choices=list(OBJECTIVES))
    ap.add_argument("--sens-joint", type=int, default=300)
    ap.add_argument("--mc", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--ft-workers", type=int, default=2)
    a = ap.parse_args()
    a.datadir = str(Path(a.datadir).resolve())
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    steps = a.steps.split(",")

    for c in a.coins:
        MK[c] = fs.load(a.datadir, c)
        log(f"{c}: {len(MK[c].t15)} nến 15m, {len(MK[c].t1)} nến 1m, "
            f"{pd.Timestamp(MK[c].t15[0], tz='UTC'):%Y-%m-%d} → {pd.Timestamp(MK[c].t15[-1], tz='UTC'):%Y-%m-%d}")
    if a.bitstamp:
        bdir = out / "bitstamp"
        build_bitstamp(a.bitstamp, bdir)
        MK["BTC_BITSTAMP"] = fs.load(str(bdir), "BTC")
    end = a.end or str(data_end(MK["BTC"]).date())
    log(f"giai đoạn {START} → {end}")

    md = (f"# Kết quả kiểm tra độ bền DonchianRevert\n\nDữ liệu: data.binance.vision USDT-M perpetual, nến 15m + 1m, "
          f"funding thật, {START} → {end}. Tạo lúc {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}.\n\n")
    summary = {"end": end}
    bt, oos, ft = pd.DataFrame(), pd.DataFrame(), {}
    if "baseline" in steps:
        part, ft, bt = step_baseline(a, end)
        md += part
        summary["baseline"] = fs.stats(bt)
        summary["baseline_years"] = fs.yearly(bt)
        log("xong baseline")
    if "wf" in steps:
        md += (f"## 2. Walk-forward (train 2 năm → test 6 tháng, trượt 6 tháng, 2022-01-01 → {end})\n\n"
               "Chạy hai lần với hai hàm mục tiêu khác nhau, để kết luận không phụ thuộc vào cách chấm điểm.\n\n")
        for i, kind in enumerate(a.wf_objectives):
            part, o, rows = step_walkforward(a, end, kind)
            md += part
            summary[f"wf_oos_{kind}"] = fs.stats(o)
            summary[f"wf_params_{kind}"] = [{"test": r[0], **r[2]["best"]} for r in rows]
            if i == 0:
                oos = o
        log("xong walk-forward")
    if "sens" in steps:
        md += step_sensitivity(a, end)
        log("xong độ nhạy")
    if "cost" in steps and ft:
        md += step_costs(a, end, ft)
        summary["cost"] = fs.stats(ft["cost"]["trades"])
    if "coins" in steps and ft:
        md += step_coins(a, end, ft)
        summary["coins"] = {c: fs.stats(ft[f"coin_{c}"]["trades"]) for c in a.coins
                            if c != "BTC" and not ft.get(f"coin_{c}", {}).get("error")}
    if "mc" in steps and not bt.empty:
        md += step_montecarlo(a, bt, oos)
        log("xong Monte Carlo")
    if "capital" in steps:
        md += step_capital(end)
    (out / "result.md").write_text(md)
    (out / "result.json").write_text(json.dumps(summary, indent=1, default=float))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)


if __name__ == "__main__":
    main()
