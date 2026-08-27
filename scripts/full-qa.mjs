import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERR " + String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text()); });
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url() + " " + (r.failure()?.errorText || "")));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("PAGE_HEIGHT", total);

const stops = Array.from({ length: 12 }, (_, i) => Math.round((i * total) / 11));
for (const y of stops) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outDir, `qa-${y}.png`) });
}

console.log("SCROLL_ERRORS", JSON.stringify(errors));
await browser.close();
