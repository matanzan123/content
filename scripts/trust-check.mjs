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
console.log("PAGE_HEIGHT", total);

await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "trust-1.png") });

await page.evaluate(() => window.scrollTo(0, 1500));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "trust-2.png") });

await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "trust-3-activecreators.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
