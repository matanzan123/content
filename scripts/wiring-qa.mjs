import { chromium } from "playwright";
import path from "node:path";

const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const errors = [];
const rows = [];

function wire(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console ${m.text()}`);
  });
  page.on("requestfailed", (r) => errors.push(`[${tag}] reqfail ${r.url()}`));
}

/** Assert one element's href, by its accessible text, inside a scope. */
async function href(page, scope, text, expected, label) {
  const el = page.locator(`${scope} a`, { hasText: text }).first();
  const n = await el.count();
  if (!n) {
    errors.push(`[missing] ${label} — no link matching "${text}" in ${scope}`);
    return;
  }
  const got = await el.getAttribute("href");
  rows.push([label, text, got, expected, got === expected ? "OK" : "MISMATCH"]);
  if (got !== expected) errors.push(`[href] ${label} "${text}" -> ${got} (expected ${expected})`);
}

/** Every internal destination wired in this pass must resolve. */
const seen = new Set();
async function reachable(page, url) {
  if (seen.has(url)) return;
  seen.add(url);
  const res = await page.request.get(`http://localhost:3000${url}`, { maxRedirects: 0 });
  const ok = res.status() < 400;
  console.log("  ROUTE", url, res.status(), ok ? "" : "<-- BROKEN");
  if (!ok) errors.push(`[route] ${url} -> ${res.status()}`);
}

