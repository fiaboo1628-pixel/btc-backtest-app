// Chạy backtest ở luồng riêng để giao diện không bị đơ.
import { resample, TF_MS } from "./timeframes.js";
import { buildSignals, validateStrategy } from "./rules.js";
import { backtest, stats } from "./engine.js";
import { atr } from "./indicators.js";

self.onmessage = (e) => {
  const { id, source, sourceTf, funding, strategy, split, from, to } = e.data;
  try {
    const errs = validateStrategy(strategy);
    if (TF_MS[strategy.tradeTf] < TF_MS[sourceTf]) errs.push("Trade TF is smaller than the data TF.");
    for (const side of ["long", "short"]) for (const c of strategy[side] || [])
      if (TF_MS[c.tf || strategy.tradeTf] < TF_MS[sourceTf]) errs.push("A condition uses a TF smaller than the data TF.");
    if (errs.length) throw new Error(errs.join("\n"));

    const base = strategy.tradeTf === sourceTf ? source : resample(source, strategy.tradeTf);
    const sig = buildSignals(strategy, base, source);
    const a = atr(base.h, base.l, base.c, 14);
    const idx = (t) => { let i = 0; while (i < base.t.length && base.t[i] < t) i++; return i; };
    const s0 = Math.max(1, idx(from ?? base.t[0])), s1 = to ? idx(to) : base.t.length;
    const run = (start, end) => {
      const res = backtest(base, sig, a, { exit: strategy.exit, account: strategy.account, funding, startIdx: start, endIdx: end });
      const st = stats(res, strategy.account?.wallet ?? 1000, base.t[start], base.t[Math.max(start, end - 1)]);
      st.from = base.t[start]; st.to = base.t[Math.max(start, end - 1)];
      st.marketPct = (base.c[Math.max(start, end - 1)] / base.o[start] - 1) * 100;
      return { res, st };
    };
    const periods = [];
    const full = run(s0, s1);
    periods.push({ name: "All", ...full.st });
    if (split && split > base.t[s0] && split < base.t[s1 - 1]) {
      const m = idx(split);
      periods.push({ name: "P1", ...run(s0, m).st });
      periods.push({ name: "P2", ...run(m, s1).st });
    }
    // đường vốn theo từng lệnh + mức giá BTC (để vẽ), gọn tối đa ~600 điểm
    const tr = full.res.trades;
    const eq = [[base.t[s0], strategy.account?.wallet ?? 1000], ...tr.map((x) => [x.exitT, x.balance])];
    const stepN = Math.ceil(eq.length / 600);
    const equity = eq.filter((_, i) => i % stepN === 0 || i === eq.length - 1);
    const signals = { long: 0, short: 0 };
    for (let i = s0; i < s1; i++) { if (sig[i] === 1) signals.long++; else if (sig[i] === -1) signals.short++; }
    self.postMessage({
      id, ok: true, periods, equity, signals, candles: s1 - s0,
      trades: tr.slice(-300).reverse(),
      exitReasons: tr.reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {}),
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
