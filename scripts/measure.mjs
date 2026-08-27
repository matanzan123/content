import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
const m = await page.evaluate(() => {
  const header = document.querySelector("header");
  const hero = document.querySelector("section");
  const sections = document.querySelectorAll("section");
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pageHeight: document.documentElement.scrollHeight,
    headerRect: header.getBoundingClientRect().toJSON(),
    heroRect: hero.getBoundingClientRect().toJSON(),
    nextSectionRect: sections[1] ? sections[1].getBoundingClientRect().toJSON() : null,
  };
});
console.log(JSON.stringify(m, null, 2));
await browser.close();
