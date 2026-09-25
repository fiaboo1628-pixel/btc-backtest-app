// Chạy backtest bằng đúng bộ máy của app (js/worker.js) trên dữ liệu CSV, in bảng so sánh markdown.
//   node tools/backtest_cli.mjs <klines.csv> [funding.csv] [--split 2025-01-01] [--from 2021-01-01]
// klines: open_time,open,high,low,close,volume,... (dòng tiêu đề tự bỏ qua; định dạng data.binance.vision)
// funding: calc_time,funding_interval_hours,last_funding_rate
import { readFileSync, appendFileSync } from "node:fs";
import { TF_MS } from "../js/timeframes.js";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const split = Date.parse(opt("--split", "2025-01-01"));
const from = Date.parse(opt("--from", "2021-01-01"));
const [kPath, fPath] = args;

function readCsv(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.split(",")).filter((f) => /^\d/.test(f[0] || ""));
}
const rows = readCsv(kPath).map((f) => f.slice(0, 6).map(Number)).sort((a, b) => a[0] - b[0]);
const K = { t: [], o: [], h: [], l: [], c: [], v: [] };
for (const r of rows) {
  if (K.t.length && r[0] <= K.t[K.t.length - 1]) continue; // trùng
  ["t", "o", "h", "l", "c", "v"].forEach((k, i) => K[k].push(r[i]));
}
const tf = Object.keys(TF_MS).find((k) => TF_MS[k] === K.t[1] - K.t[0]);
const nearOpen = (t) => { let lo = 0, hi = K.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (K.t[m] <= t) lo = m; else hi = m - 1; } return K.o[lo]; };
const funding = fPath ? readCsv(fPath).map((f) => ({ t: +f[0], rate: +f[2], mark: nearOpen(+f[0]) })).sort((a, b) => a.t - b.t) : [];

// dùng nguyên worker.js của app
let reply;
globalThis.self = { postMessage: (m) => { reply = m; } };
await import("../js/worker.js");
const run = (strategy) => { self.onmessage({ data: { id: 1, source: K, sourceTf: tf, funding, strategy, split, from, to: null } }); return reply; };

const variants = JSON.parse(readFileSync(new URL("./msb_variants.json", import.meta.url)));
const out = [];
const f1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
out.push(`Dữ liệu: BTCUSDT ${tf}, ${new Date(K.t[0]).toISOString().slice(0, 10)} → ${new Date(K.t.at(-1)).toISOString().slice(0, 10)}, ${K.t.length} nến, ${funding.length} mốc funding. Chia P1 / P2 tại ${new Date(split).toISOString().slice(0, 10)}.\n`);
out.push("| Chiến lược | Lệnh | Lãi % | CAGR % | Max DD % | PF | Win % | P1 lãi % (PF) | P2 lãi % (PF) |");
out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const v of variants) {
  const s = { exit: {}, account: {}, ...v };
  const r = run(s);
  if (!r.ok) { out.push(`| ${v.name} | lỗi: ${r.error} |||||||| `); continue; }
  const [A, p1, p2] = r.periods;
  out.push(`| ${v.name} | ${A.trades} | ${f1(A.profitPct)} | ${f1(A.cagrPct)} | ${f1(A.maxDDPct)} | ${f1(A.profitFactor, 2)} | ${f1(A.winrate * 100, 0)} | ${p1 ? `${f1(p1.profitPct)} (${f1(p1.profitFactor, 2)})` : "–"} | ${p2 ? `${f1(p2.profitPct)} (${f1(p2.profitFactor, 2)})` : "–"} |`);
}
out.push(`\nMua & giữ cả kỳ: ${f1(run(variants[0]).periods[0].marketPct)}%`);
const md = out.join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
