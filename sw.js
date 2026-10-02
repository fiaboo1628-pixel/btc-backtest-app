// Service worker: lưu sẵn vỏ app (HTML, CSS, JS, icon) để mở nhanh và mở được khi mất mạng.
// Dữ liệu (/api/...) KHÔNG bao giờ cache — luôn lấy mới từ hub. Đổi CACHE mỗi lần phát hành (cùng js/version.js).
const CACHE = "bot-app-2026.10.03h";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "icons/icon.svg", "icons/icon-192.png",
  "js/app.js", "js/api.js", "js/format.js", "js/model.js", "js/ui.js", "js/chart.js", "js/version.js", "js/push.js",
  "js/views/overview.js", "js/views/trades.js", "js/views/backtest.js", "js/views/data.js", "js/views/alerts.js",
];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;                              // dữ liệu: đi thẳng, không cache
  // vỏ app: mạng trước (có bản mới thì dùng ngay), mất mạng thì lấy bản đã lưu
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
});

// Cảnh báo từ hub (bot/hub/push.py): hiện thông báo; bấm vào thì mở app.
self.addEventListener("push", (e) => {
  let m = { title: "Cảnh báo bot", body: "" };
  try { m = { ...m, ...e.data.json() }; } catch { m.body = e.data?.text() || ""; }
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, icon: "icons/icon-192.png", tag: m.body.slice(0, 60) }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => {
    const w = ws.find((c) => new URL(c.url).origin === location.origin);
    return w ? w.focus() : self.clients.openWindow("./#alerts");
  }));
});
