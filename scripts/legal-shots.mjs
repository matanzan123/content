import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const b = await chromium.launch();
for (const [url, name, w, h] of [
  ["/privacy-policy", "legal-privacy-top", 1440, 950],
  ["/terms-of-service", "legal-terms-top", 1440, 950],
  ["/terms-of-service", "legal-terms-mid", 1440, 950],
  ["/privacy-policy", "legal-privacy-m", 390, 844],
  ["/terms-of-service", "legal-terms-m", 390, 844],
]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  await page.goto("http://localhost:3000" + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  if (name.endsWith("-mid")) {
    await page.locator('a[role="tab"]', { hasText: "Creators" }).click();
    await page.waitForTimeout(1500);
  }
  if (w < 500) {
    await page.locator('nav[aria-label="Table of contents"] button[aria-expanded]').click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  await page.close();
}
await b.close();
