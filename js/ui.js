// Mảnh giao diện dùng chung: escape HTML, thẻ (card), ô số (kpi), trạng thái đang tải / trống / lỗi, toast, hộp xác nhận.
import { ApiError } from "./api.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Thẻ nội dung. opts: {id, cls, wide (chiếm cả hàng trên PC), hint (chữ nhỏ cạnh tiêu đề)}. */
export function card(title, body, { id = "", cls = "", wide = false, hint = "" } = {}) {
  return `<section class="card ${wide ? "wide" : ""} ${cls}" ${id ? `id="${id}"` : ""}>
    ${title ? `<h2>${esc(title)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ""}</h2>` : ""}${body}</section>`;
}

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
    ${retry ? `<button class="btn sm" type="button" data-retry="${esc(retry)}">Thử lại</button>` : ""}
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
 * {title, html, ok = "Đồng ý", cancel = "Huỷ", danger = false}
 */
export function confirm({ title, html, ok = "Đồng ý", cancel = "Huỷ", danger = false }) {
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
