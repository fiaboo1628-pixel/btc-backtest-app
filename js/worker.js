// Chạy backtest ở luồng riêng để giao diện không bị đơ. Một coin (mặc định) hoặc nhiều coin chung tài khoản
// (kind: "portfolio").
import { resample, TF_MS } from "./timeframes.js";
import { buildSignals, validateStrategy } from "./rules.js";
import { backtest, stats } from "./engine.js";
import { backtestPortfolio, perPair, stepsFor } from "./portfolio.js";
import { atr } from "./indicators.js";

function check(strategy, sourceTf) {
  const errs = validateStrategy(strategy);
  if (TF_MS[strategy.tradeTf] < TF_MS[sourceTf]) errs.push("Trade TF is smaller than the data TF.");
  for (const side of ["long", "short"]) for (const c of strategy[side] || [])
    if (TF_MS[c.tf || strategy.tradeTf] < TF_MS[sourceTf]) errs.push("A condition uses a TF smaller than the data TF.");
  if (errs.length) throw new Error(errs.join("\n"));
}

/** Nến khung giao dịch, tín hiệu, ATR và (nếu dữ liệu nhỏ hơn khung giao dịch) nến chi tiết của một coin. */
function prepare(strategy, source, sourceTf) {
  const base = strategy.tradeTf === sourceTf ? source : resample(source, strategy.tradeTf);
  // dữ liệu nhỏ hơn khung giao dịch → quản lý lệnh trên từng nến nhỏ (chính xác hơn, như --timeframe-detail)
  const detail = strategy.tradeTf !== sourceTf && strategy.exit?.intrabar !== false;
  return {
    base, sig: buildSignals(strategy, base, source), atr: atr(base.h, base.l, base.c, strategy.exit?.atrN || 14),
    detail: detail ? source : null, detailMs: TF_MS[strategy.tradeTf],
  };
}

const idxOf = (t, at) => { let i = 0; while (i < t.length && t[i] < at) i++; return i; };

/** Kết quả gửi về giao diện: giai đoạn All/P1/P2, đường vốn, lệnh gần nhất, lý do thoát. */
function report(run, s0, s1, t, split, strategy, extra) {
  const periods = [];
  const full = run(s0, s1, true);
  periods.push({ name: "All", ...full.st });
  if (split && split > t[s0] && split < t[s1 - 1]) {
    const m = idxOf(t, split);
    periods.push({ name: "P1", ...run(s0, m).st });
    periods.push({ name: "P2", ...run(m, s1).st });
  }
  // đường vốn theo từng lệnh + mức giá (để vẽ), gọn tối đa ~600 điểm
  const tr = full.res.trades;
  const eq = [[t[s0], strategy.account?.wallet ?? 1000], ...tr.map((x) => [x.exitT, x.balance])];
  const stepN = Math.ceil(eq.length / 600);
  const equity = eq.filter((_, i) => i % stepN === 0 || i === eq.length - 1);
  return {
    ok: true, periods, equity, candles: s1 - s0,
    trades: tr.slice(-300).reverse().map(({ path, ...x }) => x),
    range: [t[s0], t[s1 - 1]],
    exitReasons: tr.reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {}),
    ...extra(full),
  };
}

function runSingle({ source, sourceTf, funding, strategy, split, from, to }) {
  check(strategy, sourceTf);
  const { base, sig, atr: a, detail, detailMs } = prepare(strategy, source, sourceTf);
  const s0 = Math.max(1, idxOf(base.t, from ?? base.t[0])), s1 = to ? idxOf(base.t, to) : base.t.length;
  if (s1 - s0 < 2) throw new Error("No data in the selected From/To range.");
  const run = (start, end, trace = false) => {
    const res = backtest(base, sig, a, { exit: strategy.exit, account: strategy.account, funding, startIdx: start, endIdx: end, trace,
      ...(detail ? { detail, detailMs } : {}) });
    const st = stats(res, strategy.account?.wallet ?? 1000, base.t[start], base.t[Math.max(start, end - 1)]);
    st.from = base.t[start]; st.to = base.t[Math.max(start, end - 1)];
    st.marketPct = (base.c[Math.max(start, end - 1)] / base.o[start] - 1) * 100;
    return { res, st };
  };
  const signals = { long: 0, short: 0 };
  for (let i = s0; i < s1; i++) { if (sig[i] === 1) signals.long++; else if (sig[i] === -1) signals.short++; }
  return report(run, s0, s1, base.t, split, strategy, (full) => ({
    signals, detailTf: detail ? sourceTf : null,
    // cho Replay: mọi lệnh + đường stop theo từng nến
    replay: full.res.trades.map((x) => ({ dir: x.dir, entryT: x.entryT, exitT: x.exitT, entry: x.entry, exit: x.exit, amount: x.amount,
      pnl: x.pnl, reason: x.reason, balance: x.balance, path: x.path })),
  }));
}

/** coins: [{symbol, source, funding}] theo thứ tự whitelist; mọi coin cùng khung dữ liệu sourceTf. */
function runPortfolio({ coins, sourceTf, strategy, maxOpen, haltDD, split, from, to }) {
  check(strategy, sourceTf);
  if (!coins?.length) throw new Error("Pick at least one coin.");
  const pairs = coins.map((k) => {
    const p = prepare(strategy, k.source, sourceTf);
    return { name: k.symbol, c: p.base, sig: p.sig, atr: p.atr, funding: k.funding, detail: p.detail, detailMs: p.detailMs,
      account: stepsFor(k.symbol, p.base) };
  });
  // lưới thời gian chung = nến của coin có dữ liệu sớm nhất; mỗi đoạn tính theo mốc thời gian, không theo chỉ số nến
  const first = pairs.reduce((a, p) => (p.c.t[0] < a.c.t[0] ? p : a), pairs[0]);
  const t = first.c.t;
  const s0 = Math.max(1, idxOf(t, from ?? t[0])), s1 = to ? idxOf(t, to) : t.length;
  if (s1 - s0 < 2) throw new Error("No data in the selected From/To range.");
  const wallet = strategy.account?.wallet ?? 1000;
  const run = (start, end, trace = false) => {
    const tEnd = end < t.length ? t[end] : t[end - 1] + TF_MS[strategy.tradeTf];
    const res = backtestPortfolio(pairs, { exit: strategy.exit, account: strategy.account, maxOpen, haltDD, from: t[start], to: tEnd, trace });
    const st = stats(res, wallet, t[start], t[Math.max(start, end - 1)]);
    st.from = t[start]; st.to = t[Math.max(start, end - 1)];
    // "mua & giữ": trung bình các coin, mỗi coin một phần bằng nhau
    st.marketPct = pairs.reduce((s, p) => {
      const a = idxOf(p.c.t, t[start]), b = Math.min(idxOf(p.c.t, tEnd), p.c.t.length) - 1;
      return s + (b > a ? (p.c.c[b] / p.c.o[a] - 1) * 100 : 0) / pairs.length;
    }, 0);
    st.halted = res.halted; st.haltedAt = res.haltedAt;
    return { res, st };
  };
  return report(run, s0, s1, t, split, strategy, (full) => ({
    portfolio: true, detailTf: pairs[0].detail ? sourceTf : null, replay: [],
    perCoin: perPair(full.res, pairs.map((p) => p.name)),
    halted: full.res.halted, haltedAt: full.res.haltedAt,
  }));
}

self.onmessage = (e) => {
  const { id, kind } = e.data;
  try {
    self.postMessage({ id, ...(kind === "portfolio" ? runPortfolio(e.data) : runSingle(e.data)) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
