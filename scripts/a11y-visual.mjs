import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const b = await chromium.launch();
for (const [url, name, w, h] of [
  ["/", "a11y-creator-home", 1440, 950],
  ["/brand", "a11y-brand-home", 1440, 950],
  ["/accessibility", "a11y-statement", 1440, 950],
  ["/brand", "a11y-brand-mobile", 390, 844],
]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  await page.goto("http://localhost:3000" + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(name, "overflow", ovf);
  await page.close();
}
await b.close();
