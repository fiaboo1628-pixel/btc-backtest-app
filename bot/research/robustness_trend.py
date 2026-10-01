"""
Kiểm tra độ bền TrendBreakout (4h, breakout kênh Donchian 2 chiều, danh mục nhiều coin) trên dữ liệu Binance perpetual
thật — cùng bộ kiểm tra như robustness.py cho DonchianRevert, thêm phần ghép hai chiến lược trên một tài khoản.

  python research/binance_vision.py --pairs BTC ETH SOL BNB XRP DOGE ADA LINK AVAX LTC --tf 15m 4h --start 2020-01 --end 2026-08 --out data/binance
  python research/binance_vision.py --pairs BTC --tf 1m --start 2020-01 --end 2026-08 --out data/binance   # cho DonchianRevert
  python research/robustness_trend.py --datadir data/binance --out robustness_trend_out

Các bước (nến chi tiết 15m, phí 0.05%/chiều, rủi ro 0.5%/lệnh, đòn bẩy cố định x5, mỗi coin 1 lệnh):
  0. Đối chiếu fastsim_trend với freqtrade trên danh mục
  1. Baseline tham số mặc định (20/10, không EMA) và cấu hình tốt nhất của nghiên cứu cũ (20/10 + EMA200); lãi theo coin
  2. Walk-forward: tối ưu entry_period, exit_period, r_atr, ema_filter trên 2 năm → test 6 tháng, trượt 6 tháng
  3. Độ nhạy ±20% từng tham số, bảng entry×exit và r_atr×entry
  4. Chi phí xấu: 0.07% + trượt 0.02%
  5. Từng coin riêng và bỏ-một-coin
  6. Monte Carlo xáo lệnh, bootstrap năm
  7. Ghép với DonchianRevert BTC (tương quan tháng, DD tài khoản chung)
"""
import argparse
import json
import multiprocessing as mp
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fastsim as fs  # noqa: E402
import fastsim_trend as ft  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STRAT = ROOT / "user_data" / "strategies" / "TrendBreakout.py"
FEE = 0.0005
RISK = 0.5
START = "2020-04-01"                 # 500 nến 4h khởi động từ 2020-01-01
SEED = 20261001
COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK", "AVAX", "LTC"]
EMA_CFG = {**ft.DEFAULTS, "ema_filter": 1}
U: dict = {}                         # dữ liệu dùng chung cho tiến trình con (fork)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ctx():
    return mp.get_context("fork")


# ---------------------------------------------------------------- freqtrade

def ft_params(p: dict) -> dict:
    return {"buy": {"entry_period": int(p["entry_period"]), "ema_filter": bool(p["ema_filter"])},
            "sell": {"exit_period": int(p["exit_period"]), "r_atr": float(p["r_atr"]), "risk_pct": RISK,
                     "fixed_lev": True}}


