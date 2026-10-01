"""
Biến thể ít tham số hơn của DonchianRevert, kiểm bằng cùng walk-forward với robustness.py bước 2
(tối ưu trên 2 năm → chạy 6 tháng kế tiếp chưa từng thấy, trượt 6 tháng, 2022 → hết dữ liệu, fastsim, phí 0.05%).
Ý tưởng: ít tham số tự do thì tối ưu ít "khớp nhiễu" hơn, nên nếu chiến lược có lợi thế thật thì
walk-forward của biến thể nhỏ phải tốt hơn bản tối ưu cả 8 tham số. Không sửa bot.

  python research/variants.py --datadir data/binance --out variants_out

Đạt khi, với CẢ HAI hàm mục tiêu: chuỗi test ghép lại có lãi, PF ≥ 1.15, và ≥ 60% số đoạn test có lãi.
"""
import argparse
import multiprocessing as mp
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import talib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import robustness as rb  # noqa: E402

fs = rb.fs
# Tham số không tự do. "current" = bot đang chạy, nhưng các giá trị này được chọn SAU khi xem dữ liệu 2021 → 2026,
# nên biến thể giữ chúng cố định vẫn "nhìn trước" một phần. "textbook" = giá trị thông dụng chưa từng tối ưu,
# để biết kết quả còn đứng được khi bỏ phần nhìn trước đó.
FIXED_SETS = {
    "current": dict(fs.DEFAULTS),
    "textbook": {"dc_long": 0.05, "dc_short": 0.95, "adx_min": 25, "vol_max": 1.0, "atr_min_pct": 0.4,
                 "r_atr": 2.0, "trail_start_r": 1.0, "trail_dist_r": 1.0},
}
FIXED = dict(fs.DEFAULTS)                         # đặt lại theo --fixed trước khi fork
BAND = (0.0, 0.3, 3)                              # dc_long = band, dc_short = 1 − band (đối xứng: 1 tham số thay 2)
EMAS = (0, 96, 384, 1536)                         # lọc xu hướng: tắt / EMA 1 ngày / 4 ngày / 16 ngày (nến 15m)

# tên → (mô tả, miền các tham số tự do); số = (thấp, cao, số lẻ), tuple số nguyên = lựa chọn rời rạc
VARIANTS = {
    "full8": ("8 tham số như bot (đối chứng, giống robustness.py)", {k: fs.SPACE[k] for k in fs.SPACE}),
    "entry3": ("3 tham số vào lệnh: dải Donchian đối xứng, adx_min, atr_min_pct; thoát lệnh cố định",
               {"band": BAND, "adx_min": fs.SPACE["adx_min"], "atr_min_pct": fs.SPACE["atr_min_pct"]}),
    "entry2": ("2 tham số: dải Donchian đối xứng, adx_min", {"band": BAND, "adx_min": fs.SPACE["adx_min"]}),
    "exit3": ("chỉ 3 tham số thoát lệnh (r_atr, trailing), vào lệnh cố định",
              {k: fs.SPACE[k] for k in ("r_atr", "trail_start_r", "trail_dist_r")}),
    "trend4": ("entry3 + lọc xu hướng: chỉ Long trên EMA, Short dưới EMA (EMA tắt/1/4/16 ngày)",
               {"band": BAND, "adx_min": fs.SPACE["adx_min"], "atr_min_pct": fs.SPACE["atr_min_pct"], "ema": EMAS}),
}
EMA: dict[int, np.ndarray] = {}                   # nạp trước khi fork, dùng chung cho tiến trình con
PASS_PF, PASS_WIN_SHARE = 1.15, 0.6


def to_fs(p: dict) -> dict:
    q = {**FIXED, **{k: v for k, v in p.items() if k not in ("band", "ema")}}
    if "band" in p:
        q["dc_long"], q["dc_short"] = p["band"], round(1 - p["band"], 3)
    return q


def sig(p: dict) -> np.ndarray:
    mk = rb.MK["BTC"]
    s = fs.signals(mk, to_fs(p))
    if p.get("ema"):
        e = EMA[p["ema"]]
        s[(s == 1) & ~(mk.c > e)] = 0
        s[(s == -1) & ~(mk.c < e)] = 0
    return s


def run(p: dict, t0, t1) -> pd.DataFrame:
    return fs.run(rb.MK["BTC"], to_fs(p), t0, t1, fee=rb.FEE, sig=sig(p))


def sample(space: dict, rng) -> dict:
    return {k: int(rng.choice(v)) if k == "ema" else rng.uniform(v[0], v[1]) for k, v in space.items()}


def clamp(space: dict, p: dict) -> dict:
    out = {}
    for k, v in p.items():
        if k == "ema":
            out[k] = v
            continue
        lo, hi, dec = space[k]
        v = min(max(v, lo), hi)
        out[k] = int(round(v)) if dec == 0 else round(v, dec)
    return out


def current(space: dict) -> dict:
    """Giá trị của bot đang chạy trong miền của biến thể (điểm xuất phát, giống robustness.py)."""
    p = {k: FIXED[k] for k in space if k in FIXED}
    if "band" in space:
        p["band"] = FIXED["dc_long"]
    if "ema" in space:
        p["ema"] = 0
    return p


