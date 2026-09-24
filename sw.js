// Service worker: lưu sẵn file của app để mở được khi không có mạng. Dữ liệu nến nằm trong IndexedDB.
const CACHE = "backtest-v5";
const FILES = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg",
  "js/app.js", "js/data.js", "js/catalog.js", "js/rules.js", "js/engine.js", "js/indicators.js",
  "js/timeframes.js", "js/worker.js",
  "presets/index.json", "presets/donchian_revert.json", "presets/bb_revert.json", "presets/trend_1h_filter.json",
];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return; // API Binance đi thẳng
  // mạng trước (luôn lấy bản mới), mất mạng thì dùng bản đã lưu
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
