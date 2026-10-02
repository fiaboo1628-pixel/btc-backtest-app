// Màn Alerts: thông báo đẩy tới máy này (push.py) dưới dạng hàng công tắc gọn, kênh hiện có, sự cố đang báo,
// cảnh báo gần đây (/api/alerts), báo cáo tuần (/api/weekly). Cuối trang: thông tin app (phiên bản, tải lại).
// Phản hồi thao tác (bật/tắt/gửi thử) hiện bằng toast, không chiếm chỗ trong thẻ.
import { ago, dateTime, fmt, pct, signedPct } from "../format.js";
import { ICONS, card, errorBox, esc, ibtn, loading, note, toast } from "../ui.js";
import { APP_VERSION } from "../version.js";

export const title = "Alerts";

let root = null, ctx = null;
const push = { sub: null, checked: false, busy: false };
let info = null, infoErr = null, weekly = null, weeklyErr = null, weeklyLoading = false;

const canPush = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ios = typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent);
const standalone = typeof matchMedia !== "undefined" && (matchMedia("(display-mode: standalone)").matches || navigator.standalone);
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function mount(el, c) {
  root = el; ctx = c;
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.innerHTML = `<div class="cards">${card("", loading())}</div>`;
  load();
}
export function unmount() { root?.removeEventListener("click", onClick); root?.removeEventListener("change", onChange); root = null; }
export function refresh() { load(); }

async function load() {
  if (!ctx.store.hub?.features?.live) { info = null; infoErr = null; paint(); return; }
  try { info = await ctx.api("/api/alerts"); infoErr = null; } catch (e) { infoErr = e; }
  paint();
  checkPush();
}

let swFailed = false;
async function checkPush() {
  if (!canPush || push.checked) return;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error("sw")), 5000))]);
    push.sub = await reg.pushManager.getSubscription();
  } catch { push.sub = null; swFailed = true; }
  push.checked = true; paint();
}

async function loadWeekly() {
  weeklyLoading = true; weeklyErr = null; paint();
  try { weekly = await ctx.api("/api/weekly", { timeout: 40000 }); } catch (e) { weeklyErr = e; }
  weeklyLoading = false; paint();
}

function onChange(e) {
  const t = e.target;
  if (t.id === "pushToggle" && !push.busy) pushAction(t.checked ? "on" : "off");
}
function onClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.push && !push.busy) pushAction(b.dataset.push);
  else if (b.dataset.act === "weekly") loadWeekly();
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

async function pushAction(what) {
  push.busy = true; paint();
  try {
    const reg = await navigator.serviceWorker.ready;
    if (what === "on") {
      if (await Notification.requestPermission() !== "granted") throw new Error("Thông báo đang bị chặn cho app này trong Cài đặt của máy.");
      const { key } = await ctx.api("/api/push/key");
      push.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await ctx.api("/api/push/subscribe", { method: "POST", body: push.sub.toJSON() });
      const t = await ctx.api("/api/push/test", { method: "POST" });
      toast(t.sent ? "Đã bật. Một thông báo thử đang tới máy này." : "Đã lưu, nhưng thông báo thử chưa tới được.", t.sent ? "ok" : "info", 5000);
    } else if (what === "test") {
      if (push.sub) await ctx.api("/api/push/subscribe", { method: "POST", body: push.sub.toJSON() });   // đăng ký lại phòng hub đã xoá
      const t = await ctx.api("/api/push/test", { method: "POST" });
      toast(t.sent ? `Đã gửi thử tới ${t.sent} máy.` : "Không máy nào nhận — tắt rồi bật lại thông báo.", t.sent ? "ok" : "err", 5000);
    } else if (what === "off" && push.sub) {
      await ctx.api("/api/push/unsubscribe", { method: "POST", body: push.sub.toJSON() });
      await push.sub.unsubscribe();
      push.sub = null; toast("Đã tắt thông báo trên máy này.", "info");
    }
    info = await ctx.api("/api/alerts").catch(() => info);
  } catch (e) {
    toast(`Không làm được: ${e.message}`, "err", 6000);
  } finally { push.busy = false; paint(); }
}

/** Hàng cài đặt gọn: icon · nhãn + chú thích · trạng thái/điều khiển. */
const row = (icon, iconCls, label, small, ctl) => `<div class="srow"><span class="ic ${iconCls}">${ICONS[icon] || ""}</span>
  <span class="lbl"><b>${esc(label)}</b>${small ? `<small>${small}</small>` : ""}</span><span class="ctl">${ctl}</span></div>`;
const st = (text, cls = "") => `<span class="st ${cls}">${esc(text)}</span>`;

