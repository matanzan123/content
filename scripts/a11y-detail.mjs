import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
const route = process.argv[2] || "/";
const only = process.argv[3];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
await page.goto("http://localhost:3000" + route, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
let a = new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa","best-practice"]).exclude("nextjs-portal");
if (only) a = a.withRules(only.split(","));
const r = await a.analyze();
for (const v of r.violations) {
  console.log(`\n== ${v.id} (${v.impact}) — ${v.help}`);
  for (const n of v.nodes.slice(0, 8)) {
    console.log("  target:", n.target.join(" "));
    console.log("  html:", n.html.replace(/\s+/g, " ").slice(0, 150));
    for (const c of [...n.any, ...n.all]) console.log("    ->", c.message.replace(/\s+/g, " ").slice(0, 220));
  }
  if (v.nodes.length > 8) console.log(`  ...and ${v.nodes.length - 8} more`);
}
await b.close();
