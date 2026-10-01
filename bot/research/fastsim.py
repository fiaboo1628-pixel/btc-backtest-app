"""
Mô phỏng nhanh DonchianRevert (numba), bám cách freqtrade backtest với --timeframe-detail 1m:
  - Tín hiệu xét ở nến 15m đã đóng, vào lệnh ở giá mở nến 15m kế tiếp; tối đa 1 lệnh; lệnh đóng trong
    nến 15m nào thì sớm nhất nến 15m sau mới vào lệnh mới.
  - 1R = r_atr × ATR(14) của nến tín hiệu. Khối lượng = 99% vốn (tradable_balance_ratio) × risk_pct / (1R/giá), làm tròn xuống 0.001,
    đòn bẩy như DonchianRevert.leverage(), ký quỹ tối đa 99% vốn.
  - Từng nến 1m: cập nhật đỉnh/đáy bằng high/low; nếu stop chưa bị xuyên (stop < low với Long) thì dời stop
    (SL -1R, trailing từ trail_start_r × R, cách đỉnh trail_dist_r × R; chỉ dời về phía có lợi); stop >= low
    là khớp: giá thoát = stop, hoặc giá mở nến 1m nếu cả nến nằm dưới stop (nhảy giá).
  - Phí mỗi chiều trên giá trị lệnh; trượt giá: giá vào và giá thoát xấu đi `slip` (tỉ lệ).
  - Funding: tổng rate × giá mark × khối lượng ở các mốc funding trong [lúc vào, lúc thoát]; Long trả khi rate > 0.
Dùng cho tối ưu walk-forward, độ nhạy và Monte Carlo — freqtrade quá chậm cho hàng nghìn lần chạy.
`robustness.py` đối chiếu kết quả với freqtrade thật để biết sai lệch.
"""
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import talib
from numba import njit

DEFAULTS = {"dc_long": 0.074, "dc_short": 0.944, "adx_min": 30, "vol_max": 1.0, "atr_min_pct": 0.4,
            "r_atr": 3.0, "trail_start_r": 2.0, "trail_dist_r": 1.0}
# (thấp, cao, số lẻ) — đúng miền và độ chính xác của tham số trong DonchianRevert.py
SPACE = {"dc_long": (0.0, 0.3, 3), "dc_short": (0.7, 1.0, 3), "adx_min": (10, 50, 0), "vol_max": (0.3, 3.0, 2),
         "atr_min_pct": (0.0, 1.5, 2), "r_atr": (1.0, 6.0, 1), "trail_start_r": (0.5, 5.0, 1),
         "trail_dist_r": (0.1, 2.0, 1)}
BUY = ("dc_long", "dc_short", "adx_min", "vol_max", "atr_min_pct")
SELL = ("r_atr", "trail_start_r", "trail_dist_r")
NS15 = 15 * 60 * 10**9


@dataclass
class Market:
    pair: str
    t15: np.ndarray            # int64 ns, giờ mở nến 15m
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    dpos: np.ndarray
    adx: np.ndarray
    vol_ratio: np.ndarray
    atr: np.ndarray
    atr_pct: np.ndarray
    vol: np.ndarray
    j0: np.ndarray             # chỉ số nến 1m đầu/cuối (không gồm) thuộc từng nến 15m
    j1: np.ndarray
    t1: np.ndarray
    o1: np.ndarray
    h1: np.ndarray
    l1: np.ndarray
    tf: np.ndarray             # mốc funding (ns) và rate × giá mark tại mốc đó
    fm: np.ndarray


