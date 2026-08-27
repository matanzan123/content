import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("PAGE_SCROLL_HEIGHT", total, "VIEWPORT", 900);
await page.screenshot({ path: path.join(outDir, "scroll-1-top.png") });

await page.evaluate(() => window.scrollTo(0, 500));
await page.waitForTimeout(200);
console.log("scrollY after step2", await page.evaluate(() => window.scrollY));
await page.screenshot({ path: path.join(outDir, "scroll-2-mid.png") });

await page.evaluate(() => window.scrollTo(0, 1000));
await page.waitForTimeout(200);
console.log("scrollY after step3", await page.evaluate(() => window.scrollY));
await page.screenshot({ path: path.join(outDir, "scroll-3-next.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
