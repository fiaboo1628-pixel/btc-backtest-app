// Nút chuông trên thanh tiêu đề: bật/tắt thông báo đẩy tới máy này (hub push.py).
// Tắt → bấm để bật (kèm một thông báo thử). Bật → bấm, hỏi xác nhận rồi tắt.
import { $, confirm, toast } from "./ui.js";

const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ios = /iPhone|iPad/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let api = null, onChange = () => {}, sub = null, busy = false, swFailed = false;

function paint() {
  const b = $("#btnBell");
  const on = !!sub;
  b.classList.toggle("accent", on);
  b.disabled = busy;
  b.setAttribute("aria-pressed", String(on));
  b.querySelector(".ic-bell").style.display = on ? "" : "none";
  b.querySelector(".ic-bell-off").style.display = on ? "none" : "";
  b.title = !canPush ? "Máy này chưa nhận được thông báo đẩy"
    : on ? "Thông báo đang bật trên máy này — bấm để tắt" : "Bật thông báo trên máy này";
}

async function click() {
  if (busy) return;
  if (!canPush) {
    toast(ios && !standalone ? "Trên iPhone: Safari → Chia sẻ → Thêm vào MH chính, mở app từ biểu tượng đó rồi bấm chuông."
      : "Trình duyệt này không nhận được thông báo đẩy.", "info", 7000);
    return;
  }
  if (swFailed) { toast("Không khởi động được service worker. Đóng app, mở lại rồi thử.", "err", 7000); return; }
  if (sub && !(await confirm({ title: "Tắt thông báo?", html: "<p>Máy này sẽ không nhận thông báo khi bot dừng, kẹt, mất stop hay log lỗi.</p>", ok: "Turn off", danger: true }))) return;
  busy = true; paint();
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!sub) {
      if (await Notification.requestPermission() !== "granted") throw new Error("Thông báo đang bị chặn cho app này trong Cài đặt của máy.");
      const { key } = await api("/api/push/key");
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
      const t = await api("/api/push/test", { method: "POST" });
      toast(t.sent ? "Đã bật. Một thông báo thử đang tới máy này." : "Đã lưu, nhưng thông báo thử chưa tới được.", t.sent ? "ok" : "info", 5000);
    } else {
      await api("/api/push/unsubscribe", { method: "POST", body: sub.toJSON() });
      await sub.unsubscribe();
      sub = null; toast("Đã tắt thông báo trên máy này.", "info");
    }
    onChange();
  } catch (e) {
    toast(`Không làm được: ${e.message}`, "err", 6000);
  } finally { busy = false; paint(); }
}

/** Gắn nút chuông. apiFn: api() của app; changed: gọi sau khi bật/tắt (để màn Alerts cập nhật số máy). */
export async function initBell(apiFn, changed) {
  api = apiFn; onChange = changed;
  $("#btnBell").addEventListener("click", click);
  paint();
  if (!canPush) return;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error("sw")), 5000))]);
    sub = await reg.pushManager.getSubscription();
  } catch { swFailed = true; }
  paint();
}
