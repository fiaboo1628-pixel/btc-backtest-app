// Service worker: lưu sẵn file của app để mở được khi không có mạng. Dữ liệu nến nằm trong IndexedDB.
const CACHE = "backtest-v15";
const FILES = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg",
  "js/app.js", "js/data.js", "js/catalog.js", "js/rules.js", "js/engine.js", "js/indicators.js",
  "js/timeframes.js", "js/worker.js", "js/replay.js", "js/live.js", "js/botparams.js", "vendor/lightweight-charts.js",
  "presets/index.json", "presets/donchian_revert.json", "presets/bb_revert.json", "presets/trend_1h_filter.json",
  "presets/msb_ob_retest.json",
];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return; // API Binance đi thẳng
  if (url.pathname.startsWith("/api/")) return;                               // proxy nến: không lưu (đã có IndexedDB)
  // mạng trước (luôn lấy bản mới), mất mạng thì dùng bản đã lưu
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || Response.error())));
});

// Cảnh báo bot từ hub (bot/hub/push.py): hiện thông báo, bấm vào thì mở app.
self.addEventListener("push", (e) => {
  let m = { title: "Bot alert", body: "" };
  try { m = { ...m, ...e.data.json() }; } catch { m.body = e.data?.text() || ""; }
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, icon: "icons/icon.svg", tag: m.body.slice(0, 60) }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => {
    const w = ws.find((c) => new URL(c.url).origin === location.origin);
    return w ? w.focus() : self.clients.openWindow("./");
  }));
});