def optimize(job):
    name, kind, t0, t1, n_rand, n_local, min_trades, seed = job
    space = VARIANTS[name][1]
    rng = np.random.default_rng(seed)
    score = lambda p: rb.objective(run(p, t0, t1), min_trades, kind)  # noqa: E731
    cand = [current(space)] + [clamp(space, sample(space, rng)) for _ in range(n_rand)]
    scored = sorted(((score(p), p) for p in cand), key=lambda x: -x[0])
    top = [p for _, p in scored[:10]]
    for i in range(n_local):
        b = top[i % len(top)]
        q = {k: (v if k == "ema" else v + rng.normal(0, 0.08) * (space[k][1] - space[k][0])) for k, v in b.items()}
        if "ema" in q and rng.random() < 0.2:
            q["ema"] = int(rng.choice(EMAS))
        q = clamp(space, q)
        scored.append((score(q), q))
    scored.sort(key=lambda x: -x[0])
    return scored[0][1], fs.stats(run(scored[0][1], t0, t1))


def windows(end: str) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    out, t = [], pd.Timestamp("2022-01-01")
    while t < pd.Timestamp(end):
        out.append((t, min(t + pd.DateOffset(months=6), pd.Timestamp(end))))
        t += pd.DateOffset(months=6)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datadir", default="data/binance")
    ap.add_argument("--out", default="variants_out")
    ap.add_argument("--variants", nargs="+", default=list(VARIANTS), choices=list(VARIANTS))
    ap.add_argument("--objectives", nargs="+", default=["calmar", "profit"], choices=list(rb.OBJECTIVES))
    ap.add_argument("--rand", type=int, default=3000)
    ap.add_argument("--local", type=int, default=1000)
    ap.add_argument("--min-trades", type=int, default=60)
    ap.add_argument("--fixed", default="current", choices=list(FIXED_SETS))
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    FIXED.clear()
    FIXED.update(FIXED_SETS[a.fixed])
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    mk = rb.MK["BTC"] = fs.load(str(Path(a.datadir).resolve()), "BTC")
    for n in EMAS[1:]:
        EMA[n] = talib.EMA(mk.c, timeperiod=n)
    end = str(rb.data_end(mk).date())
    wins = windows(end)
    rb.log(f"BTC {pd.Timestamp(mk.t15[0], tz='UTC'):%Y-%m-%d} → {end}, {len(wins)} đoạn test")

    jobs = [(v, k, str(max(pd.Timestamp(rb.START), s - pd.DateOffset(years=2)).date()), str(s.date()),
             a.rand, a.local, a.min_trades, rb.SEED + i)
            for v in a.variants for k in a.objectives for i, (s, _) in enumerate(wins)]
    rb.log(f"{len(jobs)} lần tối ưu × {a.rand + a.local + 1} bộ tham số")
    with ProcessPoolExecutor(a.workers, mp_context=mp.get_context("fork")) as ex:
        res = dict(zip([(j[0], j[1], j[3]) for j in jobs], ex.map(optimize, jobs)))
    rb.log("xong tối ưu")

    o0 = str(wins[0][0].date())
    cur = rb.chain([fs.run(mk, FIXED, str(s.date()), str(e.date()), fee=rb.FEE) for s, e in wins])
    md = (f"# Biến thể ít tham số — walk-forward {o0} → {end}, tham số cố định: {a.fixed}\n\n"
          f"Tham số không tự do: {', '.join(f'{x}={y}' for x, y in FIXED.items())}.\n\n"
          f"Train 2 năm → test 6 tháng, {len(wins)} đoạn, fastsim, phí 0.05%/chiều, rủi ro 1%. Mỗi lần tối ưu "
          f"{a.rand} bộ ngẫu nhiên + {a.local} bộ tinh chỉnh, cần ≥ {a.min_trades} lệnh trong 2 năm. "
          f"Đạt: cả hai hàm mục tiêu đều có chuỗi test lãi, PF ≥ {PASS_PF}, ≥ {PASS_WIN_SHARE:.0%} đoạn có lãi.\n\n"
          f"Tham số cố định ({a.fixed}), không tối ưu, cùng giai đoạn: "
          f"{rb.fmt_stats(fs.stats(cur))}, {rb.cagr(cur, o0, end):+.1f}%/năm.\n\n"
          "| Biến thể | Mục tiêu | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi/năm | Đoạn có lãi | Train TB/2 năm |\n"
          "|---|---|---|---|---|---|---|---|---|---|\n")
    verdicts, detail = {}, ""
    for v in a.variants:
        ok = True
        for k in a.objectives:
            parts, rows = [], []
            for s, e in wins:
                best, tr = res[(v, k, str(s.date()))]
                t = run(best, str(s.date()), str(e.date()))
                parts.append(t)
                rows.append((s, best, tr, fs.stats(t)))
            c = rb.chain(parts)
            st = fs.stats(c)
            n_pos = sum(r[3]["profit"] > 0 for r in rows)
            ok &= st["profit"] > 0 and st["pf"] >= PASS_PF and n_pos >= PASS_WIN_SHARE * len(rows)
            md += (f"| {v} | {k} | {rb.fmt_stats(st)} | {rb.cagr(c, o0, end):+.1f}% | {n_pos}/{len(rows)} | "
                   f"{np.mean([r[2]['profit'] for r in rows]):+.0f}% |\n")
            detail += f"\n**{v} / {k}** — tham số chọn ở từng đoạn:\n\n| Test | Train lãi | Test lãi/lệnh | Tham số |\n|---|---|---|---|\n"
            for s, best, tr, so in rows:
                detail += (f"| {s:%Y-%m} | {tr['profit']:+.0f}% | {so['profit']:+.1f}% / {so['trades']} | "
                           f"{', '.join(f'{x}={y}' for x, y in best.items())} |\n")
        verdicts[v] = ok
    md += "\n" + "".join(f"- **{v}** ({VARIANTS[v][0]}): {'ĐẠT' if ok else 'không đạt'}\n" for v, ok in verdicts.items())
    md += "\n## Tham số từng đoạn\n" + detail
    (out / "result.md").write_text(md)
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)


if __name__ == "__main__":
    main()
