import { chromium } from "playwright";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 160)));

for (const loc of ["he", "en"]) {
  await p.goto(`http://localhost:3000/${loc}/brand`, { waitUntil: "networkidle" });
  await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  console.log(`\n### /${loc}/brand`);
  console.log(`  lang/dir: ${await p.getAttribute("html", "lang")} / ${await p.getAttribute("html", "dir")}`);
  console.log(`  h1: ${(await p.locator("h1").first().innerText()).replace(/\n/g, " | ")}`);

  const region = p.getByRole("group", { name: /case stud|מקרי בוחן/i }).first();
  console.log(`  carousel region: ${await region.getAttribute("aria-label")}`);
  const prev = p.getByRole("button", { name: /previous case|מקרה הבוחן הקודם/i }).first();
  const next = p.getByRole("button", { name: /next case|מקרה הבוחן הבא/i }).first();
  console.log(`  prev/next: ${await prev.getAttribute("aria-label")} / ${await next.getAttribute("aria-label")}`);

  const live = p.locator("[aria-live]").first();
  const before = (await live.innerText()).trim();
  await next.click(); await p.waitForTimeout(900);
  const after = (await live.innerText()).trim();
  console.log(`  next advances: "${before}" -> "${after}" ${before !== after ? "OK" : "FAILED"}`);
  await prev.click(); await p.waitForTimeout(900);
  const back = (await live.innerText()).trim();
  console.log(`  prev reverses: -> "${back}" ${back === before ? "OK" : "FAILED"}`);

  // FAQ accordion
  const q = p.locator("button[aria-expanded][aria-controls]").filter({ hasText: "?" }).first();
  await q.scrollIntoViewIfNeeded();
  const e0 = await q.getAttribute("aria-expanded");
  await q.click(); await p.waitForTimeout(400);
  console.log(`  accordion: ${e0} -> ${await q.getAttribute("aria-expanded")}`);

  // internal links keep locale
  const hrefs = await p.$$eval("main a[href^='/'], footer a[href^='/']", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  const bad = hrefs.filter((h) => !/^\/(he|en)(\/|$|\?|#)/.test(h) && !h.startsWith("/api/"));
  console.log(`  internal links: ${hrefs.length}, missing locale prefix: ${bad.length ? JSON.stringify(bad) : "none"}`);
}
console.log("\nconsole errors:", errors.length ? JSON.stringify(errors.slice(0, 4)) : "none");
await b.close();
