// Proxy chỉ-đọc tới API công khai của Binance, dùng khi trình duyệt không gọi thẳng được (CORS, mạng chặn).
// Chạy ở Tokyo (xem vercel.json): hàm Vercel mặc định chạy ở Mỹ, mà Binance chặn truy cập từ Mỹ.
// Chỉ cho phép đúng các đường dẫn + tham số app cần, để không thành proxy mở.
//
// Gọi qua rewrite: /api/binance/<target>/<path>?symbol=..&interval=..&startTime=..&limit=..

const TARGETS = {
  fapi: { base: "https://fapi.binance.com", paths: ["/fapi/v1/klines", "/fapi/v1/fundingRate"] },
  spot: { base: "https://data-api.binance.vision", paths: ["/api/v3/klines"] },
};
const PARAMS = {
  symbol: /^[A-Z0-9]{2,20}$/,
  interval: /^(1|3|5|15|30)m$|^(1|2|4|6|8|12)h$|^(1|3)d$|^1w$|^1M$/,
  startTime: /^\d{1,13}$/,
  endTime: /^\d{1,13}$/,
  limit: /^\d{1,4}$/,
};

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
});

export async function proxy(request, fetchImpl = fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
  }
  if (request.method !== "GET") return json(405, { msg: "GET only" });
  const url = new URL(request.url);
  const target = TARGETS[url.searchParams.get("target")];
  const path = "/" + (url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!target || !target.paths.includes(path)) return json(404, { msg: "Path not allowed" });

  const q = new URLSearchParams();
  for (const [k, re] of Object.entries(PARAMS)) {
    const v = url.searchParams.get(k);
    if (v == null) continue;
    if (!re.test(v)) return json(400, { msg: `Invalid ${k}` });
    q.set(k, v);
  }
  if (!q.has("symbol")) return json(400, { msg: "Missing symbol" });
  if (+q.get("limit") > 1500) q.set("limit", "1500");

  let upstream;
  try {
    upstream = await fetchImpl(`${target.base}${path}?${q}`, { headers: { accept: "application/json" } });
  } catch (e) {
    return json(502, { msg: `Binance unreachable: ${e.message}` });
  }
  const headers = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "access-control-allow-origin": "*",
    // nến đã đóng không đổi: cache ngắn ở CDN để giảm số lần gọi Binance khi tải lại
    "cache-control": upstream.ok ? "public, s-maxage=60" : "no-store",
  };
  const retry = upstream.headers.get("retry-after");
  if (retry) headers["retry-after"] = retry;
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default { fetch: (request) => proxy(request) };
