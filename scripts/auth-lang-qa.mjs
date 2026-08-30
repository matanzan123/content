import { chromium } from "playwright";
const b = await chromium.launch();

for (const w of [1440, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  console.log(`\n===== viewport ${w} =====`);

  for (const start of ["/en/login", "/he/login", "/en/onboarding", "/he/onboarding"]) {
    await p.goto(`http://localhost:3000${start}?type=creator`, { waitUntil: "networkidle" });
    const group = p.getByRole("radiogroup", { name: /Choose a language|בחירת שפה|שפה/ });
    const labels = await group.locator("button").allInnerTexts();
    const checked = await group.locator("[aria-checked='true']").getAttribute("aria-label")
      ?? await group.locator("[aria-checked='true']").innerText();
    const header = await p.locator("header").count();
    console.log(`${start} -> ${p.url().replace("http://localhost:3000", "")}`);
    console.log(`   selector: [${labels.map((l) => l.replace(/\n/g, "")).join(" | ")}]  checked=${String(checked).replace(/\n/g, "")}  header=${header}`);
  }

  // Switch language on onboarding, with a query string present.
  await p.goto("http://localhost:3000/en/onboarding?type=creator", { waitUntil: "networkidle" });
  await p.getByRole("radio", { name: "עברית" }).click();
  await p.waitForURL(/\/he\/onboarding/, { timeout: 5000 });
  console.log(`switch en->he keeps page+query: ${p.url().replace("http://localhost:3000", "")}`);
  console.log(`   lang/dir: ${await p.getAttribute("html", "lang")} / ${await p.getAttribute("html", "dir")}`);

  // Keyboard reachability.
  await p.goto("http://localhost:3000/he/onboarding", { waitUntil: "networkidle" });
  let hops = 0, found = false;
  while (hops++ < 12) {
    await p.keyboard.press("Tab");
    const role = await p.evaluate(() => document.activeElement?.getAttribute("role"));
    if (role === "radio") { found = true; break; }
  }
  console.log(`   selector reachable by keyboard: ${found} (after ${hops} tabs)`);
  await ctx.close();
}
await b.close();
