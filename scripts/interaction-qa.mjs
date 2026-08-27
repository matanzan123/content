import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

// FAQ accordion click
await page.evaluate(() => {
  const el = document.querySelector("footer");
  const top = el.getBoundingClientRect().top + window.scrollY - 900;
  window.scrollTo(0, top);
});
await page.waitForTimeout(300);
await page.click("text=How do I get paid?");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "faq-open.png") });
await page.click("text=How do I get paid?");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "faq-closed.png") });

// Carousel next click x2
const heading = await page.locator("text=See How Creators Are Winning");
await heading.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.click('button[aria-label="Next story"]');
await page.waitForTimeout(600);
await page.click('button[aria-label="Next story"]');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, "carousel-next2.png") });

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
