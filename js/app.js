// Khung app: chuyển màn hình theo #hash, thanh tab, lấy /api/live chung cho mọi màn (15 s khi app đang hiện),
// báo mất mạng / hub không trả lời, giao diện sáng/tối, đăng ký service worker.
import { api } from "./api.js";
import { modeInfo } from "./format.js";
import { $, $$, esc, toast } from "./ui.js";
import { APP_VERSION } from "./version.js";
import { initBell } from "./push.js";
import * as overview from "./views/overview.js";
import * as trades from "./views/trades.js";
import * as backtest from "./views/backtest.js";
import * as data from "./views/data.js";
import * as alerts from "./views/alerts.js";

const VIEWS = { overview, trades, backtest, data, alerts };
const LIVE_MS = 15000;

/** Bộ nhớ chung: /api/live mới nhất + ai đang nghe. Màn Tổng quan, Lệnh và tiêu đề dùng chung một lần gọi. */
const store = {
  hub: null,                 // /api/hub
  live: null, liveAt: 0, liveErr: null, failedSince: 0,
  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) { try { fn(this); } catch (e) { console.error(e); } } },
};

let liveTimer = null, liveBusy = false;
async function pollLive(force = false) {
  if (liveBusy || (document.hidden && !force)) return;
  if (store.hub && !store.hub.features?.live) return;
  liveBusy = true;
  try {
    const j = await api("/api/live");
    store.live = j; store.liveAt = Date.now(); store.liveErr = null; store.failedSince = 0;
  } catch (e) {
    store.liveErr = e;
    store.failedSince ||= Date.now();
  } finally {
    liveBusy = false;
    paintHeader();
    store.emit();
  }
}

function paintHeader() {
  const pill = $("#modePill");
  const s = store.live;
  if (!s) { pill.hidden = true; return; }
  pill.hidden = false;
  if (!s.reachable || store.failedSince) {
    pill.className = "pill mode-off"; pill.textContent = store.failedSince ? "Disconnected" : "Offline";
    pill.title = store.failedSince ? "Hub không trả lời" : "Hub không liên lạc được bot";
    return;
  }
  const m = modeInfo(s.mode);
  pill.className = `pill ${m.cls}`;
  pill.textContent = m.name;
  pill.title = m.help;
}

// ---------------------------------------------------------------- màn hình
let current = null;
const ctx = { api, store, pollLive, go: (id) => { location.hash = id; } };

function route() {
  const id = (location.hash || "#overview").slice(1).split("?")[0];
  const view = VIEWS[id] ? id : "overview";
  if (current?.id === view) { current.mod.refresh?.(); return; }
  current?.mod.unmount?.();
  const root = $("#view");
  root.innerHTML = "";
  root.scrollTop = 0; window.scrollTo(0, 0);
  const mod = VIEWS[view];
  current = { id: view, mod };
  $$("#tabbar a").forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle("active", on);
    a.setAttribute("aria-current", on ? "page" : "false");
  });
  $("#pageTitle").textContent = mod.title;
  document.title = `${mod.title} · Bot`;
  mod.mount(root, ctx);
}

/** Nút tải lại ở thanh tiêu đề: gọi refresh() của màn đang mở (và /api/live nếu có). */
let spinTimer = null;
function refreshNow() {
  const b = $("#btnRefresh");
  b.classList.add("spin"); clearTimeout(spinTimer); spinTimer = setTimeout(() => b.classList.remove("spin"), 900);
  if (store.hub?.features?.live) pollLive(true);
  current?.mod.refresh?.();
}

// ---------------------------------------------------------------- mạng
function paintNet() {
  const b = $("#netBanner");
  if (!navigator.onLine) { b.hidden = false; b.textContent = "Không có mạng — số liệu đang hiện có thể đã cũ."; return; }
  if (store.failedSince && store.liveAt) { b.hidden = false; b.textContent = `Hub không trả lời (${store.liveErr?.message || "lỗi"}). Đang thử lại…`; return; }
  b.hidden = true;
}
window.addEventListener("online", () => { paintNet(); pollLive(true); });
window.addEventListener("offline", paintNet);
store.subscribe(paintNet);

// ---------------------------------------------------------------- giao diện sáng/tối
export function applyTheme(t) {
  const v = t || localStorage.getItem("theme") || "system";
  if (v === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  const dark = v === "dark" || (v === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.dark = dark ? "1" : "0";
  $("#themeColor")?.setAttribute("content", dark ? "#0b0d12" : "#f3f5f9");
  const b = $("#btnTheme");
  if (b) b.title = v === "system" ? "Giao diện theo máy — bấm để đổi sáng/tối" : v === "dark" ? "Đang tối — bấm để chuyển sáng" : "Đang sáng — bấm để chuyển tối";
}
/** Nút ở thanh tiêu đề: đảo sáng ↔ tối (lưu lựa chọn). */
function toggleTheme() {
  const dark = document.documentElement.dataset.dark === "1";
  const v = dark ? "light" : "dark";
  localStorage.setItem("theme", v); applyTheme(v);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
ctx.applyTheme = applyTheme;

// ---------------------------------------------------------------- service worker
async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    if (!reg) return;
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) toast("Có bản mới của app — đóng rồi mở lại để cập nhật.", "info", 8000);
      });
    });
  } catch (e) { console.warn("Không đăng ký được service worker", e); }
}

// ---------------------------------------------------------------- khởi động
async function init() {
  applyTheme();
  $("#version").textContent = APP_VERSION;
  $("#view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-retry]");
    if (b) current?.mod.refresh?.(b.dataset.retry);
  });
  $("#btnRefresh").addEventListener("click", refreshNow);
  $("#btnTheme").addEventListener("click", toggleTheme);
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollLive(); current?.mod.refresh?.("visible"); } });
  try {
    store.hub = await api("/api/hub");
    $("#user").textContent = store.hub.user || "";
  } catch (e) {
    store.hub = { features: {}, error: e };
  }
  route();
  if (store.hub.features?.live) {
    pollLive(true);
    liveTimer = setInterval(pollLive, LIVE_MS);
  } else {
    store.live = null; store.emit();
  }
  registerSw();
  initBell(api, () => { if (current?.id === "alerts") current.mod.refresh?.(); });
}
init();
