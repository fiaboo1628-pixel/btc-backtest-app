// Màn Alerts: kênh cảnh báo hiện có, sự cố đang báo, cảnh báo gần đây (/api/alerts), báo cáo tuần (/api/weekly).
// Cuối trang: thông tin app (phiên bản, tải lại). Bật/tắt thông báo trên máy này: nút chuông ở thanh tiêu đề (push.js).
import { ago, dateTime, fmt, pct, signedPct } from "../format.js";
import { ICONS, card, errorBox, esc, ibtn, loading, toast } from "../ui.js";
import { APP_VERSION } from "../version.js";

export const title = "Alerts";

let root = null, ctx = null;
let info = null, infoErr = null, weekly = null, weeklyErr = null, weeklyLoading = false;

export function mount(el, c) {
  root = el; ctx = c;
  root.addEventListener("click", onClick);
  root.innerHTML = `<div class="cards">${card("", loading())}</div>`;
  load();
}
export function unmount() { root?.removeEventListener("click", onClick); root = null; }
export function refresh() { load(); }

async function load() {
  if (!ctx.store.hub?.features?.live) { info = null; infoErr = null; paint(); return; }
  try { info = await ctx.api("/api/alerts"); infoErr = null; } catch (e) { infoErr = e; }
  paint();
}

async function loadWeekly() {
  weeklyLoading = true; weeklyErr = null; paint();
  try { weekly = await ctx.api("/api/weekly", { timeout: 40000 }); } catch (e) { weeklyErr = e; }
  weeklyLoading = false; paint();
}

function onClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.act === "weekly") loadWeekly();
  else if (b.dataset.act === "reload") reloadApp();
}

async function reloadApp() {
  toast("Đang tải lại app…", "info", 2000);
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    for (const r of regs || []) await r.update();
  } catch { /* bỏ qua */ }
  location.reload();
}

/** Hàng cài đặt gọn: icon · nhãn + chú thích · trạng thái/điều khiển. */
const row = (icon, iconCls, label, small, ctl) => `<div class="srow"><span class="ic ${iconCls}">${ICONS[icon] || ""}</span>
  <span class="lbl"><b>${esc(label)}</b>${small ? `<small>${small}</small>` : ""}</span><span class="ctl">${ctl}</span></div>`;
const st = (text, cls = "") => `<span class="st ${cls}">${esc(text)}</span>`;

function paint() {
  if (!root) return;
  const live = ctx.store.hub?.features?.live;
  const ch = info?.channels || {};
  const incidents = info?.active || [];

  const channels = !live ? `<p class="hint">Hub chưa bật phần theo dõi bot nên chưa canh được bot.</p>`
    : infoErr ? errorBox(infoErr, { retry: "alerts", title: "Không hỏi được hub" })
    : `<div class="rows">
        ${row("phone", ch.devices ? "on" : "", "Devices", ch.devices ? `${ch.devices} máy đang nhận thông báo` : "Chưa máy nào bật thông báo", st(String(ch.devices || 0), ch.devices ? "on" : ""))}
        ${row("tg", ch.telegram ? "on" : "", "Telegram", ch.telegram ? "Hub gửi cảnh báo và báo cáo tuần qua Telegram" : "Chưa cấu hình · trên máy chủ chạy <code>setup --telegram</code>", st(ch.telegram ? "Connected" : "Not set", ch.telegram ? "on" : ""))}
        ${row("shield", incidents.length ? "bad" : "on", "Incidents", incidents.length ? "Sự cố hub đang báo, kiểm tra lại mỗi phút" : "Không có sự cố", st(incidents.length ? String(incidents.length) : "None", incidents.length ? "bad" : "on"))}
        ${incidents.map((a) => `<div class="incident">${esc(a)}</div>`).join("")}
      </div>`;

  const recent = !live || infoErr ? "" : (info?.recent?.length
    ? `<div class="list">${info.recent.slice(0, 30).map((r) => `<div class="alert-row"><span>${esc(r.msg)}</span><small>${esc(dateTime(r.t * 1000))} · ${esc(ago(r.t * 1000))}${r.ok === false ? ' · <span class="down">không gửi được</span>' : ""}</small></div>`).join("")}</div>`
    : `<p class="hint">Chưa có cảnh báo nào.</p>`);

  const wk = !live ? "" : weeklyLoading ? loading("Đang tính báo cáo…")
    : weeklyErr ? errorBox(weeklyErr, { title: "Không lấy được báo cáo" })
    : weekly ? weeklyHtml(weekly)
    : `<p class="hint">Bấm ▸ để xem báo cáo.</p>`;
  const wkTools = ibtn(weekly ? "refresh" : "play", { title: weekly ? "Tính lại báo cáo" : "Xem báo cáo bây giờ", data: 'data-act="weekly"', cls: "sm accent", disabled: weeklyLoading });

  root.innerHTML = `<div class="cards">
    ${card("Notifications", channels, { wide: true })}
    ${live ? card("Weekly report", wk, { wide: true, tools: wkTools }) : ""}
    ${live ? card("Recent alerts", recent, { wide: true, hint: info?.recent?.length ? `${info.recent.length}` : "" }) : ""}
    ${card("App", `<div class="rows">
        ${row("tag", "", "Version", "", `${st(APP_VERSION)}${ibtn("reload", { title: "Tải lại app", data: 'data-act="reload"', cls: "sm" })}`)}
        ${row("user", "", "Account", "", st(ctx.store.hub?.user || "–"))}
        ${row("shield", "", "Security", "", st("Tailscale", "on"))}
      </div>`, { wide: true })}
  </div>`;
}

function weeklyHtml(w) {
  const r = (name, s) => {
    if (!s) return "";
    if (s.error) return `<tr><td>${esc(name)}</td><td colspan="5" class="down">không đọc được: ${esc(s.error)}</td></tr>`;
    if (!s.n) return `<tr><td>${esc(name)}</td><td colspan="5" class="hint">chưa có lệnh đóng</td></tr>`;
    return `<tr><td>${esc(name)}</td><td>${s.n}</td><td>${s.win_pct != null ? pct(s.win_pct, 0) : "–"}</td><td>${s.pf == null ? "∞" : fmt(s.pf, 2)}</td><td class="${s.pnl_pct > 0 ? "up" : s.pnl_pct < 0 ? "down" : ""}">${signedPct(s.pnl_pct, 1)}</td><td>${pct(s.dd_pct, 1)}</td></tr>`;
  };
  return `<div class="tablewrap"><table><thead><tr><th>Bot</th><th>Trades</th><th>Win</th><th>PF</th><th>P&L</th><th>DD</th></tr></thead>
    <tbody>${r("Demo / live", w.demo)}${r("Paper", w.paper)}</tbody></table></div>
    ${w.match ? `<p class="hint">Demo và paper trùng ${w.match.both} lệnh (Demo ${w.match.demo}, paper ${w.match.paper}). Paper chạy dry-run trên nến sàn thật nên là "lệnh mô phỏng" để so.</p>` : ""}
    <pre class="pre">${esc(w.text || "")}</pre>`;
}
