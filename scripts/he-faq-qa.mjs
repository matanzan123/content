import { chromium } from "playwright";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 200)));

for (const loc of ["he", "en"]) {
  await p.goto(`http://localhost:3000/${loc}`, { waitUntil: "networkidle" });
  const q = p.locator("button[aria-expanded][aria-controls]").filter({ has: p.locator("span.font-bold") }).first();
  await q.scrollIntoViewIfNeeded();
  const label = (await q.innerText()).replace(/\n/g, " ").trim();
  const before = await q.getAttribute("aria-expanded");
  await q.click();
  await p.waitForTimeout(400);
  const after = await q.getAttribute("aria-expanded");
  const panelId = await q.getAttribute("aria-controls");
  const panelText = (await p.locator(`[id="${panelId}"]`).innerText()).slice(0, 70).replace(/\n/g, " ");
  console.log(`### /${loc} accordion`);
  console.log(`  question: ${label}`);
  console.log(`  aria-expanded: ${before} -> ${after}`);
  console.log(`  panel: "${panelText}…"`);
}
console.log("\nconsole errors:", errors.length ? JSON.stringify(errors.slice(0, 5)) : "none");
await b.close();
