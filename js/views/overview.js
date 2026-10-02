// Màn Overview: bot đang làm gì, tiền thế nào, có gì cần làm — tất cả từ /api/live (store chung của app.js).
// Nhãn/tiêu đề tiếng Anh ngắn; giải thích, cảnh báo và log giữ tiếng Việt.
import { ago, cls, coin, dateTime, fmt, isoDay, modeInfo, money, pct, price, side, signedMoney, signedPct } from "../format.js";
import { botStatus, openPnl, todayPnl } from "../model.js";
import { card, errorBox, esc, freshness, kpi, loading, note } from "../ui.js";
import { barChart, drawdownBar, lineChart } from "../chart.js";

export const title = "Overview";

let root = null, unsub = null, ctxRef = null;

export function mount(el, ctx) {
  root = el; ctxRef = ctx;
  if (!ctx.store.hub?.features?.live) {
    root.innerHTML = `<div class="cards">${card("", ctx.store.hub?.error
      ? errorBox(ctx.store.hub.error, { retry: "hub", title: "Không tải được thông tin hub" })
      : `<p>Hub chưa bật phần theo dõi bot.</p><p class="hint">Cần khối <code>live</code> trong <code>bot/deploy/hub.json</code> (tạo bằng <code>docker compose run --rm setup</code>).</p>`)}</div>`;
    return;
  }
  root.innerHTML = `<div class="cards">${card("", loading("Đang hỏi bot…"))}</div>`;
  unsub = ctx.store.subscribe(paint);
  if (ctx.store.live || ctx.store.liveErr) paint(ctx.store);
}

export function unmount() { unsub?.(); unsub = null; }
export function refresh() { ctxRef?.pollLive?.(true); }

function statusBlock(live) {
  const s = botStatus(live);
  return `<div class="status ${s.kind}"><span class="dot" aria-hidden="true"></span><div><b>${esc(s.label)}</b>${s.detail ? `<span class="hint">${esc(s.detail)}</span>` : ""}</div></div>`;
}

function openTrades(live, cur) {
  const guard = live.mode !== "paper";
  if (!live.open.length) return `<p class="hint">Chưa có lệnh nào mở — bot đang chờ tín hiệu (nến ${esc(live.timeframe || "4h")} đóng).</p>`;
  return `<div class="list">${live.open.map((t) => {
    const noStop = guard && !t.stop_on_exchange;
    return `<div class="tr">
      <span class="side ${t.is_short ? "short" : "long"}">${side(t.is_short)}</span>
      <span class="tmain"><b>${esc(coin(t.pair))} <span class="num">${price(t.open_rate)} → ${price(t.current_rate)}</span></b>
        <small>SL ${price(t.stop_loss_abs)} ${noStop ? `<span class="tag bad" title="Lệnh này chưa có stoploss trên sàn">no stop</span>` : guard ? `<span class="tag good" title="Stoploss đã đặt trên sàn">on exchange</span>` : ""}
        · ${fmt(t.leverage, 0)}x · ${dateTime(t.open_timestamp)}</small></span>
      <span class="tpnl ${cls(t.profit_abs)}">${signedPct(t.profit_pct)}<small>${signedMoney(t.profit_abs, cur)}</small></span></div>`;
  }).join("")}</div>`;
}

