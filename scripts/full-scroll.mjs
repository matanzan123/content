import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url() + " " + r.failure()?.errorText));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("PAGE_HEIGHT", total);

const stops = [0, 900, 1600, 2100, 2500, 2900, 3400, 3900];
for (const y of stops) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `full-${y}.png`) });
}
console.log("ERRORS", JSON.stringify(errors));
await browser.close();
