// Màn Lịch sử lệnh: mọi lệnh đã đóng (/api/trades), lọc theo coin, thống kê và so với kỳ vọng backtest.
import { cls, coin, dateTime, duration, exitReason, fmt, pct, price, side, signedMoney, signedPct } from "../format.js";
import { coinsOf, perMonth, tradeStats } from "../model.js";
import { card, empty, errorBox, esc, kpi, loading } from "../ui.js";

export const title = "Lịch sử lệnh";

let root = null, ctx = null, data = null, filter = "all", loadingNow = false;

export function mount(el, c) {
  root = el; ctx = c; data = null;
  if (!ctx.store.hub?.features?.live) {
    root.innerHTML = `<div class="cards">${card("", `<p>Hub chưa bật phần theo dõi bot (khối <code>live</code> trong hub.json).</p>`)}</div>`;
    return;
  }
  root.addEventListener("click", onClick);
  load();
}
export function unmount() { root?.removeEventListener("click", onClick); root = null; }
export function refresh() { if (root && !loadingNow) load(); }

function onClick(e) {
  const chip = e.target.closest("[data-coin]");
  if (chip) { filter = chip.dataset.coin; paint(); }
}

async function load() {
  loadingNow = true;
  if (!data) root.innerHTML = `<div class="cards">${card("", loading("Đang tải lịch sử lệnh…"))}</div>`;
  try {
    data = await ctx.api("/api/trades");
    paint();
  } catch (e) {
    root.innerHTML = `<div class="cards">${card("", errorBox(e, { retry: "trades", title: "Không tải được lịch sử lệnh" }))}</div>`;
  } finally { loadingNow = false; }
}

function paint() {
  if (!root || !data) return;
  if (!data.reachable) {
    root.innerHTML = `<div class="cards">${card("", `<p>Hub không gọi được bot: <b>${esc(data.error || "")}</b>.</p><p class="hint">Trên máy chủ: <code>docker compose logs --tail 50 live</code>.</p><button class="btn sm" type="button" data-retry="trades">Thử lại</button>`)}</div>`;
    return;
  }
  const cur = data.stake_currency || "USDT";
  const all = data.trades || [];
  const coins = coinsOf(all);
  if (filter !== "all" && !coins.includes(filter)) filter = "all";
  const list = filter === "all" ? all : all.filter((t) => coin(t.pair) === filter);
  const st = filter === "all" ? data.stats : tradeStats(list);
  const n = st.n, pf = st.pf;
  const pm = perMonth(all.length, data.since);
  const ex = data.expect || {};
  const pfText = pf == null ? "–" : pf === Infinity ? "∞" : fmt(pf, 2);
  const enough = all.length >= (data.min_trades || 30);

  const compare = `<div class="tablewrap"><table class="wrap">
    <thead><tr><th></th><th>Bot</th><th>Kỳ vọng</th></tr></thead>
    <tbody>
      <tr><td>Lệnh / tháng</td><td>${pm == null ? "–" : fmt(pm, 1)}</td><td>~${fmt(ex.per_month, 0)}</td></tr>
      <tr><td>Tỉ lệ thắng</td><td>${data.stats.win_pct != null ? pct(data.stats.win_pct, 0) : "–"}</td><td>${pct(ex.win_pct, 0)}</td></tr>
      <tr><td>Profit factor</td><td>${data.stats.pf == null ? "–" : fmt(data.stats.pf, 2)}</td><td>${fmt(ex.pf, 2)}</td></tr>
      <tr><td>Sụt vốn lớn nhất</td><td>${pct(data.stats.dd_pct, 1)}</td><td>~11%<br><span class="hint">dừng khi quá 15%</span></td></tr>
    </tbody></table></div>
    <p class="hint">${esc(data.verdict || "")}${enough ? "" : ` — kết luận chỉ có nghĩa từ ${data.min_trades || 30} lệnh trở lên.`}</p>`;

  const rows = list.length ? `<div class="list">${list.map((t) => `<div class="tr">
      <span class="side ${t.is_short ? "short" : "long"}">${side(t.is_short)}</span>
      <span class="tmain"><b>${esc(coin(t.pair))} · ${price(t.open_rate)} → ${price(t.close_rate)}</b>
        <small>${esc(dateTime(t.close_timestamp))} · ${esc(exitReason(t.exit_reason))} · giữ ${esc(duration((t.close_timestamp || 0) - (t.open_timestamp || 0)))} · x${fmt(t.leverage, 0)}</small></span>
      <span class="tpnl ${cls(t.profit_abs)}">${signedMoney(t.profit_abs, "", 2).trim()}<small>${signedPct((t.profit_ratio ?? 0) * 100)}</small></span></div>`).join("")}</div>`
    : empty(filter === "all" ? "Chưa có lệnh nào đóng." : `Chưa có lệnh ${filter} nào đóng.`, "Chiến lược vào khoảng 19 lệnh/tháng trên 5 coin; lệnh đầu tiên có thể mất vài ngày.");

  root.innerHTML = `<div class="cards">
    ${card("", `<div class="chips scroll" role="group" aria-label="Lọc theo coin">
        <button class="chip" type="button" data-coin="all" aria-pressed="${filter === "all"}">Tất cả (${all.length})</button>
        ${coins.map((c) => `<button class="chip" type="button" data-coin="${esc(c)}" aria-pressed="${filter === c}">${esc(c)} (${all.filter((t) => coin(t.pair) === c).length})</button>`).join("")}
      </div>
      <div class="kpis">
        ${kpi("Số lệnh", String(n), { sub: filter === "all" ? (data.since ? `từ ${dateTime(data.since)}` : "") : filter })}
        ${kpi("Thắng", n ? `${st.wins}/${n}` : "–", { sub: n ? pct(filter === "all" ? st.win_pct : st.winrate, 0) : "" })}
        ${kpi("Profit factor", pfText, { sub: "lãi gộp ÷ lỗ gộp" })}
        ${kpi("Lãi/lỗ", signedMoney(st.pnl, cur), { cls: cls(st.pnl), sub: filter === "all" && st.pnl_pct != null ? signedPct(st.pnl_pct) : "" })}
      </div>`, { wide: true })}
    ${card("So với kỳ vọng nghiên cứu", compare, { hint: "toàn bộ lệnh" })}
    ${card("Các lệnh", rows, { wide: true, hint: `${list.length} lệnh, mới nhất trước` })}
  </div>`;
}
