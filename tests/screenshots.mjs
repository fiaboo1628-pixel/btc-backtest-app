// Chụp ảnh từng màn hình của app bằng Chromium headless (Playwright) ở 390px (iPhone) và 1280px (PC), kiểm tra
// không lỗi console, không cuộn ngang. Không chạy trong `npm test` (cần playwright + hub giả).
//
//   uv run ... python bot/hub/dev.py --scenario demo --port 8090 &
//   NODE_PATH=$(npm root -g) node tests/screenshots.mjs --base http://127.0.0.1:8090 --out docs/screenshots --prefix demo [--full]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", "http://127.0.0.1:8090"), OUT = arg("--out", "docs/screenshots"), PREFIX = arg("--prefix", "demo");
const FULL = process.argv.includes("--full");              // chụp cả quy trình backtest + hộp xác nhận
const ONLY = arg("--screens", "");                          // vd --screens overview,trades
const { chromium } = createRequire(import.meta.url)("playwright");   // require (CJS) đọc được NODE_PATH
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems = [];
const SCREENS = ["overview", "trades", "backtest", "data", "alerts"].filter((x) => !ONLY || ONLY.split(",").includes(x));
const STATIC_BARS = ".tabbar,.actionbar{position:static!important}.appbar{position:static!important}";   // chụp cả trang: thanh cố định không lặp giữa trang

async function shoot(width, dark) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 800 }, deviceScaleFactor: width < 600 ? 2 : 1,
    httpCredentials: { username: "admin", password: "dev" }, colorScheme: dark ? "dark" : "light", locale: "vi-VN",
    isMobile: width < 600, hasTouch: width < 600,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`[${width}] console.${m.type()}: ${m.text()}`); });
  const full = async (path) => { await page.addStyleTag({ content: STATIC_BARS }); await page.screenshot({ path, fullPage: true }); await page.reload({ waitUntil: "networkidle" }); };
  page.on("pageerror", (e) => problems.push(`[${width}] pageerror: ${e.message}`));
  const tag = `${PREFIX}-${width}${dark ? "-dark" : ""}`;
  for (const s of SCREENS) {
    await page.goto(`${BASE}/#${s}`, { waitUntil: "networkidle" });
    await page.evaluate((id) => { location.hash = id; }, s);
    await page.waitForTimeout(900);
    await page.waitForLoadState("networkidle");
    await check(page, width, s);
    await page.screenshot({ path: `${OUT}/${tag}-${s}.png` });                      // đúng cỡ màn hình
    await full(`${OUT}/${tag}-${s}-full.png`);
    if (s === "backtest" && FULL) {
      const run = page.locator("#btnRun");
      if (await run.count()) {
        await run.click();
        await page.waitForFunction(() => document.querySelector("#result table"), null, { timeout: 30000 }).catch(() => problems.push(`[${width}] backtest không ra kết quả`));
        await page.waitForTimeout(500);
        await check(page, width, "backtest-result");
        await page.addStyleTag({ content: STATIC_BARS });
        await page.locator("#resultBox").screenshot({ path: `${OUT}/${tag}-backtest-result.png` });
        await page.waitForFunction(() => document.querySelector("#chartBox .rp-price"), null, { timeout: 30000 }).catch(() => problems.push(`[${width}] biểu đồ chạy lại không hiện`));
        await page.waitForTimeout(400);
        await page.locator("#chartBox .rp-price").click({ position: { x: 60, y: 60 } }).catch(() => {});   // ghim chữ thập để thấy dòng thông tin nến
        await page.locator('#chartBox [data-rp="step"]').click().catch(() => {});                           // có con trỏ thời gian
        await page.waitForTimeout(300);
        await check(page, width, "backtest-chart");
        await page.locator("#chartBox").screenshot({ path: `${OUT}/${tag}-backtest-chart.png` });
        // đổi một tham số rồi mở hộp xác nhận
        await page.fill("#p_entry_period", "25");
        await page.dispatchEvent("#p_entry_period", "change");
        await page.click("#btnApply");
        await page.waitForSelector("dialog[open]");
        await page.screenshot({ path: `${OUT}/${tag}-backtest-confirm.png` });
        await page.click("#confirmNo");
      }
    }
  }
  await ctx.close();
}

async function check(page, width, s) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) problems.push(`[${width}] ${s}: cuộn ngang ${over}px`);
  const txt = await page.locator("#view").innerText();
  if (/undefined|NaN|\[object/.test(txt)) problems.push(`[${width}] ${s}: có chữ undefined/NaN`);
}

await shoot(390, true);
await shoot(1280, false);
await browser.close();
if (problems.length) { console.error("VẤN ĐỀ:\n" + problems.join("\n")); process.exit(1); }
console.log(`OK: ảnh trong ${OUT}/ (${PREFIX})`);
