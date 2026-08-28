import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url() + " " + (r.failure()?.errorText || "")));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.click('button[role="switch"]');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, "brand-hero-v3-desktop.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
