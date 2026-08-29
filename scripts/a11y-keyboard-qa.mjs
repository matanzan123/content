import { chromium } from "playwright";
import path from "node:path";

const outDir = path.resolve("scratch-screens");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const errors = [];

function wire(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console ${m.text()}`);
  });
}

async function open(url, tag, viewport) {
  const page = viewport ? await browser.newPage({ viewport }) : await ctx.newPage();
  wire(page, tag);
  // the dev-only Next.js indicator sits in the same corner as the floating
  // button and swallows clicks; it does not exist in a production build
  await page.addInitScript(() => {
    const css = document.createElement("style");
    css.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css));
  });
  await page.goto(`http://localhost:3000/en${url === "/" ? "" : url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return page;
}

const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    return {
      tag: a.tagName,
      name: (a.getAttribute("aria-label") || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 42),
      ring: getComputedStyle(a).outlineWidth,
    };
  });

/* ------------------------- skip link + focus ring ------------------------- */
{
  const page = await open("/", "skip");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400); // let the reveal transition settle
  const first = await focused(page);
  console.log("FIRST_TAB_STOP", JSON.stringify(first));
  if (!/Skip to main content/i.test(first?.name ?? "")) errors.push("[skip] first tab stop is not the skip link");
  const visible = await page.evaluate(() => {
    const el = document.querySelector(".skip-link");
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), visible: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  console.log("SKIP_LINK_VISIBLE_ON_FOCUS", JSON.stringify(visible));
  if (!visible.visible) errors.push("[skip] skip link is not visible when focused");
  if (first?.ring === "0px") errors.push("[focus] focused element has no outline");
  await page.screenshot({ path: path.join(outDir, "a11y-skip-link.png"), clip: { x: 0, y: 0, width: 700, height: 140 } });

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const target = await page.evaluate(() => (location.hash === "#main-content" ? "ok" : location.hash));
  console.log("SKIP_LINK_TARGET", target);
  if (target !== "ok") errors.push(`[skip] skip link went to ${target}`);
  await page.close();
}

/* ------------------------------ mobile menu ------------------------------- */
{
  const page = await open("/", "menu", { width: 390, height: 844 });
  const toggle = page.locator("header button[aria-expanded]");
  await toggle.click();
  await page.waitForTimeout(300);
  const controls = await toggle.getAttribute("aria-controls");
  const menuExists = await page.evaluate((id) => !!document.getElementById(id), controls);
  console.log("MENU aria-controls resolves:", menuExists, "| expanded:", await toggle.getAttribute("aria-expanded"));
  if (!menuExists) errors.push("[menu] aria-controls does not resolve");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const b = document.querySelector("header button[aria-expanded]");
    return { expanded: b.getAttribute("aria-expanded"), focusIsToggle: document.activeElement === b };
  });
  console.log("MENU_AFTER_ESCAPE", JSON.stringify(after));
  if (after.expanded !== "false") errors.push("[menu] Escape did not close the mobile menu");
  if (!after.focusIsToggle) errors.push("[menu] focus did not return to the menu button");
  await page.close();
}

/* ------------------------- creator / brand toggle -------------------------- */
{
  const page = await open("/", "toggle");
  const sw = page.locator('button[role="switch"]');
  const before = await sw.evaluate((n) => ({
    role: n.getAttribute("role"),
    checked: n.getAttribute("aria-checked"),
    name: n.getAttribute("aria-label"),
  }));
  await sw.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const after = await page.locator('button[role="switch"]').evaluate((n) => ({
    checked: n.getAttribute("aria-checked"),
    name: n.getAttribute("aria-label"),
  }));
  console.log("ROLE_TOGGLE", JSON.stringify({ before, after }));
  if (before.checked === after.checked) errors.push("[toggle] Enter did not change the switch state");
  if (!before.name || !after.name) errors.push("[toggle] switch has no accessible name");
  await page.close();
}

/* ------------------------------- accordions -------------------------------- */
for (const [url, tag, scope] of [
  ["/", "creator-faq", 'section:has(h2:text-is("Your Questions, Answered"))'],
  ["/brand", "brand-faq", 'section:has(h2:text-is("Answers to Your Questions"))'],
  ["/faqs", "faqs-page", "main"],
]) {
  const page = await open(url, tag);
  const btn = page.locator(`${scope} button[aria-expanded][aria-controls]`).last();
  await btn.scrollIntoViewIfNeeded();
  const id = await btn.getAttribute("aria-controls");
  const resolves = await page.evaluate((i) => {
    const el = document.getElementById(i);
    return { exists: !!el, labelled: el?.getAttribute("aria-labelledby") ? "yes" : "no" };
  }, id);
  await btn.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(350);
  const expanded = await btn.getAttribute("aria-expanded");
  console.log(`ACCORDION ${tag}:`, JSON.stringify({ ...resolves, expandedAfterSpace: expanded }));
  if (!resolves.exists) errors.push(`[${tag}] aria-controls does not resolve`);
  if (expanded !== "true") errors.push(`[${tag}] Space did not open the accordion`);
  await page.close();
}

/* ------------------------------- FAQ tabs ---------------------------------- */
{
  const page = await open("/faqs", "tabs");
  const creator = page.locator("#faq-tab-creator");
  await creator.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    selected: [...document.querySelectorAll('[role="tab"]')].map((t) => [
      t.id,
      t.getAttribute("aria-selected"),
      t.getAttribute("tabindex"),
    ]),
    focus: document.activeElement?.id,
    panel: !!document.getElementById("faq-panel"),
  }));
  console.log("FAQ_TABS", JSON.stringify(state));
  if (state.focus !== "faq-tab-brand") errors.push("[tabs] ArrowRight did not move to the Brands tab");
  if (!state.panel) errors.push("[tabs] tabpanel missing");
  await page.close();
}

