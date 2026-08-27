import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url()));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.click('button[role="switch"]');
await page.waitForTimeout(400);
const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("BRAND_PAGE_HEIGHT", total);
for (const frac of [0.3, 0.55, 0.8, 1]) {
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(total * frac));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `brand-full-${frac}.png`) });
}
console.log("ERRORS", JSON.stringify(errors));
await browser.close();
