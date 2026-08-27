import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

const heading = page.locator("text=See How Creators Are Winning");
await heading.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

await page.screenshot({ path: path.join(outDir, "carousel-start.png") });

for (let i = 0; i < 5; i++) {
  await page.click('button[aria-label="Next story"]');
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(outDir, `carousel-step-${i+1}.png`) });
}

await page.click('button[aria-label="Previous story"]');
await page.waitForTimeout(650);
await page.screenshot({ path: path.join(outDir, "carousel-prev-from-wrap.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