def freqtrade(coins, params, timerange, fee, datadir, tag):
    work = Path(tempfile.mkdtemp(prefix=f"rt_{tag}_"))
    sdir = work / "strategies"
    sdir.mkdir()
    shutil.copy(STRAT, sdir)
    (sdir / "TrendBreakout.json").write_text(json.dumps({"strategy_name": "TrendBreakout", "params": params}))
    cfg = json.loads((ROOT / "cfg_fut.json").read_text())
    cfg["exchange"]["pair_whitelist"] = [f"{p}/USDT:USDT" for p in coins]
    cfg.update(max_open_trades=len(coins), timeframe="4h", fee=fee, dry_run_wallet=1000.0)
    (work / "cfg.json").write_text(json.dumps(cfg))
    (work / "results").mkdir()
    cmd = [sys.executable, str(ROOT / "run_futures.py"), "backtesting", "-c", str(work / "cfg.json"),
           "--userdir", str(work), "--datadir", datadir, "--strategy-path", str(sdir), "--strategy", "TrendBreakout",
           "--timerange", timerange, "--timeframe-detail", "15m", "--export", "trades",
           "--backtest-directory", str(work / "results"), "--cache", "none"]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    zips = sorted((work / "results").glob("*.zip"))
    if r.returncode or not zips:
        print(r.stdout[-3000:], r.stderr[-3000:], file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)
        return {"tag": tag, "error": True}
    with zipfile.ZipFile(zips[-1]) as z:
        name = next(n for n in z.namelist() if n.endswith(".json") and "config" not in n)
        res = json.load(z.open(name))["strategy"]["TrendBreakout"]
    shutil.rmtree(work, ignore_errors=True)
    t = pd.DataFrame(res["trades"])
    if len(t):
        t["open_date"] = pd.to_datetime(t.open_date, utc=True).astype("datetime64[ns, UTC]")
        t["close_date"] = pd.to_datetime(t.close_date, utc=True).astype("datetime64[ns, UTC]")
        t = t.sort_values("close_date").reset_index(drop=True)
        t["equity_before"] = 1000 + t.profit_abs.cumsum() - t.profit_abs
        t["ret"] = t.profit_abs / t.equity_before
        t["pair"] = t.pair.str.split("/").str[0]
    log(f"freqtrade {tag}: {len(t)} lệnh, {res['profit_total'] * 100:+.1f}% ({time.time() - t0:.0f}s)")
    return {"tag": tag, "trades": t, "ft_profit": res["profit_total"] * 100, "ft_dd": res["max_drawdown_account"] * 100,
            "ft_pf": res.get("profit_factor") or 0}


def ft_job(a):
    return freqtrade(*a)


# ---------------------------------------------------------------- tiện ích

HDR = "| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm (% vốn đầu năm) |\n|---|---|---|---|---|---|---|\n"


def row(name, t, extra=""):
    s = fs.stats(t)
    y = " · ".join(f"{k}: {v:+.0f}" for k, v in fs.yearly(t).items())
    return f"| {name} | {s['profit']:+.1f}% | {s['dd']:.1f}% | {s['pf']:.2f} | {s['trades']} | {s['win']:.0f}% | {y} |{extra}\n"


def cagr(t, start, end):
    yrs = (pd.Timestamp(end, tz="UTC") - pd.Timestamp(start, tz="UTC")).days / 365.25
    return 100 * ((1 + fs.stats(t)["profit"] / 100) ** (1 / yrs) - 1) if len(t) else 0.0


def chain(parts):
    rows, eq = [], 1000.0
    for t in parts:
        if t.empty:
            continue
        t = t.copy()
        sc = eq / 1000.0
        t["profit_abs"] *= sc
        t["equity_before"] *= sc
        eq += t.profit_abs.sum()
        rows.append(t)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=["profit_abs", "close_date", "equity_before"])


def run(p, s, e, **kw):
    return ft.run(U["u"], p, s, e, fee=kw.pop("fee", FEE), risk_pct=RISK, **kw)


def monthly(t: pd.DataFrame, months) -> pd.Series:
    if t.empty:
        return pd.Series(0.0, index=months)
    m = t.close_date.dt.tz_localize(None).dt.to_period("M")
    return t.groupby(m).profit_abs.sum().reindex(months, fill_value=0.0)


# ---------------------------------------------------------------- 0 + 1