function paint(store) {
  if (!root) return;
  const live = store.live;
  if (!live) {
    root.innerHTML = `<div class="cards">${card("", errorBox(store.liveErr || new Error("Chưa có dữ liệu"), { retry: "live", title: "Không hỏi được hub" }))}</div>`;
    return;
  }
  if (!live.reachable) {
    root.innerHTML = `<div class="cards">${card("", `${statusBlock(live)}
      <p>Hub chạy nhưng không gọi được bot: <b>${esc(live.error || "không trả lời")}</b>.</p>
      <p class="hint">Trên máy chủ: <code>docker compose ps</code> rồi <code>docker compose logs --tail 50 live</code>. Thường là bot đang khởi động lại hoặc container đã dừng.</p>`)}</div>`;
    return;
  }
  const cur = live.balance?.currency || live.stake_currency || "USDT";
  const p = live.profit || {};
  const m = modeInfo(live.mode);
  const today = todayPnl(live.closed);
  const unreal = openPnl(live.open);
  const bal = live.balance || {};
  const halt = live.halt || { threshold_pct: 15, current_dd_pct: 0, max_dd_pct: 0 };
  const days = (live.daily || []).slice().reverse();
  const eq = (live.equity || []).length >= 2 ? live.equity : null;
  const fresh = freshness(store.liveAt, store.failedSince, ago);

  root.innerHTML = `<div class="cards">
    ${fresh ? `<div class="wide">${fresh}</div>` : ""}
    ${live.mode_warning ? `<div class="wide">${note(live.mode_warning, "warn")}</div>` : ""}
    ${card("", `<div class="mode-card ${m.cls}" style="border:0;padding:0;box-shadow:none;background:none">
        <div><span class="mode-name">${esc(m.name)}</span><p class="hint">${esc(m.help)} ${live.exchange ? `· ${esc(live.exchange)}` : ""}</p></div></div>
      ${statusBlock(live)}
      <p class="hint">${esc(live.strategy || "")} · ${esc(live.timeframe || "")} · bot kiểm tra ${live.last_process_ts ? esc(ago(live.last_process_ts * 1000)) : "–"}</p>`, { wide: true })}

    ${card("Balance", `
      <div class="big">${fmt(bal.total)} <small>${esc(cur)}</small></div>
      <div class="sub ${cls(p.profit_all_coin)}">${signedMoney(p.profit_all_coin, cur)} (${signedPct(p.profit_all_percent)})${bal.starting != null ? ` <span class="hint" style="font-weight:400">từ ${money(bal.starting, cur, 0)}</span>` : ""}</div>
      ${bal.account_total > (bal.total || 0) + 1 ? `<p class="hint">Cả tài khoản ${money(bal.account_total, cur)} (phần còn lại không thuộc bot).</p>` : ""}
      <div class="kpis">
        ${kpi("Today", signedMoney(today.abs, cur), { cls: cls(today.abs), sub: `${today.trades} closed` })}
        ${kpi("Unrealized", signedMoney(unreal, cur), { cls: cls(unreal), sub: `${live.open.length} open` })}
        ${kpi("Realized", signedMoney(p.profit_closed_coin, cur), { cls: cls(p.profit_closed_coin), sub: `${p.closed_trade_count ?? 0} trades` })}
        ${kpi("Win rate / PF", `${p.winrate != null ? pct(p.winrate * 100, 0) : "–"} / ${p.profit_factor != null ? fmt(p.profit_factor, 2) : "–"}`)}
      </div>`)}

    ${card("Drawdown", `
      <div class="kpis three keep">
        ${kpi("Current", pct(halt.current_dd_pct, 1))}
        ${kpi("Max", pct(halt.max_dd_pct, 1))}
        ${kpi("Halt at", pct(halt.threshold_pct, 0), { cls: halt.halted ? "down" : "" })}
      </div>
      ${drawdownBar(halt)}
      <p class="hint">${halt.halt_on === false ? "Tự dừng đang TẮT (halt_on) — bot sẽ không tự ngừng khi thua nhiều." :
        halt.halted ? "Đã quá ngưỡng: bot không vào lệnh mới. Lệnh đang mở vẫn được quản lý bình thường." :
        `Còn cách ngưỡng tự dừng ${pct(Math.max(0, halt.threshold_pct - halt.max_dd_pct), 1)}. Tính trên lãi/lỗ đã chốt, như luật của bot.`}</p>`)}

    ${card("Open positions", openTrades(live, cur), { wide: true, hint: `${live.open.length}` })}

    ${card("Equity", eq ? lineChart(eq, { label: "Equity", fmtY: (v) => money(v, cur, 0), fmtX: (v) => isoDay(new Date(v).toISOString()) }) + `<p class="hint">Vốn sau mỗi lệnh đóng, ${live.equity.length} lệnh.</p>`
      : `<p class="hint">Cần ít nhất 2 lệnh đã đóng mới vẽ được đường vốn.</p>`)}

    ${card("Daily P&L", barChart(days, { cur, fmt: (v) => signedMoney(v, "", 2).trim(), fmtDay: isoDay }) + `<p class="hint">${days.length} ngày gần nhất (ngày theo giờ UTC của bot).</p>`)}

    ${live.logs?.length ? card("Log", `<div class="logs">${live.logs.map((l) => `<p class="${l.level === "WARNING" ? "warn" : "down"}"><small>${esc(dateTime(l.t * 1000))}</small>${esc(l.msg)}</p>`).join("")}</div>`, { wide: true, hint: `${live.logs.length} warnings` }) : ""}
  </div>`;
}