def load(datadir: str, base: str, dc_period: int = 20) -> Market:
    d = Path(datadir) / "futures"
    k = pd.read_feather(d / f"{base}_USDT_USDT-15m-futures.feather")
    m = pd.read_feather(d / f"{base}_USDT_USDT-1m-futures.feather")
    fr = pd.read_feather(d / f"{base}_USDT_USDT-1h-funding_rate.feather")
    mk = pd.read_feather(d / f"{base}_USDT_USDT-1h-mark.feather")
    hh = k.high.rolling(dc_period).max()
    ll = k.low.rolling(dc_period).min()
    f64 = lambda s: np.ascontiguousarray(s.to_numpy(dtype=np.float64))
    atr = talib.ATR(f64(k.high), f64(k.low), f64(k.close), timeperiod=14)
    t15 = k.date.astype("datetime64[ns, UTC]").astype("int64").to_numpy()
    t1 = m.date.astype("datetime64[ns, UTC]").astype("int64").to_numpy()
    fx = mk[["date", "open"]].rename(columns={"open": "mark"}).merge(
        fr[["date", "open"]].rename(columns={"open": "rate"}), on="date")
    fx = fx[fx.rate != 0]
    return Market(
        pair=base, t15=t15, o=f64(k.open), h=f64(k.high), l=f64(k.low), c=f64(k.close),
        dpos=f64((k.close - ll) / (hh - ll)),
        adx=talib.ADX(f64(k.high), f64(k.low), f64(k.close), timeperiod=14),
        vol_ratio=f64(k.volume / k.volume.rolling(96).mean()), atr=atr, atr_pct=atr / f64(k.close) * 100,
        vol=f64(k.volume),
        j0=np.searchsorted(t1, t15, "left"), j1=np.searchsorted(t1, t15 + NS15, "left"),
        t1=t1, o1=f64(m.open), h1=f64(m.high), l1=f64(m.low),
        tf=fx.date.astype("datetime64[ns, UTC]").astype("int64").to_numpy(),
        fm=f64(fx.rate * fx.mark))


def signals(mk: Market, p: dict) -> np.ndarray:
    """+1 Long, -1 Short, 0 không có tín hiệu — ở nến 15m đã đóng."""
    with np.errstate(invalid="ignore"):
        common = ((mk.adx > p["adx_min"]) & (mk.vol_ratio < p["vol_max"]) & (mk.atr_pct >= p["atr_min_pct"])
                  & (mk.vol > 0))
        lo = common & (mk.dpos <= p["dc_long"])
        sh = common & (mk.dpos >= p["dc_short"])
    s = np.zeros(len(mk.t15), dtype=np.int8)
    s[lo & ~sh] = 1
    s[sh & ~lo] = -1
    return s


@njit(cache=True)
def _run(sig, atr, t15, o, h, l, c, j0, j1, t1, o1, h1, l1, tf, fm, i0, i1, r_atr, t_start, t_dist,
         risk, max_lev, fee, slip, step, wallet, out):
    """Trả về số lệnh; out[n] = (side, i_vào, giờ vào, giờ ra, giá vào, giá ra, khối lượng, lãi USDT, vốn trước lệnh)."""
    eq = wallet
    n = 0
    side = 0
    stop = peak = trough = entry = amount = R = 0.0
    t_in = 0
    k_in = 0
    for i in range(i0, i1):
        if side == 0 and i - 1 >= 0 and sig[i - 1] != 0 and i < i1 - 1:
            px = o[i]
            R = atr[i - 1] * r_atr
            if R > 0 and px > 0:
                r_pct = R / px
                cap = max(1, math.floor(0.9 * 0.15 / r_pct))
                lev = min(max(math.ceil(risk / r_pct - 1e-9), 1), max_lev, cap)
                stake = min(eq * 0.99 * risk / r_pct / lev, eq * 0.99)   # tradable_balance_ratio 0.99
                amt = math.floor(stake / px * lev * (1.0 / step)) * step  # TRUNCATE như freqtrade
                if amt * px >= 5.0:
                    side = int(sig[i - 1])
                    entry = px
                    amount = amt
                    peak = px
                    trough = px
                    stop = px * (1 - 0.15 / lev) if side > 0 else px * (1 + 0.15 / lev)
                    t_in = t15[i]
                    k_in = i
        if side == 0:
            continue
        a = j0[i]
        b = j1[i]
        done = False
        xp = 0.0
        tx = 0
        if a == b:                                   # thiếu nến 1m: dùng chính nến 15m
            a = -1
            b = 0
        for j in range(a, b):
            if j < 0:
                bo, bh, bl, bt = o[i], h[i], l[i], t15[i]
            else:
                bo, bh, bl, bt = o1[j], h1[j], l1[j], t1[j]
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
                tx = bt
                break
        if not done and i == i1 - 1:
            xp = c[i]
            tx = t15[i]
            done = True
        if done:
            pin = entry * (1 + slip * side)
            pout = xp * (1 - slip * side)
            fund = 0.0
            for q in range(np.searchsorted(tf, t_in), len(tf)):
                if tf[q] > tx:
                    break
                fund += fm[q] * amount
            pnl = side * (pout - pin) * amount - fee * amount * (pin + pout) - side * fund
            out[n, 0] = side
            out[n, 1] = k_in
            out[n, 2] = t_in
            out[n, 3] = tx
            out[n, 4] = pin
            out[n, 5] = pout
            out[n, 6] = amount
            out[n, 7] = pnl
            out[n, 8] = eq
            eq += pnl
            n += 1
            side = 0
    return n


