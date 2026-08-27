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

// Click next 5 times (5 stories total) -> should land back on story 1 (Amara Torres) seamlessly
for (let i = 0; i < 5; i++) {
  await page.click('button[aria-label="Next story"]');
  await page.waitForTimeout(650); // wait out the 500ms transition + snap
}
const nameAfterFullLoop = await page.evaluate(() => {
  const els = document.querySelectorAll('p.mt-2.text-\[13px\].font-bold');
  return Array.from(els).map(e => e.textContent);
});
console.log("names visible after 5x next (should include Amara Torres again):", nameAfterFullLoop);
await page.screenshot({ path: path.join(outDir, "carousel-full-loop.png") });

// Now click prev once from here - should go smoothly backward, not jump
await page.click('button[aria-label="Previous story"]');
await page.waitForTimeout(650);
await page.screenshot({ path: path.join(outDir, "carousel-prev-from-wrap.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
