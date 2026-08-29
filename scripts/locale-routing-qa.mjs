import { chromium } from "playwright";

const ROUTES = [
  "",
  "/brand",
  "/discover",
  "/faqs",
  "/onboarding",
  "/contact",
  "/privacy-policy",
  "/terms-of-service",
  "/accessibility",
];

const browser = await chromium.launch();
const errors = [];
const base = "http://localhost:3000";

function wire(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console ${m.text().slice(0, 140)}`);
  });
}

/* ------------------ direct load + refresh, both locales ------------------ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  wire(page, "direct");
  console.log("=== direct load + refresh ===");
  for (const locale of ["en", "he"]) {
    for (const route of ROUTES) {
      const url = `${base}/${locale}${route}`;
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      const reload = await page.reload({ waitUntil: "domcontentloaded" });
      const doc = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        path: location.pathname,
      }));
      const expectDir = locale === "he" ? "rtl" : "ltr";
      const ok =
        res.status() < 400 &&
        reload.status() < 400 &&
        doc.lang === locale &&
        doc.dir === expectDir;
      console.log(
        `  ${ok ? "OK " : "FAIL"} ${url.padEnd(46)} ${res.status()}/${reload.status()} lang=${doc.lang} dir=${doc.dir} -> ${doc.path}`,
      );
      if (!ok) errors.push(`[direct] ${url} status=${res.status()} lang=${doc.lang} dir=${doc.dir}`);
    }
  }
  await ctx.close();
}

/* ------------------------ old-URL redirect behaviour --------------------- */
console.log("\n=== old URLs redirect by preference ===");
for (const [header, cookie, expect] of [
  ["en-US,en;q=0.9", null, "en"],
  ["he-IL,he;q=0.9", null, "he"],
  ["fr-FR,fr;q=0.9", null, "en"],
  ["he-IL,he;q=0.9", "en", "en"],
  ["en-US,en;q=0.9", "he", "he"],
]) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "accept-language": header },
  });
  if (cookie) {
    await ctx.addCookies([
      { name: "cliprewards_locale", value: cookie, domain: "localhost", path: "/" },
    ]);
  }
  const page = await ctx.newPage();
  wire(page, `redirect-${header}-${cookie}`);
  const label = `accept="${header}" cookie=${cookie ?? "none"}`;
  for (const route of ["/", "/brand", "/faqs", "/privacy-policy"]) {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    const landed = await page.evaluate(() => location.pathname);
    const want = route === "/" ? `/${expect}` : `/${expect}${route}`;
    const ok = landed === want;
    if (!ok) errors.push(`[redirect] ${label} ${route} -> ${landed} (want ${want})`);
    if (route === "/brand" || route === "/") {
      console.log(`  ${ok ? "OK " : "FAIL"} ${label.padEnd(42)} ${route} -> ${landed}`);
    }
  }
  await ctx.close();
}

/* --------------------------- no redirect loops --------------------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let hops = 0;
  page.on("response", (r) => {
    if (r.status() >= 300 && r.status() < 400) hops += 1;
  });
  await page.goto(`${base}/discover`, { waitUntil: "networkidle" });
  console.log(`\n=== redirect hops for /discover: ${hops} ===`);
  if (hops > 1) errors.push(`[loop] /discover took ${hops} redirects`);
  await ctx.close();
}

/* ------------------- language switch keeps the same page ----------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  wire(page, "switch");
  await page.addInitScript(() => {
    const css = document.createElement("style");
    css.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css));
  });
  console.log("\n=== language switch preserves the page ===");
  for (const [from, hebrew, want] of [
    ["/en/discover", true, "/he/discover"],
    ["/he/privacy-policy", false, "/en/privacy-policy"],
    ["/en/brand#verified-brands", true, "/he/brand#verified-brands"],
    // /onboarding has no header, so the selector is tested on a page that does
    ["/en/discover?status=Live", true, "/he/discover?status=Live"],
  ]) {
    await page.goto(`${base}${from}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const target = hebrew ? "עברית" : "English";
    await page.locator(`header [role="radiogroup"] button[role="radio"]`, { hasText: "" }).nth(hebrew ? 1 : 0).click();
    await page.waitForTimeout(1400);
    const landed = await page.evaluate(() => location.pathname + location.search + location.hash);
    const lang = await page.evaluate(() => document.documentElement.lang);
    const ok = landed === want;
    console.log(`  ${ok ? "OK " : "FAIL"} ${from.padEnd(34)} + ${target.padEnd(8)} -> ${landed} (lang=${lang})`);
    if (!ok) errors.push(`[switch] ${from} -> ${landed} (want ${want})`);
  }
  await ctx.close();
}

/* --------------- internal links stay inside the current locale ----------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  wire(page, "links");
  console.log("\n=== internal links keep the locale ===");
  for (const locale of ["en", "he"]) {
    await page.goto(`${base}/${locale}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll("a[href^='/']")]
        .map((a) => a.getAttribute("href"))
        .filter((h) => !h.startsWith("/api/")),
    );
    const stray = [...new Set(hrefs.filter((h) => !/^\/(en|he)(\/|$)/.test(h)))];
    console.log(`  /${locale}: ${hrefs.length} internal links, ${stray.length} without a locale prefix`);
    if (stray.length) errors.push(`[links] /${locale} unprefixed: ${stray.join(", ")}`);
  }
  await ctx.close();
}

/* ---------------------------- hreflang alternates ------------------------ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  console.log("\n=== hreflang alternates ===");
  for (const url of ["/en/discover", "/he/discover", "/en/terms-of-service"]) {
    await page.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
    const alts = await page.evaluate(() =>
      [...document.querySelectorAll("link[rel='alternate'][hreflang]")].map((l) => [
        l.getAttribute("hreflang"),
        l.getAttribute("href"),
      ]),
    );
    console.log(`  ${url} -> ${JSON.stringify(alts)}`);
    if (alts.length < 2) errors.push(`[hreflang] ${url} has ${alts.length} alternates`);
  }
  await ctx.close();
}

console.log("\nERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
