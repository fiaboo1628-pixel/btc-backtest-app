// Proxy Binance (api/binance.js): chỉ cho phép đúng đường dẫn/tham số, chuyển tiếp đúng URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxy } from "../api/binance.js";

const call = async (qs, method = "GET") => {
  const seen = [];
  const fake = async (url) => { seen.push(url); return new Response("[[1,\"2\"]]", { status: 200, headers: { "content-type": "application/json" } }); };
  const r = await proxy(new Request(`https://x.vercel.app/api/binance?${qs}`, { method }), fake);
  return { r, seen, body: await r.text() };
};

test("chuyển tiếp nến futures với tham số hợp lệ", async () => {
  const { r, seen, body } = await call("target=fapi&path=fapi/v1/klines&symbol=BTCUSDT&interval=5m&startTime=1735689600000&limit=1000");
  assert.equal(r.status, 200);
  assert.equal(seen[0], "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=1735689600000&limit=1000");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(body, "[[1,\"2\"]]");
});

test("funding và spot đi đúng máy chủ", async () => {
  assert.equal((await call("target=fapi&path=fapi/v1/fundingRate&symbol=BTCUSDT&limit=1000")).seen[0],
    "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000");
  assert.equal((await call("target=spot&path=api/v3/klines&symbol=ETHUSDT&interval=1h&limit=2")).seen[0],
    "https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1h&limit=2");
});

test("chặn đường dẫn, tham số và phương thức không được phép", async () => {
  for (const [qs, code] of [
    ["target=fapi&path=fapi/v1/order&symbol=BTCUSDT", 404],          // API đặt lệnh
    ["target=evil&path=fapi/v1/klines&symbol=BTCUSDT", 404],
    ["target=spot&path=fapi/v1/klines&symbol=BTCUSDT", 404],         // sai máy chủ
    ["target=fapi&path=fapi/v1/klines&symbol=btc/../x", 400],
    ["target=fapi&path=fapi/v1/klines&symbol=BTCUSDT&interval=7m", 400],
    ["target=fapi&path=fapi/v1/klines&interval=5m", 400],            // thiếu symbol
  ]) {
    const { r, seen } = await call(qs);
    assert.equal(r.status, code, qs);
    assert.equal(seen.length, 0, `không được gọi Binance: ${qs}`);
  }
  assert.equal((await call("target=fapi&path=fapi/v1/klines&symbol=BTCUSDT", "POST")).r.status, 405);
});

test("bỏ tham số lạ, giới hạn limit", async () => {
  const { seen } = await call("target=fapi&path=fapi/v1/klines&symbol=BTCUSDT&interval=5m&limit=9999&signature=abc&apiKey=x");
  assert.equal(seen[0], "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=1500");
});
