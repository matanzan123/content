import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const PATHS = [
  "",
  "/brand",
  "/discover",
  "/faqs",
  "/onboarding",
  "/contact",
  "/privacy-policy",
  "/terms-of-service",
  "/accessibility",
  "/admin",
  "/admin/revenue",
  "/admin/geography",
  "/admin/funnels",
  "/admin/events",
  "/admin/system",
];

// Both languages, since direction, font and copy all differ between them.
const ROUTES = ["en", "he"].flatMap((locale) => PATHS.map((path) => "/" + locale + path));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });

for (const route of ROUTES) {
  const page = await context.newPage();
  const res = await page.goto(`http://localhost:3000${route}`, { waitUntil: "networkidle" });
  if (!res || res.status() >= 400) {
    console.log(`\n### ${route} — ${res ? res.status() : "no response"} (skipped)`);
    await page.close();
    continue;
  }
  await page.waitForTimeout(700);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .exclude("nextjs-portal")
    .analyze();

  const structure = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter((n) => !n.closest("nextjs-portal"))
      .map((n) => ({ level: +n.tagName[1], text: n.textContent.trim().replace(/\s+/g, " ").slice(0, 48) }));
    const skips = [];
    let prev = 0;
    for (const h of headings) {
      if (prev && h.level > prev + 1) skips.push(`h${prev} -> h${h.level} at "${h.text}"`);
      prev = h.level;
    }
    const q = (s) => [...document.querySelectorAll(s)].filter((n) => !n.closest("nextjs-portal"));
    return {
      h1: headings.filter((h) => h.level === 1).map((h) => h.text),
      skips,
      main: q("main").length,
      headerInMain: q("main header").length,
      footerInMain: q("main footer").length,
      nav: q("nav").length,
      skipLink: q('a[href="#main-content"], a[href^="#main"]').length,
      hiddenFocusable: q('[aria-hidden="true"]').filter((n) =>
        n.querySelector("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])"),
      ).length,
    };
  });

  const byId = {};
  for (const v of results.violations) {
    byId[v.id] = { impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") };
  }

  console.log(`\n### ${route}`);
  console.log("  h1:", JSON.stringify(structure.h1));
  console.log("  heading skips:", structure.skips.length ? JSON.stringify(structure.skips) : "none");
  console.log(
    `  main=${structure.main} headerInMain=${structure.headerInMain} footerInMain=${structure.footerInMain} nav=${structure.nav} skipLink=${structure.skipLink} ariaHiddenWithFocusable=${structure.hiddenFocusable}`,
  );
  console.log("  axe violations:", Object.keys(byId).length);
  for (const [id, v] of Object.entries(byId)) {
    console.log(`    - ${id} (${v.impact}) x${v.n} :: ${v.sample}`);
  }

  await page.close();
}

await browser.close();
