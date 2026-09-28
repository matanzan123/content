#!/usr/bin/env node
/**
 * TASK #24 — CSP / SECURITY HEADERS / ORIGIN COVERAGE.
 *
 * Most of what this task audited was already right: six security headers on
 * every response, a CSP with object-src/base-uri/frame-ancestors locked down,
 * HSTS gated on NODE_ENV, no CORS headers anywhere, no XSS sink, and an origin
 * check on 26 of the 30 mutating handlers. What was wrong:
 *
 *   - `trustedOrigins()` included `http://localhost:3000` IN PRODUCTION. For
 *     most routes SameSite hides that, because they need a cookie the browser
 *     withholds cross-site. `POST /api/auth/session` is the exception: it mints
 *     a session from an ID token in the BODY, needs no existing cookie, and had
 *     the origin check as its only guard. A page on a victim's own localhost
 *     could therefore post the ATTACKER's token to production and have the
 *     browser adopt the attacker's session.
 *   - `POST /api/admin/session` had no origin check at all — the same login
 *     CSRF, aimed at an admin session, and an unexplained asymmetry with
 *     `auth/session`, which did have one.
 *   - `form-action` was absent. It does not fall back to default-src, so form
 *     submission was unrestricted.
 *
 * HOW THE HEADERS ARE TESTED. The real `headers()` from `next.config.ts` is
 * EXECUTED, once with NODE_ENV=production and once without, and the emitted
 * list is asserted. That is stronger than matching the file's text: it catches a
 * directive that is present but unreachable, and it is what proves HSTS and
 * 'unsafe-eval' actually switch on environment. Booting a server would add
 * nothing — Next reads this same array.
 *
 * The origin-coverage section parses every route file and classifies every
 * mutating handler, so a NEW unguarded mutation route fails this suite rather
 * than waiting for the next audit.
 *
 * NO NETWORK. NO DATABASE — nothing here needs one, and the real database is
 * therefore trivially unchanged; the final section proves that rather than
 * asserting it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/* IMPORTS STRIPPED TOO, wherever ORDER is the property being asserted. An
 * import of `verifyWebhook` sits at the top of the file and would make any
 * "verified before parsed" comparison pass or fail on import order rather than
 * execution order. */
const bodyOnly = (p) =>
  codeOnly(p).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");

/* =========================================================================
   Loaders.
   ========================================================================= */