async function open(url, width, height, tag) {
  const page = await browser.newPage({ viewport: { width, height } });
  wire(page, tag);
  await page.goto(`http://localhost:3000${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return page;
}

/* ============================ CREATOR HOME ============================== */
{
  const page = await open("/", 1440, 950, "creator");

  await href(page, "header", "Clip", "/", "Creator header logo");
  await href(page, "header nav", "For Brands", "/brand", "Creator header");
  await href(page, "header nav", "Discover", "/discover", "Creator header");
  await href(page, "header nav", "FAQs", "/faqs", "Creator header");
  await href(page, "header nav", "Contact", "/contact", "Creator header");
  await href(page, "header", "Sign in", "/login", "Creator header");
  await href(page, "header", "Become a Creator", "/onboarding?type=creator", "Creator header CTA");

  await href(page, "section:has(h1)", "Start Earning", "/onboarding?type=creator", "Creator hero");
  await href(page, "section:has(h1)", "Browse Campaigns", "/discover", "Creator hero");
  await href(page, 'section:has(h2:text-is("Three Steps To Get Paid"))', "Start Earning Today", "/onboarding?type=creator", "Three Steps");
  await href(page, 'section:has(h2:text-is("Your Next Payout Is One Post Away"))', "Start Earning Today", "/onboarding?type=creator", "CTA first");
  await href(page, 'section:has(h2:text-is("Discover Popular Campaigns"))', "See All Campaigns", "/discover", "Popular Campaigns");
  await href(page, 'section:has(h2:text-is("Ready To Join Them?"))', "Create Your Account", "/onboarding?type=creator", "CTA second");
  await href(page, 'section:has(h2:text-is("Your Questions, Answered"))', "See All Questions", "/faqs", "FAQ preview");

  // the six homepage campaign preview cards
  const cards = page.locator('section:has(h2:text-is("Discover Popular Campaigns")) a[aria-label]');
  const cardCount = await cards.count();
  const cardHrefs = await cards.evaluateAll((ns) => ns.map((n) => n.getAttribute("href")));
  console.log("CAMPAIGN_CARDS", cardCount, JSON.stringify([...new Set(cardHrefs)]));
  if (cardCount !== 6) errors.push(`[cards] expected 6 campaign cards, found ${cardCount}`);
  if (cardHrefs.some((h) => h !== "/discover")) errors.push(`[cards] non-/discover href: ${cardHrefs}`);

  await href(page, "footer", "Become a Creator", "/onboarding?type=creator", "Creator footer CTA");
  await href(page, "footer ul", "Discover", "/discover", "Creator footer nav");
  await href(page, "footer ul", "For Brands", "/brand", "Creator footer nav");

  // untouched, as instructed
  const agencies = await page.locator("header nav a", { hasText: "Agencies" }).getAttribute("href");
  console.log("AGENCIES_UNTOUCHED", agencies);
  if (agencies !== "/agencies") errors.push(`[scope] Agencies href changed to ${agencies}`);

  for (const u of ["/", "/brand", "/discover", "/faqs", "/contact", "/login", "/onboarding?type=creator"]) {
    await reachable(page, u);
  }
  await page.close();
}

/* ============================= BRAND HOME =============================== */
{
  const page = await open("/brand", 1440, 950, "brand");

  await href(page, "header", "Clip", "/brand", "Brand header logo");
  await href(page, "header nav", "For Creators", "/", "Brand header");
  await href(page, "header nav", "Discover", "/discover", "Brand header");
  await href(page, "header nav", "FAQs", "/faqs", "Brand header");
  await href(page, "header nav", "Contact", "/contact", "Brand header");
  await href(page, "header", "Sign in", "/login", "Brand header");
  await href(page, "header", "Launch Campaign", "/contact", "Brand header CTA");

  await href(page, "section:has(h1)", "Launch a Campaign", "/contact", "Brand hero");
  await href(page, "section:has(h1)", "See Verified Brands", "#verified-brands", "Brand hero anchor");
  await href(page, 'section:has(h2:text-is("Join 200+ Profitable Brands"))', "Launch My Campaign", "/contact", "Join 200+ Brands");
  await href(page, 'section:has(h2:text-is("Why Verification Matters"))', "Launch My Campaign", "/contact", "Why Verification");
  await href(page, 'section:has(h2:text-is("See What Brands Have Achieved"))', "Launch My Campaign", "/contact", "Case studies");
  await href(page, 'section:has(h2:text-is("Protection Features You Can Trust"))', "Launch My Campaign", "/contact", "Protection");
  await href(page, 'section:has(h2:text-is("Answers to Your Questions"))', "See all questions", "/faqs", "Brand FAQ");

  await href(page, "footer", "Clip", "/brand", "Brand footer logo");
  await href(page, "footer ul", "Discover", "/discover", "Brand footer nav");
  await href(page, "footer ul", "For Creators", "/", "Brand footer nav");
  await href(page, "footer ul", "For Brands", "/brand", "Brand footer nav");
  await href(page, "footer ul", "FAQs", "/faqs", "Brand footer nav");
  await href(page, "footer ul", "Contact", "/contact", "Brand footer pages");
  await href(page, "footer ul", "Sign in", "/login", "Brand footer pages");
  await href(page, "footer ul", "Launch a Campaign", "/contact", "Brand footer pages");

  // --- the anchor jump: lands on the section, clear of the sticky header ---
  await page.locator("a", { hasText: "See Verified Brands" }).first().click();
  await page.waitForTimeout(1600);
  const jump = await page.evaluate(() => {
    const sec = document.getElementById("verified-brands");
    const heading = sec.querySelector("h2");
    const header = document.querySelector("header").getBoundingClientRect();
    return {
      sectionTop: Math.round(sec.getBoundingClientRect().top),
      headingTop: Math.round(heading.getBoundingClientRect().top),
      headerBottom: Math.round(header.bottom),
      heading: heading.textContent.trim(),
      scrollY: Math.round(window.scrollY),
    };
  });
  console.log("ANCHOR_JUMP", JSON.stringify(jump));
  if (jump.scrollY < 100) errors.push("[anchor] page did not scroll to the section");
  if (jump.headingTop < jump.headerBottom)
    errors.push(`[anchor] heading (${jump.headingTop}) sits under the sticky header (${jump.headerBottom})`);

  // the realm must not flip back to creator on a same-page hash navigation
  const stillBrand = await page.locator(".realm-brand").count();
  console.log("STILL_BRAND_AFTER_JUMP", stillBrand);
  if (stillBrand !== 1) errors.push("[anchor] hash navigation dropped the brand realm");
  await page.screenshot({ path: path.join(outDir, "wire-anchor-jump.png") });

  await page.close();
}

/* ======================== BRAND MODE VIA TOGGLE ========================== */
{
  const page = await open("/", 1440, 950, "toggle");
  await page.click('button[role="switch"]');
  await page.waitForTimeout(600);
  await href(page, "header", "Launch Campaign", "/contact", "Toggled-brand header CTA");
  await href(page, "section:has(h1)", "See Verified Brands", "#verified-brands", "Toggled-brand hero anchor");
  await page.locator("a", { hasText: "See Verified Brands" }).first().click();
  await page.waitForTimeout(1600);
  const ok = await page.evaluate(() => ({
    brand: !!document.querySelector(".realm-brand"),
    scrolled: Math.round(window.scrollY),
  }));
  console.log("TOGGLED_ANCHOR", JSON.stringify(ok));
  if (!ok.brand) errors.push("[toggle] hash jump on / reset the realm to creator");
  if (ok.scrolled < 100) errors.push("[toggle] hash jump on / did not scroll");
  await page.close();
}

/* ============================== DISCOVER ================================ */
{
  const page = await open("/discover", 1440, 950, "discover");
  await href(page, "main", "Launch a campaign", "/contact", "Discover empty state");
  await href(page, "main", "Join as a creator", "/onboarding?type=creator", "Discover empty state");
  await page.close();
}

/* ================================ FAQS ================================== */
{
  const page = await open("/faqs", 1440, 950, "faqs");
  await href(page, "main", "Contact our team", "/contact", "FAQs still stuck");
  await href(page, "main", "Become a creator", "/onboarding?type=creator", "FAQs still stuck");

  await page.locator('button[role="tab"]', { hasText: "Brands" }).click();
  await page.waitForTimeout(500);
  await href(page, "main", "Launch a campaign", "/contact", "FAQs still stuck (Brands tab)");

  // tabs / search / accordions must still behave
  const before = await page.locator("main button[aria-expanded]").count();
  await page.locator("main button[aria-expanded]").first().click();
  await page.waitForTimeout(300);
  const opened = await page.locator("main button[aria-expanded]").first().getAttribute("aria-expanded");
  await page.fill('input[type="search"]', "payout");
  await page.waitForTimeout(400);
  const after = await page.locator("main button[aria-expanded]").count();
  console.log("FAQ_CONTROLS", JSON.stringify({ rowsBefore: before, accordionOpened: opened, rowsAfterSearch: after }));
  if (opened !== "true") errors.push("[faqs] accordion no longer opens");
  if (after === before) errors.push("[faqs] search no longer filters");
  await page.close();
}

/* =========================== MOBILE HEADER ============================== */
for (const [url, tag, expectCta] of [
  ["/", "mobile-creator", "/onboarding?type=creator"],
  ["/brand", "mobile-brand", "/contact"],
]) {
  const page = await open(url, 390, 844, tag);
  await page.click('header button[aria-expanded]');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll("header a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]),
  );
  console.log(`MOBILE_MENU_${tag}`, JSON.stringify(menu));
  const ctaHrefs = menu.filter(([t]) => /Become a Creator|Launch Campaign/.test(t)).map(([, h]) => h);
  if (!ctaHrefs.every((h) => h === expectCta))
    errors.push(`[${tag}] mobile CTA href ${ctaHrefs} (expected ${expectCta})`);
  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (ovf > 1) errors.push(`[${tag}] HORIZONTAL OVERFLOW ${ovf}px`);
  await page.screenshot({ path: path.join(outDir, `wire-${tag}.png`) });
  await page.close();
}

/* ============================ mobile anchor ============================= */
{
  const page = await open("/brand", 390, 844, "mobile-anchor");
  await page.locator("a", { hasText: "See Verified Brands" }).first().click();
  await page.waitForTimeout(1600);
  const jump = await page.evaluate(() => {
    const heading = document.getElementById("verified-brands").querySelector("h2");
    const header = document.querySelector("header").getBoundingClientRect();
    return {
      headingTop: Math.round(heading.getBoundingClientRect().top),
      headerBottom: Math.round(header.bottom),
      scrollY: Math.round(window.scrollY),
    };
  });
  console.log("MOBILE_ANCHOR_JUMP", JSON.stringify(jump));
  if (jump.headingTop < jump.headerBottom) errors.push("[mobile] anchor heading hidden by sticky header");
  await page.screenshot({ path: path.join(outDir, "wire-mobile-anchor.png") });
  await page.close();
}

console.log("\n--- href checks ---");
for (const [label, text, got, expected, verdict] of rows) {
  console.log(`${verdict.padEnd(9)} ${label} :: "${text}" -> ${got}${verdict === "OK" ? "" : ` (expected ${expected})`}`);
}
console.log("\nERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
