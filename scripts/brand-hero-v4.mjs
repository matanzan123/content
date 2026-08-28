import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const errors = [];

async function shot(w, h, name, full = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => errors.push(`[${name}] ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${name}] ${m.text()}`); });
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.click('button[role="switch"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: full });
  // horizontal overflow check
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (ovf > 1) errors.push(`[${name}] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.close();
  return ovf;
}

console.log("ovf1440", await shot(1440, 980, "v4-desktop-1440"));
console.log("ovf1280", await shot(1280, 900, "v4-desktop-1280"));
console.log("ovf1680", await shot(1680, 1000, "v4-desktop-1680"));
console.log("ovf390", await shot(390, 844, "v4-mobile", true));
console.log("ERRORS", JSON.stringify(errors, null, 1));
await browser.close();