def run(mk: Market, p: dict, start=None, end=None, fee=0.0005, slip=0.0, risk_pct=1.0, max_lev=5,
        wallet=1000.0, step=0.001, sig=None) -> pd.DataFrame:
    """Backtest trên [start, end) (chuỗi ngày hoặc Timestamp, UTC). Trả về bảng lệnh."""
    i0 = 0 if start is None else int(np.searchsorted(mk.t15, pd.Timestamp(start, tz="UTC").value))
    i1 = len(mk.t15) if end is None else int(np.searchsorted(mk.t15, pd.Timestamp(end, tz="UTC").value))
    i0 = max(i0, 200)                                # startup_candle_count
    sig = signals(mk, p) if sig is None else sig
    out = np.zeros((max(1, (i1 - i0) // 2), 9))
    n = _run(sig, mk.atr, mk.t15, mk.o, mk.h, mk.l, mk.c, mk.j0, mk.j1, mk.t1, mk.o1, mk.h1, mk.l1, mk.tf, mk.fm,
             i0, i1, float(p["r_atr"]), float(p["trail_start_r"]), float(p["trail_dist_r"]),
             risk_pct / 100, int(max_lev), fee, slip, step, wallet, out)
    t = pd.DataFrame(out[:n], columns=["side", "i", "open_ns", "close_ns", "open_rate", "close_rate", "amount",
                                       "profit_abs", "equity_before"])
    t["open_date"] = pd.to_datetime(t.open_ns.astype("int64"), utc=True)
    t["close_date"] = pd.to_datetime(t.close_ns.astype("int64"), utc=True)
    t["ret"] = t.profit_abs / t.equity_before
    return t


def stats(t: pd.DataFrame, wallet: float = 1000.0) -> dict:
    if t.empty:
        return {"trades": 0, "profit": 0.0, "dd": 0.0, "pf": 0.0, "win": 0.0, "calmar": 0.0}
    eq = wallet + t.profit_abs.cumsum().to_numpy()
    peak = np.maximum.accumulate(np.concatenate([[wallet], eq]))[1:]
    dd = float(((peak - eq) / peak).max())
    gp = t.profit_abs[t.profit_abs > 0].sum()
    gl = -t.profit_abs[t.profit_abs < 0].sum()
    profit = (eq[-1] / wallet - 1) * 100
    return {"trades": len(t), "profit": profit, "dd": dd * 100, "pf": gp / gl if gl > 0 else float("inf"),
            "win": 100 * (t.profit_abs > 0).mean(), "calmar": profit / max(dd * 100, 1.0)}


def yearly(t: pd.DataFrame) -> dict:
    """Lãi % theo năm, tính trên vốn đầu năm."""
    if t.empty:
        return {}
    y = t.close_date.dt.year
    r = {}
    for k, g in t.groupby(y):
        r[int(k)] = 100 * g.profit_abs.sum() / g.equity_before.iloc[0]
    return r


def clamp(p: dict) -> dict:
    """Cắt về miền tham số và làm tròn đúng số lẻ freqtrade dùng."""
    q = dict(p)
    for k, (lo, hi, dec) in SPACE.items():
        if k in q:
            v = min(max(q[k], lo), hi)
            q[k] = int(round(v)) if dec == 0 else round(v, dec)
    return q
