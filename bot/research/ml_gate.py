"""
ML làm bộ lọc (gate) cho DonchianRevert — thử nghiệm walk-forward, không sửa chiến lược.

Câu hỏi: một mô hình học từ dữ liệu vị thế thật của Binance (open interest, tỉ lệ long/short, khối lượng taker,
funding) có lọc tín hiệu Donchian tốt hơn bộ lọc tay ADX/volume/ATR không?

Cách làm:
  1. Tín hiệu THÔ: Donchian pos <= dc_long hoặc >= dc_short, bỏ hết lọc ADX/volume/ATR → nhiều mẫu gấp ~10 lần.
  2. Mỗi tín hiệu thô được mô phỏng độc lập (vào giá mở nến sau, 1R = 3 ATR, SL -1R, trailing 2R/1R, nến 1m)
     → nhãn = lãi/lỗ tính theo R sau phí 0.05%/chiều.
  3. Đặc trưng tính tại lúc nến tín hiệu đóng (giá, biến động, funding, OI, long/short, taker — chỉ dữ liệu đã có).
  4. Walk-forward như robustness.py: train 2 năm → test 6 tháng, trượt 6 tháng (2022-01 → cuối dữ liệu). Mô hình
     HistGradientBoostingRegressor dự đoán R kỳ vọng; gate = dự đoán > 0. Lệnh có nhãn kết thúc sau ngày cuối train
     bị loại khỏi train (purge) để không rò rỉ.
  5. So sánh trên các đoạn test ghép lại (fastsim, 1 lệnh/lúc, rủi ro 1%):
       A. bộ lọc tay hiện tại        B. tín hiệu thô không lọc        C. ML gate, đủ đặc trưng
       D. ML gate, chỉ đặc trưng giá  E. lọc ngẫu nhiên giữ cùng tỉ lệ như C   F. lọc tay + ML gate
       G. ML gate giữ đúng tỉ lệ tín hiệu như bộ lọc tay (ngưỡng = phân vị dự đoán trên train) — so công bằng với A
  python research/ml_gate.py --datadir data/binance --out ml_gate_out
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from numba import njit
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fastsim as fs  # noqa: E402

FEE = 0.0005
START = "2020-01-03"
SEED = 20261001
RELAXED = {**fs.DEFAULTS, "adx_min": 0, "vol_max": 1e9, "atr_min_pct": 0.0}
MAX_BARS = 4 * 24 * 21                       # cắt nhãn sau 21 ngày (lệnh dài nhất trong baseline ~14 ngày)
PRICE_FEATS = ["dpos", "adx", "vol_ratio", "atr_pct", "ret_1", "ret_4", "ret_16", "ret_96", "rv_ratio",
               "atr_rel", "pos_96", "pos_672", "hour", "dow", "side", "fund_last", "fund_24h", "fund_z"]
POS_FEATS = ["oi_chg_1h", "oi_chg_4h", "oi_chg_24h", "oi_rel", "oi_val_rel", "ls_top_cnt", "ls_top_sum", "ls_all",
             "taker", "ls_top_cnt_z", "ls_top_sum_z", "ls_all_z", "taker_z", "ls_top_chg_24h", "taker_chg_24h"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- nhãn

@njit(cache=True)
def _label(idx, sides, atr, o, h, l, c, j0, j1, o1, h1, l1, r_atr, t_start, t_dist, fee, max_bars, out):
    """Mỗi tín hiệu idx[k] (nến đã đóng) mô phỏng độc lập: out[k] = (lãi theo R sau phí, số nến giữ)."""
    n = len(o)
    for k in range(len(idx)):
        i = idx[k] + 1
        side = sides[k]
        if i >= n or atr[idx[k]] <= 0:
            out[k, 0] = np.nan
            continue
        entry = o[i]
        R = atr[idx[k]] * r_atr
        peak = trough = entry
        stop = entry - R if side > 0 else entry + R
        xp = np.nan
        last = min(i + max_bars, n - 1)
        bars = 0
        for b in range(i, last + 1):
            a0, a1 = j0[b], j1[b]
            if a0 == a1:
                a0, a1 = -1, 0
            done = False
            for j in range(a0, a1):
                if j < 0:
                    bo, bh, bl = o[b], h[b], l[b]
                else:
                    bo, bh, bl = o1[j], h1[j], l1[j]
                if bh > peak:
                    peak = bh
                if bl < trough:
                    trough = bl
                if side > 0:
                    if stop < bl:
                        ns = entry - R
                        if peak >= entry + t_start * R:
                            ns = max(ns, peak - t_dist * R)
                        if ns > stop:
                            stop = ns
                    if stop >= bl:
                        xp = bo if stop > bh else stop
                        done = True
                else:
                    if stop > bh:
                        ns = entry + R
                        if trough <= entry - t_start * R:
                            ns = min(ns, trough + t_dist * R)
                        if ns < stop:
                            stop = ns
                    if stop <= bh:
                        xp = bo if stop < bl else stop
                        done = True
                if done:
                    break
            bars = b - i + 1
            if done:
                break
        if np.isnan(xp):
            xp = c[last]
        out[k, 0] = (side * (xp - entry) - fee * (entry + xp)) / R
        out[k, 1] = bars


def label_signals(mk: fs.Market, sig: np.ndarray, p: dict) -> pd.DataFrame:
    idx = np.where(sig != 0)[0]
    sides = sig[idx].astype(np.int64)
    out = np.zeros((len(idx), 2))
    _label(idx, sides, mk.atr, mk.o, mk.h, mk.l, mk.c, mk.j0, mk.j1, mk.o1, mk.h1, mk.l1,
           float(p["r_atr"]), float(p["trail_start_r"]), float(p["trail_dist_r"]), FEE, MAX_BARS, out)
    t = pd.DataFrame({"i": idx, "side": sides, "ret_r": out[:, 0], "bars": out[:, 1]})
    t["date"] = pd.to_datetime(mk.t15[idx], utc=True)                       # giờ mở nến tín hiệu
    t["exit_date"] = pd.to_datetime(mk.t15[np.minimum(idx + 1 + t.bars.astype(int), len(mk.t15) - 1)], utc=True)
    return t.dropna(subset=["ret_r"]).reset_index(drop=True)


# ---------------------------------------------------------------- đặc trưng

def zscore(s: pd.Series, w: int) -> pd.Series:
    return (s - s.rolling(w).mean()) / s.rolling(w).std()


def features(mk: fs.Market, datadir: str, base: str) -> pd.DataFrame:
    """Một dòng mỗi nến 15m, chỉ dùng dữ liệu có sẵn khi nến đóng (giờ đóng = t15 + 15 phút)."""
    t = pd.to_datetime(mk.t15, utc=True)
    close = pd.Series(mk.c)
    lr = np.log(close).diff()
    f = pd.DataFrame({"date": t, "dpos": mk.dpos, "adx": mk.adx, "vol_ratio": mk.vol_ratio, "atr_pct": mk.atr_pct})
    for n in (1, 4, 16, 96):
        f[f"ret_{n}"] = np.log(close / close.shift(n))
    f["rv_ratio"] = np.log(lr.rolling(96).std() / lr.rolling(672).std())
    f["atr_rel"] = pd.Series(mk.atr_pct) / pd.Series(mk.atr_pct).rolling(2880).mean()
    for n in (96, 672):
        hh, ll = pd.Series(mk.h).rolling(n).max(), pd.Series(mk.l).rolling(n).min()
        f[f"pos_{n}"] = (close - ll) / (hh - ll)
    f["hour"] = t.hour
    f["dow"] = t.dayofweek
    close_t = pd.Series(t + pd.Timedelta(minutes=15))                  # giờ đóng nến, tz-aware

    d = Path(datadir) / "futures"
    fr = pd.read_feather(d / f"{base}_USDT_USDT-1h-funding_rate.feather")
    fr = fr[fr.open != 0][["date", "open"]].rename(columns={"open": "rate"}).sort_values("date")
    fr["date"] = fr.date.astype("datetime64[ns, UTC]")
    fr["fund_24h"] = fr.rate.rolling(3).mean()
    fr["fund_z"] = zscore(fr.rate, 90)
    fr = fr.rename(columns={"rate": "fund_last"})
    f = pd.merge_asof(f.assign(_t=close_t), fr, left_on="_t", right_on="date", suffixes=("", "_fr"),
                      allow_exact_matches=False).drop(columns=["date_fr", "_t"])

    mp = d / f"{base}_USDT_USDT-5m-metrics.feather"
    if mp.exists():
        m = pd.read_feather(mp).sort_values("date")
        m["date"] = m.date.astype("datetime64[ns, UTC]")
        oi = m.sum_open_interest
        g = pd.DataFrame({"date": m.date})
        for n, lab in ((12, "1h"), (48, "4h"), (288, "24h")):
            g[f"oi_chg_{lab}"] = np.log(oi / oi.shift(n))
        g["oi_rel"] = oi / oi.rolling(288 * 30).mean()
        g["oi_val_rel"] = m.sum_open_interest_value / m.sum_open_interest_value.rolling(288 * 30).mean()
        g["ls_top_cnt"] = m.count_toptrader_long_short_ratio
        g["ls_top_sum"] = m.sum_toptrader_long_short_ratio
        g["ls_all"] = m.count_long_short_ratio
        g["taker"] = m.sum_taker_long_short_vol_ratio
        for c in ("ls_top_cnt", "ls_top_sum", "ls_all", "taker"):
            g[f"{c}_z"] = zscore(g[c], 288 * 7)
        g["ls_top_chg_24h"] = np.log(g.ls_top_sum / g.ls_top_sum.shift(288))
        g["taker_chg_24h"] = np.log(g.taker / g.taker.shift(288))
        # metrics tại T mô tả trạng thái lúc T; chỉ dùng mốc ≤ giờ đóng nến − 5 phút để chừa độ trễ công bố
        f = pd.merge_asof(f.assign(_t=close_t - pd.Timedelta(minutes=5)), g, left_on="_t", right_on="date",
                          suffixes=("", "_m")).drop(columns=["date_m", "_t"])
        log(f"metrics: {len(m)} dòng, {m.date.iloc[0]:%Y-%m-%d} → {m.date.iloc[-1]:%Y-%m-%d}")
    else:
        for c in POS_FEATS:
            f[c] = np.nan
        log("không có file metrics → đặc trưng vị thế toàn NaN (C và D sẽ giống nhau)")
    return f


# ---------------------------------------------------------------- walk-forward

def windows(end: str) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    out, t = [], pd.Timestamp("2022-01-01", tz="UTC")
    e = pd.Timestamp(end, tz="UTC")
    while t < e:
        out.append((t, min(t + pd.DateOffset(months=6), e)))
        t += pd.DateOffset(months=6)
    return out


class Model:
    """HistGradientBoosting trên các cột có dữ liệu (cột toàn NaN trong train bị bỏ, ví dụ metrics trước 12/2021)."""

    def __init__(self, X: pd.DataFrame, y: np.ndarray, seed: int):
        self.cols = [c for c in X.columns if X[c].notna().sum() >= 100]
        self.m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.03, max_depth=4, min_samples_leaf=40,
                                               l2_regularization=1.0, random_state=seed)
        self.m.fit(X[self.cols], np.clip(y, -1.5, 6.0))

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self.m.predict(X[self.cols])

    def fit(self, X, y):                        # cho permutation_importance
        return self

    def score(self, X, y):
        return -float(np.mean((self.predict(X) - y) ** 2))


def gated_sig(mk: fs.Market, lab: pd.DataFrame, keep: np.ndarray) -> np.ndarray:
    s = np.zeros(len(mk.t15), dtype=np.int8)
    rows = lab[keep]
    s[rows.i.to_numpy()] = rows.side.to_numpy()
    return s


def run_sig(mk, sig, s, e):
    return fs.run(mk, RELAXED, str(s.date()), str(e.date()), fee=FEE, sig=sig)


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


def row(name, t):
    s = fs.stats(t)
    y = " · ".join(f"{k}: {v:+.1f}" for k, v in fs.yearly(t).items())
    return f"| {name} | {s['profit']:+.1f}% | {s['dd']:.1f}% | {s['pf']:.2f} | {s['trades']} | {s['win']:.0f}% | {y} |\n"


HDR = "| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm (% vốn đầu năm) |\n|---|---|---|---|---|---|---|\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datadir", default="data/binance")
    ap.add_argument("--pair", default="BTC")
    ap.add_argument("--end")
    ap.add_argument("--out", default="ml_gate_out")
    ap.add_argument("--random-seeds", type=int, default=20)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    mk = fs.load(a.datadir, a.pair)
    end = a.end or str(pd.Timestamp(mk.t15[-1], tz="UTC").floor("D").date())
    log(f"{a.pair}: {len(mk.t15)} nến 15m → {end}")

    raw = fs.signals(mk, RELAXED)
    hand = fs.signals(mk, fs.DEFAULTS)
    lab = label_signals(mk, raw, RELAXED)
    lab["hand"] = hand[lab.i.to_numpy()] != 0
    feats = features(mk, a.datadir, a.pair)
    lab = lab.join(feats.drop(columns=["date"]).iloc[lab.i.to_numpy()].reset_index(drop=True))
    lab["side"] = lab.side.astype(float)
    all_feats = PRICE_FEATS + POS_FEATS
    log(f"tín hiệu thô {len(lab)} (tay {lab.hand.sum()}), nhãn trung bình {lab.ret_r.mean():+.3f} R, "
        f"thắng {100 * (lab.ret_r > 0).mean():.0f}%; tay: {lab[lab.hand].ret_r.mean():+.3f} R")

    ws = windows(end)
    parts = {k: [] for k in "ABCDEFG"}
    per = []
    imp_acc = pd.Series(0.0, index=all_feats)
    for wi, (s, e) in enumerate(ws):
        tr0 = max(pd.Timestamp(START, tz="UTC"), s - pd.DateOffset(years=2))
        train = lab[(lab.date >= tr0) & (lab.exit_date < s)]                    # purge: nhãn phải đóng trước test
        test = lab[(lab.date >= s) & (lab.date < e)]
        if len(train) < 200 or test.empty:
            continue
        mC = Model(train[all_feats], train.ret_r.to_numpy(), SEED + wi)
        mD = Model(train[PRICE_FEATS], train.ret_r.to_numpy(), SEED + wi)
        pC = pd.Series(mC.predict(test[all_feats]), index=test.index)
        pD = pd.Series(mD.predict(test[PRICE_FEATS]), index=test.index)
        keepC, keepD = pC > 0, pD > 0
        frac = keepC.mean()
        hand_frac = train.hand.mean()
        thr = np.quantile(mC.predict(train[all_feats]), 1 - hand_frac)
        keepG = pC > thr
        pi = permutation_importance(mC, test[all_feats], np.clip(test.ret_r, -1.5, 6).to_numpy(), n_repeats=5,
                                    random_state=SEED)
        imp_acc += pd.Series(pi.importances_mean, index=all_feats)

        tA = fs.run(mk, fs.DEFAULTS, str(s.date()), str(e.date()), fee=FEE)
        tB = run_sig(mk, raw, s, e)
        tC = run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[keepC])), s, e)
        tD = run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[keepD])), s, e)
        tF = run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[keepC & test.hand])), s, e)
        tG = run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[keepG])), s, e)
        rnd = []
        for _ in range(a.random_seeds):
            kr = rng.random(len(test)) < frac
            rnd.append(fs.stats(run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[kr])), s, e))["profit"])
        tE = run_sig(mk, gated_sig(mk, lab, lab.index.isin(test.index[rng.random(len(test)) < frac])), s, e)
        for k, t in zip("ABCDEFG", (tA, tB, tC, tD, tE, tF, tG)):
            parts[k].append(t)
        # chất lượng dự đoán ngoài mẫu: tương quan hạng dự đoán ↔ R thật, R trung bình nhóm giữ/bỏ
        ic = pd.Series(pC.values).corr(pd.Series(test.ret_r.values), method="spearman")
        per.append({"test": f"{s:%Y-%m}→{e:%Y-%m}", "n_train": len(train), "n_test": len(test), "keep": frac,
                    "ic": ic, "r_keep": test.ret_r[keepC].mean(), "r_drop": test.ret_r[~keepC].mean(),
                    "r_hand": test.ret_r[test.hand].mean(), "A": fs.stats(tA)["profit"], "B": fs.stats(tB)["profit"],
                    "C": fs.stats(tC)["profit"], "D": fs.stats(tD)["profit"], "E_mean": float(np.mean(rnd)),
                    "E_p90": float(np.percentile(rnd, 90)), "F": fs.stats(tF)["profit"],
                    "G": fs.stats(tG)["profit"], "keepG": float(keepG.mean()), "r_G": test.ret_r[keepG].mean()})
        log(f"{per[-1]['test']}: train {len(train)} test {len(test)} giữ {frac:.0%} IC {ic:+.2f} "
            f"A {per[-1]['A']:+.1f} B {per[-1]['B']:+.1f} C {per[-1]['C']:+.1f} D {per[-1]['D']:+.1f} "
            f"E {per[-1]['E_mean']:+.1f} F {per[-1]['F']:+.1f} G {per[-1]['G']:+.1f}")

    ch = {k: chain(v) for k, v in parts.items()}
    o0, o1 = f"{ws[0][0]:%Y-%m-%d}", end
    md = (f"# ML gate cho DonchianRevert — walk-forward {o0} → {o1}\n\n"
          f"Dữ liệu {a.pair}USDT perpetual (data.binance.vision), nến 15m + 1m, funding thật; metrics OI/long-short/taker 5m. "
          f"fastsim, phí 0.05%/chiều, rủi ro 1%/lệnh, 1 lệnh/lúc. Tạo lúc {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}.\n\n"
          f"Tín hiệu thô {len(lab)} (dc_long/dc_short không lọc), trong đó bộ lọc tay giữ {lab.hand.sum()}. Nhãn: lãi theo R "
          f"sau phí khi mô phỏng độc lập từng tín hiệu. Trung bình thô {lab.ret_r.mean():+.3f} R, "
          f"tay {lab[lab.hand].ret_r.mean():+.3f} R.\n\n"
          "## Kết quả ghép các đoạn test\n\n" + HDR)
    names = {"A": "A. Bộ lọc tay hiện tại (ADX/volume/ATR)", "B": "B. Tín hiệu thô, không lọc",
             "C": "**C. ML gate, đủ đặc trưng (giá + funding + OI/long-short/taker)**",
             "D": "D. ML gate, chỉ đặc trưng giá + funding", "E": "E. Lọc ngẫu nhiên, cùng tỉ lệ giữ như C (1 lần)",
             "F": "F. Lọc tay + ML gate", "G": "G. ML gate giữ cùng tỉ lệ tín hiệu như bộ lọc tay"}
    for k in "ABCDEFG":
        md += row(names[k], ch[k])
    pt = pd.DataFrame(per)
    md += ("\n## Từng đoạn test (lãi %)\n\n| Test | Train | Test | Giữ | IC | R giữ | R bỏ | R tay | A tay | B thô | C ML | D ML giá "
           "| E ngẫu nhiên TB (p90) | F tay+ML | G ML cùng tỉ lệ (giữ, R) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    for r in per:
        md += (f"| {r['test']} | {r['n_train']} | {r['n_test']} | {r['keep']:.0%} | {r['ic']:+.2f} | {r['r_keep']:+.2f} | "
               f"{r['r_drop']:+.2f} | {r['r_hand']:+.2f} | {r['A']:+.1f} | {r['B']:+.1f} | {r['C']:+.1f} | {r['D']:+.1f} | "
               f"{r['E_mean']:+.1f} ({r['E_p90']:+.1f}) | {r['F']:+.1f} | {r['G']:+.1f} ({r['keepG']:.0%}, {r['r_G']:+.2f}) |\n")
    md += (f"\nIC (Spearman giữa dự đoán và R thật ngoài mẫu) trung bình {pt.ic.mean():+.3f}, dương ở {(pt.ic > 0).sum()}/{len(pt)} "
           f"đoạn. C hơn A ở {(pt.C > pt.A).sum()}/{len(pt)} đoạn, hơn ngẫu nhiên trung bình ở {(pt.C > pt.E_mean).sum()}/{len(pt)}, "
           f"vượt p90 ngẫu nhiên ở {(pt.C > pt.E_p90).sum()}/{len(pt)}. C hơn D (giá-only) ở {(pt.C > pt.D).sum()}/{len(pt)}. "
           f"G (cùng tỉ lệ giữ như tay) hơn A ở {(pt.G > pt.A).sum()}/{len(pt)} đoạn; R trung bình lệnh G {pt.r_G.mean():+.3f} "
           f"so với tay {pt.r_hand.mean():+.3f}.\n\n")
    imp = (imp_acc / max(len(per), 1)).sort_values(ascending=False)
    md += "## Độ quan trọng đặc trưng (permutation, MSE ngoài mẫu, trung bình các đoạn)\n\n| Đặc trưng | Tăng MSE khi xáo |\n|---|---|\n"
    md += "".join(f"| {k} | {v:+.4f} |\n" for k, v in imp.head(15).items())
    md += ("\nGiá trị ≤ 0 nghĩa là xáo đặc trưng đó không làm dự đoán ngoài mẫu tệ hơn: mô hình không dùng được nó.\n")
    (out / "result.md").write_text(md)
    pt.to_csv(out / "per_window.csv", index=False)
    (out / "summary.json").write_text(json.dumps({k: fs.stats(v) for k, v in ch.items()}, indent=1, default=float))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)


if __name__ == "__main__":
    main()
