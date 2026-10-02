// Bộ máy backtest futures (USDT-M), mô phỏng theo cách freqtrade backtest từng nến:
//  - tín hiệu tính khi nến i đóng cửa → vào lệnh ở giá mở cửa nến i+1
//  - mỗi nến: cập nhật đỉnh/đáy → dời stop (trailing) theo đỉnh/đáy → kiểm tra low/high chạm stop
//  - stop dính khoảng trống giá (gap) → thoát ở giá mở cửa
//  - opts.detail (nến khung nhỏ hơn, vd 1m): quản lý lệnh chạy trên từng nến nhỏ bên trong nến giao dịch,
//    như --timeframe-detail của freqtrade — biết high hay low đến trước, không "bán đúng đỉnh nến"
//  - TP cố định theo R (tpR > 0); stop chạm trước TP nếu cùng một nến
//  - làm tròn giá stop theo bước giá (Long làm tròn lên, Short làm tròn xuống), khối lượng cắt xuống
//  - phí trên giá trị lệnh ở cả hai chiều, funding cộng dồn từ lúc vào tới nến thoát
//  - thoát theo kênh (exitChannel): tín hiệu khi nến đóng → thoát ở giá mở cửa nến sau, như exit signal của freqtrade
//  - khối lượng theo rủi ro: mất `riskPct`% vốn nếu dính stop ban đầu (đòn bẩy tự tính, có trần; fixedLev = luôn
//    dùng trần, như fixed_lev của bot — notional không đổi, chỉ khác ký quỹ)
//
// Một coin: backtest(). Nhiều coin chung tài khoản: createBook() + createRunner() cho từng coin, vòng lặp
// theo thời gian nằm ở portfolio.js (sổ lệnh `book` giữ vốn chung, số lệnh đang mở, tự dừng khi sụt vốn).

const roundStep = (x, step) => Math.round(x / step) * step;
const ceilStep = (x, step) => Math.ceil(x / step - 1e-9) * step;
const floorStep = (x, step) => Math.floor(x / step + 1e-9) * step;

export const DEFAULT_EXIT = {
  rAtr: 3,             // 1R = rAtr × ATR của nến tín hiệu
  trailStartR: 2,      // lãi chạm ngần này R thì bật trailing (0 = tắt trailing)
  trailDistR: 0.5,     // trailing cách đỉnh/đáy ngần này R
  maxHoldBars: 0,      // 0 = không giới hạn thời gian giữ lệnh
  tpR: 0,              // chốt lời cố định ở ngần này R (0 = tắt)
  exitChannel: 0,      // thoát theo kênh: Long đóng dưới đáy N nến trước / Short đóng trên đỉnh → thoát ở giá mở nến sau (0 = tắt)
  atrN: 14,            // số nến ATR dùng tính R
};

export const DEFAULT_ACCOUNT = {
  wallet: 1000,
  riskPct: 1,          // % vốn rủi ro mỗi lệnh
  maxLev: 5,
  fixedLev: false,     // true: luôn dùng maxLev (fixed_lev của bot) — ký quỹ mỗi lệnh nhỏ hơn, khối lượng không đổi
  hardStop: 0,         // stop cứng của freqtrade (|stoploss|, vd 0.5): đòn bẩy ≤ 0.9 × hardStop / R% để stop 1R luôn
                       // gần hơn stop cứng (leverage() của bot). 0 = không giới hạn
  fee: 0.0005,         // phí mỗi chiều: taker 0.05% (bot vào/ra bằng lệnh market)
  tradableRatio: 0.99, // như tradable_balance_ratio của freqtrade
  slippage: 0,         // trượt giá mỗi lệnh market (tỉ lệ, vd 0.0005 = 0.05%); 0 = như backtest freqtrade
  amountStep: 0.001,   // bước khối lượng BTCUSDT perpetual (= khối lượng tối thiểu)
  priceStep: 0.1,      // bước giá (dùng khi không có priceSteps)
  priceSteps: null,    // bước giá theo thời gian [[t, step|null], …] như freqtrade suy từ nến từng tháng; null = priceStep
  minNotional: 5,      // giá trị lệnh tối thiểu của sàn (USDT): lệnh nhỏ hơn được nâng lên mức tối thiểu như freqtrade
};
// freqtrade nâng lệnh quá nhỏ lên mức tối thiểu của sàn (validate_stake_amount): ký quỹ tối thiểu =
// max(giá trị tối thiểu × 1.05/(1−5%), khối lượng tối thiểu × giá × 1.05) / đòn bẩy; nhỏ hơn thì nâng lên,
// nhưng phải nâng quá 30% thì bỏ lệnh. Vốn nhỏ + rủi ro thấp (0.25%) trên BTC gặp trường hợp này thường xuyên.
const MIN_RESERVE = 1.05 / (1 - 0.05), AMOUNT_RESERVE = 1.05;