/* --------------------------- carousel keyboard ----------------------------- */
{
  const page = await open("/brand", "carousel");
  const dots = page.locator('button[aria-label^="Go to case study"]');
  const size = await dots.first().evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log("CAROUSEL_DOT_TARGET", JSON.stringify(size));
  if (size.w < 24 || size.h < 24) errors.push(`[carousel] dot target ${size.w}x${size.h} < 24px`);

  const region = page.locator('[aria-roledescription="carousel"]');
  await region.scrollIntoViewIfNeeded();
  await region.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(700);
  const live = await page.locator('[aria-live="polite"]').first().textContent();
  console.log("CAROUSEL_LIVE_REGION", JSON.stringify(live?.trim()));
  if (!live?.trim()) errors.push("[carousel] no live region announcing the active slide");
  await page.close();
}

/* --------------------------- accessibility panel --------------------------- */
{
  const page = await open("/", "panel");
  const trigger = page.locator('button[aria-label="Accessibility options"]');
  console.log("PANEL_TRIGGER_LABEL", await trigger.getAttribute("aria-label"));
  await trigger.click();
  await page.waitForTimeout(400);

  const opened = await page.evaluate(() => ({
    expanded: document.querySelector('button[aria-label="Accessibility options"]').getAttribute("aria-expanded"),
    dialog: !!document.querySelector('[role="dialog"]'),
    focusInside: !!document.querySelector('[role="dialog"]')?.contains(document.activeElement),
  }));
  console.log("PANEL_OPEN", JSON.stringify(opened));
  if (opened.expanded !== "true" || !opened.dialog) errors.push("[panel] did not open");
  if (!opened.focusInside) errors.push("[panel] focus did not move into the panel");

  // change a setting, confirm it applies and persists
  await page.locator('[role="radio"]', { hasText: "Large" }).first().click();
  // the switches are visually-hidden real checkboxes; force past the label overlay
  await page.locator('input[type="checkbox"]').nth(0).check({ force: true });
  await page.locator('input[type="checkbox"]').nth(2).check({ force: true });
  await page.waitForTimeout(400);
  const applied = await page.evaluate(() => ({
    classes: document.documentElement.className.split(/\s+/).filter((c) => c.startsWith("a11y-")),
    stored: localStorage.getItem("cliprewards_accessibility_preferences"),
  }));
  console.log("PANEL_APPLIED", JSON.stringify(applied));
  if (!applied.classes.includes("a11y-text-large")) errors.push("[panel] text size did not apply");
  if (!applied.classes.includes("a11y-contrast")) errors.push("[panel] contrast did not apply");
  if (!applied.classes.includes("a11y-reduce-motion")) errors.push("[panel] reduce motion did not apply");
  await page.screenshot({ path: path.join(outDir, "a11y-panel-open.png") });

  // survives a reload
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() =>
    document.documentElement.className.split(/\s+/).filter((c) => c.startsWith("a11y-")),
  );
  console.log("PANEL_AFTER_RELOAD", JSON.stringify(afterReload));
  if (!afterReload.includes("a11y-text-large")) errors.push("[panel] preferences did not survive reload");

  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log("OVERFLOW_AT_LARGE_TEXT", ovf);
  if (ovf > 1) errors.push(`[panel] horizontal overflow at large text: ${ovf}px`);

  // reset + escape
  await trigger.click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Reset all" }).click();
  await page.waitForTimeout(400);
  const reset = await page.evaluate(() =>
    document.documentElement.className.split(/\s+/).filter((c) => c.startsWith("a11y-")),
  );
  console.log("PANEL_AFTER_RESET", JSON.stringify(reset));
  if (reset.length) errors.push(`[panel] reset left classes: ${reset}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    dialog: !!document.querySelector('[role="dialog"]'),
    focusIsTrigger:
      document.activeElement === document.querySelector('button[aria-label="Accessibility options"]'),
  }));
  console.log("PANEL_AFTER_ESCAPE", JSON.stringify(closed));
  if (closed.dialog) errors.push("[panel] Escape did not close the panel");
  if (!closed.focusIsTrigger) errors.push("[panel] focus did not return to the trigger");
  await page.close();
}

/* ------------------------- extra-large text on mobile ---------------------- */
{
  const page = await open("/brand", "xl-mobile", { width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.setItem(
      "cliprewards_accessibility_preferences",
      JSON.stringify({ textSize: "xlarge", contrast: true, highlightLinks: true, reduceMotion: true }),
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const ovf = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log("XL_MOBILE_OVERFLOW", ovf);
  if (ovf > 1) errors.push(`[xl] horizontal overflow at extra-large text on mobile: ${ovf}px`);
  await page.screenshot({ path: path.join(outDir, "a11y-xl-mobile.png") });
  await page.close();
}

/* ------------------------------ contact form -------------------------------- */
{
  const page = await open("/contact", "form");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const active = document.activeElement;
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent.trim().slice(0, 40));
    const name = document.getElementById("name");
    return {
      focusedField: active?.id,
      invalid: name?.getAttribute("aria-invalid"),
      describedby: !!name?.getAttribute("aria-describedby"),
      required: name?.hasAttribute("required"),
      alerts: alerts.length,
    };
  });
  console.log("CONTACT_FORM_ERRORS", JSON.stringify(state));
  if (state.focusedField !== "name") errors.push("[form] focus did not move to the first invalid field");
  if (state.invalid !== "true" || !state.describedby) errors.push("[form] error not associated with the field");
  if (!state.required) errors.push("[form] required not exposed programmatically");
  if (!state.alerts) errors.push("[form] errors are not announced");
  await page.close();
}

console.log("\nERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
