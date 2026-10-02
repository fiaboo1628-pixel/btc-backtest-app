// Backtest nhiều coin chung một tài khoản (như bot TrendBreakout chạy 5 coin, max_open_trades 5):
//  - cùng một chiến lược trên mọi coin; khối lượng mỗi lệnh theo % rủi ro của vốn ĐÃ CHỐT hiện tại (chung)
//  - tối đa `maxOpen` lệnh mở cùng lúc, mỗi coin tối đa 1 lệnh
//  - cùng một nến mà nhiều coin có việc: xử lý coin đang có lệnh trước (theo thứ tự mở lệnh), rồi các coin
//    còn lại theo thứ tự danh sách (whitelist) — đúng vòng lặp backtest của freqtrade, nên lãi/lỗ của lệnh đóng
//    trong nến này đã tính vào vốn khi coin sau vào lệnh ở cùng giá mở nến
//  - tuỳ chọn tự dừng vào lệnh mới khi vốn đã chốt sụt quá haltDD từ đỉnh (halt_on của bot; freqtrade KHÔNG
//    áp dụng khi backtest, nên so với freqtrade thì tắt)
import { createBook, createRunner, DEFAULT_ACCOUNT } from "./engine.js";

// Bước khối lượng Binance USDT-M perpetual của các coin bot hay chạy (gần đúng theo sàn 2026; coin khác 0.001).
// Bước giá không tra bảng mà suy từ số chữ số thập phân của nến (inferPriceStep), như freqtrade làm khi backtest.
// Sai bước chỉ lệch làm tròn giá stop và khối lượng, không đổi logic.
export const AMOUNT_STEP = { BTCUSDT: 0.001, ETHUSDT: 0.001, SOLUSDT: 1, XRPUSDT: 0.1, DOGEUSDT: 1, BNBUSDT: 0.01 };
export function stepsFor(symbol, candles) {
  const priceSteps = inferPriceSteps(candles);
  // tháng không suy được (giá toàn số nguyên) dùng bước nhỏ nhất đã thấy; không thấy gì thì 1e-6 (hiếm, Binance luôn có số lẻ)
  const known = priceSteps.map(([, v]) => v).filter((v) => v != null);
  return { priceSteps, priceStep: known.length ? Math.min(...known) : 1e-6, amountStep: AMOUNT_STEP[symbol] || 0.001 };
}

/** Bước giá từng tháng = 10^−(số chữ số thập phân nhiều nhất trong o/h/l/c của tháng đó), như get_tick_size_over_time
 *  của freqtrade; null khi cả tháng giá là số nguyên (freqtrade khi đó dùng bước của sàn). Trả về [[giờ đầu tháng, bước], …]. */
export function inferPriceSteps(c) {
  const out = [];
  let month = null, d = 0;
  const flush = () => { if (month != null) out.push([month, d ? +(10 ** -d).toFixed(d) : null]); };
  for (let i = 0; i < c.t.length; i++) {
    const dt = new Date(c.t[i]), m0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
    if (m0 !== month) { flush(); month = m0; d = 0; }
    for (const col of ["o", "h", "l", "c"]) {
      // số lẻ thật của giá (bỏ sai số nhị phân): tối đa 8 chữ số, cắt số 0 cuối
      const s = c[col][i].toFixed(8).replace(/0+$/, "");
      const k = s.endsWith(".") ? 0 : s.length - s.indexOf(".") - 1;
      if (k > d) d = k;
    }
  }
  flush();
  return out;
}

/**
 * @param {Array} pairs  mỗi coin: {name, c: nến khung giao dịch {t,o,h,l,c}, sig, atr, funding, detail, detailMs,
 *                        account: ghi đè riêng (priceStep, amountStep)} — thứ tự mảng = thứ tự whitelist
 * @param {object} opts  {exit, account, maxOpen (mặc định = số coin), haltDD (0 = tắt), from, to (ms), trace}
 * @returns {{trades, finalBalance, halted, haltedAt}} — trades theo thứ tự đóng lệnh, mỗi lệnh có .pair và .balance
 */
export function backtestPortfolio(pairs, opts = {}) {
  const acc = { ...DEFAULT_ACCOUNT, ...opts.account };
  const book = createBook(acc, { maxOpen: opts.maxOpen ?? pairs.length, haltDD: opts.haltDD || 0 });
  const runners = pairs.map((p) => ({
    name: p.name, c: p.c, sig: p.sig, i: 0,
    r: createRunner(p.c, p.sig, p.atr, { exit: opts.exit, account: p.account, funding: p.funding, detail: p.detail,
      detailMs: p.detailMs, trace: opts.trace, pair: p.name }, book),
  }));
  // lưới thời gian chung: mọi giờ mở nến của mọi coin trong [from, to)
  const from = opts.from ?? -Infinity, to = opts.to ?? Infinity;
  const times = new Set();
  for (const p of runners) for (const t of p.c.t) if (t >= from && t < to) times.add(t);
  const grid = [...times].sort((a, b) => a - b);
  for (const p of runners) { while (p.i < p.c.t.length && p.c.t[p.i] < grid[0]) p.i++; }
  for (const t of grid) {
    // coin đang có lệnh trước (theo thứ tự mở), rồi phần còn lại theo whitelist
    const open = runners.filter((p) => p.r.pos).sort((a, b) => a.r.pos.seq - b.r.pos.seq);
    const order = open.concat(runners.filter((p) => !p.r.pos));
    for (const p of order) {
      while (p.i < p.c.t.length && p.c.t[p.i] < t) p.i++;
      const i = p.i;
      if (i >= p.c.t.length || p.c.t[i] !== t || i < 1) continue;     // coin chưa có nến ở giờ này
      p.r.exitJ = -1;
      const closedDir = p.r.step(i, -1);
      if (closedDir && p.sig[i - 1] === -closedDir) p.r.step(i, p.r.exitJ);
    }
  }
  for (const p of runners) {
    let end = p.c.t.length;
    while (end > 0 && p.c.t[end - 1] >= to) end--;
    if (end > 0) p.r.finish(end);
  }
  return { trades: book.trades, finalBalance: acc.wallet + book.closedPnl, halted: book.halted, haltedAt: book.haltedAt };
}

/** Bảng từng coin từ kết quả portfolio: lệnh, lãi USDT, PF, thắng. */
export function perPair(result, names) {
  return names.map((name) => {
    const tr = result.trades.filter((x) => x.pair === name);
    const gp = tr.filter((x) => x.pnl > 0).reduce((s, x) => s + x.pnl, 0);
    const gl = -tr.filter((x) => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
    return {
      pair: name, trades: tr.length, long: tr.filter((x) => x.dir === 1).length, short: tr.filter((x) => x.dir === -1).length,
      pnl: tr.reduce((s, x) => s + x.pnl, 0), winrate: tr.length ? tr.filter((x) => x.pnl > 0).length / tr.length : 0,
      profitFactor: gl > 0 ? gp / gl : null,
    };
  });
}