function pushRow() {
  const why = "Báo khi bot dừng, kẹt, mất stop trên sàn, tự dừng vì sụt vốn, log lỗi, hub không tải được nến.";
  if (!canPush) {
    const small = ios && !standalone
      ? "Trên iPhone: Safari → <b>Chia sẻ → Thêm vào MH chính</b>, mở app từ biểu tượng đó rồi bật ở đây."
      : "Trình duyệt này không nhận được thông báo đẩy.";
    return row("bell", "", "This device", small, st("Unavailable"));
  }
  if (!push.checked) return row("bell", "", "This device", esc(why), `<span class="spinner" aria-hidden="true"></span>`);
  if (swFailed) return row("bell", "bad", "This device", "Không khởi động được phần nhận thông báo (service worker). Đóng app, mở lại rồi thử; trên iPhone phải mở từ biểu tượng ở màn hình chính.", st("Error", "bad"));
  const on = !!push.sub;
  return row("bell", on ? "on" : "", "This device", esc(why),
    `${on ? ibtn("send", { title: "Gửi thông báo thử", data: 'data-push="test"', cls: "sm", disabled: push.busy }) : ""}
     <label class="switch sm" title="${on ? "Tắt thông báo trên máy này" : "Bật thông báo trên máy này"}"><input type="checkbox" id="pushToggle" ${on ? "checked" : ""} ${push.busy ? "disabled" : ""}><span></span></label>`);
}

function paint() {
  if (!root) return;
  const live = ctx.store.hub?.features?.live;
  const ch = info?.channels || {};
  const incidents = info?.active || [];

  const channels = !live ? `<p class="hint">Hub chưa bật phần theo dõi bot nên chưa canh được bot.</p>`
    : infoErr ? errorBox(infoErr, { retry: "alerts", title: "Không hỏi được hub" })
    : `<div class="rows">
        ${pushRow()}
        ${row("phone", ch.devices ? "on" : "", "Devices", ch.devices ? `${ch.devices} máy đang nhận thông báo` : "Chưa máy nào bật thông báo", st(String(ch.devices || 0), ch.devices ? "on" : ""))}
        ${row("tg", ch.telegram ? "on" : "", "Telegram", ch.telegram ? "Hub gửi cảnh báo và báo cáo tuần qua Telegram" : "Chưa cấu hình · trên máy chủ chạy <code>setup --telegram</code>", st(ch.telegram ? "Connected" : "Not set", ch.telegram ? "on" : ""))}
        ${row("shield", incidents.length ? "bad" : "on", "Incidents", incidents.length ? "Sự cố hub đang báo, kiểm tra lại mỗi phút" : "Không có sự cố", st(incidents.length ? String(incidents.length) : "None", incidents.length ? "bad" : "on"))}
        ${incidents.map((a) => `<div class="incident">${esc(a)}</div>`).join("")}
      </div>`;

  const recent = !live || infoErr ? "" : (info?.recent?.length
    ? `<div class="list">${info.recent.slice(0, 30).map((r) => `<div class="alert-row"><span>${esc(r.msg)}</span><small>${esc(dateTime(r.t * 1000))} · ${esc(ago(r.t * 1000))}${r.ok === false ? ' · <span class="down">không gửi được</span>' : ""}</small></div>`).join("")}</div>`
    : `<p class="hint">Chưa có cảnh báo nào. Hub canh bot mỗi phút: không trả lời, không xử lý nến quá 3 phút, bị dừng, lệnh mở không có stop trên sàn, log lỗi.</p>`);

  const wk = !live ? "" : weeklyLoading ? loading("Đang tính báo cáo…")
    : weeklyErr ? errorBox(weeklyErr, { title: "Không lấy được báo cáo" })
    : weekly ? weeklyHtml(weekly)
    : `<p class="hint">Bot có giữ được lợi thế của backtest không: số lệnh, thắng, PF, lãi, sụt vốn — so với kỳ vọng. Hub tự gửi mỗi thứ Hai 08:00. Bấm ▸ để xem ngay.</p>`;
  const wkTools = ibtn(weekly ? "refresh" : "play", { title: weekly ? "Tính lại báo cáo" : "Xem báo cáo bây giờ", data: 'data-act="weekly"', cls: "sm accent", disabled: weeklyLoading });

  root.innerHTML = `<div class="cards">
    ${card("Notifications", channels, { wide: true })}
    ${live ? card("Weekly report", wk, { wide: true, tools: wkTools }) : ""}
    ${live ? card("Recent alerts", recent, { wide: true, hint: info?.recent?.length ? `${info.recent.length}` : "" }) : ""}
    ${card("App", `<div class="rows">
        ${row("tag", "", "Version", "Bấm ↻ để kiểm tra bản mới và tải lại", `${st(APP_VERSION)}${ibtn("reload", { title: "Tải lại app", data: 'data-act="reload"', cls: "sm" })}`)}
        ${row("user", "", "Account", "", st(ctx.store.hub?.user || "–"))}
        ${row("shield", "", "Security", "App chỉ nói chuyện với hub qua Tailscale; mật khẩu bot và API key ở trên máy chủ, không có trong app.", st("Tailscale", "on"))}
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
