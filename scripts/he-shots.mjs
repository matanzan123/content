import { chromium } from "playwright";
const b = await chromium.launch();

async function shot(file, { w, h, locale, full = true, dsf = 1 }) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:3000/${locale}`, { waitUntil: "networkidle" });
  await p.addStyleTag({ content: "nextjs-portal{display:none!important} *{animation-play-state:paused!important}" });
  // Let lazy images and the marquee settle.
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(1200);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(800);
  await p.screenshot({ path: `scratch-screens/${file}`, fullPage: full });
  console.log("wrote", file);
  await ctx.close();
}

await shot("HE-discover-desktop.png", { w: 1440, h: 1000, locale: "he/discover" });
await shot("HE-faqs-desktop.png", { w: 1440, h: 1000, locale: "he/faqs" });
await shot("HE-faqs-mobile.png", { w: 390, h: 844, locale: "he/faqs", dsf: 2 });

await b.close();