def step_baseline(a, end):
    tr = f"{START.replace('-', '')}-{end.replace('-', '')}"
    jobs = [(a.coins, ft_params(ft.DEFAULTS), tr, FEE, a.datadir, "baseline"),
            (a.coins, ft_params(EMA_CFG), tr, FEE, a.datadir, "ema"),
            (a.coins, ft_params(ft.DEFAULTS), tr, 0.0009, a.datadir, "cost")]
    with ProcessPoolExecutor(a.ft_workers, mp_context=ctx()) as ex:
        R = {r["tag"]: r for r in ex.map(ft_job, jobs)}
    bt = R["baseline"]["trades"]
    sim = run(ft.DEFAULTS, START, end)
    m = bt.merge(sim, on=["pair", "open_date"], how="outer", suffixes=("_ft", "_sim"), indicator=True)
    both = m[m._merge == "both"]
    md = "## 0. Đối chiếu bộ mô phỏng nhanh với freqtrade (danh mục, tham số mặc định 20/10, phí 0.05%)\n\n" + HDR
    md += row("freqtrade", bt) + row("fastsim_trend", sim)
    md += (f"\nLệnh trùng coin + giờ vào: {len(both)}/{len(bt)} (freqtrade) — {len(sim)} (fastsim); trong số trùng "
           f"{100 * (both.close_date_ft == both.close_date_sim).mean():.1f}% trùng giờ ra, chênh lãi trung bình "
           f"{np.abs(both.profit_abs_ft - both.profit_abs_sim).mean():.2f} USDT/lệnh. freqtrade tự báo lãi "
           f"{R['baseline']['ft_profit']:+.1f}%, DD {R['baseline']['ft_dd']:.1f}%, PF {R['baseline']['ft_pf']:.2f}.\n\n")

    md += (f"## 1. Baseline — danh mục {' '.join(a.coins)} ({START} → {end})\n\n"
           f"freqtrade, 4h + chi tiết 15m, phí 0.05%/chiều, funding thật, vốn 1 000 USDT, rủi ro {RISK}%/lệnh, đòn bẩy x5, "
           "mỗi coin tối đa 1 lệnh.\n\n" + HDR)
    md += row("Mặc định: kênh 20/10, không EMA", bt)
    md += row("Kênh 20/10 + EMA200 (tốt nhất nghiên cứu cũ)", R["ema"]["trades"])
    md += f"\nLãi kép bình quân năm: mặc định {cagr(bt, START, end):+.1f}%/năm, +EMA200 {cagr(R['ema']['trades'], START, end):+.1f}%/năm.\n\n"
    md += "| Coin | Lệnh | Lãi USDT (mặc định) | Thắng | Lệnh | Lãi USDT (+EMA200) |\n|---|---|---|---|---|---|\n"
    for c in a.coins:
        g, ge = bt[bt.pair == c], R["ema"]["trades"][R["ema"]["trades"].pair == c]
        md += (f"| {c} | {len(g)} | {g.profit_abs.sum():+.0f} | {100 * (g.profit_abs > 0).mean() if len(g) else 0:.0f}% | "
               f"{len(ge)} | {ge.profit_abs.sum():+.0f} |\n")
    md += f"\nLong {bt[~bt.is_short].profit_abs.sum():+.0f} USDT ({(~bt.is_short).sum()} lệnh), Short {bt[bt.is_short].profit_abs.sum():+.0f} USDT ({bt.is_short.sum()} lệnh). Funding cộng dồn {bt.funding_fees.sum():+.0f} USDT.\n\n"
    return md, R, bt


# ---------------------------------------------------------------- 2: walk-forward

OBJ = {"calmar": "lãi % / max(DD %, 5)", "profit": "tổng lãi %"}


def objective(t, min_trades, kind):
    s = fs.stats(t)
    if s["trades"] < min_trades:
        return -1e6 + s["trades"]
    if kind == "profit":
        return s["profit"]
    return s["profit"] / max(s["dd"], 5.0) if s["profit"] > 0 else s["profit"]


def sample(rng):
    return ft.clamp({k: rng.uniform(lo, hi) for k, (lo, hi, _) in ft.SPACE.items()})


def optimize(args):
    t0, t1, n_rand, n_local, min_trades, seed, kind = args
    rng = np.random.default_rng(seed)
    cand = [dict(ft.DEFAULTS), dict(EMA_CFG)] + [sample(rng) for _ in range(n_rand)]
    scored = [(objective(run(p, t0, t1), min_trades, kind), p) for p in cand]
    scored.sort(key=lambda x: -x[0])
    top = [p for _, p in scored[:10]]
    for i in range(n_local):
        b = top[i % len(top)]
        q = ft.clamp({k: v + rng.normal(0, 0.08) * (ft.SPACE[k][1] - ft.SPACE[k][0]) for k, v in b.items()})
        scored.append((objective(run(q, t0, t1), min_trades, kind), q))
    scored.sort(key=lambda x: -x[0])
    return {"best": scored[0][1], "train_stats": fs.stats(run(scored[0][1], t0, t1))}