/**
 * Sổ lệnh chung cho một hay nhiều coin: vốn đã chốt, số lệnh đang mở, ký quỹ đang dùng, tự dừng khi sụt vốn.
 * @param {object} acc    tài khoản (DEFAULT_ACCOUNT + ghi đè)
 * @param {object} limits {maxOpen: số lệnh mở cùng lúc tối đa (0 = không giới hạn),
 *                         haltDD: ngừng vào lệnh mới khi vốn đã chốt sụt quá tỉ lệ này từ đỉnh (0 = tắt; bot: 0.15)}
 */
export function createBook(acc, limits = {}) {
  const book = {
    acc, trades: [], closedPnl: 0, openCount: 0, tiedUp: 0, seq: 0,
    maxOpen: limits.maxOpen || 0, haltDD: limits.haltDD || 0, peak: acc.wallet, halted: false, haltedAt: null,
    /** vốn dùng tính khối lượng: (vốn + lãi đã chốt) × tradable_balance_ratio, như get_total_stake_amount() */
    equity: () => (acc.wallet + book.closedPnl) * acc.tradableRatio,
    canOpen: () => !book.halted && (book.maxOpen <= 0 || book.openCount < book.maxOpen),
    onOpen(pos) { book.openCount++; book.tiedUp += pos.stake; pos.seq = book.seq++; },
    onClose(pos, trade) {
      book.openCount--; book.tiedUp -= pos.stake; book.closedPnl += trade.pnl;
      trade.balance = acc.wallet + book.closedPnl;
      book.trades.push(trade);
      // tự dừng như halt_reason() của bot: sụt vốn tính trên lệnh đã đóng, đã chạm thì dừng hẳn
      book.peak = Math.max(book.peak, trade.balance);
      if (book.haltDD > 0 && !book.halted && 1 - trade.balance / book.peak > book.haltDD) { book.halted = true; book.haltedAt = trade.exitT; }
    },
  };
  return book;
}

/**
 * Bộ chạy một coin: vào/thoát lệnh trên nến của coin đó, ghi vào `book`.
 * @param {object} c       nến khung giao dịch: {t, o, h, l, c} (mảng, t = mili-giây giờ mở nến)
 * @param {Int8Array} sig  tín hiệu tại nến đóng: 1 = Long, -1 = Short, 0 = không
 * @param {Float64Array} atr ATR khung giao dịch (dùng tính R)
 * @param {object} opts    {exit, account (ghi đè riêng cho coin: amountStep, priceStep…), funding: [{t, rate, mark}],
 *                          detail: nến khung nhỏ {t,o,h,l,c} để quản lý lệnh bên trong nến, detailMs: độ dài nến giao dịch,
 *                          trace: true → mỗi lệnh có path [[t, stop], …] (stop cuối mỗi nến, để xem lại/Replay), pair: tên coin}
 */
