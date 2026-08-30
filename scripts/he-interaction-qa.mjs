import { chromium } from "playwright";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const p = await ctx.newPage();
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 160)));

const line = (k, v) => console.log(`  ${k}: ${v}`);

console.log("### direct load /he");
await p.goto("http://localhost:3000/he", { waitUntil: "networkidle" });
line("lang/dir", (await p.getAttribute("html", "lang")) + " / " + (await p.getAttribute("html", "dir")));
line("h1", (await p.locator("h1").first().innerText()).replace(/\n/g, " | "));
line("skip link", await p.locator(".skip-link").first().innerText());

console.log("\n### language switch he -> en (with query + hash)");
await p.goto("http://localhost:3000/he?ref=test#faq", { waitUntil: "networkidle" });
await p.getByRole("radio", { name: "English" }).click();
await p.waitForURL(/\/en/, { timeout: 5000 });
line("url", p.url());
line("lang/dir", (await p.getAttribute("html", "lang")) + " / " + (await p.getAttribute("html", "dir")));

console.log("\n### persistence (cookie survives a fresh navigation to /)");
await p.goto("http://localhost:3000/", { waitUntil: "networkidle" });
line("landed on", p.url());
const cookies = await ctx.cookies();
line("locale cookie", JSON.stringify(cookies.find((c) => c.name === "cliprewards_locale")?.value));

console.log("\n### internal links keep the locale (/he)");
await p.goto("http://localhost:3000/he", { waitUntil: "networkidle" });
const hrefs = await p.$$eval("main a[href^='/'], footer a[href^='/']", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
const unprefixed = hrefs.filter((h) => !/^\/(he|en)(\/|$|\?|#)/.test(h) && !h.startsWith("/api/"));
line("internal links", hrefs.length);
line("missing locale prefix", unprefixed.length ? JSON.stringify(unprefixed) : "none");

console.log("\n### carousel (/he)");
const region = p.getByRole("region", { name: /סיפורי הצלחה|Success stories/ });
line("region label", await region.getAttribute("aria-label"));
const prev = p.getByRole("button", { name: /הקודם|Previous/ }).first();
const next = p.getByRole("button", { name: /הבא|Next/ }).first();
line("prev/next labels", `${await prev.getAttribute("aria-label")} / ${await next.getAttribute("aria-label")}`);
const dotBefore = await p.locator("[aria-current='true']").first().getAttribute("aria-label");
await next.click(); await p.waitForTimeout(800);
const dotAfter = await p.locator("[aria-current='true']").first().getAttribute("aria-label");
line("next advances", `${dotBefore} -> ${dotAfter} ${dotBefore !== dotAfter ? "OK" : "FAILED"}`);
await prev.click(); await p.waitForTimeout(800);
const dotBack = await p.locator("[aria-current='true']").first().getAttribute("aria-label");
line("prev reverses", `${dotAfter} -> ${dotBack} ${dotBack === dotBefore ? "OK" : "FAILED"}`);

console.log("\n### FAQ accordion (/he)");
const firstFaq = p.locator("button[aria-expanded]").nth(0);
line("before", await firstFaq.getAttribute("aria-expanded"));
await firstFaq.click(); await p.waitForTimeout(400);
line("after click", await firstFaq.getAttribute("aria-expanded"));

console.log("\n### console");
line("errors", errors.length ? JSON.stringify(errors.slice(0, 5), null, 1) : "none");
await b.close();
