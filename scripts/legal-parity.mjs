/**
 * Structural parity for the long-form legal documents.
 *
 * The flat dictionaries are covered by i18n-check; these documents live in
 * src/content/legal/*.{en,he}.tsx instead, so this compares the rendered
 * shape of the two languages: same section ids, in the same order, with the
 * same number of blocks and list items. A dropped clause changes the shape.
 */
import { chromium } from "playwright";

const DOCS = ["privacy-policy", "terms-of-service", "accessibility"];
const base = process.env.BASE ?? "http://localhost:3000";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;

async function shape(url) {
  await page.goto(url, { waitUntil: "networkidle" });
  return page.evaluate(() =>
    [...document.querySelectorAll("main article section")].map((s) => ({
      id: s.querySelector("h2")?.id ?? "(no id)",
      h2: s.querySelectorAll("h2").length,
      h3: s.querySelectorAll("h3").length,
      p: s.querySelectorAll("p").length,
      li: s.querySelectorAll("li").length,
    })),
  );
}

for (const doc of DOCS) {
  const en = await shape(`${base}/en/${doc}`);
  const he = await shape(`${base}/he/${doc}`);
  const problems = [];

  if (en.length !== he.length) problems.push(`section count ${en.length} vs ${he.length}`);
  const n = Math.min(en.length, he.length);
  for (let i = 0; i < n; i++) {
    if (en[i].id !== he[i].id) problems.push(`#${i} id "${en[i].id}" vs "${he[i].id}"`);
    for (const k of ["h3", "p", "li"]) {
      if (en[i][k] !== he[i][k]) problems.push(`${en[i].id}: ${k} ${en[i][k]} vs ${he[i][k]}`);
    }
  }

  if (problems.length) {
    failures += problems.length;
    console.log(`\n✗ /${doc} — ${problems.length} mismatch(es)`);
    for (const x of problems.slice(0, 20)) console.log("   - " + x);
  } else {
    console.log(`✓ /${doc} — ${en.length} sections, structure identical in both languages`);
  }
}

await browser.close();
if (failures) {
  console.log(`\n${failures} structural mismatch(es) between EN and HE legal content.`);
  process.exit(1);
}
console.log("\nOK — EN/HE legal documents are structurally identical.");
