import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url()));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.click('button[role="switch"]');
await page.waitForTimeout(400);

const total = await page.evaluate(() => document.documentElement.scrollHeight);
console.log("BRAND_PAGE_HEIGHT", total);

// Structural checks: which sections actually mounted
const checks = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    hasBrandCredibility: text.includes("Join 200+ Growing Brands"),
    hasBrandProtection: text.includes("Every Campaign, Protected"),
    hasPopularCampaigns: text.includes("Discover Popular Campaigns") || text.includes("See What's Already Running"),
    hasCreatorTrustSection: text.includes("Built On Real Trust"),
    faqCount: (text.match(/\?/g) || []).length,
  };
});
console.log("STRUCTURAL_CHECKS", JSON.stringify(checks, null, 2));

const stops = Array.from({ length: 10 }, (_, i) => Math.round((i * total) / 9));
for (const y of stops) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outDir, `brandqa-${y}.png`) });
}

console.log("ERRORS", JSON.stringify(errors));
await browser.close();