const cache = new Map();
function loadTs(file, fresh = false) {
  const key = resolve(file);
  if (!fresh && cache.has(key)) return cache.get(key).exports;

  const js = ts.transpileModule(readFileSync(key, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  if (!fresh) cache.set(key, mod);
  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try { return loadTs(`${base}.ts`); } catch { return loadTs(`${base}/index.ts`); }
    }
    if (spec === "next" || spec.startsWith("next/")) return {};
    return require(spec);
  };
  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

/** Executes the REAL next.config headers() under a chosen NODE_ENV. */
async function emittedHeaders(nodeEnv) {
  const saved = process.env.NODE_ENV;
  /* Plain assignment: `process.env` refuses a property descriptor, and
   * NODE_ENV is the one variable the config actually branches on. */
  process.env.NODE_ENV = nodeEnv;
  try {
    /* Loaded fresh each time: `isDev` and the CSP string are module-level
     * constants, so a cached module would answer for the previous environment
     * and the whole section would prove nothing. */
    const cfg = loadTs("next.config.ts", true).default;
    const routes = await cfg.headers();
    const map = new Map();
    for (const entry of routes) for (const h of entry.headers) map.set(h.key.toLowerCase(), h.value);
    return { map, routes };
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

const directives = (csp) => {
  const out = new Map();
  for (const part of csp.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    out.set(name, values);
  }
  return out;
};

/* ---------------------------------------------------------------- A ---- */
section("A. The headers actually emitted in production");

const prod = await emittedHeaders("production");
const dev = await emittedHeaders("development");

{
  check("every path is covered by one header block",
    prod.routes.length === 1 && prod.routes[0].source === "/(.*)",
    prod.routes.map((r) => r.source).join(","));

  for (const [header, expected] of [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["x-frame-options", "DENY"],
  ]) {
    check(`${header}: ${expected}`, prod.map.get(header) === expected, prod.map.get(header));
  }

  check("permissions-policy denies camera, microphone and geolocation",
    /camera=\(\)/.test(prod.map.get("permissions-policy") ?? "") &&
      /microphone=\(\)/.test(prod.map.get("permissions-policy") ?? "") &&
      /geolocation=\(\)/.test(prod.map.get("permissions-policy") ?? ""),
    prod.map.get("permissions-policy"));

  check("a content-security-policy is emitted at all",
    typeof prod.map.get("content-security-policy") === "string" &&
      prod.map.get("content-security-policy").length > 50);

  /* COOP IS DELIBERATELY NOT `same-origin`: signInWithPopup needs the popup to
   * talk back, and same-origin silently breaks Google sign-in. */
  check("cross-origin-opener-policy allows the auth popup to report back",
    prod.map.get("cross-origin-opener-policy") === "same-origin-allow-popups",
    prod.map.get("cross-origin-opener-policy"));
}

/* ---------------------------------------------------------------- B ---- */
section("B. HSTS is production-only");

{
  check("production sends Strict-Transport-Security",
    typeof prod.map.get("strict-transport-security") === "string",
    prod.map.get("strict-transport-security"));
  check("for at least a year, including subdomains",
    /max-age=(\d+)/.test(prod.map.get("strict-transport-security") ?? "") &&
      Number(RegExp.$1) >= 31_536_000 &&
      /includeSubDomains/i.test(prod.map.get("strict-transport-security") ?? ""));
  /* NOT IN DEVELOPMENT. HSTS pins the browser to HTTPS for a year, and a
   * developer who receives it on localhost cannot reach http://localhost again
   * until they clear it by hand. */
  check("development sends NO HSTS",
    dev.map.get("strict-transport-security") === undefined,
    String(dev.map.get("strict-transport-security")));
}

/* ---------------------------------------------------------------- C ---- */
section("C. The CSP, directive by directive");

const csp = directives(prod.map.get("content-security-policy") ?? "");
const devCsp = directives(dev.map.get("content-security-policy") ?? "");

{
  check("default-src is 'self' and nothing else",
    (csp.get("default-src") ?? []).join(" ") === "'self'",
    (csp.get("default-src") ?? []).join(" "));

  for (const [directive, value] of [
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
  ]) {
    check(`${directive} ${value}`,
      (csp.get(directive) ?? []).join(" ") === value,
      (csp.get(directive) ?? ["MISSING"]).join(" "));
  }

  /* form-action AND frame-ancestors DO NOT FALL BACK to default-src. A CSP that
   * omits them restricts neither, however strict default-src looks. */
  check("neither form-action nor frame-ancestors is left to default-src",
    csp.has("form-action") && csp.has("frame-ancestors"));

  check("style-src and font-src cover Google Fonts and nothing wider",
    (csp.get("style-src") ?? []).includes("https://fonts.googleapis.com") &&
      (csp.get("font-src") ?? []).includes("https://fonts.gstatic.com") &&
      !(csp.get("font-src") ?? []).some((v) => v.includes("*")),
    (csp.get("font-src") ?? []).join(" "));

  /* NO WILDCARD THAT WOULD ADMIT ANY HOST. A bare `*`, `https:` or `http:` as a
   * source defeats the directive it appears in; `https://*.example.com` is a
   * bounded wildcard and is fine. */
  for (const [name, values] of csp) {
    const bad = values.filter((v) => v === "*" || v === "https:" || v === "http:");
    check(`  ${name} has no host-wide wildcard`, bad.length === 0, bad.join(" "));
  }

  /* NO PLAINTEXT SOURCE IN PRODUCTION. An http:// source is a downgrade any
   * network attacker can use to inject into the page. */
  const httpSources = [...csp].flatMap(([name, values]) =>
    values.filter((v) => v.startsWith("http://")).map((v) => `${name}: ${v}`));
  check("no http:// source anywhere in the production policy",
    httpSources.length === 0, httpSources.join(", "));

  check("img-src's data: and blob: are bounded to images only",
    (csp.get("img-src") ?? []).includes("data:") &&
      !(csp.get("default-src") ?? []).includes("data:") &&
      !(csp.get("script-src") ?? []).some((v) => v === "data:" || v === "blob:"),
    (csp.get("script-src") ?? []).join(" "));
}

/* ---------------------------------------------------------------- D ---- */
section("D. Development allowances do not reach production");

{
  /* 'unsafe-eval' — React's development build needs it to rebuild callstacks.
   * In production it turns any injected string into executable code. */
  check("production script-src has NO 'unsafe-eval'",
    !(csp.get("script-src") ?? []).includes("'unsafe-eval'"),
    (csp.get("script-src") ?? []).join(" "));
  check("development does have it, so the switch is real and not dead code",
    (devCsp.get("script-src") ?? []).includes("'unsafe-eval'"));

  /* ws:/wss: — the dev server's HMR socket. Nothing in production opens one. */
  check("production connect-src has no ws:/wss:",
    !(csp.get("connect-src") ?? []).some((v) => v === "ws:" || v === "wss:"),
    (csp.get("connect-src") ?? []).join(" "));
  check("development does, again proving the switch",
    (devCsp.get("connect-src") ?? []).some((v) => v === "ws:"));

  /* 'unsafe-inline' IS in production script-src, and that is a known,
   * documented limitation rather than an oversight: the App Router emits inline
   * hydration scripts that need a per-request nonce to cover, which needs
   * middleware work. Asserted so it stays deliberate — if someone removes it
   * the app stops hydrating, and if someone adds a nonce this should be
   * revisited together with that. */
  check("script-src's 'unsafe-inline' is present and documented as temporary",
    (csp.get("script-src") ?? []).includes("'unsafe-inline'") &&
      /nonce/.test(src("next.config.ts")));

  /* THE ENVIRONMENT IS SERVER-DECIDED. Nothing in the header block may read a
   * request — a policy chosen by a header is a policy the caller chooses. */
  /* THE WHOLE CONFIG, not just the headers() block. `isDev` and the CSP string
   * are module-level constants declared ABOVE it, so a switch smuggled into
   * either would sit outside a scan that started at `async headers()` — which
   * is exactly what survived the first mutation run. */
  const cfgCode = codeOnly("next.config.ts");
  check("nothing in the config reads a request value",
    !/\brequest\b|\breq\b|headers\.get\(|X-Forwarded/i.test(cfgCode));

  /* AND THE ENVIRONMENT SWITCH IS EXACTLY NODE_ENV. Pinned to the whole
   * expression: an added `|| something-else` is how a production policy quietly
   * becomes selectable, and a substring match would not notice. */
  check("the dev/prod switch is NODE_ENV and nothing else",
    /const isDev = process\.env\.NODE_ENV !== "production";/.test(cfgCode),
    (cfgCode.match(/const isDev = [^\n]*/) ?? ["missing"])[0]);
  check("and only NODE_ENV and APP_PUBLIC_URL are read at all",
    [...new Set([...cfgCode.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))]
      .sort().join(",") === "APP_PUBLIC_URL,NODE_ENV",
    [...new Set([...cfgCode.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort().join(","));
}

/* ---------------------------------------------------------------- E ---- */
section("E. Framing is closed, and nothing reopens it");

{
  check("frame-ancestors 'none' plus X-Frame-Options DENY",
    (csp.get("frame-ancestors") ?? []).join(" ") === "'none'" &&
      prod.map.get("x-frame-options") === "DENY");

  /* NO SECOND OPINION ANYWHERE. Two sources of framing policy is how one gets
   * relaxed without anyone noticing, so next.config must be the only one. */
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) all.push(p);
    }
  };
  walk("src");
  const reopeners = all.filter((f) =>
    /x-frame-options|frame-ancestors|content-security-policy/i.test(codeOnly(f)));
  check("no route, page or middleware sets a framing or CSP header of its own",
    reopeners.length === 0, reopeners.join(", "));

  /* AND NOTHING NEEDS FRAMING. Every provider hand-off is a top-level redirect,
   * so frame-ancestors 'none' breaks no feature. */
  const iframes = all.filter((f) => /<iframe|createPortal\(.*iframe/i.test(src(f)));
  check("the app contains no iframe, so 'none' costs no functionality",
    iframes.length === 0, iframes.join(", "));
}

/* ---------------------------------------------------------------- F ---- */
section("F. The origin check");

{
  const ro = loadTs("src/lib/server/request-origin.ts");
  const PROD = { NODE_ENV: "production", APP_PUBLIC_URL: "https://app.example.com", WHOP_ENVIRONMENT: "production" };
  const DEV = { NODE_ENV: "development", APP_PUBLIC_URL: "https://app.example.com" };
  const H = (o) => new Headers(o);

  check("the configured origin is accepted",
    ro.checkRequestOrigin(H({ origin: "https://app.example.com" }), PROD).ok === true);

  /* THE FIX. localhost was accepted in production, which defeated the only
   * guard on the one mutating route that needs no cookie. */
  for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "https://localhost:3000"]) {
    check(`production REFUSES ${local}`,
      ro.checkRequestOrigin(H({ origin: local }), PROD).ok === false,
      JSON.stringify(ro.checkRequestOrigin(H({ origin: local }), PROD)));
    check(`  and development still accepts it`,
      ro.checkRequestOrigin(H({ origin: local }), DEV).ok === true);
  }
  check("the production allow-list contains no local origin at all",
    !ro.trustedOrigins(PROD).some((o) => /localhost|127\.0\.0\.1/.test(o)),
    ro.trustedOrigins(PROD).join(" "));
  check("an unconfigured production deployment trusts NOTHING rather than localhost",
    ro.trustedOrigins({ NODE_ENV: "production" }).length === 0,
    JSON.stringify(ro.trustedOrigins({ NODE_ENV: "production" })));

  /* MISSING, MALFORMED AND null ORIGINS. A browser attaches Origin to every
   * non-GET request, so refusing one costs no legitimate browser traffic. */
  check("a missing Origin and Referer fails closed",
    ro.checkRequestOrigin(H({}), PROD).ok === false &&
      ro.checkRequestOrigin(H({}), PROD).reason === "missing_origin");
  check("a malformed Origin fails closed",
    ro.checkRequestOrigin(H({ origin: "not a url" }), PROD).ok === false);
  check("the literal null origin — a sandboxed frame — fails closed",
    ro.checkRequestOrigin(H({ origin: "null" }), PROD).ok === false);
  check("an unparseable Referer fails closed",
    ro.checkRequestOrigin(H({ referer: "::::" }), PROD).ok === false);

  /* NAME TRICKS. The comparison is exact, so neither a prefix, a suffix, nor a
   * subdomain of the real origin is the real origin. */
  for (const trick of [
    "https://app.example.com.evil.test",
    "https://evil.app.example.com",
    "https://notapp.example.com",
    "http://app.example.com",
    "https://app.example.com:8443",
    "https://app.example.com/",
  ]) {
    check(`  refuses ${trick}`,
      ro.checkRequestOrigin(H({ origin: trick }), PROD).ok === false,
      JSON.stringify(ro.checkRequestOrigin(H({ origin: trick }), PROD)));
  }

  /* HOST HEADERS ARE NOT CONSULTED. The allow-list is configuration; a caller
   * who can set Host or X-Forwarded-Host must not be able to choose it. */
  check("a forged Host cannot make an untrusted origin acceptable",
    ro.checkRequestOrigin(H({
      origin: "https://evil.test", host: "app.example.com",
      "x-forwarded-host": "app.example.com",
    }), PROD).ok === false);
  check("and Host alone is never an identity",
    ro.checkRequestOrigin(H({ host: "app.example.com" }), PROD).ok === false);

  const roCode = codeOnly("src/lib/server/request-origin.ts");
  check("the helper reads neither host nor any forwarded header",
    !/\bhost\b|forwarded/i.test(roCode), "host or forwarded header referenced");
  check("and takes no origin from a body or query string",
    !/body|searchParams|\.json\(\)/.test(roCode));
}

/* ---------------------------------------------------------------- G ---- */
section("G. Every mutating handler is accounted for");

{
  /* JUSTIFIED EXCEPTIONS, each with the mechanism that protects it instead of a
   * browser origin check. Anything mutating that is not here and not
   * origin-checked fails this section — which is the point: a new unguarded
   * mutation route should break the suite, not wait for an audit. */
  const EXEMPT = new Map([
    ["webhooks/whop:POST", "signature"],
    ["analytics/collect:POST", "public"],
  ]);

  const routes = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") routes.push(p);
    }
  };
  walk("src/app/api");

  const classified = [];
  for (const file of routes) {
    const code = codeOnly(file);
    const name = file.replace(/\\/g, "/").replace("src/app/api/", "").replace("/route.ts", "");
    const marks = [...code.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)]
      .map((m) => [m[1], m.index]);
    marks.push(["END", code.length]);
    for (let i = 0; i < marks.length - 1; i++) {
      const [method, start] = marks[i];
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      const body = code.slice(start, marks[i + 1][1]);
      classified.push({
        name, method, id: `${name}:${method}`,
        origin: /checkRequestOrigin\(/.test(body),
        signature: /verifyWebhook\(/.test(body),
      });
    }
  }

  check("mutating handlers were found at all — the parser works",
    classified.length >= 25, `${classified.length} handlers`);

  const unexplained = classified.filter(
    (h) => !h.origin && !(EXEMPT.has(h.id) && (EXEMPT.get(h.id) !== "signature" || h.signature)));
  check("NO unexplained mutating handler",
    unexplained.length === 0, unexplained.map((h) => h.id).join(", "));

  /* THE TWO EXEMPTIONS, EACH PROVEN RATHER THAN TRUSTED. */
  const hook = classified.find((h) => h.id === "webhooks/whop:POST");
  check("the webhook mutation verifies a signature instead of an origin",
    hook?.signature === true && hook?.origin === false);
  const hookCode = bodyOnly("src/app/api/webhooks/whop/route.ts");
  check("and verifies the RAW body before parsing it",
    hookCode.indexOf("request.text()") < hookCode.indexOf("verifyWebhook") &&
      !/request\.json\(\)/.test(hookCode),
    `text@${hookCode.indexOf("request.text()")} verify@${hookCode.indexOf("verifyWebhook")}`);
  check("an unverified delivery is never acknowledged",
    /if \(!verified\.ok\)/.test(hookCode));

  const an = classified.find((h) => h.id === "analytics/collect:POST");
  check("the public analytics mutation is bounded instead", an?.origin === false &&
    /MAX_BODY_BYTES/.test(codeOnly("src/app/api/analytics/collect/route.ts")) &&
    /MAX_BATCH/.test(codeOnly("src/app/api/analytics/collect/route.ts")));

  /* THE SESSION ROUTES SPECIFICALLY, because they are the ones a login-CSRF
   * targets and the ones that need no cookie to succeed. */
  for (const id of ["auth/session:POST", "auth/session:DELETE",
                    "admin/session:POST", "admin/session:DELETE"]) {
    check(`${id} checks the request origin`,
      classified.find((h) => h.id === id)?.origin === true);
  }

  /* PROVIDER CALLBACKS ARE GETs and must NOT be origin-checked — the browser
   * arrives from the provider's own domain. They carry a state cookie instead,
   * and this asserts the mechanism is there rather than absent. */
  for (const cb of ["whop/callback", "google/calendar/callback"]) {
    const code = codeOnly(`src/app/api/${cb}/route.ts`);
    check(`${cb} uses a state cookie, not a browser origin check`,
      !/checkRequestOrigin/.test(code) && /state/i.test(code));
  }
  const wc = codeOnly("src/app/api/whop/callback/route.ts");
  check("the whop callback compares the state cookie to the URL state",
    /cookieState !== state/.test(wc));
  check("and builds its redirect from configuration, not from the request host",
    /getAppPublicUrl\(\)/.test(wc) && !/x-forwarded-host/i.test(wc));
  check("refusing an absolute or protocol-relative return path",
    /startsWith\("\/"\)/.test(wc) && /startsWith\("\/\/"\)/.test(wc));
}

/* ---------------------------------------------------------------- H ---- */
section("H. Cookies, CORS and caching");

{
  const us = codeOnly("src/lib/server/user-session.ts");
  const as = codeOnly("src/app/api/admin/session/route.ts");
  const ag = codeOnly("src/lib/server/admin-guard.ts");

  check("the creator session cookie is httpOnly",  /httpOnly: true/.test(us));
  check("secure in production only",               /secure: process\.env\.NODE_ENV === "production"/.test(us));
  check("sameSite lax, so a cross-site POST carries no session",
    /sameSite: "lax"/.test(us));
  check("path / and a bounded maxAge",             /path: "\/"/.test(us) && /maxAge: maxAgeSeconds/.test(us));
  /* SIGN-OUT MUST MATCH SIGN-IN. A cookie cleared with different attributes is
   * a cookie that does not get cleared. */
  const authRoute = codeOnly("src/app/api/auth/session/route.ts");
  check("sign-out clears the cookie through the same options helper",
    (authRoute.match(/userSessionCookieOptions\(/g) ?? []).length === 2 &&
      /userSessionCookieOptions\(0\)/.test(authRoute));

  check("the admin cookie is httpOnly and sameSite STRICT — stricter than the creator's",
    /httpOnly: true/.test(as) && /sameSite: "strict"/.test(as));
  check("and expires sooner than a creator session",
    loadTs("src/lib/server/admin-guard.ts").ADMIN_SESSION_MAX_AGE_MS <
      loadTs("src/lib/server/user-session.ts").USER_SESSION_MAX_AGE_MS,
    `${loadTs("src/lib/server/admin-guard.ts").ADMIN_SESSION_MAX_AGE_MS} < ${loadTs("src/lib/server/user-session.ts").USER_SESSION_MAX_AGE_MS}`);
  check("admin sign-out clears with the same attributes it set",
    (as.match(/sameSite: "strict"/g) ?? []).length >= 2 && /maxAge: 0/.test(as));

  /* NO CORS AT ALL. Nothing needs cross-origin access, so the safest policy is
   * the absence of one — and `*` with credentials is the mistake this rules out
   * by construction. */
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) all.push(p);
    }
  };
  walk("src");
  /* CODE, NOT COMMENTS. A comment explaining why this app sends no CORS header
   * names the header, and a raw-text scan reports the explanation as the
   * offence. */
  const cors = all.filter((f) => /Access-Control-Allow/i.test(codeOnly(f)));
  check("no Access-Control-Allow-* header is emitted anywhere",
    cors.length === 0, cors.join(", "));
  const options = all.filter((f) => /export (async )?function OPTIONS/.test(src(f)));
  check("and no OPTIONS handler grants a preflight",
    options.length === 0, options.join(", "));
  check("next.config emits no CORS header either",
    !/Access-Control/i.test(src("next.config.ts")));

  /* SENSITIVE RESPONSES MUST NOT BE CACHEABLE. The admin wrapper sets no-store
   * centrally; creator routes set it themselves. */
  check("withAdminApi sets no-store on every admin response",
    /"cache-control": "no-store"/.test(ag));
  const sensitive = [
    "creator/earnings", "creator/notifications", "creator/notifications/read",
    "creator/withdraw", "whop/kyc/status", "whop/payout/status", "whop/connection",
    "onboarding/profile", "auth/session", "admin/session",
  ];
  for (const r of sensitive) {
    check(`  ${r} is no-store`, /no-store/.test(codeOnly(`src/app/api/${r}/route.ts`)));
  }

  /* NOTHING LEAKS FROM A FAILURE. Closed-set reason codes, never an exception. */
  const apiFiles = all.filter((f) => f.includes("app") && f.endsWith("route.ts"));
  const leaky = apiFiles.filter((f) => /\.stack|String\(error\)|error: error[,}\s]/.test(codeOnly(f)));
  check("no API route returns a stack trace or a raw error object",
    leaky.length === 0, leaky.join(", "));
}

