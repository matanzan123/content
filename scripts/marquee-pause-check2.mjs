import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
const box = await page.locator(".marquee-track").first().boundingBox();
await page.mouse.move(box.x + 100, box.y + box.height / 2);
await page.waitForTimeout(200);
const playState = await page.evaluate(() => {
  const el = document.querySelector(".marquee-track");
  return getComputedStyle(el).animationPlayState;
});
console.log("playState on hover:", playState);
await browser.close();
