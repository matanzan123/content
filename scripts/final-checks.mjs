import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url()));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

// verify brand-tile fix
await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "brandtile-fix.png") });

// hover a campaign card
await page.evaluate(() => window.scrollTo(0, 3400));
await page.waitForTimeout(300);
await page.hover("text=Neon Rift — Launch Trailer Clipping");
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "campaign-hover.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
