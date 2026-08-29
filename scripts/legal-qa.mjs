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

async function open(url, w, h, tag) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  wire(page, tag);
  const res = await page.goto(`http://localhost:3000${url}`, { waitUntil: "networkidle" });
  if (res.status() >= 400) errors.push(`[${tag}] ${url} -> ${res.status()}`);
  await page.waitForTimeout(600);
  return page;
}

/* ------------------------- both pages, desktop -------------------------- */
for (const [url, tag, expectTitle, expectTabs] of [
  ["/privacy-policy", "privacy", "Privacy Policy | ClipRewards", false],
  ["/terms-of-service", "terms", "Terms of Service | ClipRewards", true],
]) {
  const page = await open(url, 1440, 950, tag);

  console.log(`\n=== ${url} ===`);
  console.log("TITLE", await page.title());
  if ((await page.title()) !== expectTitle) errors.push(`[${tag}] wrong <title>`);
  const desc = await page.locator('meta[name="description"]').getAttribute("content");
  console.log("DESCRIPTION", desc);

  // the dev overlay injects its own <footer>, so only count the page chrome
  const chrome = await page.evaluate(() => ({
    header: document.querySelectorAll("body > header, body > div > header").length,
    footer: [...document.querySelectorAll("footer")].filter((n) => !n.closest("nextjs-portal")).length,
  }));
  console.log("PAGE_CHROME", JSON.stringify(chrome));
  if (chrome.header !== 1) errors.push(`[${tag}] expected one header, got ${chrome.header}`);
  if (chrome.footer !== 1) errors.push(`[${tag}] expected one footer, got ${chrome.footer}`);

  // every TOC entry must point at a heading that exists
  const toc = await page.evaluate(() => {
    const links = [...document.querySelectorAll('nav[aria-label="Table of contents"] a[href^="#"]')];
    const ids = [...new Set(links.map((a) => a.getAttribute("href").slice(1)))];
    return { count: ids.length, missing: ids.filter((id) => !document.getElementById(id)) };
  });
  console.log("TOC_ENTRIES", toc.count, "MISSING_TARGETS", JSON.stringify(toc.missing));
  if (toc.missing.length) errors.push(`[${tag}] TOC targets missing: ${toc.missing}`);

  const sectionCount = await page.locator("article > section").count();
  console.log("SECTIONS", sectionCount);

  // tabs (terms only)
  const tabs = await page.locator('[role="tab"]').count();
  console.log("PART_TABS", tabs);
  if (expectTabs && tabs !== 3) errors.push(`[${tag}] expected 3 part tabs, got ${tabs}`);
  if (!expectTabs && tabs !== 0) errors.push(`[${tag}] unexpected tabs on privacy page`);

  // unfilled placeholders should be visible and bracketed
  const placeholders = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll("article span.font-mono")].map((n) => n.textContent))],
  );
  console.log("PLACEHOLDERS", JSON.stringify(placeholders));
  if (placeholders.some((t) => !/^\[.+\]$/.test(t)))
    errors.push(`[${tag}] a placeholder is not bracketed: ${placeholders}`);

  // --- TOC click: smooth scroll, heading clears the sticky header ---
  const lastTocLink = page.locator('nav[aria-label="Table of contents"] a[href^="#"]').last();
  const targetId = (await lastTocLink.getAttribute("href")).slice(1);
  await lastTocLink.click();
  await page.waitForTimeout(1500);
  const jump = await page.evaluate((id) => {
    const h = document.getElementById(id).getBoundingClientRect();
    const header = document.querySelector("header").getBoundingClientRect();
    return { headingTop: Math.round(h.top), headerBottom: Math.round(header.bottom), y: Math.round(window.scrollY) };
  }, targetId);
  console.log("TOC_JUMP", targetId, JSON.stringify(jump));
  if (jump.y < 100) errors.push(`[${tag}] TOC click did not scroll`);
  if (jump.headingTop < jump.headerBottom)
    errors.push(`[${tag}] "${targetId}" heading sits under the sticky header`);

  // --- scroll-spy marks a current entry ---
  const current = await page.locator('nav[aria-label="Table of contents"] a[aria-current="true"]').first();
  const currentText = (await current.count()) ? (await current.textContent()).trim() : null;
  console.log("SCROLLSPY_ACTIVE", JSON.stringify(currentText));
  if (!currentText) errors.push(`[${tag}] scroll-spy did not mark an active section`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `legal-${tag}-desktop.png`) });

  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[${tag}] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.close();
}

