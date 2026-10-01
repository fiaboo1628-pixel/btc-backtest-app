"""
Mô phỏng nhanh TrendBreakout (numba) cho danh mục nhiều coin, bám cách freqtrade backtest 4h với --timeframe-detail 15m:
  - Tín hiệu xét ở nến 4h đã đóng: Long khi close > đỉnh `entry_period` nến trước, Short khi close < đáy; tuỳ chọn EMA200.
    Vào lệnh ở giá mở nến 4h kế tiếp; mỗi coin tối đa 1 lệnh. Lệnh đóng ngay đầu nến (tín hiệu thoát, hoặc stop khớp
    trong 15 phút đầu) và có tín hiệu NGƯỢC chiều → đảo chiều ngay ở cùng nến (freqtrade gọi backtest_loop lần 2);
    cùng chiều thì không vào lại trong nến đó.
  - Thoát: SL = r_atr × ATR(20) nến tín hiệu (kiểm trên từng nến 15m: stop >= low → khớp ở stop, hoặc ở giá mở nến 15m
    nếu nhảy giá); tín hiệu thoát (close thủng đáy `exit_period` nến trước) → thoát ở giá mở nến 4h kế tiếp.
  - Khối lượng: fixed_lev → đòn bẩy = max_lev; stake = 99% vốn đã chốt × risk / (1R/giá) / đòn bẩy; làm tròn xuống 0.001.
  - Phí mỗi chiều trên giá trị lệnh, trượt giá làm xấu giá vào/ra; funding thật tại các mốc trong thời gian giữ lệnh.
robustness_trend.py đối chiếu với freqtrade thật để biết sai lệch.
"""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import talib
from numba import njit

DEFAULTS = {"entry_period": 20, "exit_period": 10, "r_atr": 2.0, "ema_filter": 0}
SPACE = {"entry_period": (10, 100, 0), "exit_period": (5, 50, 0), "r_atr": (1.0, 6.0, 1), "ema_filter": (0, 1, 0)}
H4 = 4 * 3600 * 10**9
DETAIL = 16                                      # 16 nến 15m trong 1 nến 4h


@dataclass
class Universe:
    coins: list
    t4: np.ndarray                 # lưới 4h chung (ns)
    o: np.ndarray                  # [C, T], NaN khi coin chưa có dữ liệu
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    ema: np.ndarray
    atr: np.ndarray
    do: np.ndarray                 # [C, T, 16] nến 15m: mở, cao, thấp (NaN nếu thiếu)
    dh: np.ndarray
    dl: np.ndarray
    tf: list                       # mỗi coin: mốc funding (ns) và rate × mark
    fm: list


