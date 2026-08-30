import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [, , url, out] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto(url, { waitUntil: "networkidle" });
// Visible words only: skip script/style payloads and collapse text-node
// boundaries, so a re-render that splits a string differently is not a diff.
const text = await p.evaluate(() => {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (skip.has(n.parentElement?.tagName) ? 2 : 1),
  });
  const parts = [];
  let n;
  while ((n = walk.nextNode())) {
    const s = n.nodeValue.replace(/\s+/g, " ").trim();
    if (s) parts.push(s);
  }
  return parts.join(" ").replace(/\s+/g, " ");
});
writeFileSync(out, text.replace(/ (?=[.,])/g, ""), "utf8");
console.log(out, text.length, "chars");
await b.close();