/* ------------------------------- mobile --------------------------------- */
for (const [url, tag] of [["/privacy-policy", "privacy"], ["/terms-of-service", "terms"]]) {
  const page = await open(url, 390, 844, `${tag}-mobile`);
  const toggle = page.locator('nav[aria-label="Table of contents"] button[aria-expanded]');
  console.log(`\nMOBILE ${url} — collapsible TOC:`, await toggle.count());
  if ((await toggle.count()) !== 1) errors.push(`[${tag}-mobile] no collapsible TOC`);
  await toggle.click();
  await page.waitForTimeout(500);
  const open1 = await toggle.getAttribute("aria-expanded");
  console.log("  expanded:", open1);
  if (open1 !== "true") errors.push(`[${tag}-mobile] TOC did not expand`);
  await page.screenshot({ path: path.join(outDir, `legal-${tag}-mobile.png`) });
  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[${tag}-mobile] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.close();
}

/* ---------------------- links into the legal pages ----------------------- */
{
  const page = await open("/", 1440, 950, "links-creator");
  const creator = await page.evaluate(() =>
    [...document.querySelectorAll("footer a")]
      .filter((a) => /Privacy Policy|Terms of Service/.test(a.textContent))
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]),
  );
  console.log("\nCREATOR_FOOTER_LEGAL", JSON.stringify(creator));
  await page.close();

  const brand = await open("/brand", 1440, 950, "links-brand");
  const brandLinks = await brand.evaluate(() =>
    [...document.querySelectorAll("footer a")]
      .filter((a) => /Privacy Policy|Terms of Service/.test(a.textContent))
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]),
  );
  console.log("BRAND_FOOTER_LEGAL", JSON.stringify(brandLinks));
  await brand.close();

  const onb = await open("/onboarding", 1440, 950, "links-onboarding");
  const gate = await onb.evaluate(() =>
    [...document.querySelectorAll("main a")]
      .filter((a) => /Terms|Privacy Policy/.test(a.textContent))
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]),
  );
  console.log("ONBOARDING_GATE_LEGAL", JSON.stringify(gate));
  await onb.close();

  const expected = { "Privacy Policy": "/privacy-policy", "Terms of Service": "/terms-of-service", Terms: "/terms-of-service" };
  for (const [where, set] of [["creator footer", creator], ["brand footer", brandLinks], ["onboarding gate", gate]]) {
    if (!set.length) errors.push(`[links] no legal links found in ${where}`);
    for (const [text, h] of set) {
      if (expected[text] && h !== expected[text]) errors.push(`[links] ${where} "${text}" -> ${h}`);
    }
  }
}

/* --------------------- direct load + refresh + 404 check ----------------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  wire(page, "reload");
  for (const url of ["/privacy-policy", "/terms-of-service"]) {
    const a = await page.goto(`http://localhost:3000${url}`, { waitUntil: "networkidle" });
    const b = await page.reload({ waitUntil: "networkidle" });
    console.log("\nDIRECT", url, a.status(), "RELOAD", b.status());
    if (a.status() !== 200 || b.status() !== 200) errors.push(`[reload] ${url} ${a.status()}/${b.status()}`);
    // a hash-only goto is a same-document navigation and returns no response;
    // load it from a different page so the deep link is a real request
    await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
    const deep = await page.goto(`http://localhost:3000${url}#contact`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const landed = await page.evaluate(() => ({
      status: !!document.getElementById("contact"),
      y: Math.round(window.scrollY),
    }));
    console.log("DEEP_LINK", url + "#contact", deep?.status() ?? "same-doc", JSON.stringify(landed));
    if (!landed.status) errors.push(`[deeplink] ${url}#contact has no target`);
    if (landed.y < 100) errors.push(`[deeplink] ${url}#contact did not scroll to the section`);
  }
  await page.close();
}

console.log("\nERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