def load(datadir: str, coins: list) -> Universe:
    d = Path(datadir) / "futures"
    k4 = {}
    for b in coins:
        k = pd.read_feather(d / f"{b}_USDT_USDT-4h-futures.feather")
        k["t"] = k.date.astype("datetime64[ns, UTC]").astype("int64")
        k4[b] = k
    t4 = np.unique(np.concatenate([k.t.to_numpy() for k in k4.values()]))
    C, T = len(coins), len(t4)
    o, h, l, c, ema, atr = (np.full((C, T), np.nan) for _ in range(6))
    do, dh, dl = (np.full((C, T, DETAIL), np.nan) for _ in range(3))
    tfs, fms = [], []
    for ci, b in enumerate(coins):
        k = k4[b]
        idx = np.searchsorted(t4, k.t.to_numpy())
        f64 = lambda s: np.ascontiguousarray(s.to_numpy(dtype=np.float64))
        o[ci, idx], h[ci, idx], l[ci, idx], c[ci, idx] = f64(k.open), f64(k.high), f64(k.low), f64(k.close)
        ema[ci, idx] = talib.EMA(f64(k.close), timeperiod=200)
        atr[ci, idx] = talib.ATR(f64(k.high), f64(k.low), f64(k.close), timeperiod=20)
        m = pd.read_feather(d / f"{b}_USDT_USDT-15m-futures.feather")
        tm = m.date.astype("datetime64[ns, UTC]").astype("int64").to_numpy()
        bar = np.searchsorted(t4, tm, "right") - 1
        ok = (bar >= 0) & (tm - t4[np.clip(bar, 0, T - 1)] < H4)
        sub = ((tm - t4[np.clip(bar, 0, T - 1)]) // (15 * 60 * 10**9)).astype(int)
        do[ci, bar[ok], sub[ok]] = m.open.to_numpy()[ok]
        dh[ci, bar[ok], sub[ok]] = m.high.to_numpy()[ok]
        dl[ci, bar[ok], sub[ok]] = m.low.to_numpy()[ok]
        fr = pd.read_feather(d / f"{b}_USDT_USDT-1h-funding_rate.feather")
        mk = pd.read_feather(d / f"{b}_USDT_USDT-1h-mark.feather")
        fx = mk[["date", "open"]].rename(columns={"open": "mark"}).merge(
            fr[["date", "open"]].rename(columns={"open": "rate"}), on="date")
        fx = fx[fx.rate != 0]
        tfs.append(fx.date.astype("datetime64[ns, UTC]").astype("int64").to_numpy())
        fms.append(f64(fx.rate * fx.mark))
    return Universe(coins, t4, o, h, l, c, ema, atr, do, dh, dl, tfs, fms)


def signals(u: Universe, p: dict):
    """enter[C,T] ∈ {−1,0,1}, exit_long[C,T], exit_short[C,T] (bool) tại nến đã đóng."""
    n, m = int(p["entry_period"]), int(p["exit_period"])
    C, T = u.o.shape
    enter = np.zeros((C, T), dtype=np.int8)
    xl_ = np.zeros((C, T), dtype=np.bool_)
    xs_ = np.zeros((C, T), dtype=np.bool_)
    for ci in range(C):
        hi, lo = pd.Series(u.h[ci]), pd.Series(u.l[ci])
        hh = hi.shift(1).rolling(n).max().to_numpy()
        ll = lo.shift(1).rolling(n).min().to_numpy()
        xh = hi.shift(1).rolling(m).max().to_numpy()
        xl = lo.shift(1).rolling(m).min().to_numpy()
        with np.errstate(invalid="ignore"):
            up = u.c[ci] > hh
            dn = u.c[ci] < ll
            if p["ema_filter"]:
                up &= u.c[ci] > u.ema[ci]
                dn &= u.c[ci] < u.ema[ci]
            enter[ci][up & ~dn] = 1
            enter[ci][dn & ~up] = -1
            xl_[ci] = u.c[ci] < xl
            xs_[ci] = u.c[ci] > xh
    return enter, xl_, xs_


@njit(cache=True)
def _run(enter, xl_, xs_, atr, t4, o, do, dh, dl, tf_flat, fm_flat, tf_off, i0, i1, r_atr, risk, lev, fee, slip,
         step, wallet, out):
    C = o.shape[0]
    eq = wallet
    n = 0
    side = np.zeros(C, dtype=np.int64)
    entry = np.zeros(C)
    stop = np.zeros(C)
    amount = np.zeros(C)
    t_in = np.zeros(C, dtype=np.int64)
    for t in range(i0, i1):
        for ci in range(C):
            px0 = o[ci, t]
            if np.isnan(px0):
                continue
            closed_now = False
            closed_side = 0
            closed_first = False
            if side[ci] != 0:
                s = side[ci]
                xp = np.nan
                tx = 0
                # tín hiệu thoát ở nến trước → thoát ở giá mở nến này
                if (s > 0 and xl_[ci, t - 1]) or (s < 0 and xs_[ci, t - 1]):
                    xp = px0
                    tx = t4[t]
                    closed_first = True
                else:
                    for j in range(DETAIL):
                        bo, bh, bl = do[ci, t, j], dh[ci, t, j], dl[ci, t, j]
                        if np.isnan(bo):
                            continue
                        if s > 0 and stop[ci] >= bl:
                            xp = bo if stop[ci] > bh else stop[ci]
                        elif s < 0 and stop[ci] <= bh:
                            xp = bo if stop[ci] < bl else stop[ci]
                        if not np.isnan(xp):
                            tx = t4[t] + j * (15 * 60 * 10**9)
                            closed_first = j == 0
                            break
                if np.isnan(xp) and t == i1 - 1:
                    xp = o[ci, t]
                    tx = t4[t]
                if not np.isnan(xp):
                    pin = entry[ci] * (1 + slip * s)
                    pout = xp * (1 - slip * s)
                    fund = 0.0
                    a0, a1 = tf_off[ci], tf_off[ci + 1]
                    q = a0 + np.searchsorted(tf_flat[a0:a1], t_in[ci])
                    while q < a1 and tf_flat[q] <= tx:
                        fund += fm_flat[q] * amount[ci]
                        q += 1
                    pnl = s * (pout - pin) * amount[ci] - fee * amount[ci] * (pin + pout) - s * fund
                    out[n, 0] = ci
                    out[n, 1] = s
                    out[n, 2] = t_in[ci]
                    out[n, 3] = tx
                    out[n, 4] = pin
                    out[n, 5] = pout
                    out[n, 6] = amount[ci]
                    out[n, 7] = pnl
                    out[n, 8] = eq
                    eq += pnl
                    n += 1
                    side[ci] = 0
                    closed_now = True
                    closed_side = s
            can_enter = (not closed_now) or (closed_first and enter[ci, t - 1] == -closed_side)
            if side[ci] == 0 and can_enter and t - 1 >= 0 and enter[ci, t - 1] != 0 and t < i1 - 1:
                R = atr[ci, t - 1] * r_atr
                if R > 0 and px0 > 0:
                    r_pct = R / px0
                    stake = eq * 0.99 * risk / r_pct / lev
                    amt = np.floor(stake / px0 * lev * (1.0 / step)) * step
                    if amt * px0 >= 5.0:
                        s = int(enter[ci, t - 1])
                        side[ci] = s
                        entry[ci] = px0
                        amount[ci] = amt
                        stop[ci] = px0 - R if s > 0 else px0 + R
                        t_in[ci] = t4[t]
                        # stop có thể khớp ngay trong nến vào lệnh
                        xp = np.nan
                        tx = 0
                        for j in range(DETAIL):
                            bo, bh, bl = do[ci, t, j], dh[ci, t, j], dl[ci, t, j]
                            if np.isnan(bo):
                                continue
                            if s > 0 and stop[ci] >= bl:
                                xp = bo if stop[ci] > bh else stop[ci]
                            elif s < 0 and stop[ci] <= bh:
                                xp = bo if stop[ci] < bl else stop[ci]
                            if not np.isnan(xp):
                                tx = t4[t] + j * (15 * 60 * 10**9)
                                break
                        if not np.isnan(xp):
                            pin = px0 * (1 + slip * s)
                            pout = xp * (1 - slip * s)
                            pnl = s * (pout - pin) * amt - fee * amt * (pin + pout)
                            out[n, 0] = ci
                            out[n, 1] = s
                            out[n, 2] = t4[t]
                            out[n, 3] = tx
                            out[n, 4] = pin
                            out[n, 5] = pout
                            out[n, 6] = amt
                            out[n, 7] = pnl
                            out[n, 8] = eq
                            eq += pnl
                            n += 1
                            side[ci] = 0
    return n


def run(u: Universe, p: dict, start=None, end=None, fee=0.0005, slip=0.0, risk_pct=0.5, max_lev=5, wallet=1000.0,
        step=0.001, sig=None) -> pd.DataFrame:
    i0 = 0 if start is None else int(np.searchsorted(u.t4, pd.Timestamp(start, tz="UTC").value))
    i1 = len(u.t4) if end is None else int(np.searchsorted(u.t4, pd.Timestamp(end, tz="UTC").value))
    i0 = max(i0, 500)                              # startup_candle_count
    enter, xl_, xs_ = signals(u, p) if sig is None else sig
    tf_off = np.zeros(len(u.coins) + 1, dtype=np.int64)
    tf_off[1:] = np.cumsum([len(x) for x in u.tf])
    tf_flat = np.concatenate(u.tf) if u.tf else np.zeros(0, dtype=np.int64)
    fm_flat = np.concatenate(u.fm) if u.fm else np.zeros(0)
    out = np.zeros((max(1, (i1 - i0) * len(u.coins) // 4 + 10), 9))
    n = _run(enter, xl_, xs_, u.atr, u.t4, u.o, u.do, u.dh, u.dl, tf_flat, fm_flat, tf_off, i0, i1,
             float(p["r_atr"]), risk_pct / 100, float(max_lev), fee, slip, step, wallet, out)
    t = pd.DataFrame(out[:n], columns=["ci", "side", "open_ns", "close_ns", "open_rate", "close_rate", "amount",
                                       "profit_abs", "equity_before"])
    t["pair"] = [u.coins[int(i)] for i in t.ci]
    t["open_date"] = pd.to_datetime(t.open_ns.astype("int64"), utc=True)
    t["close_date"] = pd.to_datetime(t.close_ns.astype("int64"), utc=True)
    t = t.sort_values("close_date").reset_index(drop=True)
    # equity_before theo thứ tự đóng lệnh (nhiều coin cùng lúc → lệnh đóng sau dùng vốn đã cộng lệnh trước)
    t["equity_before"] = wallet + t.profit_abs.cumsum() - t.profit_abs
    t["ret"] = t.profit_abs / t.equity_before
    return t


def clamp(p: dict) -> dict:
    q = dict(p)
    for k, (lo, hi, dec) in SPACE.items():
        if k in q:
            v = min(max(q[k], lo), hi)
            q[k] = int(round(v)) if dec == 0 else round(v, dec)
    if q["exit_period"] > q["entry_period"]:
        q["exit_period"] = q["entry_period"]
    return q
