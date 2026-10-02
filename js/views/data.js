// Màn Data: nến LAB dùng cho backtest — coin nào, khung nào, từ ngày nào tới ngày nào, hub tự cập nhật lúc nào.
import { ago, isoDay } from "../format.js";
import { dataSummary } from "../model.js";
import { card, errorBox, esc, loading, note } from "../ui.js";

export const title = "Data";

let root = null, ctx = null, timer = null;

export function mount(el, c) {
  root = el; ctx = c;
  if (!ctx.store.hub?.features?.tune) {
    root.innerHTML = `<div class="cards">${card("", `<p>Hub chưa bật phần backtest nên chưa có dữ liệu nến để xem.</p><p class="hint">Cần khối <code>lab</code> + <code>live</code> trong <code>bot/deploy/hub.json</code>.</p>`)}</div>`;
    return;
  }
  root.innerHTML = `<div class="cards">${card("", loading("Đang hỏi hub…"))}</div>`;
  load();
  timer = setInterval(load, 60000);
}
export function unmount() { clearInterval(timer); timer = null; root = null; }
export function refresh() { load(); }

async function load() {
  if (!root || document.hidden) return;
  let s;
  try { s = await ctx.api("/api/tune/live"); } catch (e) {
    root.innerHTML = `<div class="cards">${card("", errorBox(e, { retry: "data", title: "Không hỏi được hub" }))}</div>`;
    return;
  }
  if (!s.reachable) {
    root.innerHTML = `<div class="cards">${card("", `${note(`Hub không gọi được bot: ${s.error || ""}`, "err")}<p class="hint">Danh sách coin/khung lấy từ bot đang chạy nên cần bot trả lời. Trên máy chủ: <code>docker compose logs --tail 50 live</code>.</p><button class="btn sm" type="button" data-retry="data">Retry</button>`)}</div>`;
    return;
  }
  const u = s.data_update || { enabled: false };
  const sum = dataSummary(s.data || [], s.timeframe);
  const stale = u.last_ok && Date.now() - Date.parse(u.last_ok) > 2 * 86400e3;
  const upd = `<div class="rows">
      <div class="srow"><span class="ic ${!u.enabled ? "warn" : u.last_error || stale ? "warn" : "on"}"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg></span>
        <span class="lbl"><b>Auto-update</b><small>${!u.enabled ? "Tắt trong hub.json (lab_data_update: false)" : u.last_ok ? `Lần gần nhất ${esc(ago(Date.parse(u.last_ok)))} · ${esc(new Date(u.last_ok).toLocaleString("vi-VN"))}` : "Chưa chạy lần nào"}</small></span>
        <span class="ctl"><span class="st ${!u.enabled ? "warn" : u.running ? "warn" : "on"}">${!u.enabled ? "Off" : u.running ? "Updating…" : "Daily"}</span></span></div>
    </div>
    ${!u.enabled ? note("Hub KHÔNG tự cập nhật nến: backtest chỉ chạy được tới ngày cuối ở dưới.", "warn") : ""}
    ${u.last_error ? note(`Lần tải trước lỗi: ${u.last_error}`, "err") : ""}
    ${stale ? note("Đã quá 2 ngày chưa cập nhật được — xem log hub trên máy chủ.", "warn") : ""}`;

  const blocks = sum.map((b) => {
    const rows = b.coins.map((c) => `<tr><td>${esc(c.coin)}</td><td>${c.from ? esc(isoDay(c.from)) : `<span class="down">missing</span>`}</td><td>${c.to ? esc(isoDay(c.to)) + " " + esc(String(c.to).slice(11)) : "–"}</td></tr>`).join("");
    return card(`Candles ${b.tf}`, `
      <p>${b.from ? `<span class="num"><b>${esc(isoDay(b.from))}</b> → <b>${esc(isoDay(b.to))}</b></span>` : `<span class="down">Chưa có nến ${esc(b.tf)}.</span>`}</p>
      ${b.missing.length ? note(`Thiếu ${b.tf} của ${b.missing.join(", ")}: backtest sẽ từ chối chạy cho tới khi hub tải xong.`, "err") : ""}
      <div class="tablewrap"><table><thead><tr><th>Coin</th><th>From</th><th>To</th></tr></thead><tbody>${rows}</tbody></table></div>`, { hint: b.role === "signal" ? "signal" : "fill" });
  }).join("");

  root.innerHTML = `<div class="cards">
    ${card("Bot config", `<dl class="info">
      <dt>Pairs</dt><dd>${(s.pairs || []).map((p) => `<span class="coinchip">${esc(p.split("/")[0])}</span>`).join("") || "–"}</dd>
      <dt>Timeframe</dt><dd>${esc(s.timeframe || "–")}</dd>
      <dt>Source</dt><dd>Binance Futures</dd>
      <dt>Path</dt><dd><code>${esc(s.data_dir || "")}</code></dd></dl>`, { wide: true })}
    ${card("Update", upd, { wide: true })}
    ${blocks || card("", `<p class="hint">Chưa có thông tin nến.</p>`)}
  </div>`;
}
