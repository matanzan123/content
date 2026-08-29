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

async function openBrand(width, height, tag, scale = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  wire(page, tag);
  await page.goto("http://localhost:3000/brand", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  return page;
}

const faq = 'section:has(h2:text-is("Answers to Your Questions"))';

/* ------------------------------- desktop -------------------------------- */
{
  const page = await openBrand(1440, 950, "desktop");

  // --- FAQ accordion behaviour -------------------------------------------
  const rows = page.locator(`${faq} button[aria-expanded]`);
  console.log("FAQ_ROWS", await rows.count());

  const first = rows.nth(0);
  const third = rows.nth(2);
  console.log("FIRST_OPEN_ON_LOAD", await first.getAttribute("aria-expanded"));

  const panelHeight = async (i) =>
    rows.nth(i).evaluate((b) => {
      const panel = document.getElementById(b.getAttribute("aria-controls"));
      return Math.round(panel.getBoundingClientRect().height);
    });

  await third.scrollIntoViewIfNeeded();
  await third.click();
  await page.waitForTimeout(600);
  console.log("AFTER_OPEN_3", {
    third: await third.getAttribute("aria-expanded"),
    first: await first.getAttribute("aria-expanded"),
    thirdPanel: await panelHeight(2),
  });

  await third.click();
  await page.waitForTimeout(600);
  console.log("AFTER_CLOSE_3", {
    third: await third.getAttribute("aria-expanded"),
    thirdPanel: await panelHeight(2),
  });

  // keyboard: focus the row and toggle with Enter
  await third.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  console.log("AFTER_ENTER_3", await third.getAttribute("aria-expanded"));
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  console.log("AFTER_SPACE_3", await third.getAttribute("aria-expanded"));

  // leave the accordion in its default state for the screenshots
  await first.click();
  await page.waitForTimeout(600);
  await page.locator(`${faq}`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.addStyleTag({ content: "header{visibility:hidden!important}" });
  await page.locator(faq).screenshot({ path: path.join(outDir, "faq-desktop.png") });
  await rows.nth(4).click();
  await page.waitForTimeout(600);
  await page.locator(faq).screenshot({ path: path.join(outDir, "faq-desktop-open5.png") });

  // --- footer -------------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await page.locator("footer").screenshot({ path: path.join(outDir, "footer-desktop.png") });
  await page.screenshot({ path: path.join(outDir, "footer-viewport.png") });

  // sticky header must still be pinned, and must not sit over the legal row
  const headerState = await page.evaluate(() => {
    const h = document.querySelector("header").getBoundingClientRect();
    const legal = [...document.querySelectorAll("footer p")].find((p) =>
      p.textContent.startsWith("ClipRewards ©"),
    );
    const l = legal.getBoundingClientRect();
    return { headerTop: Math.round(h.top), headerBottom: Math.round(h.bottom), legalTop: Math.round(l.top) };
  });
  console.log("HEADER_VS_LEGAL", JSON.stringify(headerState));

  // the closing wordmark must not be cropped left or right
  const mark = await page.evaluate(() => {
    const p = [...document.querySelectorAll("footer p")].find((n) => n.textContent === "CLIPREWARDS");
    const r = p.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(p);
    const t = range.getBoundingClientRect();
    return { boxLeft: Math.round(r.left), boxRight: Math.round(r.right), textLeft: Math.round(t.left), textRight: Math.round(t.right), vw: window.innerWidth };
  });
  console.log("WORDMARK", JSON.stringify(mark));
  if (mark.textLeft < 0 || mark.textRight > mark.vw) errors.push(`[desktop] wordmark cropped: ${JSON.stringify(mark)}`);
  if (headerState.headerBottom > headerState.legalTop) errors.push("[desktop] header overlaps the legal row");

  // --- every footer link resolves ----------------------------------------
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll("footer a[href]")].map((a) => a.getAttribute("href")),
  );
  const internal = [...new Set(hrefs.filter((h) => h.startsWith("/")))];
  console.log("FOOTER_INTERNAL_LINKS", JSON.stringify(internal));
  for (const href of internal) {
    const res = await page.request.get(`http://localhost:3000${href}`, { maxRedirects: 0 });
    const ok = res.status() < 400;
    console.log("  LINK", href, res.status());
    if (!ok) errors.push(`[links] ${href} -> ${res.status()}`);
  }
  console.log("FOOTER_EXTERNAL_LINKS", JSON.stringify([...new Set(hrefs.filter((h) => !h.startsWith("/")))]));

  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[desktop] HORIZONTAL OVERFLOW ${ovf}px`);

  // full brand page: section order, top to bottom
  const order = await page.evaluate(() =>
    [...document.querySelectorAll("h1, h2")].map((h) => h.textContent.trim().replace(/\s+/g, " ")),
  );
  console.log("BRAND_PAGE_HEADINGS", JSON.stringify(order, null, 1));
  const lastEl = await page.evaluate(() => document.querySelector(".realm-brand").lastElementChild.tagName);
  console.log("LAST_ELEMENT_IN_REALM", lastEl);
  if (lastEl !== "FOOTER") errors.push(`[structure] page does not end on the footer (${lastEl})`);

  await page.close();
}

/* -------------------------------- mobile -------------------------------- */
{
  const page = await openBrand(390, 844, "mobile", 2);
  await page.locator(faq).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: "header{visibility:hidden!important}" });
  await page.locator(faq).screenshot({ path: path.join(outDir, "faq-mobile.png") });

  // touch target height on the smallest viewport
  const h = await page.locator(`${faq} button[aria-expanded]`).first().evaluate((b) => Math.round(b.getBoundingClientRect().height));
  console.log("MOBILE_ROW_HEIGHT", h);
  if (h < 44) errors.push(`[mobile] FAQ touch target only ${h}px`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  await page.locator("footer").screenshot({ path: path.join(outDir, "footer-mobile.png") });

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
  const leaked = await page.locator('h2:text-is("Answers to Your Questions")').count();
  console.log("BRAND_FAQ_IN_CREATOR", leaked);
  if (leaked !== 0) errors.push("[creator] brand FAQ leaked into creator realm");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "creator-footer-regression.png") });
  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[creator] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.close();
}

console.log("ERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
