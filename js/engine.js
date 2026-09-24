// Bộ máy backtest futures (USDT-M), mô phỏng theo cách freqtrade backtest từng nến:
//  - tín hiệu tính khi nến i đóng cửa → vào lệnh ở giá mở cửa nến i+1
//  - mỗi nến: cập nhật đỉnh/đáy → dời stop (trailing) theo đỉnh/đáy → kiểm tra low/high chạm stop
//  - stop dính khoảng trống giá (gap) → thoát ở giá mở cửa
//  - làm tròn giá stop theo bước giá (Long làm tròn lên, Short làm tròn xuống), khối lượng cắt xuống
//  - phí trên giá trị lệnh ở cả hai chiều, funding cộng dồn từ lúc vào tới nến thoát
//  - khối lượng theo rủi ro: mất `riskPct`% vốn nếu dính stop ban đầu (đòn bẩy tự tính, có trần)

const roundStep = (x, step) => Math.round(x / step) * step;
const ceilStep = (x, step) => Math.ceil(x / step - 1e-9) * step;
const floorStep = (x, step) => Math.floor(x / step + 1e-9) * step;

export const DEFAULT_EXIT = {
  rAtr: 3,             // 1R = rAtr × ATR của nến tín hiệu
  trailStartR: 2,      // lãi chạm ngần này R thì bật trailing
  trailDistR: 0.5,     // trailing cách đỉnh/đáy ngần này R
  maxHoldBars: 0,      // 0 = không giới hạn thời gian giữ lệnh
};

export const DEFAULT_ACCOUNT = {
  wallet: 1000,
  riskPct: 1,          // % vốn rủi ro mỗi lệnh
  maxLev: 5,
  fee: 0.00035,        // phí mỗi chiều (0.035% = TB maker 0.02% vào + taker 0.05% ra)
  tradableRatio: 0.99, // như tradable_balance_ratio của freqtrade
  amountStep: 0.001,   // bước khối lượng BTCUSDT perpetual
  priceStep: 0.1,      // bước giá
};

/**
 * @param {object} c       nến khung giao dịch: {t, o, h, l, c} (mảng, t = mili-giây giờ mở nến)
 * @param {Int8Array} sig  tín hiệu tại nến đóng: 1 = Long, -1 = Short, 0 = không
 * @param {Float64Array} atr ATR khung giao dịch (dùng tính R)
 * @param {object} opts    {exit, account, funding: [{t, rate, mark}], startIdx, endIdx}
 */
