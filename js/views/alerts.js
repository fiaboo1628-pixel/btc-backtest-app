// Màn Cảnh báo & báo cáo: thông báo đẩy tới máy này (push.py), kênh hiện có, cảnh báo gần đây (/api/alerts),
// báo cáo tuần (/api/weekly). Cuối trang: cài đặt gọn (giao diện, phiên bản, tải lại).
import { ago, dateTime, fmt, pct, signedPct } from "../format.js";
import { card, errorBox, esc, loading, note, toast, $ } from "../ui.js";
import { APP_VERSION } from "../version.js";

export const title = "Cảnh báo";

let root = null, ctx = null;
const push = { sub: null, checked: false, busy: false, msg: "", kind: "info" };
let info = null, infoErr = null, weekly = null, weeklyErr = null, weeklyLoading = false;

const canPush = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ios = typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent);
const standalone = typeof matchMedia !== "undefined" && (matchMedia("(display-mode: standalone)").matches || navigator.standalone);
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

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

function onClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.push && !push.busy) pushAction(b.dataset.push);
  else if (b.dataset.act === "weekly") loadWeekly();
  else if (b.dataset.theme) { localStorage.setItem("theme", b.dataset.theme); ctx.applyTheme(b.dataset.theme); paint(); }
  else if (b.dataset.act === "reload") reloadApp();
}

async function reloadApp() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    for (const r of regs || []) await r.update();
  } catch { /* bỏ qua */ }
  location.reload();
}

async function pushAction(what) {
  push.busy = true; push.msg = ""; paint();
  try {
    const reg = await navigator.serviceWorker.ready;
    if (what === "on") {
      if (await Notification.requestPermission() !== "granted") throw new Error("Thông báo đang bị chặn cho app này trong Cài đặt của máy.");
      const { key } = await ctx.api("/api/push/key");
      push.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await ctx.api("/api/push/subscribe", { method: "POST", body: push.sub.toJSON() });
      const t = await ctx.api("/api/push/test", { method: "POST" });
      push.msg = t.sent ? "Đã bật. Một thông báo thử đang tới máy này." : "Đã lưu, nhưng thông báo thử chưa tới được.";
      push.kind = t.sent ? "ok" : "warn";
    } else if (what === "test") {
      if (push.sub) await ctx.api("/api/push/subscribe", { method: "POST", body: push.sub.toJSON() });   // đăng ký lại phòng hub đã xoá
      const t = await ctx.api("/api/push/test", { method: "POST" });
      push.msg = t.sent ? `Đã gửi tới ${t.sent} máy.` : "Không máy nào nhận — tắt rồi bật lại thông báo.";
      push.kind = t.sent ? "ok" : "warn";
    } else if (what === "off" && push.sub) {
      await ctx.api("/api/push/unsubscribe", { method: "POST", body: push.sub.toJSON() });
      await push.sub.unsubscribe();
      push.sub = null; push.msg = "Đã tắt thông báo trên máy này."; push.kind = "info";
    }
    info = await ctx.api("/api/alerts").catch(() => info);
  } catch (e) {
    push.msg = `Không làm được: ${e.message}`; push.kind = "err";
  } finally { push.busy = false; paint(); }
}

function pushCard() {
  let body;
  if (!canPush) {
    body = ios && !standalone
      ? `<p class="hint">Trên iPhone: trong Safari bấm <b>Chia sẻ → Thêm vào MH chính</b>, mở app từ biểu tượng đó rồi quay lại đây để bật.</p>`
      : `<p class="hint">Trình duyệt này không nhận được thông báo đẩy.</p>`;
  } else if (!push.checked) body = loading("Đang kiểm tra…");
  else if (swFailed) body = `<p class="hint">Không khởi động được phần nhận thông báo của app (service worker). Đóng app, mở lại rồi thử; trên iPhone phải mở từ biểu tượng ở màn hình chính.</p>`;
  else if (push.sub) {
    body = `<p><span class="pill good">Đang bật trên máy này</span></p><p class="hint">Bạn sẽ nhận thông báo khi bot dừng, kẹt, mất stop trên sàn, tự dừng vì sụt vốn, hoặc log có lỗi; và khi hub không tải được nến.</p>
      <div class="row"><button class="btn sm" type="button" data-push="test" ${push.busy ? "disabled" : ""}>Gửi thử</button>
      <button class="btn sm" type="button" data-push="off" ${push.busy ? "disabled" : ""}>Tắt trên máy này</button></div>`;
  } else {
    body = `<p class="hint">Nhận thông báo trên máy này khi bot dừng, kẹt, mất stop trên sàn, tự dừng vì sụt vốn, hoặc log có lỗi.</p>
      <div class="row"><button class="btn primary" type="button" data-push="on" ${push.busy ? "disabled" : ""}>Bật thông báo</button></div>`;
  }
  return `${body}${push.msg ? note(push.msg, push.kind) : ""}`;
}

