import { chromium } from "playwright";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 150)); });
p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 150)));

await p.goto("http://localhost:3000/en/onboarding?type=creator", { waitUntil: "networkidle" });
await p.addStyleTag({ content: "nextjs-portal{display:none!important}" });

// Fill step 1, pick a language on step 2, then switch language mid-wizard.
const name = p.locator("input").filter({ hasNot: p.locator("[type=file]") }).first();
await name.fill("Dana Levi");
await p.waitForTimeout(300);
const bio = p.locator("textarea").first();
if (await bio.count()) await bio.fill("Short clips about food");
await p.waitForTimeout(400);

console.log("### language switch mid-wizard");
console.log(`  before: name="${await name.inputValue()}"  url=${p.url().replace("http://localhost:3000", "")}`);
await p.getByRole("radio", { name: "עברית" }).click();
await p.waitForURL(/\/he\/onboarding/, { timeout: 6000 });
await p.waitForTimeout(900);
const nameAfter = p.locator("input").filter({ hasNot: p.locator("[type=file]") }).first();
console.log(`  after : name="${await nameAfter.inputValue()}"  url=${p.url().replace("http://localhost:3000", "")}`);
console.log(`  lang/dir: ${await p.getAttribute("html", "lang")} / ${await p.getAttribute("html", "dir")}`);
const bioAfter = p.locator("textarea").first();
if (await bioAfter.count()) console.log(`  bio preserved: "${await bioAfter.inputValue()}"`);
console.log(`  draft in localStorage: ${JSON.stringify(await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("cr-onboarding:")).length))} key(s)`);

// Step through the wizard in Hebrew.
console.log("\n### wizard steps (he)");
for (let i = 0; i < 5; i++) {
  const h1 = await p.locator("h1").first().innerText().catch(() => "(none)");
  const bar = await p.locator("[role=progressbar]").getAttribute("aria-label");
  console.log(`  step ${i + 1}: "${h1}"   progress="${bar}"`);
  const next = p.locator("button").filter({ hasText: /המשך|סיום/ }).last();
  if (!(await next.count())) break;
  if (await next.isDisabled()) {
    // Steps 2 and 3 gate Continue behind a chip selection.
    for (const re of [/אנגלית/, /רק מתחילים/, /מפה לאוזן/]) {
      const chip = p.locator("button").filter({ hasText: re }).first();
      if (await chip.count()) { await chip.click(); await p.waitForTimeout(350); }
    }
  }
  if (await next.isDisabled()) { console.log('    (still disabled — stopping)'); break; }
  await next.click();
  await p.waitForTimeout(600);
}
const done = await p.locator("h2").first().innerText().catch(() => "");
console.log(`  completion: "${done}"`);

console.log("\nconsole errors:", errors.length ? JSON.stringify(errors.slice(0, 4)) : "none");
await b.close();
