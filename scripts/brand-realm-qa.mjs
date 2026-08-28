import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url()));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.click('button[role="switch"]');
await page.waitForTimeout(400);
const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("BRAND_PAGE_HEIGHT", total);

await page.screenshot({ path: path.join(outDir, "realm-hero.png") });
await page.evaluate(() => window.scrollTo(0, 1500));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "realm-credibility.png") });
await page.evaluate(() => window.scrollTo(0, 2200));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "realm-verification.png") });
await page.evaluate(() => window.scrollTo(0, 2900));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "realm-protection.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