function paint() {
  if (!root) return;
  const live = ctx.store.hub?.features?.live;
  const ch = info?.channels || {};
  const none = live && info && !ch.telegram && !ch.devices;
  const channels = !live ? `<p class="hint">Hub chưa bật phần theo dõi bot nên chưa canh được bot.</p>`
    : infoErr ? errorBox(infoErr, { retry: "alerts", title: "Không hỏi được hub" })
    : `<dl class="info">
        <dt>Điện thoại</dt><dd>${ch.devices ? `${ch.devices} máy đã bật` : "chưa máy nào"}</dd>
        <dt>Telegram</dt><dd>${ch.telegram ? "đã bật" : "chưa cấu hình (docker compose run --rm setup --no-download --telegram)"}</dd>
        <dt>Đang báo</dt><dd>${info.active?.length ? info.active.map((a) => `<div class="down">${esc(a)}</div>`).join("") : `<span class="up">không có sự cố</span>`}</dd></dl>
      ${none ? note("Chưa có kênh nào: nếu bot dừng hay mất stop, không ai được báo. Bật thông báo ở trên.", "warn") : ""}`;

  const recent = !live || infoErr ? "" : (info?.recent?.length
    ? `<div class="list">${info.recent.slice(0, 30).map((r) => `<div class="alert-row"><span>${esc(r.msg)}</span><small>${esc(dateTime(r.t * 1000))} · ${esc(ago(r.t * 1000))}${r.ok === false ? ' · <span class="down">không gửi được</span>' : ""}</small></div>`).join("")}</div>`
    : `<p class="hint">Chưa có cảnh báo nào. Hub canh bot mỗi phút: không trả lời, không xử lý nến quá 3 phút, bị dừng, lệnh mở không có stop trên sàn, log lỗi.</p>`);

  const wk = !live ? "" : weeklyLoading ? loading("Đang tính báo cáo…")
    : weeklyErr ? errorBox(weeklyErr, { title: "Không lấy được báo cáo" }) + `<button class="btn sm" type="button" data-act="weekly">Thử lại</button>`
    : weekly ? weeklyHtml(weekly)
    : `<p class="hint">Bot có giữ được lợi thế của backtest không: số lệnh, thắng, PF, lãi, sụt vốn — so với kỳ vọng. Hub tự gửi mỗi thứ Hai 08:00.</p><button class="btn sm" type="button" data-act="weekly">Xem báo cáo bây giờ</button>`;

  const theme = localStorage.getItem("theme") || "system";
  root.innerHTML = `<div class="cards">
    ${card("Thông báo trên máy này", pushCard())}
    ${card("Kênh cảnh báo", channels)}
    ${live ? card("Báo cáo tuần", wk, { wide: true }) : ""}
    ${live ? card("Cảnh báo gần đây", recent, { wide: true, hint: info?.recent?.length ? `${info.recent.length} tin` : "" }) : ""}
    ${card("Ứng dụng", `<dl class="info">
        <dt>Giao diện</dt><dd><div class="seg" role="group" aria-label="Giao diện">
          <button type="button" data-theme="system" aria-pressed="${theme === "system"}">Theo máy</button>
          <button type="button" data-theme="light" aria-pressed="${theme === "light"}">Sáng</button>
          <button type="button" data-theme="dark" aria-pressed="${theme === "dark"}">Tối</button></div></dd>
        <dt>Phiên bản</dt><dd>${esc(APP_VERSION)} <button class="btn sm" type="button" data-act="reload" style="margin-left:8px">Tải lại app</button></dd>
        <dt>Đăng nhập</dt><dd>${esc(ctx.store.hub?.user || "–")}</dd>
        <dt>Bảo mật</dt><dd class="hint">App chỉ nói chuyện với hub qua Tailscale; mật khẩu bot và API key ở trên máy chủ, không có trong app.</dd></dl>`, { wide: true })}
  </div>`;
}

function weeklyHtml(w) {
  const row = (name, s) => {
    if (!s) return "";
    if (s.error) return `<tr><td>${esc(name)}</td><td colspan="5" class="down">không đọc được: ${esc(s.error)}</td></tr>`;
    if (!s.n) return `<tr><td>${esc(name)}</td><td colspan="5" class="hint">chưa có lệnh đóng</td></tr>`;
    return `<tr><td>${esc(name)}</td><td>${s.n}</td><td>${s.win_pct != null ? pct(s.win_pct, 0) : "–"}</td><td>${s.pf == null ? "∞" : fmt(s.pf, 2)}</td><td class="${s.pnl_pct > 0 ? "up" : s.pnl_pct < 0 ? "down" : ""}">${signedPct(s.pnl_pct, 1)}</td><td>${pct(s.dd_pct, 1)}</td></tr>`;
  };
  return `<div class="tablewrap"><table><thead><tr><th>Bot</th><th>Lệnh</th><th>Thắng</th><th>PF</th><th>Lãi</th><th>DD</th></tr></thead>
    <tbody>${row("Demo / thật", w.demo)}${row("Paper", w.paper)}</tbody></table></div>
    ${w.match ? `<p class="hint">Demo và paper trùng ${w.match.both} lệnh (Demo ${w.match.demo}, paper ${w.match.paper}). Paper chạy dry-run trên nến sàn thật nên là "lệnh mô phỏng" để so.</p>` : ""}
    <pre class="pre">${esc(w.text || "")}</pre>
    <button class="btn sm" type="button" data-act="weekly">Tính lại</button>`;
}
