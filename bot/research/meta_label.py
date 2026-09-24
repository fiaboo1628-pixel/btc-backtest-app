"""
Meta-labeling cho DonchianRevert: dùng ML (LightGBM, hồi quy logistic) để lọc tín hiệu — có nâng được
chất lượng lệnh hay không? Kiểm tra walk-forward, so với lọc ngẫu nhiên cùng tỉ lệ.

  pip install lightgbm scikit-learn
  python research/binance_vision.py --pairs BTC --start 2020-10 --end 2026-08 --tf 1m --out user_data/data/binance
  python research/meta_label.py --data user_data/data/binance/futures/BTC_USDT_USDT-1m-futures.feather
  python research/meta_label.py --data ... --loose      # nới điều kiện vào lệnh để có nhiều tín hiệu hơn

Cách làm:
  1. Mọi tín hiệu DonchianRevert trên nến 15m (ghép từ 1m); mô phỏng từng tín hiệu độc lập trên nến 1m
     (thận trọng: kiểm tra SL trước rồi mới dời trailing), ra R thực nhận sau phí + funding.
  2. ~40 feature tại nến tín hiệu (chỉ nến đã đóng; khung 1h/4h/1D chỉ dùng nến lớn đã đóng),
     đổi dấu theo chiều lệnh.
  3. Mỗi nửa năm từ 2022: train trên tín hiệu đã ĐÓNG lệnh trước kỳ test; ngưỡng giữ lệnh lấy từ dự đoán
     out-of-fold trên tập train (giữ 50% / 70%).
  4. Mô phỏng tuần tự (1 lệnh 1 lúc, rủi ro 1%/lệnh, lãi kép), so với không lọc và 500 lần lọc ngẫu nhiên.

Kết quả (09/2026, dữ liệu Bitstamp 1m, ngoài mẫu 01/2022 → 09/2026) — ML KHÔNG giúp:
  Gốc 307 lệnh +55% DD 14.6% PF 1.24 · LightGBM giữ 70% +47% DD 12.4% PF 1.31 (hơn ngẫu nhiên 70% số lần)
  · giữ 50% +22%. Nới điều kiện (9264 tín hiệu): không lọc −53%, ML giữ 50% chỉ về +4%.
"""
import argparse
import warnings

import lightgbm as lgb
import numpy as np
import pandas as pd
import talib as ta
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

R_ATR, T_START, T_GAP = 3.0, 2.0, 1.0      # 1R = 3 ATR, trailing từ +2R, cách đỉnh 1R
FEE, FUND8H = 0.00035, 0.0001
TEST0 = pd.Timestamp("2022-01-01")
SIGNED = ["dpos", "di_diff", "trend_ema50", "trend_ema200", "ema_slope", "rsi14", "rsi2", "bb_pctb",
          "ret1_atr", "ret4_atr", "ret16_atr", "ret96_atr", "body_atr", "vwap_dist",
          "ema50_1h", "rsi_1h", "ema50_4h", "rsi_4h", "ema50_1D", "rsi_1D"]


def load_1m(path: str) -> pd.DataFrame:
    m1 = pd.read_feather(path)
    m1["date"] = pd.to_datetime(m1["date"], utc=True).dt.tz_localize(None)
    return m1.set_index("date")[["open", "high", "low", "close", "volume"]].sort_index()