/* ---------------------------------------------------------------- I ---- */
section("I. Nothing secret reaches the browser");

{
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) all.push(p);
    }
  };
  walk("src");

  /* EVERY NEXT_PUBLIC_ VARIABLE IS PUBLISHED TO THE BROWSER, so the allow-list
   * is the security boundary. Firebase's client config is public by design —
   * access is enforced by rules and by our own server, not by hiding the key. */
  const ALLOWED_PUBLIC = new Set([
    "NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_SITE_URL",
  ]);
  const found = new Set();
  for (const f of all) for (const m of src(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) found.add(m[0]);
  const unexpected = [...found].filter((v) => !ALLOWED_PUBLIC.has(v));
  check("no NEXT_PUBLIC_ variable outside the reviewed list",
    unexpected.length === 0, unexpected.join(", "));

  /* AND NO SERVER SECRET IS NAMED IN CLIENT CODE. A "use client" file that
   * reads one would ship it. */
  const SECRETS = [
    "WHOP_API_KEY", "WHOP_WEBHOOK_SECRET", "WHOP_CLIENT_SECRET",
    "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "DATABASE_URL",
    "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY",
    "WHOP_TOKEN_ENCRYPTION_KEY",
  ];
  const clientFiles = all.filter((f) => /^\s*["']use client["']/.test(src(f)));
  check("client components were found — the scan is not looking at nothing",
    clientFiles.length > 5, `${clientFiles.length} client files`);
  const exposed = [];
  for (const f of clientFiles) {
    for (const s of SECRETS) if (src(f).includes(s)) exposed.push(`${f}: ${s}`);
  }
  check("no server secret is named in any client component",
    exposed.length === 0, exposed.join(", "));

  /* SERVER-ONLY MODULES SAY SO, so importing one into a client component is a
   * build error rather than a silent bundle. */
  for (const f of ["src/lib/server/request-origin.ts", "src/lib/server/app-url.ts",
                   "src/lib/server/user-session.ts", "src/lib/server/rate-limit.ts"]) {
    check(`  ${f.split("/").pop()} is marked server-only`, /import "server-only"/.test(src(f)));
  }

  check("browser source maps are not enabled in production",
    !/productionBrowserSourceMaps:\s*true/.test(src("next.config.ts")));
}

/* ---------------------------------------------------------------- J ---- */
section("J. Redirect targets are fixed, not caller-chosen");

{
  /* A NOTIFICATION'S action_url IS RENDERED AS A LINK, so a caller-supplied
   * value would be a stored open redirect — or a javascript: URL. Every one is
   * a literal relative path written by the server. */
  const triggers = codeOnly("src/lib/server/notification-triggers.ts");
  const urls = [...triggers.matchAll(/actionUrl: ("([^"]*)"|[^,\n]+)/g)].map((m) => m[1]);
  check("every notification action_url is a literal", urls.length > 0 &&
    urls.every((u) => u.startsWith('"')), urls.filter((u) => !u.startsWith('"')).join(", "));
  check("and every one is a relative path on this site",
    urls.every((u) => u.startsWith('"/') && !u.startsWith('"//')),
    urls.join(" "));

  /* THE PUBLIC ORIGIN CANNOT BE A LOCAL OR PLAINTEXT HOST, which is what stops
   * a misconfiguration from becoming a redirect off-site. */
  const appUrl = loadTs("src/lib/server/app-url.ts");
  for (const [label, value, reason] of [
    ["a localhost origin", "https://localhost", "local_host"],
    ["a plaintext origin", "http://app.example.com", "not_https"],
    ["a relative value", "/dashboard", "not_absolute"],
    ["an empty value", "", "missing"],
  ]) {
    const r = appUrl.resolveAppPublicUrl({ APP_PUBLIC_URL: value }, "production");
    check(`  ${label} is refused as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }
  check("a tunnel is refused in production and allowed in sandbox",
    appUrl.resolveAppPublicUrl({ APP_PUBLIC_URL: "https://x.ngrok-free.app" }, "production").ok === false &&
      appUrl.resolveAppPublicUrl({ APP_PUBLIC_URL: "https://x.ngrok-free.app" }, "sandbox").ok === true);

  /* THE CHECKOUT RETURN URL takes a locale from the caller and must not let it
   * become a path. */
  const env = { APP_PUBLIC_URL: "https://app.example.com" };
  check("an unknown locale falls back instead of being interpolated",
    appUrl.buildCheckoutReturnUrl("o1", "../../evil", env) ===
      "https://app.example.com/en/checkout/sandbox/complete?order_id=o1",
    String(appUrl.buildCheckoutReturnUrl("o1", "../../evil", env)));
  check("and the order id is encoded",
    appUrl.buildCheckoutReturnUrl("a b&c=d", "en", env).endsWith("order_id=a%20b%26c%3Dd"),
    String(appUrl.buildCheckoutReturnUrl("a b&c=d", "en", env)));
}

/* ---------------------------------------------------------------- K ---- */
section("K. withAdminApi still passes a refusal through");

{
  /* A 403 FROM AN ORIGIN CHECK, OR A 429, MUST REACH THE CLIENT AS ITSELF.
   * `Response.json(aResponse)` serialises to `{}` with status 200, which is how
   * a refusal used to look like a success — fixed in Task #18 and asserted here
   * because this task's fixes add another handler-returned 403. */
  const guard = codeOnly("src/lib/server/admin-guard.ts");
  check("a handler-returned Response is returned unchanged",
    /if \(body instanceof Response\) return body;/.test(guard));
  check("and the check precedes the serialising return",
    guard.indexOf("body instanceof Response") <
      guard.indexOf("return Response.json(body"));

  /* AND A 403 COSTS NOTHING. The origin check is the first statement in each
   * mutating handler, so a refused request reaches no audit, no provider and no
   * journal. */
  const mutatingRoutes = [];
  const walkRoutes = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkRoutes(p);
      else if (e.name === "route.ts" &&
        /export async function (POST|PUT|PATCH|DELETE)/.test(src(p))) mutatingRoutes.push(p);
    }
  };
  walkRoutes("src/app/api");

  const financial = [
    ["admin/transfer/creator", ["initiateCreatorTransfer", "writeAudit"]],
    ["admin/earnings/record", ["recordCreatorEarning", "writeAudit"]],
    ["admin/fees/reconcile/[id]", ["reconcileProviderFees", "writeAudit"]],
    ["admin/withdrawals/reconcile", ["sweepPendingWithdrawals", "writeAudit"]],
    ["creator/withdraw", ["requestWithdrawal"]],
    ["checkout/sandbox", ["createWhopCheckoutForOrder"]],
    ["whop/payout/portal", []],
    ["admin/session", ["createSessionCookie"]],
    ["auth/session", ["createSessionCookie", "provisionUser"]],
  ];
  for (const [route, afters] of financial) {
    const body = codeOnly(`src/app/api/${route}/route.ts`)
      .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
    const at = body.indexOf("checkRequestOrigin");
    check(`${route} checks the origin before anything else`, at >= 0);
    for (const after of afters) {
      const pos = body.indexOf(after);
      if (pos < 0) continue;
      check(`  and before ${after}`, at < pos, `${at} < ${pos}`);
    }
  }

  /* AND THE SAME ORDERING RULE OVER EVERY ORIGIN-CHECKED MUTATION, not a
   * hand-picked list — the first mutation run moved the check behind a body read
   * on `whop/connect`, which the list above does not mention, and nothing
   * failed. Reading the body before refusing is not a vulnerability by itself,
   * but it is the shape of one: it means work happens before the gate, and it is
   * how a gate ends up after a side effect.
   *
   * BOTH readers are checked. Only looking for `request.json()` let a
   * `request.text()` slip past. */
  for (const file of mutatingRoutes) {
    const body = codeOnly(file).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
    const at = body.indexOf("checkRequestOrigin");
    if (at < 0) continue;
    const name = file.replace(/\\/g, "/").replace("src/app/api/", "").replace("/route.ts", "");
    for (const reader of ["request.json()", "request.text()", "request.formData()"]) {
      const pos = body.indexOf(reader);
      if (pos >= 0) {
        check(`${name}: origin checked before ${reader}`, at < pos, `${at} < ${pos}`);
      }
    }
  }
}

/* ---------------------------------------------------------------- L ---- */
section("L. This suite touches no database");

{
  /* THE STRONGEST FORM OF "THE REAL DB IS UNCHANGED" IS NOT NEEDING ONE. Every
   * assertion above is over configuration, source structure, and pure functions,
   * so there is no connection to leak and no schema to clean up. */
  /* ASKED OF THE RUNTIME, NOT OF THIS FILE'S TEXT. A regex over its own source
   * is circular — the pattern matches the pattern — and it proves nothing about
   * what ran. `require.cache` records every module that was actually loaded, so
   * the absence of a driver there is evidence rather than a claim. */
  const loaded = Object.keys(require.cache);
  check("the postgres driver was never loaded",
    !loaded.some((m) => /node_modules[\\/]postgres[\\/]/.test(m)),
    loaded.filter((m) => /node_modules[\\/]postgres[\\/]/.test(m)).join(", "));
  check("nor any drizzle client",
    !loaded.some((m) => /node_modules[\\/]drizzle-orm[\\/]/.test(m)));
  check("and no application module that talks to the database was transpiled",
    ![...cache.keys()].some((m) => /[\\/]lib[\\/]db[\\/]/.test(m)),
    [...cache.keys()].filter((m) => /[\\/]lib[\\/]db[\\/]/.test(m)).join(", "));
  check("so there is no connection for the real database to be reached through",
    typeof globalThis.__pgConnections === "undefined");
}

/* ========================================================================= */

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
