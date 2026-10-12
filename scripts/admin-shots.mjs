/**
 * Admin dashboard visual capture + overflow QA.
 *
 * Runs against a dev server started with NEXT_PUBLIC_QA_ADMIN=1, which is a
 * review-only bypass of the authorization guard so the dashboard body renders.
 * The bypass is removed before delivery; this script exists only to produce the
 * review screenshots and to measure layout at three widths.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "qa/admin";
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  ["01-overview-en", "/en/admin", 1440, 900],
  ["02-overview-he", "/he/admin", 1440, 900],
  ["03-revenue-en", "/en/admin/revenue", 1440, 900],
  ["04-geography-en", "/en/admin/geography", 1440, 900],
  ["05-funnels-en", "/en/admin/funnels", 1440, 900],
  ["06-events-en", "/en/admin/events", 1440, 900],
  ["07-mobile-he", "/he/admin", 390, 844],
  ["08-system-en", "/en/admin/system", 1440, 900],
  ["09-users-he", "/he/admin/users", 1440, 900],
  ["10-traffic-en", "/en/admin/traffic", 1440, 900],
];

const ROUTES = [
  "/admin", "/admin/revenue", "/admin/users", "/admin/activity", "/admin/geography",
  "/admin/traffic", "/admin/pages", "/admin/funnels", "/admin/events",
  "/admin/campaigns", "/admin/creators", "/admin/brands", "/admin/audit", "/admin/system",
];
const WIDTHS = [390, 768, 1920];

const browser = await chromium.launch();

/* ------------------------------ screenshots ------------------------------- */
for (const [name, path, w, h] of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: w > 400 });
  console.log(`shot ${name}`);
  await ctx.close();
}

/* ------------------------- overflow at three widths ----------------------- */
let problems = 0;
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  for (const locale of ["en", "he"]) {
    for (const route of ROUTES) {
      await page.goto(`${BASE}/${locale}${route}`, { waitUntil: "domcontentloaded" });
      const bad = await page.evaluate(() => {
        const docW = document.documentElement.clientWidth;
        const scrollW = document.documentElement.scrollWidth;
        const offenders = [];
        if (scrollW > docW + 1) {
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            // An element inside its own scroll container is intentional.
            let p = el.parentElement, contained = false;
            while (p && p !== document.body) {
              const ov = getComputedStyle(p).overflowX;
              if (ov === "auto" || ov === "scroll") { contained = true; break; }
              p = p.parentElement;
            }
            if (contained) continue;
            if (r.right > docW + 1 || r.left < -1) {
              offenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 40)}`);
            }
          }
        }
        return { docW, scrollW, offenders: offenders.slice(0, 3) };
      });
      if (bad.scrollW > bad.docW + 1) {
        problems++;
        console.log(`✗ ${width}px /${locale}${route} — scrollW ${bad.scrollW} > ${bad.docW}`);
        for (const o of bad.offenders) console.log(`    ${o}`);
      }
    }
  }
  await ctx.close();
  console.log(`checked ${width}px`);
}

await browser.close();
console.log(problems === 0 ? "\nNo horizontal overflow on any admin route." : `\n${problems} overflow problems.`);
process.exit(problems === 0 ? 0 : 1);
