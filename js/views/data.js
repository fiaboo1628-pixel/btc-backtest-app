// Màn Dữ liệu: nến LAB dùng cho backtest — coin nào, khung nào, từ ngày nào tới ngày nào, hub tự cập nhật lúc nào.
import { ago, isoDay } from "../format.js";
import { dataSummary } from "../model.js";
import { card, errorBox, esc, loading, note } from "../ui.js";

export const title = "Dữ liệu";

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
    root.innerHTML = `<div class="cards">${card("", `${note(`Hub không gọi được bot: ${s.error || ""}`, "err")}<p class="hint">Danh sách coin/khung lấy từ bot đang chạy nên cần bot trả lời. Trên máy chủ: <code>docker compose logs --tail 50 live</code>.</p><button class="btn sm" type="button" data-retry="data">Thử lại</button>`)}</div>`;
    return;
  }
  const u = s.data_update || { enabled: false };
  const sum = dataSummary(s.data || [], s.timeframe);
  const upd = !u.enabled
    ? note("Hub KHÔNG tự cập nhật nến (hub.json \"lab_data_update\": false). Backtest chỉ chạy được tới ngày cuối ở dưới.", "warn")
    : `<p>${u.running ? `<span class="pill warn">Đang tải nến mới…</span> ` : `<span class="pill good">Tự cập nhật mỗi ngày</span> `}
        lần gần nhất: <b>${u.last_ok ? esc(ago(Date.parse(u.last_ok))) : "chưa lần nào"}</b>${u.last_ok ? ` <span class="hint">(${esc(new Date(u.last_ok).toLocaleString("vi-VN"))})</span>` : ""}</p>
       ${u.last_error ? note(`Lần tải trước lỗi: ${u.last_error}`, "err") : ""}
       ${u.last_ok && Date.now() - Date.parse(u.last_ok) > 2 * 86400e3 ? note("Đã quá 2 ngày chưa cập nhật được — xem log hub trên máy chủ.", "warn") : ""}`;

  const blocks = sum.map((b) => {
    const roleText = b.role === "signal" ? `nến tín hiệu (${esc(b.tf)})` : `nến ${esc(b.tf)} để khớp lệnh trong nến`;
    const rows = b.coins.map((c) => `<tr><td>${esc(c.coin)}</td><td>${c.from ? esc(isoDay(c.from)) : `<span class="down">chưa có</span>`}</td><td>${c.to ? esc(isoDay(c.to)) + " " + esc(String(c.to).slice(11)) : "–"}</td></tr>`).join("");
    return card(`Nến ${b.tf}`, `
      <p>${b.from ? `Mọi coin đều có từ <b>${esc(isoDay(b.from))}</b> đến <b>${esc(isoDay(b.to))}</b>.` : `<span class="down">Chưa có nến ${esc(b.tf)}.</span>`}
        <span class="hint">Dùng làm ${roleText}.</span></p>
      ${b.missing.length ? note(`Thiếu ${b.tf} của ${b.missing.join(", ")}: backtest sẽ từ chối chạy cho tới khi hub tải xong.`, "err") : ""}
      <div class="tablewrap"><table><thead><tr><th>Coin</th><th>Từ ngày</th><th>Tới</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }).join("");

  root.innerHTML = `<div class="cards">
    ${card("Bot đang dùng", `<dl class="info">
      <dt>Coin</dt><dd>${(s.pairs || []).map((p) => `<span class="coinchip">${esc(p.split("/")[0])}</span>`).join("") || "–"}</dd>
      <dt>Khung nến</dt><dd>${esc(s.timeframe || "–")} (tín hiệu) + 15m (khớp lệnh khi backtest)</dd>
      <dt>Nguồn</dt><dd>Binance Futures, tải bằng freqtrade download-data trên máy chủ</dd>
      <dt>Lưu ở</dt><dd><code>${esc(s.data_dir || "")}</code></dd></dl>`, { wide: true })}
    ${card("Cập nhật tự động", upd, { wide: true })}
    ${blocks || card("", `<p class="hint">Chưa có thông tin nến.</p>`)}
    ${card("", `<p class="hint">Backtest ở màn <a href="#backtest">Backtest</a> chỉ chạy trong khoảng mọi coin đều có nến. Lịch sử dài hơn: chạy <code>freqtrade download-data</code> với <code>--timerange</code> xa hơn trên máy chủ (hub chỉ tải tiếp từ nến cuối).</p>`, { wide: true })}
  </div>`;
}
