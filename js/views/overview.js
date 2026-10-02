// Màn Tổng quan: bot đang làm gì, tiền thế nào, có gì cần làm — tất cả từ /api/live (store chung của app.js).
import { ago, cls, coin, dateTime, fmt, isoDay, modeInfo, money, pct, price, side, signedMoney, signedPct } from "../format.js";
import { botStatus, openPnl, todayPnl } from "../model.js";
import { card, errorBox, esc, freshness, kpi, loading, note } from "../ui.js";
import { barChart, drawdownBar, lineChart } from "../chart.js";

export const title = "Tổng quan";

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
      <span class="tmain"><b>${esc(coin(t.pair))} · vào ${price(t.open_rate)} → giờ ${price(t.current_rate)}</b>
        <small>Stop ${price(t.stop_loss_abs)} ${noStop ? `<span class="tag bad">chưa có stop trên sàn</span>` : guard ? `<span class="tag good">stop trên sàn ✓</span>` : ""}
        · x${fmt(t.leverage, 0)} · từ ${dateTime(t.open_timestamp)}</small></span>
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
  const noAlert = live.alerts === false;

  root.innerHTML = `<div class="cards">
    ${freshness(store.liveAt, store.failedSince, ago) ? `<div class="wide">${freshness(store.liveAt, store.failedSince, ago)}</div>` : ""}
    ${live.mode_warning ? `<div class="wide">${note(live.mode_warning, "warn")}</div>` : ""}
    ${card("", `<div class="mode-card ${m.cls}" style="border:0;padding:0;box-shadow:none;background:none">
        <div><span class="mode-name">${esc(m.name)}</span><p class="hint">${esc(m.help)} ${live.exchange ? `· ${esc(live.exchange)}` : ""}</p></div></div>
      ${statusBlock(live)}
      ${noAlert ? `<div class="msg warn">Chưa có kênh cảnh báo: nếu bot dừng hay mất stop, không ai được báo. Bật ở màn <a href="#alerts">Cảnh báo</a>.</div>` : ""}
      <p class="hint">${esc(live.strategy || "")} · nến ${esc(live.timeframe || "")} · bot kiểm tra ${live.last_process_ts ? esc(ago(live.last_process_ts * 1000)) : "–"}</p>`, { wide: true })}

    ${card("Vốn của bot", `
      <div class="big">${fmt(bal.total)} <small>${esc(cur)}</small></div>
      <div class="sub ${cls(p.profit_all_coin)}">${signedMoney(p.profit_all_coin, cur)} (${signedPct(p.profit_all_percent)}) từ ${bal.starting != null ? money(bal.starting, cur, 0) : "đầu"}</div>
      ${bal.account_total > (bal.total || 0) + 1 ? `<p class="hint">Cả tài khoản ${money(bal.account_total, cur)} (phần còn lại không thuộc bot).</p>` : ""}
      <div class="kpis">
        ${kpi("Hôm nay (lệnh đã đóng)", signedMoney(today.abs, cur), { cls: cls(today.abs), sub: `${today.trades} lệnh` })}
        ${kpi("Đang mở (chưa chốt)", signedMoney(unreal, cur), { cls: cls(unreal), sub: `${live.open.length} lệnh` })}
        ${kpi("Đã chốt", signedMoney(p.profit_closed_coin, cur), { cls: cls(p.profit_closed_coin), sub: `${p.closed_trade_count ?? 0} lệnh` })}
        ${kpi("Thắng / PF", `${p.winrate != null ? pct(p.winrate * 100, 0) : "–"} / ${p.profit_factor != null ? fmt(p.profit_factor, 2) : "–"}`)}
      </div>`)}

    ${card("Sụt vốn so với ngưỡng tự dừng", `
      <p>Hiện tại <b class="num">${pct(halt.current_dd_pct, 1)}</b> · lớn nhất từ đầu <b class="num">${pct(halt.max_dd_pct, 1)}</b> · bot tự ngừng vào lệnh mới khi quá <b>${pct(halt.threshold_pct, 0)}</b>.</p>
      ${drawdownBar(halt)}
      <p class="hint">${halt.halt_on === false ? "Tự dừng đang TẮT (halt_on) — bot sẽ không tự ngừng khi thua nhiều." :
        halt.halted ? "Đã quá ngưỡng: bot không vào lệnh mới. Lệnh đang mở vẫn được quản lý bình thường." :
        `Còn cách ngưỡng ${pct(Math.max(0, halt.threshold_pct - halt.max_dd_pct), 1)}. Tính trên lãi/lỗ đã chốt, như luật của bot.`}</p>`)}

    ${card("Lệnh đang mở", openTrades(live, cur), { wide: true, hint: `tối đa ${live.open.length} / 5` })}

    ${card("Đường vốn", eq ? lineChart(eq, { label: "Đường vốn", fmtY: (v) => money(v, cur, 0), fmtX: (v) => isoDay(new Date(v).toISOString()) }) + `<p class="hint">Vốn sau mỗi lệnh đóng, ${live.equity.length} lệnh.</p>`
      : `<p class="hint">Cần ít nhất 2 lệnh đã đóng mới vẽ được đường vốn.</p>`)}

    ${card("Lãi/lỗ theo ngày", barChart(days, { cur, fmt: (v) => signedMoney(v, "", 2).trim(), fmtDay: isoDay }) + `<p class="hint">${days.length} ngày gần nhất (ngày theo giờ UTC của bot).</p>`)}

    ${live.logs?.length ? card("Cảnh báo trong log bot", `<div class="logs">${live.logs.map((l) => `<p class="${l.level === "WARNING" ? "warn" : "down"}"><small>${esc(dateTime(l.t * 1000))}</small>${esc(l.msg)}</p>`).join("")}</div>`, { wide: true, hint: `${live.logs.length} dòng` }) : ""}
  </div>`;
}
