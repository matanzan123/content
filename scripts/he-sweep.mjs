import { chromium } from "playwright";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto("http://localhost:3000/he/accessibility", { waitUntil: "networkidle" });

const lang = await p.getAttribute("html", "lang");
const dir = await p.getAttribute("html", "dir");
console.log("lang/dir:", lang, dir);

// Every visible text node that contains Latin letters.
const latin = await p.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const s = n.nodeValue.trim();
    if (!s || !/[A-Za-z]{2,}/.test(s)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    const path = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      path.push(e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""));
    }
    out.push({ text: s.slice(0, 90), where: path.slice(0, 3).reverse().join(" > ") });
  }
  return out;
});
console.log("\n--- visible Latin text on /he (" + latin.length + ") ---");
for (const l of latin) console.log(JSON.stringify(l.text), "  @", l.where);

// horizontal overflow
const ow = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
console.log("\noverflow:", ow);
await b.close();
