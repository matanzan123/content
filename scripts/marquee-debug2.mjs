import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 2100));
await page.waitForTimeout(300);
const box = await page.locator(".marquee-track").first().boundingBox();
await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 5 });
await page.waitForTimeout(200);
const info = await page.evaluate(() => {
  const track = document.querySelector(".marquee-track");
  const realGroup = track.closest(".group");
  return {
    hasGroupAncestor: !!realGroup,
    realGroupMatchesHover: realGroup ? realGroup.matches(":hover") : null,
    trackAnimationPlayState: getComputedStyle(track).animationPlayState,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