export function createRunner(c, sig, atr, opts, book) {
  const ex = { ...DEFAULT_EXIT, ...opts.exit };
  const acc = { ...book.acc, ...opts.account };
  const funding = opts.funding || [];
  // bước giá tại thời điểm t (freqtrade: get_pair_precision → Series.asof: giá trị gần nhất KHÁC null trước t,
  // chưa có thì bước của sàn); mỗi lệnh giữ bước của lúc vào
  const steps = acc.priceSteps || null;
  const stepAt = (t) => {
    let st = acc.priceStep;
    if (steps) for (let k = 0; k < steps.length && steps[k][0] <= t; k++) st = steps[k][1] ?? st;
    return st;
  };
  // tín hiệu thoát theo kênh tại nến đóng: xl/xh = đáy/đỉnh của exitChannel nến trước đó
  let exitLong = null, exitShort = null;
  if (ex.exitChannel > 0 && c.h) {
    const m = ex.exitChannel, n = c.t.length;
    exitLong = new Uint8Array(n); exitShort = new Uint8Array(n);
    for (let i = m; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - m; j < i; j++) { if (c.h[j] > hi) hi = c.h[j]; if (c.l[j] < lo) lo = c.l[j]; }
      exitLong[i] = c.c[i] < lo ? 1 : 0;
      exitShort[i] = c.c[i] > hi ? 1 : 0;
    }
  }
  let pos = null;
  let fundIdx = 0;
  // chỉ số nến nhỏ đầu tiên của từng nến giao dịch (detail)
  const D = opts.detail || null;
  let dStart = null;
  if (D) {
    const ms = opts.detailMs;
    dStart = new Int32Array(c.t.length + 1);
    let j = 0;
    for (let i = 0; i < c.t.length; i++) {
      while (j < D.t.length && D.t[j] < c.t[i]) j++;
      dStart[i] = j;
    }
    dStart[c.t.length] = D.t.length;
    // nến giao dịch cuối có thể chưa đủ nến nhỏ: chặn theo độ dài nến
    for (let i = 0; i < c.t.length; i++) {
      let e = dStart[i + 1];
      while (e > dStart[i] && D.t[e - 1] >= c.t[i] + ms) e--;
      if (e < dStart[i + 1]) dStart[i + 1] = Math.max(e, dStart[i]);
    }
  }

  // mốc funding làm tròn tới phút: fundingTime của Binance hay trễ vài ms (…:00:00.004), không làm tròn thì
  // lệnh thoát đúng nến mở lúc …:00:00 bị bỏ sót khoản funding đó
  const fT = funding.map((x) => Math.round(x.t / 60000) * 60000);
  const fundingBetween = (t0, t1, amount, dir) => {
    // tổng funding trong [t0, t1]; Long trả khi rate > 0, Short nhận
    while (fundIdx < funding.length && fT[fundIdx] < t0) fundIdx++;
    let f = 0;
    for (let k = fundIdx; k < funding.length && fT[k] <= t1; k++) {
      f += funding[k].rate * funding[k].mark * amount;
    }
    return dir === 1 ? -f : f;
  };

  // t: giờ thoát thật (nến nhỏ khi có detail), không phải giờ mở nến giao dịch
  const close = (i, price, reason, t = c.t[i]) => {
    // trượt giá: lệnh thoát là lệnh market (stop market / đóng tay) → khớp tệ hơn giá kích hoạt
    const p = roundStep(price * (1 - pos.dir * acc.slippage), pos.step);
    const gross = pos.dir * pos.amount * (p - pos.entry);
    const fees = acc.fee * pos.amount * (pos.entry + p);
    const fund = fundingBetween(pos.t0, t, pos.amount, pos.dir);
    const pnl = gross - fees + fund;
    const trade = {
      ...(opts.pair ? { pair: opts.pair } : {}),
      dir: pos.dir, entryT: pos.t0, exitT: t, entry: pos.entry, exit: p, amount: pos.amount,
      leverage: pos.lev, r: pos.r, pnl, fees, funding: fund, reason, bars: i - pos.i0,
      ...(opts.trace ? { path: [...pos.path, [t, pos.stop]] } : {}),
    };
    book.onClose(pos, trade);                      // đặt trade.balance = vốn sau lệnh
    pos = null;
  };

  const runner = {
    exitJ: -1,          // nến nhỏ vừa thoát lệnh (detail), -1 = thoát trên nến giao dịch
    get pos() { return pos; },
    step,
    /** Đóng lệnh còn mở ở giá đóng cửa nến cuối (như freqtrade đóng lệnh còn mở khi hết dữ liệu). */
    finish(end) { if (pos) close(end - 1, c.c[end - 1], "end"); },
  };
  return runner;

  /** Xử lý một nến; trả về hướng lệnh vừa đóng (nếu có) để đảo chiều. from ≥ 0: vào lệnh từ nến nhỏ này. */
  function step(i, from) {
    const o = c.o[i], h = c.h[i], l = c.l[i];
    const eo = from >= 0 ? D.o[from] : o, et = from >= 0 ? D.t[from] : c.t[i];
    let enteredNow = false;

    // 0) thoát theo kênh: tín hiệu ở nến trước → thoát ở giá mở cửa nến này
    if (pos && exitLong && (pos.dir === 1 ? exitLong[i - 1] : exitShort[i - 1])) {
      const d = pos.dir;
      close(i, o, "exit_signal");
      return d;
    }

    // 1) vào lệnh theo tín hiệu của nến trước (sổ lệnh còn chỗ và chưa tự dừng)
    if (!pos && sig[i - 1] !== 0 && Number.isFinite(atr[i - 1]) && book.canOpen()) {
      const dir = sig[i - 1];
      const r = atr[i - 1] * ex.rAtr;
      const rPct = r / eo;
      const risk = acc.riskPct / 100;
      // đòn bẩy nguyên, làm tròn lên: Binance làm tròn xuống đòn bẩy lẻ (thiếu ký quỹ), notional không đổi
      const cap = acc.hardStop > 0 ? Math.max(1, Math.floor(0.9 * acc.hardStop / rPct)) : Infinity;
      const lev = Math.min(acc.fixedLev ? acc.maxLev : Math.max(Math.ceil(risk / rPct - 1e-9), 1), acc.maxLev, cap);
      const equity = book.equity();
      // vốn còn rảnh = vốn − ký quỹ các lệnh đang mở (get_available_stake_amount của freqtrade)
      const available = Math.max(equity - book.tiedUp, 0);
      let stake = Math.min(equity * risk / rPct / lev, available);
      const pStep = stepAt(et);
      const entry = roundStep(eo * (1 + dir * acc.slippage), pStep);  // vào lệnh market: trượt giá
      const minStake = Math.max(acc.minNotional * MIN_RESERVE, acc.amountStep * entry * AMOUNT_RESERVE) / lev;
      if (minStake > available) stake = 0;
      else if (stake < minStake) stake = stake * 1.3 < minStake ? 0 : minStake;
      const amount = floorStep((stake / entry) * lev, acc.amountStep);
      if (amount > 0) {
        const stop = dir === 1 ? ceilStep(entry - r, pStep) : floorStep(entry + r, pStep);
        pos = { dir, entry, amount, lev, r, stop, stopRef: entry, peak: entry, i0: i, t0: et, stake: amount * entry / lev, step: pStep };
        if (opts.trace) pos.path = [[et, stop]];
        book.onOpen(pos);
        enteredNow = true;
      }
    }
    if (!pos) return 0;

    // 2–3) quản lý lệnh: trên từng nến nhỏ (detail) hoặc trên chính nến giao dịch
    const d = pos.dir;
    if (D && dStart[i + 1] > dStart[i]) {
      const j0 = from >= 0 ? from : dStart[i];
      for (let j = j0; j < dStart[i + 1]; j++) {
        const out = manage(D.o[j], D.h[j], D.l[j], enteredNow && j === j0);
        if (out) { close(i, out[0], out[1], D.t[j]); runner.exitJ = j; return d; }
      }
    } else {
      const out = manage(o, h, l, enteredNow);
      if (out) { close(i, out[0], out[1]); return d; }
    }

    if (opts.trace) pos.path.push([c.t[i], pos.stop]);

    // 4) giới hạn thời gian giữ lệnh (thoát ở giá đóng cửa)
    // không đảo chiều sau lệnh này: đã thoát ở giá đóng cửa, không vào lại được ở giá mở của chính nến đó
    if (ex.maxHoldBars > 0 && i - pos.i0 + 1 >= ex.maxHoldBars) { close(i, c.c[i], "time"); return 0; }
    return 0;
  }

  /** Một nến (hoặc nến nhỏ): dời stop theo đỉnh/đáy, kiểm tra stop rồi TP. Trả [giá thoát, lý do] hoặc null. */
  function manage(o, h, l, first) {
    const d = pos.dir;
    const bound = d === 1 ? h : l;
    pos.peak = d === 1 ? Math.max(pos.peak, h) : Math.min(pos.peak, l);
    const stopSafe = d === 1 ? pos.stop < l : pos.stop > h;
    if (stopSafe) {
      let want = pos.entry - d * pos.r;
      const moved = d * (pos.peak - pos.entry);
      if (ex.trailStartR > 0 && moved >= ex.trailStartR * pos.r) {
        const trail = pos.peak - d * ex.trailDistR * pos.r;
        want = d === 1 ? Math.max(want, trail) : Math.min(want, trail);
      }
      want = d === 1 ? ceilStep(want, pos.step) : floorStep(want, pos.step);
      if (d * (want - pos.stop) > 0) { pos.stop = want; pos.stopRef = bound; }
    }
    const hit = d === 1 ? pos.stop >= l : pos.stop <= h;
    if (hit) {
      let px;
      if (d === 1 ? pos.stop > h : pos.stop < l) px = o;             // khoảng trống giá
      else if (first) {                                               // chạm ngay trong nến vào lệnh
        const rate = o * (pos.stop / pos.stopRef);
        px = d === 1 ? Math.max(l, rate) : Math.min(h, rate);
      } else px = pos.stop;
      const initial = d === 1 ? ceilStep(pos.entry - pos.r, pos.step) : floorStep(pos.entry + pos.r, pos.step);
      return [px, pos.stop === initial ? "stop_loss" : "trailing"];
    }
    if (ex.tpR > 0) {
      const tp = pos.entry + d * ex.tpR * pos.r;
      if (d === 1 ? h >= tp : l <= tp) return [d === 1 ? Math.max(o, tp) : Math.min(o, tp), "take_profit"];
    }
    return null;
  }
}