export function backtest(c, sig, atr, opts = {}) {
  const ex = { ...DEFAULT_EXIT, ...opts.exit };
  const acc = { ...DEFAULT_ACCOUNT, ...opts.account };
  const funding = opts.funding || [];
  const start = Math.max(1, opts.startIdx ?? 1);
  const end = Math.min(c.t.length, opts.endIdx ?? c.t.length);
  const trades = [];
  let closedPnl = 0;
  let pos = null;
  let fundIdx = 0;

  const fundingBetween = (t0, t1, amount, dir) => {
    // tổng funding trong [t0, t1]; Long trả khi rate > 0, Short nhận
    while (fundIdx < funding.length && funding[fundIdx].t < t0) fundIdx++;
    let f = 0;
    for (let k = fundIdx; k < funding.length && funding[k].t <= t1; k++) {
      f += funding[k].rate * funding[k].mark * amount;
    }
    return dir === 1 ? -f : f;
  };

  const close = (i, price, reason) => {
    const p = roundStep(price, acc.priceStep);
    const gross = pos.dir * pos.amount * (p - pos.entry);
    const fees = acc.fee * pos.amount * (pos.entry + p);
    const fund = fundingBetween(pos.t0, c.t[i], pos.amount, pos.dir);
    const pnl = gross - fees + fund;
    closedPnl += pnl;
    trades.push({
      dir: pos.dir, entryT: pos.t0, exitT: c.t[i], entry: pos.entry, exit: p, amount: pos.amount,
      leverage: pos.lev, r: pos.r, pnl, fees, funding: fund, reason, bars: i - pos.i0,
      balance: acc.wallet + closedPnl,
    });
    pos = null;
  };

  for (let i = start; i < end; i++) {
    // freqtrade: nếu lệnh vừa đóng trong nến này và tín hiệu ngược chiều → vào lệnh ngược chiều ngay
    const closedDir = step(i);
    if (closedDir && sig[i - 1] === -closedDir) step(i);
  }
  if (pos) close(end - 1, c.c[end - 1], "end");
  return { trades, finalBalance: acc.wallet + closedPnl };

  /** Xử lý một nến; trả về hướng lệnh vừa đóng (nếu có). */
  function step(i) {
    const o = c.o[i], h = c.h[i], l = c.l[i];
    let enteredNow = false;

    // 1) vào lệnh theo tín hiệu của nến trước
    if (!pos && sig[i - 1] !== 0 && Number.isFinite(atr[i - 1])) {
      const dir = sig[i - 1];
      const r = atr[i - 1] * ex.rAtr;
      const rPct = r / o;
      const risk = acc.riskPct / 100;
      const lev = Math.min(Math.max(risk / rPct, 1), acc.maxLev);
      const equity = (acc.wallet + closedPnl) * acc.tradableRatio;
      const stake = Math.min(equity * risk / rPct / lev, equity);
      const amount = floorStep((stake / o) * lev, acc.amountStep);
      if (amount > 0) {
        const stop = dir === 1 ? ceilStep(o - r, acc.priceStep) : floorStep(o + r, acc.priceStep);
        pos = { dir, entry: o, amount, lev, r, stop, stopRef: o, peak: o, i0: i, t0: c.t[i] };
        enteredNow = true;
      }
    }
    if (!pos) return 0;

    // 2) cập nhật đỉnh/đáy và dời stop (chỉ khi stop chưa bị chạm trong nến này)
    const d = pos.dir;
    const bound = d === 1 ? h : l;
    pos.peak = d === 1 ? Math.max(pos.peak, h) : Math.min(pos.peak, l);
    const stopSafe = d === 1 ? pos.stop < l : pos.stop > h;
    if (stopSafe) {
      let want = pos.entry - d * pos.r;
      const moved = d * (pos.peak - pos.entry);
      if (moved >= ex.trailStartR * pos.r) {
        const trail = pos.peak - d * ex.trailDistR * pos.r;
        want = d === 1 ? Math.max(want, trail) : Math.min(want, trail);
      }
      want = d === 1 ? ceilStep(want, acc.priceStep) : floorStep(want, acc.priceStep);
      if (d * (want - pos.stop) > 0) { pos.stop = want; pos.stopRef = bound; }
    }

    // 3) stop bị chạm?
    const hit = d === 1 ? pos.stop >= l : pos.stop <= h;
    if (hit) {
      let px;
      if (d === 1 ? pos.stop > h : pos.stop < l) px = o;             // khoảng trống giá
      else if (enteredNow) {                                          // chạm ngay trong nến vào lệnh
        const rate = o * (pos.stop / pos.stopRef);
        px = d === 1 ? Math.max(l, rate) : Math.min(h, rate);
      } else px = pos.stop;
      const initial = d === 1 ? ceilStep(pos.entry - pos.r, acc.priceStep) : floorStep(pos.entry + pos.r, acc.priceStep);
      close(i, px, pos.stop === initial ? "stop_loss" : "trailing");
      return d;
    }

    // 4) giới hạn thời gian giữ lệnh (thoát ở giá đóng cửa)
    if (ex.maxHoldBars > 0 && i - pos.i0 + 1 >= ex.maxHoldBars) { close(i, c.c[i], "time"); return d; }
    return 0;
  }
}

/** Thống kê kết quả, cùng cách tính với báo cáo freqtrade. */
export function stats(result, wallet, t0, t1) {
  const tr = result.trades;
  const wins = tr.filter((x) => x.pnl > 0), losses = tr.filter((x) => x.pnl <= 0);
  const gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -losses.reduce((s, x) => s + x.pnl, 0);
  let peak = wallet, maxDD = 0, bal = wallet;
  for (const x of tr) {
    bal = x.balance;
    peak = Math.max(peak, bal);
    maxDD = Math.max(maxDD, (peak - bal) / peak);
  }
  const years = Math.max((t1 - t0) / (365.25 * 864e5), 1e-9);
  const byYear = {};
  for (const x of tr) {
    const y = new Date(x.exitT).getUTCFullYear();
    const e = (byYear[y] ??= { year: y, trades: 0, pnl: 0, gp: 0, gl: 0 });
    e.trades++; e.pnl += x.pnl;
    if (x.pnl > 0) e.gp += x.pnl; else e.gl -= x.pnl;
  }
  return {
    trades: tr.length,
    long: tr.filter((x) => x.dir === 1).length,
    short: tr.filter((x) => x.dir === -1).length,
    winrate: tr.length ? wins.length / tr.length : 0,
    profitPct: (result.finalBalance / wallet - 1) * 100,
    profitAbs: result.finalBalance - wallet,
    profitFactor: gl > 0 ? gp / gl : null,
    maxDDPct: maxDD * 100,
    cagrPct: (Math.pow(result.finalBalance / wallet, 1 / years) - 1) * 100,
    years: Object.values(byYear).map((e) => ({ ...e, pf: e.gl > 0 ? e.gp / e.gl : null })),
  };
}
