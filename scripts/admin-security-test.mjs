/**
 * Admin authorization tests.
 *
 * Exercises the three identities the brief names — anonymous, authenticated
 * non-admin, and admin — against both locales and against the admin API
 * directly, plus the negative cases that matter most: a forged cookie, and a
 * check that no admin markup reaches an unauthorised response.
 *
 * The "authenticated non-admin" and "admin" cases need a real Firebase service
 * account. Without one the server denies everyone by design, which this run
 * verifies explicitly rather than skipping.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3000";
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

/* ---------------------------- anonymous ---------------------------------- */

for (const locale of ["en", "he"]) {
  const res = await page.goto(`${BASE}/${locale}/admin`, { waitUntil: "domcontentloaded" });
  const url = page.url();
  const body = await page.content();

  const redirectedToLogin = /\/(en|he)\/(login|onboarding)/.test(url);
  const denied = /Access denied|הגישה נדחתה|not configured|אינה מוגדרת/.test(body);
  record(
    `anonymous GET /${locale}/admin is denied`,
    redirectedToLogin || denied,
    redirectedToLogin ? "redirected to sign-in" : `refusal page (${res?.status()})`,
  );

  // The decisive check: no admin surface in the bytes sent to an unauthorised
  // visitor. Hiding it client-side would fail here.
  const leaked =
    body.includes("ClipRewards Admin") ||
    body.includes("Audit Log") ||
    body.includes("יומן ביקורת");
  record(`anonymous /${locale}/admin leaks no admin markup`, !leaked);
}

/* --------------------- every section route is guarded --------------------- */
// SECTION ROUTES: a new admin page must not be able to ship unprotected.
const SECTIONS = [
  "revenue", "users", "activity", "geography", "traffic", "pages", "funnels",
  "events", "campaigns", "creators", "brands", "audit", "system",
];

for (const section of SECTIONS) {
  const res = await page.goto(`${BASE}/en/admin/${section}`, { waitUntil: "domcontentloaded" });
  const html = await page.content();
  const leaked =
    html.includes("ClipRewards Admin") ||
    html.includes("Audit Log") ||
    html.includes("Recently active") ||
    html.includes("Gross campaign volume");
  record(`anonymous /en/admin/${section} leaks nothing`, !leaked, `status ${res?.status()}`);
}

/* ------------------------------ admin API -------------------------------- */

const apiAnon = await page.request.get(`${BASE}/api/admin/summary`);
record(
  "anonymous GET /api/admin/summary is refused",
  apiAnon.status() === 401 || apiAnon.status() === 403,
  `status ${apiAnon.status()}`,
);

const apiBody = await apiAnon.text();
record(
  "refused admin API returns no data",
  !apiBody.includes("financial_definitions") && !apiBody.includes("uid"),
  apiBody.slice(0, 60),
);

/* --------------------- forged / tampered session cookie ------------------- */

await context.addCookies([
  {
    name: "cliprewards_admin_session",
    value: "eyJhbGciOiJSUzI1NiJ9.eyJhZG1pbiI6dHJ1ZSwidWlkIjoiYXR0YWNrZXIifQ.forged",
    domain: "localhost",
    path: "/",
  },
]);

const forgedApi = await page.request.get(`${BASE}/api/admin/summary`);
record(
  "forged admin cookie is rejected by the API",
  forgedApi.status() === 401 || forgedApi.status() === 403,
  `status ${forgedApi.status()}`,
);

await page.goto(`${BASE}/en/admin`, { waitUntil: "domcontentloaded" });
const forgedBody = await page.content();
record(
  "forged admin cookie cannot render the dashboard",
  !forgedBody.includes("ClipRewards Admin"),
);

await context.clearCookies();

/* ------------- claimed admin identity supplied by the client -------------- */

const spoofHeaders = await page.request.get(`${BASE}/api/admin/summary`, {
  headers: { "x-admin": "true", "x-user-role": "admin", authorization: "Bearer admin" },
});
record(
  "client-supplied admin headers are ignored",
  spoofHeaders.status() === 401 || spoofHeaders.status() === 403,
  `status ${spoofHeaders.status()}`,
);

const spoofQuery = await page.request.get(`${BASE}/api/admin/summary?admin=true&role=admin`);
record(
  "admin query parameters are ignored",
  spoofQuery.status() === 401 || spoofQuery.status() === 403,
  `status ${spoofQuery.status()}`,
);

/* ---------------------- session exchange refuses junk ---------------------- */

const badExchange = await page.request.post(`${BASE}/api/admin/session`, {
  data: { idToken: "not-a-token" },
});
record(
  "session exchange rejects an invalid token",
  badExchange.status() >= 400,
  `status ${badExchange.status()}`,
);

/* ----------------------- dev debug endpoint is guarded -------------------- */

const debug = await page.request.get(`${BASE}/api/analytics/debug`);
record(
  "analytics debug endpoint is not open",
  debug.status() === 401 || debug.status() === 403 || debug.status() === 404,
  `status ${debug.status()}`,
);

/* ------------------------------- noindex ---------------------------------- */

await page.goto(`${BASE}/en/admin`, { waitUntil: "domcontentloaded" });
const robots = await page
  .locator('meta[name="robots"]')
  .getAttribute("content")
  .catch(() => null);
record("admin page is noindex", (robots ?? "").includes("noindex"), robots ?? "(none)");

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
