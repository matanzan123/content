import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto(process.argv[2], { waitUntil: "networkidle" });
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(1500);
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(500);

const items = await p.evaluate(() => {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (skip.has(n.parentElement?.tagName) ? 2 : 1),
  });
  let n;
  while ((n = walk.nextNode())) {
    const s = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!s) continue;
    const el = n.parentElement;
    const sec = el.closest("section,header,footer");
    out.push({ s, sec: sec ? (sec.tagName === "SECTION" ? (sec.querySelector("h2")?.innerText || "").split("\n")[0].slice(0, 28) || "(hero)" : sec.tagName) : "?" });
  }
  return out;
});

// aria-labels and alts are user-facing too.
const aria = await p.evaluate(() =>
  [...document.querySelectorAll("[aria-label],img[alt]")]
    .map((e) => e.getAttribute("aria-label") || e.getAttribute("alt"))
    .filter((v) => v && v.trim())
);

let last = "";
for (const it of items) {
  if (it.sec !== last) { console.log(`\n──── ${it.sec} ────`); last = it.sec; }
  console.log("  " + it.s);
}
console.log("\n──── aria-labels / alt ────");
for (const a of [...new Set(aria)]) console.log("  " + a);
await b.close();