def build(m1: pd.DataFrame, loose: bool) -> pd.DataFrame:
    d = m1.resample("15min").agg({"open": "first", "high": "max", "low": "min",
                                  "close": "last", "volume": "sum"}).dropna()
    o, h, l, c, v = d.open, d.high, d.low, d.close, d.volume

    # --- Tín hiệu (giống DonchianRevert.py; --loose: ADX > 20, volume < 1.5, Donchian 15%)
    adx_min, vol_max, dl, ds = (20, 1.5, 0.15, 0.85) if loose else (30, 1.0, 0.074, 0.944)
    hh, ll = h.rolling(20).max(), l.rolling(20).min()
    dpos = (c - ll) / (hh - ll)
    adx = ta.ADX(h, l, c, 14)
    volr = v / v.rolling(96).mean()
    atr = ta.ATR(h, l, c, 14)
    atrp = atr / c * 100
    common = (adx > adx_min) & (volr < vol_max) & (atrp >= 0.4) & (v > 0)
    sig = pd.Series(0, index=d.index)
    sig[common & (dpos <= dl)] = 1
    sig[common & (dpos >= ds)] = -1

    # --- Feature
    f = pd.DataFrame(index=d.index)
    f["dpos"] = dpos
    f["adx"] = adx
    f["vol_ratio"] = volr
    f["atr_pct"] = atrp
    f["atr_ratio"] = atr / ta.SMA(atr, 100)
    f["di_diff"] = ta.PLUS_DI(h, l, c, 14) - ta.MINUS_DI(h, l, c, 14)
    f["trend_ema50"] = (c - ta.EMA(c, 50)) / atr
    f["trend_ema200"] = (c - ta.EMA(c, 200)) / atr
    f["ema_slope"] = ta.EMA(c, 50).diff(4) / atr
    f["rsi14"] = ta.RSI(c, 14)
    f["rsi2"] = ta.RSI(c, 2)
    up, mid, lo = ta.BBANDS(c, 20, 2, 2)
    f["bb_pctb"] = (c - lo) / (up - lo)
    f["bb_width"] = (up - lo) / mid
    f["ch_width_atr"] = (hh - ll) / atr
    for n in (1, 4, 16, 96):
        f[f"ret{n}_atr"] = c.diff(n) / atr
    f["range_atr"] = (h - l) / atr
    f["body_atr"] = (c - o) / atr
    f["vwap_dist"] = (c - (c * v).rolling(96).sum() / v.rolling(96).sum()) / atr
    for tf in ("1h", "4h", "1D"):
        g = d.resample(tf, label="right", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
        a = ta.ATR(g.high, g.low, g.close, 14)
        t = pd.DataFrame({f"ema50_{tf}": (g.close - ta.EMA(g.close, 50)) / a,
                          f"rsi_{tf}": ta.RSI(g.close, 14),
                          f"adx_{tf}": ta.ADX(g.high, g.low, g.close, 14)})
        t.index = t.index - pd.Timedelta("15min")   # nến lớn đóng lúc X chỉ dùng từ nến 15m đóng lúc X
        f = f.join(t.reindex(f.index, method="ffill"))
    f["hour"] = d.index.hour
    f["dow"] = d.index.dayofweek
    f["sig_count16"] = (sig != 0).rolling(16).sum()

    # --- Mô phỏng từng tín hiệu trên nến 1m: vào ở giá mở nến 15m kế tiếp
    mt = m1.index.values.astype("datetime64[ms]").astype("int64")
    mo, mh, ml = m1.open.values, m1.high.values, m1.low.values
    t15 = d.index.values.astype("datetime64[ms]").astype("int64")
    rows = []
    for i in np.where(sig.values != 0)[0]:
        if i + 1 >= len(d) or i < 300:
            continue
        s = int(sig.values[i])
        j = np.searchsorted(mt, t15[i + 1])
        if j >= len(mt):
            continue
        e, r = mo[j], atr.values[i] * R_ATR
        stop, best, x = e - s * r, e, None
        while j < len(mt):
            if s == 1:
                if mo[j] <= stop: x = mo[j]
                elif ml[j] <= stop: x = stop
            else:
                if mo[j] >= stop: x = mo[j]
                elif mh[j] >= stop: x = stop
            if x is not None:
                break
            if s == 1:
                best = max(best, mh[j])
                if best >= e + T_START * r: stop = max(stop, best - T_GAP * r)
            else:
                best = min(best, ml[j])
                if best <= e - T_START * r: stop = min(stop, best + T_GAP * r)
            j += 1
        if x is None:
            x, j = mo[-1], len(mt) - 1
        hours = (mt[j] - t15[i + 1]) / 3.6e6
        row = {"time": d.index[i], "entry_t": t15[i + 1], "exit_t": int(mt[j]), "side": s,
               "R": (s * (x - e) - FEE * (e + x) - FUND8H * e * hours / 8) / r}
        for k in f.columns:
            val = f[k].values[i]
            if k in SIGNED:
                val = (val - 50) * s if k.startswith("rsi") else (
                    (val - 0.5) * s if k in ("dpos", "bb_pctb") else val * s)
            row[k] = val
        rows.append(row)
    return pd.DataFrame(rows).set_index("time")


MODELS = {
    "lgbm": lambda: lgb.LGBMClassifier(n_estimators=200, learning_rate=0.03, num_leaves=7, max_depth=3,
                                       min_child_samples=30, subsample=0.8, subsample_freq=1,
                                       colsample_bytree=0.7, reg_lambda=5, verbose=-1),
    "logreg": lambda: make_pipeline(SimpleImputer(), StandardScaler(), LogisticRegression(C=0.05, max_iter=2000)),
}


def walk(cand, feat, mk, keep):
    """1 = giữ lệnh, 0 = bỏ; mỗi nửa năm train lại chỉ trên lệnh đã đóng trước kỳ test."""
    out = {}
    edges = pd.date_range(TEST0, cand.index[-1] + pd.offsets.MonthBegin(7), freq="6MS")
    for a, b in zip(edges[:-1], edges[1:]):
        te = (cand.index >= a) & (cand.index < b)
        if not te.any():
            continue
        tr = cand.exit_t < a.value // 10**6
        X, y = cand.loc[tr, feat], (cand.loc[tr, "R"] > 0).astype(int)
        p_oof = np.zeros(len(y))
        for i, j in KFold(5).split(X):
            p_oof[j] = mk().fit(X.iloc[i], y.iloc[i]).predict_proba(X.iloc[j])[:, 1]
        thr = np.quantile(p_oof, 1 - keep)
        p = mk().fit(X, y).predict_proba(cand.loc[te, feat])[:, 1]
        out.update(zip(cand.index[te], (p >= thr).astype(int)))
    return out


def simulate(cand, take, risk=0.01):
    eq, peak, dd, busy, rs, yr = 1.0, 1.0, 0.0, 0, [], {}
    for t, row in cand[cand.index >= TEST0].iterrows():
        if row.entry_t < busy or not take.get(t, 1):
            continue
        busy, e0 = row.exit_t, eq
        eq *= 1 + risk * row.R
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
        rs.append(row.R)
        yr[t.year] = yr.get(t.year, 1.0) * eq / e0
    rs = np.array(rs)
    return dict(n=len(rs), ret=(eq - 1) * 100, dd=dd * 100, pf=rs[rs > 0].sum() / -rs[rs < 0].sum(),
                years=" ".join(f"{y % 100}:{(g - 1) * 100:+.0f}" for y, g in sorted(yr.items())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="nến 1m định dạng freqtrade (.feather)")
    ap.add_argument("--loose", action="store_true")
    ap.add_argument("--random", type=int, default=500, help="số lần lọc ngẫu nhiên để so")
    a = ap.parse_args()

    cand = build(load_1m(a.data), a.loose)
    feat = [k for k in cand.columns if k not in ("entry_t", "exit_t", "R")]
    print(f"{len(cand)} tín hiệu, R trung bình {cand.R.mean():.3f}, thắng {(cand.R > 0).mean():.0%}")
    print(f"Ngoài mẫu từ {TEST0:%m/%Y}, rủi ro 1%/lệnh\n{'':<18}{'lệnh':>5}{'lãi%':>8}{'DD%':>7}{'PF':>6}   theo năm")
    row = lambda tag, s: f"{tag:<18}{s['n']:>5}{s['ret']:>8.1f}{s['dd']:>7.1f}{s['pf']:>6.2f}   {s['years']}"
    print(row("Không lọc", simulate(cand, {})))
    rng = np.random.default_rng(0)
    for keep in (0.5, 0.7):
        rnd = [simulate(cand, {t: int(rng.random() < keep) for t in cand.index})["ret"] for _ in range(a.random)]
        for name, mk in MODELS.items():
            s = simulate(cand, walk(cand, feat, mk, keep))
            beat = (np.array(rnd) < s["ret"]).mean() * 100
            print(row(f"{name} giữ {keep:.0%}", s) + f"   | ngẫu nhiên TB {np.mean(rnd):.1f}%, ML hơn {beat:.0f}% số lần")


if __name__ == "__main__":
    main()