/**
 * Backtest một coin (1 lệnh/lúc).
 * @param {object} c       nến khung giao dịch: {t, o, h, l, c}
 * @param {Int8Array} sig  tín hiệu tại nến đóng: 1 = Long, -1 = Short, 0 = không
 * @param {Float64Array} atr ATR khung giao dịch
 * @param {object} opts    như createRunner, thêm {startIdx, endIdx}
 */
export function backtest(c, sig, atr, opts = {}) {
  const acc = { ...DEFAULT_ACCOUNT, ...opts.account };
  const book = createBook(acc);
  const r = createRunner(c, sig, atr, { ...opts, account: {} }, book);
  const start = Math.max(1, opts.startIdx ?? 1);
  const end = Math.min(c.t.length, opts.endIdx ?? c.t.length);
  for (let i = start; i < end; i++) {
    // freqtrade: nếu lệnh vừa đóng trong nến này và tín hiệu ngược chiều → vào lệnh ngược chiều ngay,
    // ở giá mở của chính nến (nhỏ) vừa thoát — không quay lại giá mở nến giao dịch (đã qua)
    r.exitJ = -1;
    const closedDir = r.step(i, -1);
    if (closedDir && sig[i - 1] === -closedDir) r.step(i, r.exitJ);
  }
  r.finish(end);
  return { trades: book.trades, finalBalance: acc.wallet + book.closedPnl };
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
