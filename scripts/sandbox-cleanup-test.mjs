#!/usr/bin/env node
/**
 * TASK #25 — SANDBOX CLEANUP.
 *
 * The audit found the codebase already well defended: the Whop environment is
 * resolved once, from server configuration, by exact string match, with no
 * fallback and an explicit `baseUrl` on every client; the sandbox checkout is
 * double-gated and 404s otherwise; no provider id is hardcoded in runtime code;
 * no client component imports a server module; every provider error log goes
 * through a sanitiser. One thing was wrong, and it was the one that mattered:
 *
 *   `whop_connections` — the Whop OAuth link — had NO environment column.
 *
 * That looked defensible because OAuth is a different credential from payments.
 * It is not defensible: `whop-oauth.ts` resolves the authorize, token and
 * userinfo hosts from WHOP_ENV against two different hosts, and an app created
 * at sandbox.whop.com exists only there. So `whop_user_id`, the scopes and the
 * encrypted tokens in a row are all meaningful in exactly one environment, and
 * nothing recorded which.
 *
 * WHAT THAT COST. `POST /api/whop/account` uses `getActiveConnection(uid)` as
 * its proof of provider identity — the `whop_identity_required` gate. That read
 * was environment-blind, so after a cutover to production a creator whose only
 * link was made in SANDBOX still passed the gate, and the route then created a
 * REAL production connected account via the platform API key, writing the
 * sandbox subject into that account's provider metadata — which the
 * reconciliation path later reads back as identity. A sandbox artefact
 * authorising a production provider mutation.
 *
 * DB-BACKED, because the fix is half schema. The new per-environment unique
 * indexes are the thing that lets one creator hold a sandbox link and a
 * production link at once, and no fake can demonstrate a partial unique index.
 *
 * NO NETWORK. NOTHING IS WRITTEN TO public — every table the modules name
 * resolves to a throwaway schema, verified before a single row is written, and
 * the real database is counted before and after.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

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

const SCRATCH = "sandbox_cleanup_selftest";

/* =========================================================================
   Loader. The database and process.env are the only seams.
   ========================================================================= */

const cache = new Map();
let DB = null;

/* EVERY WhopClient CONSTRUCTION, RECORDED.
 *
 * The SDK is stubbed rather than imported because the single most dangerous
 * fallback in this codebase is invisible from the outside: `new WhopClient({})`
 * with no `baseUrl` silently uses the SDK's own default, which is PRODUCTION. A
 * sandbox-configured process that forgot the argument would move real money
 * while every environment string in the app still read "sandbox". Asserting the
 * URL map alone cannot see that — only the constructor argument can. */
const sdkConstructions = [];
class FakeWhopClient {
  constructor(options) { sdkConstructions.push(options ?? {}); this.options = options; }
}

