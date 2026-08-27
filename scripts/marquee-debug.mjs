import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
const box = await page.locator(".marquee-track").first().boundingBox();
console.log("box", box);
await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 5 });
await page.waitForTimeout(200);
const info = await page.evaluate(() => {
  const group = document.querySelector(".group");
  const track = document.querySelector(".marquee-track");
  const elAtPoint = document.elementFromPoint(300, 500);
  return {
    groupMatchesHover: group ? group.matches(":hover") : null,
    groupClass: group ? group.className : null,
    trackClass: track.className,
    elAtPointTag: elAtPoint ? elAtPoint.tagName + "." + elAtPoint.className : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
