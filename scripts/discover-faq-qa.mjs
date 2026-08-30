import { chromium } from "playwright";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 150)); });
p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 150)));

// ---------- FAQ ----------
await p.goto("http://localhost:3000/he/faqs", { waitUntil: "networkidle" });
await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
console.log("### /he/faqs");
console.log(`  lang/dir: ${await p.getAttribute("html", "lang")} / ${await p.getAttribute("html", "dir")}`);
console.log(`  h1: ${await p.locator("h1").first().innerText()}`);
const status = p.locator("[role='status']").first();
console.log(`  count line: ${(await status.innerText()).trim()}`);

const search = p.getByRole("searchbox").or(p.locator("input[type='search'], input[placeholder]")).first();
for (const term of ["תשלום", "קמפיין", "מותג", "יוצר", "CPM"]) {
  await search.fill(term);
  await p.waitForTimeout(350);
  console.log(`  search "${term}": ${(await status.innerText()).trim()}`);
}
await search.fill("zzzznomatch");
await p.waitForTimeout(350);
console.log(`  no-match state: ${(await p.locator("main").innerText()).includes("לא נמצאו") || (await p.locator("main").innerText()).includes("אין שאלות") ? "shown" : (await p.locator("main p").nth(2).innerText()).slice(0, 40)}`);
await search.fill("");
await p.waitForTimeout(300);

// tabs
const tabs = p.getByRole("tab");
console.log(`  tabs: ${(await tabs.allInnerTexts()).join(" | ")}`);
await tabs.first().focus();
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(300);
console.log(`  ArrowRight -> selected: ${await p.locator("[role='tab'][aria-selected='true']").innerText()}`);
await p.keyboard.press("Home");
await p.waitForTimeout(300);
console.log(`  Home -> selected: ${await p.locator("[role='tab'][aria-selected='true']").innerText()}`);

// accordion
const q = p.locator("button[aria-expanded][aria-controls]").filter({ hasText: "?" }).first();
await q.scrollIntoViewIfNeeded();
const e0 = await q.getAttribute("aria-expanded");
await q.click(); await p.waitForTimeout(350);
console.log(`  accordion: ${e0} -> ${await q.getAttribute("aria-expanded")}`);

// category jump nav
const catLinks = await p.$$eval("nav a[href^='#']", (as) => as.map((a) => a.getAttribute("href")));
console.log(`  category anchors: ${catLinks.length} (${catLinks.slice(0, 3).join(", ")})`);

// ---------- DISCOVER ----------
await p.goto("http://localhost:3000/he/discover", { waitUntil: "networkidle" });
await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
console.log("\n### /he/discover");
console.log(`  lang/dir: ${await p.getAttribute("html", "lang")} / ${await p.getAttribute("html", "dir")}`);
const triggers = p.locator("button").filter({ hasText: /סטטוס|קטגוריה|סוג תוכן/ });
console.log(`  filter triggers: ${(await triggers.allInnerTexts()).map((s) => s.trim()).join(" | ")}`);
await triggers.first().click();
await p.waitForTimeout(300);
const opts = await p.locator("button").filter({ hasText: /כל הסטטוסים|פעיל|מסתיים|הסתיים/ }).allInnerTexts();
console.log(`  status options: ${opts.map((s) => s.trim()).join(" | ")}`);
await p.keyboard.press("Escape");

const hrefs = await p.$$eval("main a[href^='/'], footer a[href^='/']", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
const bad = hrefs.filter((h) => !/^\/(he|en)(\/|$|\?|#)/.test(h) && !h.startsWith("/api/"));
console.log(`  internal links: ${hrefs.length}, missing locale: ${bad.length ? JSON.stringify(bad) : "none"}`);

console.log("\nconsole errors:", errors.length ? JSON.stringify(errors.slice(0, 4)) : "none");
await b.close();
