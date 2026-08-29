import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
for (const [url, name, w, h] of [["/", "wire-creator-home", 1440, 950], ["/brand", "wire-brand-home", 1440, 950]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto("http://localhost:3000" + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.addStyleTag({ content: "header{visibility:hidden!important}" });
  const sel = url === "/" ? 'section:has(h2:text-is("Discover Popular Campaigns"))' : "section:has(h1)";
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.locator(sel).screenshot({ path: path.join(outDir, name + ".png") });
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(name, "overflow", ovf);
  await page.close();
}
await browser.close();
