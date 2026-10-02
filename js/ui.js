// Mảnh giao diện dùng chung: escape HTML, thẻ (card), ô số (kpi), trạng thái đang tải / trống / lỗi, toast, hộp xác nhận.
import { ApiError } from "./api.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Thẻ nội dung. opts: {id, cls, wide (chiếm cả hàng trên PC), hint (chữ nhỏ cạnh tiêu đề), tools (HTML nút icon bên phải tiêu đề)}. */
export function card(title, body, { id = "", cls = "", wide = false, hint = "", tools = "" } = {}) {
  return `<section class="card ${wide ? "wide" : ""} ${cls}" ${id ? `id="${id}"` : ""}>
    ${title ? `<h2>${esc(title)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ""}${tools ? `<span class="tools">${tools}</span>` : ""}</h2>` : ""}${body}</section>`;
}

/** Nút chỉ có icon (36px). name: refresh | send | play | off | reload | chevron | download. title = tooltip tiếng Việt. */
export function ibtn(name, { title = "", data = "", cls = "", disabled = false, id = "" } = {}) {
  return `<button class="ibtn ${cls}" type="button" ${id ? `id="${id}"` : ""} ${data} title="${esc(title)}" aria-label="${esc(title)}" ${disabled ? "disabled" : ""}>${ICONS[name] || ""}</button>`;
}
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
  play: svg('<path d="M6 4l14 8-14 8z"/>'),
  reload: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
  phone: svg('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>'),
  tg: svg('<path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/><path d="M9 13l10-9"/>'),
  shield: svg('<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  tag: svg('<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="8" cy="8" r="1.5"/>'),
  doc: svg('<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/>'),
  warn: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 18h.01"/>'),
};

/** Ô số: nhãn nhỏ + số to (+ dòng phụ). value đã là HTML an toàn. */
export function kpi(label, value, { cls = "", sub = "" } = {}) {
  return `<div class="kpi"><span class="kpi-label">${esc(label)}</span><b class="kpi-value ${cls}">${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
}

export const loading = (text = "Đang tải…") => `<div class="state loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
export const empty = (text, hint = "") => `<div class="state empty"><p>${esc(text)}</p>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;

/** Khối lỗi: nói lỗi gì và làm gì tiếp; có nút thử lại khi truyền `retry` (id nút). */
export function errorBox(err, { retry = "", title = "" } = {}) {
  const e = err instanceof ApiError ? err : { message: err?.message || String(err), hint: "" };
  return `<div class="state error" role="alert">
    <p class="err-title">${esc(title || (e.kind === "offline" ? "Không kết nối được" : "Có lỗi"))}</p>
    <p>${esc(e.message)}</p>
    ${e.hint ? `<p class="hint">${esc(e.hint)}</p>` : ""}
    ${retry ? `<button class="btn sm" type="button" data-retry="${esc(retry)}">Retry</button>` : ""}
  </div>`;
}

/** Thông báo ngắn kiểu "msg" trong thẻ: ok | warn | err. */
export const note = (text, kind = "warn") => (text ? `<div class="msg ${kind}">${esc(text)}</div>` : "");

let toastTimer = null;
/** Thông báo nổi ở dưới màn hình, tự tắt. */
export function toast(text, kind = "info", ms = 4000) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/**
 * Hộp xác nhận. html là nội dung (đã escape). Trả về Promise<boolean>.
 * {title, html, ok = "OK", cancel = "Cancel", danger = false}
 */
export function confirm({ title, html, ok = "OK", cancel = "Cancel", danger = false }) {
  const dlg = $("#confirm");
  if (!dlg) return Promise.resolve(window.confirm(title));
  $("#confirmTitle", dlg).textContent = title;
  $("#confirmBody", dlg).innerHTML = html;
  const yes = $("#confirmYes", dlg), no = $("#confirmNo", dlg);
  yes.textContent = ok; no.textContent = cancel;
  yes.className = `btn ${danger ? "danger" : "primary"}`;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); yes.onclick = no.onclick = dlg.oncancel = null; resolve(v); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    no.focus();
  });
}

/** Dòng "cập nhật … trước" + cảnh báo số liệu cũ khi mất kết nối. */
export function freshness(lastOkMs, failedSinceMs, agoFn) {
  if (!lastOkMs) return "";
  if (failedSinceMs) {
    return `<div class="msg err stale">Mất liên lạc với hub từ ${agoFn(failedSinceMs)}. Số liệu dưới đây là của ${agoFn(lastOkMs)}, có thể đã cũ.</div>`;
  }
  return `<p class="hint updated">Cập nhật ${agoFn(lastOkMs)}</p>`;
}
