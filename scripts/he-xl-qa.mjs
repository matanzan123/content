import { chromium } from "playwright";

const b = await chromium.launch();

async function check(label, locale) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:3000/${locale}`, { waitUntil: "networkidle" });

  await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await p.click(".a11y-launcher");
  await p.waitForTimeout(400);
  const btn = p.getByRole("radio", { name: /Extra large|גדול מאוד/i }).first();
  await btn.click();
  await p.waitForTimeout(500);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(600);

  const r = await p.evaluate(() => {
    const doc = document.documentElement;
    const applied = doc.classList.contains("a11y-text-xlarge");
    const overflow = doc.scrollWidth - doc.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll("main *, header *, footer *")) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (el.children.length || !el.textContent.trim()) continue;
      // A leaf whose text is wider than the box that clips it.
      if (el.scrollWidth > el.clientWidth + 2 && ["hidden", "clip"].includes(st.overflowX) && !el.className.includes("sr-only") && !el.closest(".marquee-wrap")) {
        bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 45), text: el.textContent.trim().slice(0, 45) });
      }
    }
    return { applied, overflow, bad: bad.slice(0, 15), total: bad.length, zoom: getComputedStyle(doc).zoom };
  });

  console.log(`\n### ${label}`);
  console.log(`  xlarge class applied: ${r.applied}   root zoom: ${r.zoom}`);
  console.log(`  horizontal overflow: ${r.overflow}px`);
  console.log(`  clipped text leaves: ${r.total}`);
  for (const x of r.bad) console.log(`   - <${x.tag} class="${x.cls}"> "${x.text}"`);
  await ctx.close();
}

await check("/he/privacy-policy 390 + XL", "he/privacy-policy");
await check("/he/terms-of-service 390 + XL", "he/terms-of-service");
await check("/he/accessibility 390 + XL", "he/accessibility");
await b.close();
