import { chromium } from "playwright";
import path from "node:path";
const outDir = path.resolve("scratch-screens");
const b = await chromium.launch();
const errors = [];
for (const [locale, name] of [["en", "i18n-en"], ["he", "i18n-he"]]) {
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 950 },
    extraHTTPHeaders: locale === "he" ? { "accept-language": "he-IL,he;q=0.9" } : { "accept-language": "en-US,en;q=0.9" },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${locale}] ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${locale}] ${m.text().slice(0, 120)}`); });
  await page.addInitScript(() => {
    const css = document.createElement("style");
    css.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css));
  });
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const state = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    nav: [...document.querySelectorAll("header nav a")].map((a) => a.textContent.trim()),
    cta: document.querySelector("header a[href^='/onboarding']")?.textContent.trim(),
    skip: document.querySelector(".skip-link")?.textContent.trim(),
    font: getComputedStyle(document.body).fontFamily.split(",")[0],
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  console.log(name, JSON.stringify(state, null, 1));
  await page.screenshot({ path: path.join(outDir, name + "-home.png"), clip: { x: 0, y: 0, width: 1440, height: 420 } });
  await ctx.close();
}
// explicit choice must beat the browser header
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, extraHTTPHeaders: { "accept-language": "he-IL,he;q=0.9" } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator('[role="radiogroup"][aria-label] button[role="radio"]').first().click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, url: location.pathname }));
  console.log("MANUAL_EN_IN_ISRAEL", JSON.stringify(after));
  await page.goto("http://localhost:3000/discover", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const persisted = await page.evaluate(() => ({ lang: document.documentElement.lang, url: location.pathname }));
  console.log("PERSISTS_ACROSS_ROUTES", JSON.stringify(persisted));
  await ctx.close();
}
console.log("\nERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await b.close();
