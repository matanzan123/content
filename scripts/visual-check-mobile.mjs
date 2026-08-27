import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(outDir, "hero-mobile.png"), fullPage: true });
await browser.close();
