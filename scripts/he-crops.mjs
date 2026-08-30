import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto("http://localhost:3000/he/brand", { waitUntil: "networkidle" });
await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(1500);
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(800);

const shots = {
  "HE-brand-hero.png": "section:has(h1)",
  "HE-brand-verification.png": "section:has(h2:text('למה אימות משנה'))",
  "HE-brand-results.png": "section:has(h2:text('מה מותגים כבר השיגו'))",
  "HE-brand-protection.png": "section:has(h2:text('הגנות שאפשר'))",
};
for (const [file, sel] of Object.entries(shots)) {
  const el = p.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  await el.screenshot({ path: `scratch-screens/${file}` });
  console.log("wrote", file);
}
await b.close();