def step_walkforward(a, end, kind):
    tests = []
    t = pd.Timestamp("2022-01-01")
    while t < pd.Timestamp(end):
        tests.append((t, min(t + pd.DateOffset(months=6), pd.Timestamp(end))))
        t += pd.DateOffset(months=6)
    jobs = [(str(max(pd.Timestamp(START), s - pd.DateOffset(years=2)).date()), str(s.date()), a.wf_rand, a.wf_local,
             a.wf_min_trades, SEED + i, kind) for i, (s, _) in enumerate(tests)]
    log(f"walk-forward {kind}: {len(jobs)} cửa sổ × {a.wf_rand + a.wf_local + 2}")
    with ProcessPoolExecutor(a.workers, mp_context=ctx()) as ex:
        opt = list(ex.map(optimize, jobs))
    oos, dflt, ema, rows, ftjobs = [], [], [], [], []
    for (s, e), o in zip(tests, opt):
        s_, e_ = str(s.date()), str(e.date())
        to, td, te = run(o["best"], s_, e_), run(ft.DEFAULTS, s_, e_), run(EMA_CFG, s_, e_)
        oos.append(to)
        dflt.append(td)
        ema.append(te)
        rows.append((s_, e_, o, fs.stats(to), fs.stats(td), fs.stats(te)))
        ftjobs.append((a.coins, ft_params(o["best"]), f"{s_.replace('-', '')}-{e_.replace('-', '')}", FEE, a.datadir,
                       f"wf_{kind}_{s_}"))
    ftres = []
    if kind == a.wf_objectives[0]:
        with ProcessPoolExecutor(a.ft_workers, mp_context=ctx()) as ex:
            ftres = list(ex.map(ft_job, ftjobs))
    oos_c, dflt_c, ema_c = chain(oos), chain(dflt), chain(ema)
    o0 = str(tests[0][0].date())
    md = (f"### Hàm mục tiêu: {OBJ[kind]}\n\nMỗi cửa sổ train: {a.wf_rand} bộ ngẫu nhiên + {a.wf_local} bộ tinh chỉnh quanh top 10 "
          f"(entry_period 10–100, exit_period 5–50, r_atr 1–6, EMA200 bật/tắt), cần ≥ {a.wf_min_trades} lệnh. Bộ tốt nhất chạy "
          "trên 6 tháng ngay sau. Kết quả test ghép lãi kép.\n\n" + HDR)
    md += row("**Walk-forward OOS (fastsim)**", oos_c)
    if ftres:
        md += row("Walk-forward OOS (freqtrade, cùng tham số)", chain([r["trades"] for r in ftres if not r.get("error")]))
    md += row("Mặc định 20/10, cùng giai đoạn", dflt_c)
    md += row("20/10 + EMA200, cùng giai đoạn", ema_c)
    md += (f"\nLãi kép năm: walk-forward {cagr(oos_c, o0, end):+.1f}% · mặc định {cagr(dflt_c, o0, end):+.1f}% · "
           f"+EMA200 {cagr(ema_c, o0, end):+.1f}%.\n\n")
    md += ("| Test | Train lãi/DD | Test WF lãi/DD/lệnh | Test mặc định | Test +EMA200 | entry | exit | r_atr | EMA |\n"
           "|---|---|---|---|---|---|---|---|---|\n")
    for s_, e_, o, so, sd, se in rows:
        b, ts = o["best"], o["train_stats"]
        md += (f"| {s_[:7]}→{e_[:7]} | {ts['profit']:+.0f}% / {ts['dd']:.0f}% | {so['profit']:+.1f}% / {so['dd']:.1f}% / {so['trades']} | "
               f"{sd['profit']:+.1f}% / {sd['dd']:.1f}% | {se['profit']:+.1f}% / {se['dd']:.1f}% | {b['entry_period']} | "
               f"{b['exit_period']} | {b['r_atr']} | {'bật' if b['ema_filter'] else 'tắt'} |\n")
    n_pos = sum(r[3]["profit"] > 0 for r in rows)
    md += (f"\nĐoạn test có lãi: {n_pos}/{len(rows)}. WF hơn mặc định ở {sum(r[3]['profit'] > r[4]['profit'] for r in rows)}/{len(rows)}, "
           f"hơn +EMA200 ở {sum(r[3]['profit'] > r[5]['profit'] for r in rows)}/{len(rows)}. Train trung bình "
           f"{np.mean([r[2]['train_stats']['profit'] for r in rows]):+.0f}%/2 năm so với test {np.mean([r[3]['profit'] for r in rows]):+.1f}%/6 tháng.\n\n")
    return md, oos_c, rows


