import { chromium } from "playwright";
import path from "node:path";

const outDir = path.resolve("scratch-screens");
await import("node:fs/promises").then((fs) => fs.mkdir(outDir, { recursive: true }));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector("text=Earn From Every Post");
await page.screenshot({ path: path.join(outDir, "hero-creator.png") });

await page.click('button[role="switch"]');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "hero-brand.png") });

console.log("CONSOLE_ERRORS:", JSON.stringify(errors));
await browser.close();