function loadTs(file) {
  const key = resolve(file);
  if (cache.has(key)) return cache.get(key).exports;
  const js = ts.transpileModule(readFileSync(key, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  cache.set(key, mod);
  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@whop/sdk") return { WhopClient: FakeWhopClient };
    if (spec === "@/lib/db") {
      return {
        getDb: () => DB,
        isDatabaseConfigured: () => DB !== null,
        schema: loadTs("src/lib/db/schema.ts"),
      };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try { return loadTs(`${base}.ts`); } catch { return loadTs(`${base}/index.ts`); }
    }
    return require(spec);
  };
  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

/** Runs `fn` with WHOP_ENV set to `value` (or removed), then restores it. */
async function withEnv(value, fn) {
  const saved = process.env.WHOP_ENV;
  if (value === null) delete process.env.WHOP_ENV;
  else process.env.WHOP_ENV = value;
  try { return await fn(); }
  finally {
    if (saved === undefined) delete process.env.WHOP_ENV;
    else process.env.WHOP_ENV = saved;
  }
}

/* ---------------------------------------------------------------- A ---- */
section("A. The environment is server-decided, exact, and never defaulted");

{
  const wp = loadTs("src/lib/server/whop-payments.ts");
  const base = { WHOP_API_KEY: "k", WHOP_COMPANY_ID: "biz_abc123" };

  check("sandbox resolves to the sandbox host",
    wp.resolveWhopPayments({ ...base, WHOP_ENV: "sandbox" }).config.baseUrl ===
      "https://sandbox-api.whop.com/api/v1");
  check("production resolves to the production host",
    wp.resolveWhopPayments({ ...base, WHOP_ENV: "production" }).config.baseUrl ===
      "https://api.whop.com/api/v1");

  /* NO FALLBACK IN EITHER DIRECTION. A missing value must not become sandbox
   * (which would silently stop real payments) and must not become production
   * (which would silently start them). */
  for (const [label, value, reason] of [
    ["an absent WHOP_ENV", undefined, "missing_environment"],
    ["an empty WHOP_ENV", "", "missing_environment"],
    ["a capitalised value", "Production", "invalid_environment"],
    ["an upper-case value", "SANDBOX", "invalid_environment"],
    ["a plausible synonym", "prod", "invalid_environment"],
    ["a plausible synonym", "live", "invalid_environment"],
    ["a plausible synonym", "test", "invalid_environment"],
    ["a plausible synonym", "dev", "invalid_environment"],
  ]) {
    const r = wp.resolveWhopPayments({ ...base, WHOP_ENV: value });
    check(`  ${label} (${JSON.stringify(value)}) is refused as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }
  check("and an unresolved environment is null, never a string",
    wp.getWhopEnvironment({ ...base }) === null);

  /* TRIMMED BUT NOT NORMALISED, asserted as the two separate properties they
   * are. Stripping whitespace from an env file is a kindness; accepting "prod"
   * or "Production" would be a guess about what an operator meant, and that is
   * how a test key ends up aimed at a live company. */
  check("surrounding whitespace is trimmed, so a stray space still says sandbox",
    wp.getWhopEnvironment({ ...base, WHOP_ENV: " sandbox " }) === "sandbox");
  check("but case is never normalised",
    wp.getWhopEnvironment({ ...base, WHOP_ENV: "Sandbox" }) === null);

  /* ONLY TWO ENVIRONMENTS EXIST, so no third value can be smuggled in. */
  check("exactly two base URLs are defined",
    Object.keys(wp.WHOP_API_BASE_URLS).sort().join(",") === "production,sandbox");
  check("neither is a localhost or tunnel host",
    !Object.values(wp.WHOP_API_BASE_URLS).some((u) => /localhost|127\.|ngrok|trycloudflare|loca\.lt/.test(u)),
    Object.values(wp.WHOP_API_BASE_URLS).join(" "));
  check("and both are https",
    Object.values(wp.WHOP_API_BASE_URLS).every((u) => u.startsWith("https://")));

  /* OAUTH IS SPLIT THE SAME WAY, which is the fact that made an
   * environment-blind connection row wrong. */
  const oa = loadTs("src/lib/server/whop-oauth.ts");
  check("OAuth has its own two hosts, mirroring payments",
    oa.WHOP_OAUTH_BASE_URLS.sandbox !== oa.WHOP_OAUTH_BASE_URLS.production &&
      oa.WHOP_OAUTH_BASE_URLS.sandbox.includes("sandbox"),
    Object.values(oa.WHOP_OAUTH_BASE_URLS).join(" "));

  /* THE CLIENT IS BUILT WITH AN EXPLICIT baseUrl, EVERY TIME.
   *
   * This is the assertion that the environment actually reaches the wire. The
   * SDK defaults to production when `baseUrl` is omitted, so a sandbox-resolved
   * config that forgot to pass it would talk to the live API while every
   * environment string in the process still said "sandbox" — the one failure
   * mode no amount of checking our own variables can detect. */
  {
    sdkConstructions.length = 0;
    const sandboxClient = wp.getWhopPaymentsClient({ ...base, WHOP_ENV: "sandbox" });
    check("a client is built for a valid sandbox config", sandboxClient !== null);
    check("and it was given an EXPLICIT baseUrl",
      sdkConstructions.length === 1 &&
        typeof sdkConstructions[0].baseUrl === "string" &&
        sdkConstructions[0].baseUrl.length > 0,
      JSON.stringify(Object.keys(sdkConstructions[0] ?? {})));
    check("which is the SANDBOX host, not the SDK's production default",
      sdkConstructions[0]?.baseUrl === wp.WHOP_API_BASE_URLS.sandbox,
      String(sdkConstructions[0]?.baseUrl));

    /* AND A DIFFERENT ENVIRONMENT PRODUCES A DIFFERENT HOST — so the cache
     * cannot keep serving a client built for the other one. */
    sdkConstructions.length = 0;
    wp.getWhopPaymentsClient({ ...base, WHOP_ENV: "production" });
    check("production builds a client aimed at the production host",
      sdkConstructions.length === 1 &&
        sdkConstructions[0].baseUrl === wp.WHOP_API_BASE_URLS.production,
      String(sdkConstructions[0]?.baseUrl));

    /* NO CLIENT AT ALL when configuration is unusable — never a default one. */
    sdkConstructions.length = 0;
    check("an unresolved environment yields no client",
      wp.getWhopPaymentsClient({ ...base }) === null);
    check("and constructs nothing", sdkConstructions.length === 0);
    check("a missing API key yields no client either",
      wp.getWhopPaymentsClient({ WHOP_COMPANY_ID: "biz_abc123", WHOP_ENV: "sandbox" }) === null &&
        sdkConstructions.length === 0);
  }

  /* NOTHING REQUEST-SHAPED CHOOSES THE ENVIRONMENT. */
  const wpCode = codeOnly("src/lib/server/whop-payments.ts");
  check("the resolver reads no request, header, body or query",
    !/\brequest\b|headers\.get|searchParams|\.json\(\)|\bbody\b/i.test(wpCode));
  check("and reads WHOP_ENV rather than NODE_ENV",
    /read\(env, "WHOP_ENV"\)/.test(wpCode) && !/NODE_ENV/.test(wpCode));
}

/* ---------------------------------------------------------------- B ---- */
section("B. No route or component accepts an environment from the caller");

{
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");

  /* A REQUEST-SUPPLIED ENVIRONMENT IS THE WHOLE CLASS OF DEFECT THIS TASK IS
   * ABOUT, so the sweep is over every source file rather than a chosen list. */
  const offenders = [];
  for (const f of files) {
    /* THE i18n DICTIONARIES ARE UI COPY, NOT LOGIC. They contain the admin
     * sandbox-audit screen's own explanatory text — including the phrase "unique
     * indexes that do not include the environment" — so a pattern hunting for
     * environment-near-request fires on the explanation of the very rule it is
     * enforcing. */
    if (/[\\/]i18n[\\/]dictionaries[\\/]/.test(f)) continue;
    const code = codeOnly(f);
    for (const m of code.matchAll(
      /(?:body|payload|params|searchParams|query|json\(\))[^\n;]{0,80}\.?\b(environment|whop_env|whopEnv)\b/gi)) {
      offenders.push(`${f}: ${m[0].trim().slice(0, 70)}`);
    }
    for (const m of code.matchAll(/searchParams\.get\(\s*["'](environment|env|whop_env)["']/gi)) {
      offenders.push(`${f}: ${m[0]}`);
    }
  }
  check("no source file derives an environment from a request",
    offenders.length === 0, offenders.join(" | "));

  /* AND EVERY ROUTE THAT NAMES AN ENVIRONMENT GETS IT FROM CONFIGURATION. */
  const routeFiles = files.filter((f) => f.endsWith("route.ts"));
  const bad = [];
  for (const f of routeFiles) {
    const code = codeOnly(f);
    if (!/\benvironment\b/.test(code)) continue;
    /* `currentEnvironment()` is a one-line alias for `getWhopEnvironment()` in
     * google-calendar-connection.ts — the Google flows resolve the environment
     * through it, and it is server config and fail-closed exactly like the
     * original. Accepted by name rather than by chasing aliases. */
    if (!/getWhopEnvironment\(|currentEnvironment\(|resolvePlatformConfig\(|platform\.config|\.environment\b/.test(code)) {
      bad.push(f);
    }
  }
  check("every route naming an environment resolves it server-side",
    bad.length === 0, bad.join(", "));
}

/* ---------------------------------------------------------------- C ---- */
section("C. The sandbox surfaces are gated, and the gate is not NODE_ENV");

{
  const so = loadTs("src/lib/server/sandbox-orders.ts");
  const base = { WHOP_API_KEY: "k", WHOP_COMPANY_ID: "biz_abc123" };

  /* BOTH CONDITIONS REQUIRED, and the default is off. */
  check("sandbox + explicit opt-in is the only combination that enables it",
    so.isSandboxOrderingEnabled({ ...base, WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" }) === true);
  for (const [label, env] of [
    ["sandbox without the opt-in", { WHOP_ENV: "sandbox" }],
    ["sandbox with the opt-in unset to something else", { WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "1" }],
    ["sandbox with the opt-in capitalised", { WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "TRUE" }],
    ["PRODUCTION with the opt-in on", { WHOP_ENV: "production", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" }],
    ["an unresolved environment with the opt-in on", { ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" }],
    ["an invalid environment with the opt-in on", { WHOP_ENV: "prod", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" }],
  ]) {
    check(`  ${label} leaves it OFF`,
      so.isSandboxOrderingEnabled({ ...base, ...env }) === false);
  }

  /* THE FLAG IS NOT NODE_ENV, deliberately: a sandbox key on a deployed preview
   * should still work, and a production key on a laptop must not. */
  const soCode = codeOnly("src/lib/server/sandbox-orders.ts");
  check("the gate does not key on NODE_ENV", !/NODE_ENV/.test(soCode));
  check("the sandbox amount is a server constant, not a request field",
    /SANDBOX_TEST_AMOUNT_MINOR = BigInt\(1000\)/.test(soCode) &&
      !/\bbody\b|searchParams/.test(soCode));

  /* EVERY SANDBOX SURFACE CHECKS THE GATE BEFORE ANYTHING ELSE. */
  for (const [file, gate] of [
    ["src/app/api/checkout/sandbox/route.ts", "isSandboxOrderingEnabled"],
    ["src/app/[locale]/checkout/sandbox/page.tsx", "isSandboxOrderingEnabled"],
    ["src/app/[locale]/checkout/sandbox/complete/page.tsx", "isSandboxOrderingEnabled"],
  ]) {
    const body = codeOnly(file).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
    const at = body.indexOf(gate);
    check(`${file.split("/").slice(-2).join("/")} checks the gate`, at >= 0);
    /* BEFORE THE PROVIDER AND BEFORE THE DATABASE. A 404 must cost nothing. */
    for (const after of ["createSandboxTestOrder", "createWhopCheckoutForOrder", "getDb("]) {
      const pos = body.indexOf(after);
      if (pos >= 0) check(`  and before ${after}`, at < pos, `${at} < ${pos}`);
    }
  }
  const routeBody = codeOnly("src/app/api/checkout/sandbox/route.ts");
  check("both methods of the sandbox route are gated",
    (routeBody.match(/isSandboxOrderingEnabled\(\)/g) ?? []).length >= 2,
    `${(routeBody.match(/isSandboxOrderingEnabled\(\)/g) ?? []).length} gates`);
  check("and an ungated caller gets an indistinguishable 404",
    /not_found/.test(routeBody) && /404/.test(routeBody));

  /* THE ADMIN SANDBOX AUDIT IS READ-ONLY, AND AGREES WITH THE GATE. */
  const sa = codeOnly("src/lib/server/sandbox-audit.ts");
  check("the sandbox audit writes nothing",
    !/\.insert\(|\.update\(|\.delete\(/.test(sa));
  /* ONE COPY OF THE RULE. The audit screen previously compared
   * `process.env.WHOP_ENV` itself, so a trimmed value made it report the sandbox
   * checkout disabled while the checkout page was live — an audit surface that
   * contradicts the thing it audits. */
  check("and reports the gate by calling it, not by re-deriving it",
    /isSandboxOrderingEnabled\(\)/.test(sa) && !/process\.env\.WHOP_ENV/.test(sa),
    (sa.match(/process\.env\.WHOP_ENV[^\n]*/) ?? ["delegates"])[0]);
}

/* ---------------------------------------------------------------- D ---- */
section("D. No sandbox identifier or tunnel host is baked into runtime code");

{
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");

  /* A PROVIDER-ID-SHAPED LITERAL in runtime code is either a fixture that
   * escaped a test or a default nobody chose. Either way production must not
   * depend on it. */
  const ids = [];
  for (const f of files) {
    for (const m of codeOnly(f).matchAll(
      /["'`](biz|pay|acct|po|tr|rf|dp|ch|plan|prod|app)_[A-Za-z0-9]{8,}["'`]/g)) {
      ids.push(`${f}: ${m[0]}`);
    }
  }
  check("no provider-id literal in runtime source", ids.length === 0, ids.join(" | "));

  /* NO TUNNEL OR LOCALHOST HOST AS A VALUE. The refusal lists in app-url.ts and
   * the dev-only allow-list in request-origin.ts are the exceptions, and they
   * exist to REJECT such hosts — so the sweep looks for a URL being used, not a
   * hostname being named. */
  const hosts = [];
  for (const f of files) {
    for (const m of codeOnly(f).matchAll(
      /["'`](https?:\/\/(?:localhost|127\.0\.0\.1|[a-z0-9-]+\.(?:ngrok[a-z.-]*|trycloudflare\.com|loca\.lt))[^"'`]*)["'`]/gi)) {
      if (/request-origin\.ts$/.test(f)) continue; // the dev-only allow-list, gated on NODE_ENV
      hosts.push(`${f}: ${m[1]}`);
    }
  }
  check("no localhost or tunnel URL is used as a value in runtime source",
    hosts.length === 0, hosts.join(" | "));

  /* THE PUBLIC URL REFUSES BOTH, so no misconfiguration produces one. */
  const au = loadTs("src/lib/server/app-url.ts");
  for (const [label, value, reason] of [
    ["localhost", "https://localhost:3000", "local_host"],
    ["127.0.0.1", "https://127.0.0.1:3000", "local_host"],
    ["plaintext", "http://app.example.com", "not_https"],
  ]) {
    const r = au.resolveAppPublicUrl({ APP_PUBLIC_URL: value }, "production");
    check(`  a ${label} public URL is refused as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }
  for (const t of [".ngrok-free.app", ".ngrok.io", ".trycloudflare.com", ".loca.lt"]) {
    check(`  a${t} host is refused in production`,
      au.resolveAppPublicUrl({ APP_PUBLIC_URL: `https://x${t}` }, "production").ok === false);
    check(`    and allowed in sandbox`,
      au.resolveAppPublicUrl({ APP_PUBLIC_URL: `https://x${t}` }, "sandbox").ok === true);
  }
}

/* ---------------------------------------------------------------- E ---- */
section("E. No secret is committed, and none reaches the browser");

{
  /* .env.local IS NOT TRACKED. A committed credential is the one finding that
   * cannot be undone by a code change. */
  check(".env.local is ignored by git",
    /(^|\n)\.env\*?(\.local)?/.test(src(".gitignore")) || /\.env\.local/.test(src(".gitignore")),
    "not found in .gitignore");

  /* AND .env.example CARRIES NO VALUE THAT LOOKS LIKE A REAL CREDENTIAL. */
  const example = src(".env.example");
  const filled = [];
  for (const line of example.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    const v = value.trim();
    if (!v) continue;
    // A documented placeholder or example host is fine; a secret-shaped value is not.
    const looksReal =
      /^(biz|pay|app|whop)_[A-Za-z0-9]{10,}/.test(v) ||
      /^[A-Za-z0-9+/]{40,}={0,2}$/.test(v) ||
      /^postgres(ql)?:\/\/[^\s]*:[^\s]*@/.test(v) ||
      /* A PEM HEADER IS NOT A KEY. The template ships
       * "-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----",
       * which is the shape an operator fills in — so the body has to look like
       * actual base64 key material, not a placeholder, before this counts. */
      (/BEGIN (RSA )?PRIVATE KEY/.test(v) &&
        /[A-Za-z0-9+/]{100,}/.test(v.replace(/\\n/g, "")));
    if (looksReal) filled.push(`${key}=${v.slice(0, 12)}…`);
  }
  check(".env.example contains no credential-shaped value",
    filled.length === 0, filled.join(", "));

  /* SANDBOX VARIABLES ARE NAMED AND DOCUMENTED. */
  for (const key of ["WHOP_ENV", "ENABLE_SANDBOX_CHECKOUT_TEST_UI", "APP_PUBLIC_URL"]) {
    check(`  ${key} is documented in .env.example`, example.includes(`${key}=`));
  }
  check("WHOP_ENV ships without a value, so no environment is implied",
    /^WHOP_ENV=\s*$/m.test(example) || /^WHOP_ENV=$/m.test(example),
    (example.match(/^WHOP_ENV=.*/m) ?? ["absent"])[0]);

  /* SECRETS ARE NEVER NEXT_PUBLIC_. */
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");
  const publicSecrets = [];
  for (const f of files) {
    for (const m of src(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|DATABASE|API_KEY)[A-Z0-9_]*/g)) {
      // Firebase's browser apiKey is public by design and is not a secret.
      if (m[0] === "NEXT_PUBLIC_FIREBASE_API_KEY") continue;
      publicSecrets.push(`${f}: ${m[0]}`);
    }
  }
  check("no secret-shaped NEXT_PUBLIC_ variable", publicSecrets.length === 0, publicSecrets.join(", "));

  /* AND NO CLIENT COMPONENT IMPORTS A SERVER MODULE — `server-only` makes that a
   * build error, so this asserts the marker is actually present where it must be. */
  const clientFiles = files.filter((f) => /^\s*["']use client["']/.test(src(f)));
  const leaks = clientFiles.filter((f) => /@\/lib\/server\//.test(src(f)));
  check("no client component imports from lib/server", leaks.length === 0, leaks.join(", "));
  for (const f of ["whop-payments", "whop-oauth", "whop-connections", "sandbox-orders", "app-url"]) {
    check(`  lib/server/${f}.ts is marked server-only`,
      /import "server-only"/.test(src(`src/lib/server/${f}.ts`)));
  }

  /* NO RUNTIME IMPORT OF A TEST OR FIXTURE MODULE. */
  const fixtureImports = files.filter((f) =>
    /from\s+["'][^"']*(scripts\/|\.test|__tests__|fixtures?\/|mocks?\/)/.test(codeOnly(f)));
  check("runtime source imports no test, script or fixture module",
    fixtureImports.length === 0, fixtureImports.join(", "));
}

/* ---------------------------------------------------------------- F ---- */
section("F. Migration 0015 is written, registered, and not applied here");

{
  const journal = JSON.parse(src("drizzle/meta/_journal.json"));
  const tags = journal.entries.map((e) => e.tag);
  check("0015 is registered in the journal",
    tags.includes("0015_whop_connection_environment"), tags.slice(-2).join(", "));
  check("and is last in the chain",
    tags[tags.length - 1] === "0015_whop_connection_environment");
  check("the chain has no gap and no duplicate",
    new Set(tags).size === tags.length &&
      journal.entries.every((e, i) => e.idx === i),
    `${tags.length} migrations`);

  /* THE STATEMENTS, NOT THE PROSE. This migration's header explains the
   * CREATE-then-DROP ordering by naming 0011 and quotes the partial predicate it
   * preserves, so counting either over the raw file counts the explanation as
   * well as the code. */
  const sqlAll = src("drizzle/0015_whop_connection_environment.sql");
  const sqlText = sqlAll.replace(/^--.*$/gm, "");
  check("it adds environment to both OAuth tables",
    /ALTER TABLE "whop_connections" ADD COLUMN "environment"/.test(sqlText) &&
      /ALTER TABLE "whop_oauth_states" ADD COLUMN "environment"/.test(sqlText));
  /* THE DEFAULT IS A BACKFILL DEVICE, NOT A POLICY. Leaving it in place would
   * let a future insert inherit an environment instead of stating one. */
  check("the backfill default is dropped again",
    (sqlText.match(/DROP DEFAULT/g) ?? []).length === 2);
  check("both new unique indexes include environment",
    /uniq_whop_connection_active_user_env.*"firebase_uid","environment"/s.test(sqlText) &&
      /uniq_whop_connection_active_whop_user_env.*"whop_user_id","environment"/s.test(sqlText));
  check("the old environment-blind indexes are dropped",
    /DROP INDEX "uniq_whop_connection_active_user"/.test(sqlText) &&
      /DROP INDEX "uniq_whop_connection_active_whop_user"/.test(sqlText));
  check("it creates before it drops, so uniqueness is never unenforced",
    sqlText.indexOf("CREATE UNIQUE INDEX") < sqlText.indexOf("DROP INDEX"));
  check("the partial predicate is preserved on both",
    (sqlText.match(/WHERE revoked_at is null/g) ?? []).length === 2);

  /* IT TOUCHES ONLY THE TWO TABLES IT IS ABOUT. Stated as an allow-list over the
   * statements rather than as "does not mention 0011", which the header does
   * mention, on purpose. */
  const touched = new Set(
    [...sqlText.matchAll(/(?:ALTER TABLE|CREATE(?: UNIQUE)? INDEX[^"]*ON)\s+"([a-z_]+)"/g)]
      .map((m) => m[1]));
  check("0015 alters only whop_connections and whop_oauth_states",
    [...touched].sort().join(",") === "whop_connections,whop_oauth_states",
    [...touched].sort().join(","));
  check("and DROPs only the two indexes it replaces",
    [...sqlText.matchAll(/DROP INDEX "([a-z_]+)"/g)].map((m) => m[1]).sort().join(",") ===
      "uniq_whop_connection_active_user,uniq_whop_connection_active_whop_user",
    [...sqlText.matchAll(/DROP INDEX "([a-z_]+)"/g)].map((m) => m[1]).join(","));
  /* AND NO ALREADY-APPLIED MIGRATION FILE WAS EDITED — the real database reports
   * 14 applied, so 0000-0013 are frozen and only 0014/0015 may still change. */
  const applied = tags.filter((t) => /^00(0\d|1[0-3])_/.test(t));
  check("the 14 applied migrations are still present and untouched by this one",
    applied.length === 14, `${applied.length} applied tags`);

  /* SCHEMA.TS MUST AGREE WITH THE MIGRATION.
   *
   * Drizzle's index declarations do not create anything at runtime — the SQL
   * above does — so a schema.ts index that drifted from it would pass every
   * behavioural test in this file and then emit a WRONG generated migration the
   * next time someone runs drizzle-kit. Asserted because a mutation run showed
   * reverting the schema-side index to (firebase_uid) alone surviving everything
   * else here. */
  const schemaSrc = src("src/lib/db/schema.ts");
  const connBlock = schemaSrc.slice(
    schemaSrc.indexOf("export const whopConnections = pgTable"),
    schemaSrc.indexOf("export const accountingTransactions"));
  check("schema.ts declares the per-user index on (firebaseUid, environment)",
    /uniqueIndex\("uniq_whop_connection_active_user_env"\)\s*\n?\s*\.on\(t\.firebaseUid,\s*t\.environment\)/.test(connBlock),
    (connBlock.match(/uniq_whop_connection_active_user_env[\s\S]{0,80}/) ?? ["absent"])[0].replace(/\s+/g, " "));
  check("and the anti-takeover index on (whopUserId, environment)",
    /uniqueIndex\("uniq_whop_connection_active_whop_user_env"\)\s*\n?\s*\.on\(t\.whopUserId,\s*t\.environment\)/.test(connBlock),
    (connBlock.match(/uniq_whop_connection_active_whop_user_env[\s\S]{0,80}/) ?? ["absent"])[0].replace(/\s+/g, " "));
  check("both carry the partial predicate, so revoked history stays unconstrained",
    (connBlock.match(/revoked_at is null/g) ?? []).length >= 2);
  check("and the old environment-blind index names are gone from schema.ts",
    !/uniqueIndex\("uniq_whop_connection_active_user"\)/.test(connBlock) &&
      !/uniqueIndex\("uniq_whop_connection_active_whop_user"\)/.test(connBlock));
  check("whop_connections and whop_oauth_states both declare the column",
    /environment: whopEnvironmentEnum\("environment"\)\.notNull\(\)/.test(connBlock) &&
      /environment: whopEnvironmentEnum\("environment"\)\.notNull\(\)/.test(
        schemaSrc.slice(schemaSrc.indexOf("export const whopOauthStates"),
          schemaSrc.indexOf("export const whopConnections"))));
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const before = {};
  for (const t of ["whop_connections", "whop_oauth_states", "whop_accounts", "payment_orders"]) {
    const [r] = await client.unsafe(`select count(*)::int as n from public.${t}`);
    before[t] = r.n;
  }
  const [beforeMig] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;
  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);
    const [{ schema }] = await client`select current_schema() as schema`;
    if (schema !== SCRATCH) throw new Error(`ISOLATION FAILED — DDL would run in ${schema}`);

    /* THE WHOLE CHAIN, 0015 INCLUDED. That is the point: the new indexes only
     * exist if the migration this task wrote actually applies on top of the
     * fourteen before it. */
    const tags = JSON.parse(src("drizzle/meta/_journal.json")).entries.map((e) => e.tag);
    for (const tag of tags) {
      const text = src(`drizzle/${tag}.sql`);
      for (const stmt of text
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
        .filter(Boolean)) {
        try { await client.unsafe(stmt); }
        catch (e) { throw new Error(`DDL FAILED in ${tag}: ${String(e?.message ?? e).slice(0, 200)}`); }
      }
    }
    check("the full chain including 0015 applies cleanly", true, `${tags.length} migrations`);

    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);
    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('whop_connections')) as conns`;
    if (where.schema !== SCRATCH || where.conns !== SCRATCH) {
      throw new Error(`ISOLATION FAILED — refusing to write: ${where.schema}/${where.conns}`);
    }
    check("ISOLATION PROVED: whop_connections resolves to the throwaway schema",
      true, where.conns);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    process.env.WHOP_API_KEY ??= "test-key";
    process.env.WHOP_COMPANY_ID ??= "biz_selftest";
    /* THE CORRECT VARIABLE NAME. This said WHOP_TOKEN_ENCRYPTION_KEY, which
     * nothing reads — the real one is WHOP_OAUTH_TOKEN_ENCRYPTION_KEY. The suite
     * passed anyway because the .env.local reader above had already supplied the
     * developer's own key, so it was silently depending on local configuration
     * and would have failed with `encryption_unavailable` on a machine without
     * one. Found while inventorying variables in Task #26. */
    process.env.WHOP_OAUTH_TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

    const conns = loadTs("src/lib/server/whop-connections.ts");

    /* ------------------------------------------------------------ G ---- */
    section("G. One creator can hold a sandbox link and a production link");

    const UID = "uid_creator_1";
    const SUB = "user_whopsubject_1";

    const sandboxLink = await withEnv("sandbox", () => conns.linkWhopIdentity({
      firebaseUid: UID, whopUserId: SUB, whopUsername: "creator",
      scopes: "openid", accessToken: "sandbox-access", refreshToken: "sandbox-refresh",
      expiresInSeconds: 3600,
    }));
    check("a sandbox link is stored", sandboxLink.ok === true, JSON.stringify(sandboxLink).slice(0, 120));

    /* THE PER-ENVIRONMENT UNIQUE INDEX IS WHAT MAKES THIS POSSIBLE. Under the
     * old key this insert was refused: one active link per user, full stop. */
    const prodLink = await withEnv("production", () => conns.linkWhopIdentity({
      firebaseUid: UID, whopUserId: SUB, whopUsername: "creator",
      scopes: "openid", accessToken: "production-access", refreshToken: "production-refresh",
      expiresInSeconds: 3600,
    }));
    check("a production link for the SAME user and SAME subject is also stored",
      prodLink.ok === true, JSON.stringify(prodLink).slice(0, 120));
    check("and it did not retire the sandbox link",
      prodLink.ok === true && prodLink.replacedPrevious === false,
      String(prodLink.ok && prodLink.replacedPrevious));
    check("both rows are active at once",
      (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.whop_connections where revoked_at is null`))[0].n === 2);
    const perEnv = (await scoped.unsafe(
      `select environment, count(*)::int as n from ${SCRATCH}.whop_connections
        where revoked_at is null group by environment order by environment`))
      /* SORTED IN JS. `order by environment` on an enum column orders by the
       * enum's DECLARATION order — sandbox is declared first — not
       * alphabetically, so the SQL ordering is not a stable thing to assert. */
      .map((r) => `${r.environment}=${r.n}`).sort().join(" ");
    check("one per environment", perEnv === "production=1 sandbox=1", perEnv);

    /* ------------------------------------------------------------ H ---- */
    section("H. A sandbox link is not a production identity");

    {
      /* THE DEFECT, STATED AS A TEST. A creator linked ONLY in sandbox must not
       * satisfy the `whop_identity_required` gate in production — that gate is
       * what lets `POST /api/whop/account` create a real connected account. */
      const SANDBOX_ONLY = "uid_sandbox_only";
      const r = await withEnv("sandbox", () => conns.linkWhopIdentity({
        firebaseUid: SANDBOX_ONLY, whopUserId: "user_sandbox_only",
        whopUsername: "sbx", scopes: "openid",
        accessToken: "sbx-access", refreshToken: "sbx-refresh", expiresInSeconds: 3600,
      }));
      check("the sandbox-only creator has a link", r.ok === true);

      check("sandbox sees it",
        (await withEnv("sandbox", () => conns.getActiveConnection(SANDBOX_ONLY))) !== null);
      check("PRODUCTION DOES NOT — the gate is closed",
        (await withEnv("production", () => conns.getActiveConnection(SANDBOX_ONLY))) === null);

      /* AND NO CREDENTIAL CROSSES EITHER. Handing a sandbox refresh token to the
       * production host would spend a single-use rotating token for nothing. */
      check("production cannot read the sandbox access token",
        (await withEnv("production", () => conns.getAccessTokenFor(SANDBOX_ONLY))) === null);
      check("sandbox still can",
        (await withEnv("sandbox", () => conns.getAccessTokenFor(SANDBOX_ONLY))) === "sbx-access");

      let refreshCalls = 0;
      const refresh = async () => { refreshCalls += 1; return { ok: false, reason: "provider_error" }; };
      const prodRefresh = await withEnv("production", () =>
        conns.getUsableAccessToken(SANDBOX_ONLY, refresh));
      check("production reports not_connected rather than refreshing a sandbox token",
        prodRefresh.ok === false && prodRefresh.reason === "not_connected",
        JSON.stringify(prodRefresh));
      check("and never called the provider — no rotating token was burned",
        refreshCalls === 0, `${refreshCalls} calls`);

      /* EACH ENVIRONMENT'S TOKEN IS ITS OWN. */
      check("sandbox and production tokens do not cross",
        (await withEnv("sandbox", () => conns.getAccessTokenFor(UID))) === "sandbox-access" &&
        (await withEnv("production", () => conns.getAccessTokenFor(UID))) === "production-access");

      /* DISCONNECT IS SCOPED TOO: it must end what the UI called connected. */
      const dis = await withEnv("production", () => conns.disconnectWhop(UID));
      check("disconnecting in production revokes only the production link", dis.ok === true);
      check("the sandbox link survives",
        (await withEnv("sandbox", () => conns.getActiveConnection(UID))) !== null &&
        (await withEnv("production", () => conns.getActiveConnection(UID))) === null);
    }

    /* ------------------------------------------------------------ I ---- */
    section("I. An unresolved environment fails closed, never to sandbox");

    {
      const UID2 = "uid_failclosed";
      await withEnv("sandbox", () => conns.linkWhopIdentity({
        firebaseUid: UID2, whopUserId: "user_failclosed", whopUsername: null,
        scopes: "openid", accessToken: "a", refreshToken: "b", expiresInSeconds: 3600,
      }));

      /* THE FALLBACK THIS TASK EXISTS TO REMOVE. With WHOP_ENV missing, a
       * sandbox default would quietly serve sandbox rows to code that believes
       * it is configured. */
      /* `" sandbox "` is deliberately ABSENT from this list. Section A proves it
       * resolves to sandbox — whitespace is trimmed — so expecting no connection
       * for it would be asserting the opposite of the documented behaviour. */
      for (const bad of [null, "", "prod", "Production", "SANDBOX", "live"]) {
        check(`  WHOP_ENV=${JSON.stringify(bad)} yields NO connection`,
          (await withEnv(bad, () => conns.getActiveConnection(UID2))) === null);
        check(`    and no token`,
          (await withEnv(bad, () => conns.getAccessTokenFor(UID2))) === null);
      }
      check("a link cannot even be created without a resolved environment",
        (await withEnv(null, () => conns.linkWhopIdentity({
          firebaseUid: "uid_x", whopUserId: "user_x", whopUsername: null, scopes: "openid",
          accessToken: "a", refreshToken: "b", expiresInSeconds: 60,
        }))).ok === false);
      check("and nothing was written by that attempt",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_connections where firebase_uid = 'uid_x'`))[0].n === 0);
      check("sandbox still works, so the guard is not simply breaking everything",
        (await withEnv("sandbox", () => conns.getActiveConnection(UID2))) !== null);
    }

    /* ------------------------------------------------------------ J ---- */
    section("J. The anti-takeover rule holds per environment, and only there");

    {
      /* INSIDE an environment the rule must still bite: one Whop identity, one
       * ClipRewards user. */
      const taken = await withEnv("sandbox", () => conns.linkWhopIdentity({
        firebaseUid: "uid_attacker", whopUserId: "user_whopsubject_1",
        whopUsername: null, scopes: "openid",
        accessToken: "a", refreshToken: "b", expiresInSeconds: 60,
      }));
      check("a second user claiming the same sandbox subject is refused",
        taken.ok === false && taken.reason === "whop_identity_taken", JSON.stringify(taken));

      /* ACROSS environments it must NOT: a sandbox subject naming someone else is
       * not a production takeover, and refusing would be a self-inflicted outage. */
      const across = await withEnv("production", () => conns.linkWhopIdentity({
        firebaseUid: "uid_other", whopUserId: "user_sandbox_only",
        whopUsername: null, scopes: "openid",
        accessToken: "a", refreshToken: "b", expiresInSeconds: 60,
      }));
      check("but the same subject in the OTHER environment is allowed",
        across.ok === true, JSON.stringify(across).slice(0, 120));
    }

    /* ------------------------------------------------------------ K ---- */
    section("K. An OAuth state cannot be redeemed across environments");

    {
      const STATE = "s".repeat(40);
      check("a sandbox authorization is recorded",
        (await withEnv("sandbox", () => conns.createAuthorization({
          state: STATE, firebaseUid: "uid_cb", codeVerifier: "v".repeat(50),
          returnPath: "/dashboard",
        }))) === true);

      /* THE CALLBACK CANNOT CROSS. The code accompanying this state is only
       * exchangeable at the host that issued it. */
      check("production cannot consume it",
        (await withEnv("production", () => conns.consumeAuthorization(STATE))) === null);
      check("and it was NOT deleted by that attempt — a live state survives",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_oauth_states where state = $1`, [STATE]))[0].n === 1);
      check("an unresolved environment cannot consume it either",
        (await withEnv(null, () => conns.consumeAuthorization(STATE))) === null);

      const consumed = await withEnv("sandbox", () => conns.consumeAuthorization(STATE));
      check("sandbox consumes it exactly once",
        consumed !== null && consumed.firebaseUid === "uid_cb" && consumed.returnPath === "/dashboard",
        JSON.stringify(consumed).slice(0, 100));
      check("and a replay finds nothing",
        (await withEnv("sandbox", () => conns.consumeAuthorization(STATE))) === null);
      check("no authorization can be created without a resolved environment",
        (await withEnv(null, () => conns.createAuthorization({
          state: "x".repeat(40), firebaseUid: "uid_cb", codeVerifier: "v".repeat(50),
          returnPath: "/dashboard",
        }))) === false);

      /* THE MIRROR CASE, and it is not redundant. Everything above minted its
       * state in sandbox, so a bug that hardcoded `environment: "sandbox"` on
       * insert would behave identically and pass — which is exactly what a
       * mutation run showed. Minting under PRODUCTION is what distinguishes
       * "records the active environment" from "records a constant". */
      const PSTATE = "p".repeat(40);
      check("a production authorization is recorded",
        (await withEnv("production", () => conns.createAuthorization({
          state: PSTATE, firebaseUid: "uid_cb2", codeVerifier: "v".repeat(50),
          returnPath: "/dashboard",
        }))) === true);
      check("it is stored AS production, not as a hardcoded sandbox",
        (await scoped.unsafe(
          `select environment from ${SCRATCH}.whop_oauth_states where state = $1`,
          [PSTATE]))[0]?.environment === "production",
        String((await scoped.unsafe(
          `select environment from ${SCRATCH}.whop_oauth_states where state = $1`,
          [PSTATE]))[0]?.environment));
      check("sandbox cannot consume a production state",
        (await withEnv("sandbox", () => conns.consumeAuthorization(PSTATE))) === null);
      check("and production consumes its own",
        (await withEnv("production", () => conns.consumeAuthorization(PSTATE))) !== null);

      /* SAME ARGUMENT FOR THE LINK ROW: assert the stored environment, not just
       * which reads can see it. */
      const stored = await scoped.unsafe(
        `select environment from ${SCRATCH}.whop_connections
          where firebase_uid = 'uid_creator_1' order by environment`);
      check("each connection row records the environment it was made in",
        stored.map((r) => r.environment).sort().join(",") === "production,sandbox",
        stored.map((r) => r.environment).join(","));
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    section("L. The real database is untouched");
    for (const t of Object.keys(before)) {
      const [r] = await client.unsafe(`select count(*)::int as n from public.${t}`);
      check(`  public.${t} unchanged`, r.n === before[t], `${before[t]} -> ${r.n}`);
    }
    const [afterMig] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("no migration was applied to the real database",
      afterMig.n === beforeMig.n, `${beforeMig.n} applied`);
    /* 0015 IS DELIBERATELY NOT APPLIED. The task forbids it; the chain is
     * registered and proven to apply, and running it is a separate decision. */
    check("0015 in particular is registered but NOT applied",
      afterMig.n === 14, `${afterMig.n} applied, 16 registered`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) =>
  check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

/* ========================================================================= */

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