# ---------------------------------------------------------------- 3: độ nhạy

def step_sensitivity(a, end):
    base = fs.stats(run(ft.DEFAULTS, START, end))
    md = (f"## 3. Độ nhạy tham số (danh mục, {START} → {end}, fastsim, phí 0.05%)\n\nBaseline 20/10 không EMA: "
          f"{base['profit']:+.1f}% | DD {base['dd']:.1f}% | PF {base['pf']:.2f} | {base['trades']} lệnh.\n\n"
          "| Tham số | −20% | Lãi / DD / PF | +20% | Lãi / DD / PF |\n|---|---|---|---|---|\n")
    for k in ("entry_period", "exit_period", "r_atr"):
        cells = []
        for f in (0.8, 1.2):
            p = ft.clamp({**ft.DEFAULTS, k: ft.DEFAULTS[k] * f})
            s = fs.stats(run(p, START, end))
            cells += [str(p[k]), f"{s['profit']:+.0f}% / {s['dd']:.0f}% / {s['pf']:.2f}"]
        md += f"| {k} | " + " | ".join(cells) + " |\n"
    s = fs.stats(run(EMA_CFG, START, end))
    md += f"| ema_filter | tắt | {base['profit']:+.0f}% / {base['dd']:.0f}% / {base['pf']:.2f} | bật | {s['profit']:+.0f}% / {s['dd']:.0f}% / {s['pf']:.2f} |\n"
    rng = np.random.default_rng(SEED)
    res = []
    for _ in range(a.sens_joint):
        p = ft.clamp({**ft.DEFAULTS, **{k: ft.DEFAULTS[k] * rng.uniform(0.8, 1.2) for k in ("entry_period", "exit_period", "r_atr")},
                      "ema_filter": int(rng.random() < 0.5)})
        res.append(fs.stats(run(p, START, end)))
    pr = np.array([r["profit"] for r in res])
    md += (f"\nLệch đồng thời 3 tham số ±20% + EMA ngẫu nhiên ({a.sens_joint} lần): lãi p5/p50/p95 = {np.percentile(pr, 5):+.0f}% / "
           f"{np.percentile(pr, 50):+.0f}% / {np.percentile(pr, 95):+.0f}%, có lãi {100 * (pr > 0).mean():.0f}%, "
           f"DD p95 {np.percentile([r['dd'] for r in res], 95):.0f}%.\n\n")

    def grid(kx, xs, ky, ys, title, base_p):
        out = f"### {title}\n\nÔ: tổng lãi % / max DD %. **Đậm** = mặc định.\n\n| {ky} \\ {kx} | " + " | ".join(map(str, xs)) + \
              " |\n|---|" + "---|" * len(xs) + "\n"
        for y in ys:
            out += f"| {y} |"
            for x in xs:
                p = ft.clamp({**base_p, kx: x, ky: y})
                s = fs.stats(run(p, START, end))
                c = f"{s['profit']:+.0f} / {s['dd']:.0f}"
                out += f" **{c}** |" if (x == ft.DEFAULTS[kx] and y == ft.DEFAULTS[ky]) else f" {c} |"
            out += "\n"
        return out + "\n"

    md += grid("entry_period", [10, 15, 20, 30, 40, 55, 70, 100], "exit_period", [5, 7, 10, 15, 20, 27, 35],
               "entry_period × exit_period (không EMA)", ft.DEFAULTS)
    md += grid("entry_period", [10, 15, 20, 30, 40, 55, 70, 100], "r_atr", [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
               "entry_period × r_atr (không EMA, exit = 10)", ft.DEFAULTS)
    return md


# ---------------------------------------------------------------- 4: chi phí

def step_costs(a, end, R):
    md = f"## 4. Chi phí xấu (danh mục, {START} → {end})\n\n" + HDR
    md += row("freqtrade, phí 0.05% (baseline)", R["baseline"]["trades"])
    md += row("freqtrade, phí 0.09% (= 0.07% + trượt 0.02%)", R["cost"]["trades"])
    md += row("fastsim, phí 0.07% + trượt 0.02% trên giá", run(ft.DEFAULTS, START, end, fee=0.0007, slip=0.0002))
    md += "\nfastsim, lãi tổng % (PF) theo phí × trượt giá mỗi chiều:\n\n| Phí \\ trượt | 0 | 0.02% | 0.05% | 0.10% |\n|---|---|---|---|---|\n"
    for fee in (0.0002, 0.00035, 0.0005, 0.0007, 0.001):
        md += f"| {fee * 100:.3f}% |"
        for slip in (0, 0.0002, 0.0005, 0.001):
            s = fs.stats(run(ft.DEFAULTS, START, end, fee=fee, slip=slip))
            md += f" {s['profit']:+.0f}% ({s['pf']:.2f}) |"
        md += "\n"
    return md + "\n"


# ---------------------------------------------------------------- 5: coin

def step_coins(a, end):
    u = U["u"]
    md = f"## 5. Từng coin riêng và bỏ-một-coin ({START} → {end}, fastsim, mặc định 20/10, rủi ro {RISK}%/lệnh)\n\n"
    md += "| Coin | Riêng: lãi | DD | PF | Lệnh | Năm lãi | | Danh mục bỏ coin này: lãi | DD | PF |\n|---|---|---|---|---|---|---|---|---|---|\n"
    full = fs.stats(run(ft.DEFAULTS, START, end))
    for ci, c in enumerate(u.coins):
        sub = ft.Universe([c], u.t4, u.o[ci:ci + 1], u.h[ci:ci + 1], u.l[ci:ci + 1], u.c[ci:ci + 1], u.ema[ci:ci + 1],
                          u.atr[ci:ci + 1], u.do[ci:ci + 1], u.dh[ci:ci + 1], u.dl[ci:ci + 1], [u.tf[ci]], [u.fm[ci]])
        t = ft.run(sub, ft.DEFAULTS, START, end, fee=FEE, risk_pct=RISK)
        s = fs.stats(t)
        y = fs.yearly(t)
        keep = [k for k in range(len(u.coins)) if k != ci]
        rest = ft.Universe([u.coins[k] for k in keep], u.t4, u.o[keep], u.h[keep], u.l[keep], u.c[keep], u.ema[keep],
                           u.atr[keep], u.do[keep], u.dh[keep], u.dl[keep], [u.tf[k] for k in keep], [u.fm[k] for k in keep])
        r = fs.stats(ft.run(rest, ft.DEFAULTS, START, end, fee=FEE, risk_pct=RISK))
        md += (f"| {c} | {s['profit']:+.0f}% | {s['dd']:.0f}% | {s['pf']:.2f} | {s['trades']} | {sum(v > 0 for v in y.values())}/{len(y)} | | "
               f"{r['profit']:+.0f}% | {r['dd']:.0f}% | {r['pf']:.2f} |\n")
    md += f"\nDanh mục đủ {len(u.coins)} coin: {full['profit']:+.0f}% / DD {full['dd']:.0f}% / PF {full['pf']:.2f}.\n\n"
    return md


# ---------------------------------------------------------------- 6: Monte Carlo

def mc(ret, n, rng, scale=1.0):
    dds, st = [], []
    for _ in range(n):
        r = rng.permutation(ret) * scale
        eq = np.cumprod(1 + r)
        peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
        dds.append(((peak - eq) / peak).max() * 100)
        cur = best = 0
        for x in r < 0:
            cur = cur + 1 if x else 0
            best = max(best, cur)
        st.append(best)
    return np.array(dds), np.array(st)


def step_mc(a, bt, oos):
    rng = np.random.default_rng(SEED)
    md = (f"## 6. Monte Carlo ({a.mc} lần xáo thứ tự lệnh)\n\nLệnh nhiều coin chồng nhau về thời gian; xáo theo lệnh đóng "
          "nên là xấp xỉ. Lãi/lỗ mỗi lệnh giữ theo % vốn lúc đóng.\n\n"
          "| Chuỗi lệnh | Rủi ro/lệnh | DD thực tế | DD p50 | DD p95 | DD p99 | Tệ nhất |\n|---|---|---|---|---|---|---|\n")
    streak = "| Chuỗi lệnh | Số lệnh | Thắng | Chuỗi thua thực tế | p50 | p95 | P(≥15) | P(≥20) | P(≥25) |\n|---|---|---|---|---|---|---|---|---|\n"
    for name, t in [("Baseline 20/10 (freqtrade)", bt), ("Walk-forward OOS", oos)]:
        if t.empty:
            continue
        ret = (t.profit_abs / t.equity_before).to_numpy()
        eq = np.cumprod(1 + ret)
        peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
        real = ((peak - eq) / peak).max() * 100
        cur = best = 0
        for x in ret < 0:
            cur = cur + 1 if x else 0
            best = max(best, cur)
        for risk in (0.25, 0.5, 1.0):
            dds, st = mc(ret, a.mc, rng, risk / RISK)
            md += (f"| {name} | {risk}% | {f'{real:.1f}%' if risk == RISK else ''} | {np.percentile(dds, 50):.1f}% | "
                   f"{np.percentile(dds, 95):.1f}% | {np.percentile(dds, 99):.1f}% | {dds.max():.1f}% |\n")
            if risk == RISK:
                streak += (f"| {name} | {len(ret)} | {100 * (ret > 0).mean():.0f}% | {best} | {np.percentile(st, 50):.0f} | "
                           f"{np.percentile(st, 95):.0f} | {100 * (st >= 15).mean():.0f}% | {100 * (st >= 20).mean():.0f}% | "
                           f"{100 * (st >= 25).mean():.0f}% |\n")
    md += "\nChuỗi thua dài nhất:\n\n" + streak
    md += "\nBootstrap 12 tháng (rút có hoàn lại số lệnh của 1 năm, 10 000 lần):\n\n| Chuỗi lệnh | Lệnh/năm | Lãi năm p5 | p50 | p95 | P(năm lỗ) | P(lỗ > 20%) |\n|---|---|---|---|---|---|---|\n"
    for name, t in [("Baseline 20/10 (freqtrade)", bt), ("Walk-forward OOS", oos)]:
        if t.empty:
            continue
        ret = (t.profit_abs / t.equity_before).to_numpy()
        yrs = (t.close_date.max() - t.open_date.min()).days / 365.25
        n = int(round(len(ret) / yrs))
        fin = np.prod(1 + rng.choice(ret, size=(10000, n)), axis=1) - 1
        md += (f"| {name} | {n} | {100 * np.percentile(fin, 5):+.0f}% | {100 * np.percentile(fin, 50):+.0f}% | "
               f"{100 * np.percentile(fin, 95):+.0f}% | {100 * (fin < 0).mean():.0f}% | {100 * (fin < -0.2).mean():.0f}% |\n")
    return md + "\n"


# ---------------------------------------------------------------- 7: ghép DonchianRevert

def step_combo(a, end, bt):
    mk = fs.load(a.datadir, "BTC")
    rev = fs.run(mk, fs.DEFAULTS, START, end, fee=FEE, risk_pct=RISK)
    months = pd.period_range(pd.Timestamp(START).to_period("M"), pd.Timestamp(end).to_period("M"), freq="M")
    mt, mr = monthly(bt, months), monthly(rev, months)
    both = pd.concat([bt[["close_date", "open_date", "profit_abs"]], rev[["close_date", "open_date", "profit_abs"]]]).sort_values("close_date")
    both["equity_before"] = 1000 + both.profit_abs.cumsum() - both.profit_abs
    md = (f"## 7. Ghép với DonchianRevert BTC 15m trên cùng tài khoản ({START} → {end}, rủi ro {RISK}%/lệnh mỗi bên)\n\n"
          "Lãi USDT hai bên cộng vào một tài khoản 1 000 USDT (mỗi bên tính khối lượng trên vốn riêng của mình, như trend.py).\n\n" + HDR)
    md += row("TrendBreakout 20/10 (freqtrade)", bt)
    md += row("DonchianRevert BTC (fastsim)", rev)
    md += row("**Cả hai, một tài khoản**", both)
    corr = mt.corr(mr)
    md += (f"\nTương quan lãi theo tháng: {corr:+.2f}. Tháng có lãi: Trend {100 * (mt > 0).mean():.0f}%, Revert "
           f"{100 * (mr > 0).mean():.0f}%, cả hai {100 * ((mt + mr) > 0).mean():.0f}%. Tháng Revert lỗ mà Trend bù được: "
           f"{((mr < 0) & (mt + mr > 0)).sum()}/{(mr < 0).sum()}; tháng Trend lỗ mà Revert bù: {((mt < 0) & (mt + mr > 0)).sum()}/{(mt < 0).sum()}.\n\n")
    yr = pd.DataFrame({"Trend": mt.groupby(mt.index.year).sum(), "Revert": mr.groupby(mr.index.year).sum()})
    yr["Cả hai"] = yr.Trend + yr.Revert
    md += "| Năm | Trend USDT | Revert USDT | Cả hai |\n|---|---|---|---|\n"
    md += "".join(f"| {k} | {v.Trend:+.0f} | {v.Revert:+.0f} | {v['Cả hai']:+.0f} |\n" for k, v in yr.iterrows())
    return md + "\n"


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datadir", default="data/binance")
    ap.add_argument("--coins", nargs="+", default=COINS)
    ap.add_argument("--end")
    ap.add_argument("--out", default="robustness_trend_out")
    ap.add_argument("--steps", default="baseline,wf,sens,cost,coins,mc,combo")
    ap.add_argument("--wf-rand", type=int, default=1500)
    ap.add_argument("--wf-local", type=int, default=500)
    ap.add_argument("--wf-min-trades", type=int, default=100)
    ap.add_argument("--wf-objectives", nargs="+", default=["calmar", "profit"], choices=list(OBJ))
    ap.add_argument("--sens-joint", type=int, default=200)
    ap.add_argument("--mc", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--ft-workers", type=int, default=2)
    a = ap.parse_args()
    a.datadir = str(Path(a.datadir).resolve())
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    steps = a.steps.split(",")

    U["u"] = ft.load(a.datadir, a.coins)
    u = U["u"]
    end = a.end or str(pd.Timestamp(u.t4[-1], tz="UTC").floor("D").date())
    log(f"{len(a.coins)} coin, {len(u.t4)} nến 4h, {pd.Timestamp(u.t4[0], tz='UTC'):%Y-%m-%d} → {end}")
    md = (f"# Kết quả kiểm tra độ bền TrendBreakout\n\nDữ liệu data.binance.vision USDT-M perpetual, nến 4h + 15m, funding thật, "
          f"{START} → {end}, {len(a.coins)} coin. Tạo lúc {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}.\n\n")
    summary = {"end": end}
    bt, oos, R = pd.DataFrame(), pd.DataFrame(), {}
    if "baseline" in steps:
        part, R, bt = step_baseline(a, end)
        md += part
        summary["baseline"] = fs.stats(bt)
        log("xong baseline")
    if "wf" in steps:
        md += f"## 2. Walk-forward (train 2 năm → test 6 tháng, trượt 6 tháng, 2022-01-01 → {end})\n\n"
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
    if "cost" in steps and R:
        md += step_costs(a, end, R)
    if "coins" in steps:
        md += step_coins(a, end)
    if "mc" in steps and not bt.empty:
        md += step_mc(a, bt, oos)
    if "combo" in steps and not bt.empty:
        md += step_combo(a, end, bt)
    (out / "result.md").write_text(md)
    (out / "result.json").write_text(json.dumps(summary, indent=1, default=float))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)


if __name__ == "__main__":
    main()
