import { chromium } from "playwright";

const b = await chromium.launch();

async function check(label, { locale, xl }) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:3000/${locale}`, { waitUntil: "networkidle" });

  if (xl) {
    // Drive the real accessibility panel rather than faking a font size.
    await p.click(".a11y-launcher");
    await p.waitForTimeout(300);
    const btn = p.locator('button', { hasText: /Extra Large|גדול מאוד/ }).first();
    if (await btn.count()) { await btn.click(); await p.waitForTimeout(400); }
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
  }
  await p.waitForTimeout(500);

  const r = await p.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    // Elements whose text paints outside their own box, or outside the viewport.
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || !el.textContent.trim()) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        bad.push({ why: "outside viewport", tag: el.tagName, cls: String(el.className).slice(0, 50), text: el.textContent.trim().slice(0, 40), l: Math.round(rect.left), r: Math.round(rect.right) });
      }
      if (st.overflow === "hidden" && el.scrollWidth > el.clientWidth + 2 && el.children.length === 0) {
        bad.push({ why: "clipped text", tag: el.tagName, cls: String(el.className).slice(0, 50), text: el.textContent.trim().slice(0, 40) });
      }
    }
    return { overflow, bad: bad.slice(0, 12), badTotal: bad.length, fontSize: getComputedStyle(doc).fontSize };
  });

  console.log(`\n### ${label} — root font ${r.fontSize}`);
  console.log(`  horizontal overflow: ${r.overflow}px`);
  console.log(`  overflowing/clipped elements: ${r.badTotal}`);
  for (const x of r.bad) console.log(`   - [${x.why}] <${x.tag} class="${x.cls}"> "${x.text}"`);
  await ctx.close();
}

await check("/he/privacy-policy 390", { locale: "he/privacy-policy" });
await check("/he/terms-of-service 390", { locale: "he/terms-of-service" });
await check("/he/accessibility 390", { locale: "he/accessibility" });

await b.close();
