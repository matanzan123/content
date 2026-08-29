import { chromium } from "playwright";
import path from "node:path";

const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const errors = [];

function wire(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console ${m.text()}`);
  });
  page.on("requestfailed", (r) => errors.push(`[${tag}] reqfail ${r.url()}`));
}

/** Brand realm is reached via /brand, which mounts with role=brand already. */
async function openBrand(width, height, tag, scale = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  wire(page, tag);
  await page.goto("http://localhost:3000/brand", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  return page;
}

const section = 'section:has(h2:text-is("Protection Features You Can Trust"))';

/* ------------------------------- desktop -------------------------------- */
{
  const page = await openBrand(1440, 950, "desktop");
  const el = page.locator(section);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);

  // sticky header verification happens on the full page; for the section crops
  // it is hidden, otherwise it paints over the heading in every element shot.
  const headerTop = await page.evaluate(() => {
    const h = document.querySelector("header");
    return h ? Math.round(h.getBoundingClientRect().top) : null;
  });
  console.log("HEADER_TOP_WHILE_SCROLLED", headerTop);
  await page.addStyleTag({ content: "header{visibility:hidden!important}" });

  await el.screenshot({ path: path.join(outDir, "prot-desktop.png") });

  const box = await el.boundingBox();
  console.log("SECTION_HEIGHT", Math.round(box.height));

  // artwork stage height as a share of the card it sits in
  const share = await page.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((s) =>
      s.querySelector("h2")?.textContent?.includes("Protection Features"),
    );
    return [...sec.querySelectorAll(".group")].map((c) => {
      const art = c.querySelector("h3")?.closest("div")?.previousElementSibling;
      return art ? +(art.getBoundingClientRect().height / c.getBoundingClientRect().height).toFixed(3) : null;
    });
  });
  console.log("ART_SHARE", JSON.stringify(share));

  // hover: the card must lift AND its copper rim must brighten
  const cards = page.locator(`${section} .group`);
  console.log("CARD_COUNT", await cards.count());
  for (let i = 0; i < 3; i++) {
    const card = cards.nth(i);
    const cbox = await card.boundingBox();
    await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + 40);
    await page.waitForTimeout(700);
    await el.screenshot({ path: path.join(outDir, `prot-hover-${i + 1}.png`) });
    const state = await card.evaluate((n) => {
      const rim = [...n.children].find((c) => c.className.includes?.("group-hover:opacity-100"));
      return {
        translate: getComputedStyle(n).translate,
        rim: rim ? getComputedStyle(rim).opacity : null,
      };
    });
    console.log(`HOVER_${i + 1}`, JSON.stringify(state));
  }

  // per-card crops at 2x so clipping is visible
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  for (let i = 0; i < 3; i++) {
    await cards.nth(i).screenshot({ path: path.join(outDir, `prot-card-${i + 1}.png`) });
  }

  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[desktop] HORIZONTAL OVERFLOW ${ovf}px`);

  // the seam with the approved section above, and the black bottom under the CTA
  const top = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top + window.scrollY, "section:has(h2)");
  void top;
  const sbox = await el.boundingBox();
  const pageTop = await page.evaluate(() => window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, pageTop + sbox.y - 300));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "prot-seam-top.png") });
  await page.evaluate((y) => window.scrollTo(0, y), pageTop + sbox.y + sbox.height - 700);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "prot-seam-bottom.png") });

  await page.close();
}

/* -------------------------------- mobile -------------------------------- */
{
  const page = await openBrand(390, 844, "mobile", 2);
  const el = page.locator(section);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await page.addStyleTag({ content: "header{visibility:hidden!important}" });
  await el.screenshot({ path: path.join(outDir, "prot-mobile.png") });
  await page.locator(`${section} .group`).first().screenshot({ path: path.join(outDir, "prot-mobile-card1.png") });
  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[mobile] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.close();
}

/* --------------------- creator realm regression check -------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  wire(page, "creator");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const leaked = await page.locator('h2:text-is("Protection Features You Can Trust")').count();
  console.log("PROTECTION_IN_CREATOR", leaked);
  if (leaked !== 0) errors.push("[creator] protection section leaked into creator realm");
  await page.screenshot({ path: path.join(outDir, "prot-creator-regression.png"), fullPage: true });
  await page.close();
}

console.log("ERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
