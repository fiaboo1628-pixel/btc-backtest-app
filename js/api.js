// Một chỗ gọi API của hub: không cache, có thời gian chờ, lỗi đổi thành câu tiếng Việt + việc cần làm tiếp.

const TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, { status = 0, kind = "server", hint = "" } = {}) {
    super(message);
    this.status = status;   // mã HTTP (0 = không tới được hub)
    this.kind = kind;       // offline | timeout | auth | missing | busy | server
    this.hint = hint;       // làm gì tiếp
  }
}

const HINTS = {
  offline: "Kiểm tra mạng, Tailscale trên máy này và máy chủ nhà.",
  timeout: "Hub có thể đang bận (backtest/tải nến) hoặc máy chủ treo. Thử lại sau ít phút.",
  auth: "Mở lại app từ địa chỉ Tailscale, hoặc đăng nhập lại.",
  missing: "Hub chưa bật phần này (xem bot/deploy/hub.json: lab, live).",
  busy: "",
  server: "Xem log hub trên máy chủ: docker compose logs --tail 50 hub",
};

function fromStatus(status, detail) {
  if (status === 401) return new ApiError("Cần đăng nhập", { status, kind: "auth", hint: HINTS.auth });
  if (status === 403) return new ApiError(detail || "Hub từ chối yêu cầu", { status, kind: "auth", hint: HINTS.auth });
  if (status === 404 || status === 405) return new ApiError(detail || "Hub chưa có chức năng này", { status, kind: "missing", hint: HINTS.missing });
  if (status === 409) return new ApiError(detail || "Hub đang bận", { status, kind: "busy" });
  if (status === 400 || status === 422) return new ApiError(detail || "Dữ liệu gửi lên không hợp lệ", { status, kind: "busy" });
  if (status === 502) return new ApiError(detail || "Hub không gọi được bot", { status, kind: "server", hint: "Trên máy chủ: docker compose ps, docker compose logs --tail 50 live" });
  return new ApiError(detail || `Lỗi máy chủ hub (HTTP ${status})`, { status, kind: "server", hint: HINTS.server });
}

/**
 * api("/api/live") → JSON. api(path, {method: "POST", body: {...}}).
 * Ném ApiError với message tiếng Việt; hub trả {detail} thì lấy làm message.
 */
export async function api(path, { method = "GET", body, timeout = TIMEOUT_MS, signal } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("Không có mạng", { kind: "offline", hint: HINTS.offline });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  signal?.addEventListener("abort", () => ctl.abort());
  let r;
  try {
    r = await fetch(path, {
      method, cache: "no-store", signal: ctl.signal,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (ctl.signal.aborted && signal?.aborted) throw new ApiError("Đã huỷ", { kind: "busy" });
    if (ctl.signal.aborted) throw new ApiError("Hub không trả lời (quá 20 giây)", { kind: "timeout", hint: HINTS.timeout });
    throw new ApiError("Không kết nối được hub", { kind: "offline", hint: HINTS.offline });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await r.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const d = data && typeof data.detail === "string" ? data.detail : (Array.isArray(data?.detail) ? data.detail.map((x) => x.msg).join("; ") : "");
    throw fromStatus(r.status, d);
  }
  return data;
}
