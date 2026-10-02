// Mọi file JS của app phải qua `node --check` (sw.js không phải ES module nhưng vẫn phải đúng cú pháp).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = ["sw.js", ...readdirSync("js").filter((f) => f.endsWith(".js")).map((f) => `js/${f}`),
  ...readdirSync("js/views").filter((f) => f.endsWith(".js")).map((f) => `js/views/${f}`)];

for (const f of files) {
  test(`node --check ${f}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }));
  });
}

test("sw.js liệt kê đúng các file vỏ app đang có và cùng phiên bản với js/version.js", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const sw = readFileSync("sw.js", "utf8");
  const { APP_VERSION } = await import("../js/version.js");
  assert.ok(sw.includes(`"bot-app-${APP_VERSION}"`), "CACHE trong sw.js phải = bot-app-<APP_VERSION>");
  const listed = [...sw.matchAll(/"(js\/[^"]+|css\/[^"]+|icons\/[^"]+)"/g)].map((m) => m[1]);
  for (const f of listed) assert.ok(existsSync(f), `${f} trong sw.js không tồn tại`);
  for (const f of files.filter((x) => x !== "sw.js")) assert.ok(listed.includes(f), `${f} chưa có trong sw.js`);
});
