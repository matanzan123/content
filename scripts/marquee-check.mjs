import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
const t1 = await page.evaluate(() => {
  const el = document.querySelector(".marquee-track");
  return getComputedStyle(el).transform;
});
await page.waitForTimeout(1000);
const t2 = await page.evaluate(() => {
  const el = document.querySelector(".marquee-track");
  return getComputedStyle(el).transform;
});
console.log("t1:", t1);
console.log("t2:", t2);
console.log("MOVED:", t1 !== t2);
await browser.close();
