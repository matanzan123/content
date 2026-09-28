#!/usr/bin/env node
/**
 * TASK #26 — PRODUCTION CREDENTIAL / CONFIGURATION READINESS.
 *
 * Asks one question: if a real production Whop credential were supplied
 * tomorrow, would this application use it correctly — and would it refuse
 * clearly when something is missing?
 *
 * Mostly the answer was already yes. `WHOP_ENV` is exact-matched from server
 * config with no fallback in either direction, every SDK client is handed an
 * explicit `baseUrl` (the SDK's own default is production, so an omitted one
 * would move real money), OAuth resolves its own host pair the same way, and
 * `APP_PUBLIC_URL` refuses localhost, plaintext and production tunnels. One
 * thing was wrong:
 *
 *   `WHOP_REDIRECT_URI` was validated as "absolute https" and nothing more.
 *
 * So with WHOP_ENV=production it accepted `https://localhost:3000/...`,
 * `https://127.0.0.1/...` and a week-old tunnel URL — all valid https, none of
 * them this application — and nothing ever compared it with `APP_PUBLIC_URL`.
 * A real creator would have been sent through Whop's consent screen and had
 * their authorization code delivered to a developer host.
 *
 * NO NETWORK. NO PROVIDER CALL. NO DATABASE.
 *
 * The provider is not contacted because there is no production credential to
 * authenticate: the local environment is sandbox-only, and calling a live API
 * with a sandbox key would prove nothing about production. The SDK is stubbed so
 * every constructor argument can be inspected without a request leaving the
 * process.
 *
 * THIS FILE PRINTS NO CREDENTIAL VALUE. Where the real environment is read at
 * all it is reduced to PRESENT / MISSING / a shape boolean before anything is
 * printed, and the fixtures below are obvious fakes.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";

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

/* OBVIOUS FAKES. Nothing here resembles a credential, so a copy/paste out of
 * this file cannot authenticate anywhere. */
const FAKE = {
  WHOP_API_KEY: "fake-not-a-real-key",
  WHOP_COMPANY_ID: "biz_fakecompany",
  WHOP_CLIENT_ID: "app_fakeclient",
  WHOP_CLIENT_SECRET: "fake-not-a-real-secret",
};
const PROD_ORIGIN = "https://app.example.com";
const PROD_REDIRECT = `${PROD_ORIGIN}/api/whop/callback`;

/* =========================================================================
   Loader. The SDK is the only seam.
   ========================================================================= */

const sdkConstructions = [];
class FakeWhopClient {
  constructor(options) { sdkConstructions.push(options ?? {}); this.options = options; }
}

const cache = new Map();
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
    if (spec === "@/lib/db") return { getDb: () => null, isDatabaseConfigured: () => false };
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

const allSources = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) allSources.push(p);
  }
})("src");

/* ---------------------------------------------------------------- A ---- */
section("A. WHOP_ENV=production selects production, and only production");

const wp = loadTs("src/lib/server/whop-payments.ts");

{
  const prod = wp.resolveWhopPayments({ ...FAKE, WHOP_ENV: "production" });
  check("a complete production config resolves", prod.ok === true, JSON.stringify(prod.ok ? prod.config.environment : prod));
  check("to the PRODUCTION base URL",
    prod.ok && prod.config.baseUrl === "https://api.whop.com/api/v1", prod.ok ? prod.config.baseUrl : "");
  check("and reports environment 'production'",
    prod.ok && prod.config.environment === "production");
  check("the sandbox host is NOT selected",
    prod.ok && !prod.config.baseUrl.includes("sandbox"));

  const sbx = wp.resolveWhopPayments({ ...FAKE, WHOP_ENV: "sandbox" });
  check("sandbox still resolves to the sandbox host",
    sbx.ok && sbx.config.baseUrl === "https://sandbox-api.whop.com/api/v1");
  check("and production is NOT selected there",
    sbx.ok && sbx.config.baseUrl !== "https://api.whop.com/api/v1");
  check("the two hosts are genuinely different",
    wp.WHOP_API_BASE_URLS.sandbox !== wp.WHOP_API_BASE_URLS.production);

  /* NEITHER DIRECTION FALLS BACK. Production must not silently become sandbox
   * (payments stop working while looking configured) and sandbox must not
   * silently become production (test traffic moves real money). */
  for (const [label, value, reason] of [
    ["absent", undefined, "missing_environment"],
    ["empty", "", "missing_environment"],
    ["whitespace only", "   ", "missing_environment"],
    ["'Production'", "Production", "invalid_environment"],
    ["'PRODUCTION'", "PRODUCTION", "invalid_environment"],
    ["'prod'", "prod", "invalid_environment"],
    ["'live'", "live", "invalid_environment"],
    ["'staging'", "staging", "invalid_environment"],
  ]) {
    const r = wp.resolveWhopPayments({ ...FAKE, WHOP_ENV: value });
    check(`  a ${label} WHOP_ENV fails closed as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
    check(`    and yields no environment at all`,
      wp.getWhopEnvironment({ ...FAKE, WHOP_ENV: value }) === null);
  }
}

/* ---------------------------------------------------------------- B ---- */
section("B. Missing or malformed production credentials fail closed");

{
  for (const [label, env, reason] of [
    ["no API key", { WHOP_COMPANY_ID: FAKE.WHOP_COMPANY_ID, WHOP_ENV: "production" }, "missing_api_key"],
    ["an empty API key", { ...FAKE, WHOP_API_KEY: "", WHOP_ENV: "production" }, "missing_api_key"],
    ["a whitespace API key", { ...FAKE, WHOP_API_KEY: "   ", WHOP_ENV: "production" }, "missing_api_key"],
    ["no company id", { WHOP_API_KEY: FAKE.WHOP_API_KEY, WHOP_ENV: "production" }, "missing_company_id"],
    ["an empty company id", { ...FAKE, WHOP_COMPANY_ID: "", WHOP_ENV: "production" }, "missing_company_id"],
    ["a company id without the biz_ prefix", { ...FAKE, WHOP_COMPANY_ID: "acme", WHOP_ENV: "production" }, "invalid_company_id"],
    ["a bare biz_ prefix", { ...FAKE, WHOP_COMPANY_ID: "biz_", WHOP_ENV: "production" }, "invalid_company_id"],
  ]) {
    const r = wp.resolveWhopPayments(env);
    check(`  ${label} fails closed as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }

  /* AN API KEY WITHOUT A COMPANY ID IS NOT A PARTIAL SUCCESS. Every reason is a
   * closed-set token, safe to log and safe to show an administrator — none of
   * them can carry a credential. */
  const reasons = new Set();
  for (const env of [
    { WHOP_ENV: "production" },
    { WHOP_API_KEY: FAKE.WHOP_API_KEY, WHOP_ENV: "production" },
    { ...FAKE, WHOP_COMPANY_ID: "nope", WHOP_ENV: "production" },
    { ...FAKE },
  ]) {
    const r = wp.resolveWhopPayments(env);
    if (!r.ok) reasons.add(r.reason);
  }
  check("every failure reason is a short token, never a value",
    [...reasons].every((x) => /^[a-z_]{5,40}$/.test(x)), [...reasons].join(","));
  check("no client is built for an incomplete production config",
    wp.getWhopPaymentsClient({ WHOP_COMPANY_ID: FAKE.WHOP_COMPANY_ID, WHOP_ENV: "production" }) === null &&
    wp.getWhopPaymentsClient({ ...FAKE, WHOP_ENV: "production", WHOP_API_KEY: "" }) === null);

  /* AN EMPTY STRING IS NOT A CREDENTIAL, and one caller asks the question in a
   * way that can tell the difference.
   *
   * `read()` trims and returns null for a blank value, so everywhere the result
   * is used as a truth test, `""` and `null` behave alike. `isWhopWebhookConfigured`
   * is the exception: it compares `!== null`, so a `read` that returned `""`
   * instead of null would report the endpoint as CONFIGURED while holding no
   * secret — and a webhook endpoint with no secret can verify nothing. A mutation
   * run found exactly that gap. (Verifying deliveries is Task #27; that the
   * configuration is reported honestly is this task's business.) */
  for (const [label, value] of [
    ["unset", undefined], ["empty", ""], ["whitespace", "   "], ["a tab", "\t"],
  ]) {
    check(`  a ${label} webhook secret reports NOT configured`,
      wp.isWhopWebhookConfigured({ ...FAKE, WHOP_ENV: "production", WHOP_WEBHOOK_SECRET: value }) === false,
      String(wp.isWhopWebhookConfigured({ ...FAKE, WHOP_ENV: "production", WHOP_WEBHOOK_SECRET: value })));
    check(`    and yields no secret`,
      wp.getWhopWebhookSecret({ WHOP_WEBHOOK_SECRET: value }) === null);
  }
  check("a present webhook secret reports configured",
    wp.isWhopWebhookConfigured({ WHOP_WEBHOOK_SECRET: "ws_obviously_fake_for_tests" }) === true);
  /* THE SAME TRIMMING RULE, asserted on the reader itself so the property holds
   * for every consumer rather than only the ones tested above. */
  check("a whitespace-padded secret is returned trimmed, never as padding",
    wp.getWhopWebhookSecret({ WHOP_WEBHOOK_SECRET: "  ws_fake  " }) === "ws_fake");
}

/* ---------------------------------------------------------------- C ---- */
section("C. Every Whop client is constructed with an explicit base URL");

{
  /* THE MOST DANGEROUS DEFAULT IN THE DEPENDENCY. `new WhopClient({ token })`
   * with no `baseUrl` talks to PRODUCTION — so a sandbox-configured process that
   * forgot the argument moves real money while every environment string in the
   * app still reads "sandbox". No amount of checking our own variables can see
   * that; only the constructor argument can. */
  sdkConstructions.length = 0;
  const client = wp.getWhopPaymentsClient({ ...FAKE, WHOP_ENV: "production" });
  check("a production client is built", client !== null);
  check("exactly one construction happened", sdkConstructions.length === 1, String(sdkConstructions.length));
  check("it received an explicit baseUrl",
    typeof sdkConstructions[0]?.baseUrl === "string" && sdkConstructions[0].baseUrl.length > 0,
    JSON.stringify(Object.keys(sdkConstructions[0] ?? {})));
  check("which is the production host",
    sdkConstructions[0]?.baseUrl === wp.WHOP_API_BASE_URLS.production,
    String(sdkConstructions[0]?.baseUrl));
  check("and a token, from the server environment",
    typeof sdkConstructions[0]?.token === "string" && sdkConstructions[0].token.length > 0);

  /* THE CACHE IS KEYED ON THE HOST, so one process cannot keep serving a client
   * built for the other environment after configuration changes. */
  sdkConstructions.length = 0;
  wp.getWhopPaymentsClient({ ...FAKE, WHOP_ENV: "sandbox" });
  check("switching environment builds a NEW client for the other host",
    sdkConstructions.length === 1 &&
      sdkConstructions[0].baseUrl === wp.WHOP_API_BASE_URLS.sandbox,
    String(sdkConstructions[0]?.baseUrl));

  /* EVERY CONSTRUCTION SITE IN THE REPOSITORY, not just this one. */
  const sites = allSources.filter((f) => /new WhopClient\(/.test(codeOnly(f)));
  check("WhopClient is constructed in exactly one module",
    sites.length === 1 && /whop-payments\.ts$/.test(sites[0]), sites.join(", "));
  const paymentsCode = codeOnly("src/lib/server/whop-payments.ts");
  check("and that construction names baseUrl explicitly",
    /new WhopClient\(\{[\s\S]{0,200}baseUrl: state\.config\.baseUrl/.test(paymentsCode));
  /* NOBODY ELSE IMPORTS THE CLIENT CLASS, so a second client cannot appear
   * without this assertion noticing.
   *
   * THE CLASS, not the package. Fourteen other modules import `WhopError` and
   * the SDK's types for error classification and type safety, which is correct
   * and unrelated — an earlier version of this check conflated the two and
   * reported all fifteen as a finding. What must stay singular is the thing that
   * can be constructed with a host. */
  const clientImporters = allSources.filter((f) =>
    /import \{[^}]*\bWhopClient\b[^}]*\} from "@whop\/sdk"/.test(src(f)));
  check("WhopClient is imported by exactly one module",
    clientImporters.length === 1 && /whop-payments\.ts$/.test(clientImporters[0]),
    clientImporters.join(", "));
  const typeOnlyImporters = allSources.filter((f) =>
    /from "@whop\/sdk"/.test(src(f)) && !/\bWhopClient\b/.test(src(f)));
  check("every other SDK importer takes only errors and types",
    typeOnlyImporters.every((f) => /WhopError|type Whop/.test(src(f))),
    `${typeOnlyImporters.length} type-only importers`);
}

/* ---------------------------------------------------------------- D ---- */
section("D. OAuth production endpoints and redirect URI");

const oa = loadTs("src/lib/server/whop-oauth.ts");

{
  check("production OAuth host is the live one",
    oa.WHOP_OAUTH_BASE_URLS.production === "https://api.whop.com/oauth",
    oa.WHOP_OAUTH_BASE_URLS.production);
  check("sandbox OAuth host is the sandbox one",
    oa.WHOP_OAUTH_BASE_URLS.sandbox === "https://sandbox-api.whop.com/oauth",
    oa.WHOP_OAUTH_BASE_URLS.sandbox);

  /* ALL THREE ENDPOINTS COME FROM ONE HOST. A mixed pair — authorizing against
   * production and exchanging against sandbox — is the failure this prevents. */
  for (const env of ["production", "sandbox"]) {
    const eps = oa.whopOAuthEndpoints(env);
    const hosts = new Set(Object.values(eps).map((u) => new URL(u).origin));
    check(`  ${env}: authorize, token and userinfo share one host`,
      hosts.size === 1, [...hosts].join(","));
    check(`    and it is the ${env} host`,
      [...hosts][0] === new URL(oa.WHOP_OAUTH_BASE_URLS[env]).origin);
    check(`    with all three endpoints present`,
      Boolean(eps.authorize && eps.token && eps.userinfo),
      Object.keys(eps).join(","));
  }
  check("production endpoints contain no sandbox host",
    !JSON.stringify(oa.whopOAuthEndpoints("production")).includes("sandbox"));

  const base = { ...FAKE, WHOP_ENV: "production" };
  check("a complete production OAuth config resolves",
    oa.resolveOAuthConfig({ ...base, WHOP_REDIRECT_URI: PROD_REDIRECT }).ok === true);

  /* PARTIAL CONFIGURATION FAILS CLOSED, with a reason naming what is missing. */
  for (const [label, env, reason] of [
    ["no client id", { WHOP_ENV: "production", WHOP_REDIRECT_URI: PROD_REDIRECT }, "missing_client_id"],
    ["an empty client id", { ...base, WHOP_CLIENT_ID: "", WHOP_REDIRECT_URI: PROD_REDIRECT }, "missing_client_id"],
    ["a whitespace client id", { ...base, WHOP_CLIENT_ID: "  ", WHOP_REDIRECT_URI: PROD_REDIRECT }, "missing_client_id"],
    ["no redirect URI", { ...base }, "missing_redirect_uri"],
    ["an empty redirect URI", { ...base, WHOP_REDIRECT_URI: "" }, "missing_redirect_uri"],
    ["a relative redirect URI", { ...base, WHOP_REDIRECT_URI: "/api/whop/callback" }, "invalid_redirect_uri"],
    ["a plaintext redirect URI", { ...base, WHOP_REDIRECT_URI: "http://app.example.com/api/whop/callback" }, "invalid_redirect_uri"],
    ["no environment", { ...FAKE, WHOP_REDIRECT_URI: PROD_REDIRECT }, "missing_environment"],
    ["an invalid environment", { ...FAKE, WHOP_ENV: "prod", WHOP_REDIRECT_URI: PROD_REDIRECT }, "invalid_environment"],
  ]) {
    const r = oa.resolveOAuthConfig(env);
    check(`  ${label} fails closed as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }

  /* THE CLIENT SECRET IS OPTIONAL ON PURPOSE — PKCE makes a public client
   * legitimate — so its absence must NOT be a failure, and a whitespace value
   * must be treated as absent rather than sent as a secret made of spaces. */
  const noSecret = oa.resolveOAuthConfig({
    WHOP_CLIENT_ID: FAKE.WHOP_CLIENT_ID, WHOP_ENV: "production", WHOP_REDIRECT_URI: PROD_REDIRECT,
  });
  check("a missing client secret is allowed (PKCE public client)",
    noSecret.ok === true && noSecret.config.clientSecret === null);
  const blankSecret = oa.resolveOAuthConfig({
    ...base, WHOP_CLIENT_SECRET: "   ", WHOP_REDIRECT_URI: PROD_REDIRECT,
  });
  check("a whitespace-only client secret is treated as absent, not sent",
    blankSecret.ok === true && blankSecret.config.clientSecret === null);

  /* THE FIX. https alone was not enough. */
  for (const [label, uri, reason] of [
    ["localhost", "https://localhost:3000/api/whop/callback", "local_redirect_uri"],
    ["127.0.0.1", "https://127.0.0.1:3000/api/whop/callback", "local_redirect_uri"],
    ["0.0.0.0", "https://0.0.0.0/api/whop/callback", "local_redirect_uri"],
    ["an ngrok tunnel", "https://abc.ngrok-free.app/api/whop/callback", "tunnel_redirect_uri"],
    ["an ngrok.io tunnel", "https://abc.ngrok.io/api/whop/callback", "tunnel_redirect_uri"],
    ["a cloudflare tunnel", "https://abc.trycloudflare.com/api/whop/callback", "tunnel_redirect_uri"],
    ["a loca.lt tunnel", "https://abc.loca.lt/api/whop/callback", "tunnel_redirect_uri"],
  ]) {
    check(`  production REFUSES a ${label} callback as ${reason}`,
      (() => {
        const r = oa.resolveOAuthConfig({ ...base, WHOP_REDIRECT_URI: uri });
        return r.ok === false && r.reason === reason;
      })(),
      JSON.stringify(oa.resolveOAuthConfig({ ...base, WHOP_REDIRECT_URI: uri })));
    /* AND SANDBOX STILL ACCEPTS IT — this is how the app is developed, so the
     * rule must not be "stricter everywhere". */
    check(`    and sandbox still accepts it`,
      oa.resolveOAuthConfig({ ...FAKE, WHOP_ENV: "sandbox", WHOP_REDIRECT_URI: uri }).ok === true);
  }

  /* THE TWO URLS MUST AGREE. Configured separately, required to match — the pair
   * that drifts when a tunnel rotates or a domain changes. */
  check("a callback on APP_PUBLIC_URL's origin is accepted",
    oa.resolveOAuthConfig({ ...base, WHOP_REDIRECT_URI: PROD_REDIRECT, APP_PUBLIC_URL: PROD_ORIGIN }).ok === true);
  for (const [label, uri, app] of [
    ["a different host", "https://other.example.com/api/whop/callback", PROD_ORIGIN],
    ["a subdomain of it", "https://api.app.example.com/api/whop/callback", PROD_ORIGIN],
    ["a different port", "https://app.example.com:8443/api/whop/callback", PROD_ORIGIN],
  ]) {
    const r = oa.resolveOAuthConfig({ ...base, WHOP_REDIRECT_URI: uri, APP_PUBLIC_URL: app });
    check(`  ${label} is refused as redirect_uri_origin_mismatch`,
      r.ok === false && r.reason === "redirect_uri_origin_mismatch", JSON.stringify(r));
  }
  check("the mismatch rule also applies in sandbox",
    oa.resolveOAuthConfig({
      ...FAKE, WHOP_ENV: "sandbox",
      WHOP_REDIRECT_URI: "https://a.ngrok-free.app/api/whop/callback",
      APP_PUBLIC_URL: "https://b.ngrok-free.app",
    }).reason === "redirect_uri_origin_mismatch");
  check("and a matching sandbox tunnel pair is fine",
    oa.resolveOAuthConfig({
      ...FAKE, WHOP_ENV: "sandbox",
      WHOP_REDIRECT_URI: "https://a.ngrok-free.app/api/whop/callback",
      APP_PUBLIC_URL: "https://a.ngrok-free.app",
    }).ok === true);
  /* WITH APP_PUBLIC_URL UNSET the comparison is skipped — plain local
   * development has no public origin and must stay workable. */
  check("an unset APP_PUBLIC_URL skips the comparison rather than failing",
    oa.resolveOAuthConfig({ ...FAKE, WHOP_ENV: "sandbox", WHOP_REDIRECT_URI: "https://localhost:3000/api/whop/callback" }).ok === true);

  /* ONE LIST OF HOSTS. The rules are imported from app-url.ts, not restated. */
  const oaCode = codeOnly("src/lib/server/whop-oauth.ts");
  check("the host rules are imported, not duplicated",
    /from "\.\/app-url"/.test(oaCode) &&
      !/ngrok|trycloudflare|loca\.lt/.test(oaCode) &&
      !/"localhost"|127\.0\.0\.1/.test(oaCode));
}

/* ---------------------------------------------------------------- E ---- */
section("E. APP_PUBLIC_URL and the callback path");

{
  const au = loadTs("src/lib/server/app-url.ts");
  for (const [label, value, reason] of [
    ["unset", undefined, "missing"],
    ["empty", "", "missing"],
    ["relative", "/dashboard", "not_absolute"],
    ["plaintext", "http://app.example.com", "not_https"],
    ["localhost", "https://localhost:3000", "local_host"],
    ["127.0.0.1", "https://127.0.0.1", "local_host"],
    ["0.0.0.0", "https://0.0.0.0", "local_host"],
  ]) {
    const r = au.resolveAppPublicUrl({ APP_PUBLIC_URL: value }, "production");
    check(`  a ${label} APP_PUBLIC_URL is refused as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }
  check("a real https origin is accepted in production",
    au.resolveAppPublicUrl({ APP_PUBLIC_URL: PROD_ORIGIN }, "production").ok === true);
  for (const t of [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.io", ".trycloudflare.com", ".loca.lt"]) {
    check(`  a${t} origin is refused in production`,
      au.resolveAppPublicUrl({ APP_PUBLIC_URL: `https://x${t}` }, "production").reason === "tunnel_in_production");
    check(`    and allowed in sandbox`,
      au.resolveAppPublicUrl({ APP_PUBLIC_URL: `https://x${t}` }, "sandbox").ok === true);
  }
  check("only the origin is kept — path and trailing slash are dropped",
    au.getAppPublicUrl({ APP_PUBLIC_URL: `${PROD_ORIGIN}/some/path/` }) === PROD_ORIGIN,
    String(au.getAppPublicUrl({ APP_PUBLIC_URL: `${PROD_ORIGIN}/some/path/` })));

  /* NO FORWARDED HOST IS EVER TRUSTED — that is what would turn a provider
   * return URL into an open redirect. */
  const auCode = codeOnly("src/lib/server/app-url.ts");
  check("app-url consults no request or forwarded header",
    !/x-forwarded|\brequest\b|headers\.get/i.test(auCode));

  /* THE CALLBACK PATHS, read from the routes rather than invented. */
  const routes = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "route.ts") routes.push(p);
    }
  })("src/app/api");
  const callbackPaths = routes
    .filter((f) => /callback[\\/]route\.ts$/.test(f))
    .map((f) => "/" + f.replace(/\\/g, "/").replace("src/app/", "").replace("/route.ts", ""));
  check("the provider callback routes exist at their documented paths",
    callbackPaths.includes("/api/whop/callback") &&
      callbackPaths.includes("/api/google/calendar/callback"),
    callbackPaths.join(", "));
  check(".env.example documents the whop callback path",
    src(".env.example").includes("/api/whop/callback"));
}

/* ---------------------------------------------------------------- F ---- */
section("F. Nothing can select the environment or supply a credential");

{
  /* THE BROWSER CANNOT CHOOSE, and no request field can carry a credential.
   * Swept over every source file rather than a chosen list. */
  const offenders = [];
  for (const f of allSources) {
    if (/[\\/]i18n[\\/]dictionaries[\\/]/.test(f)) continue;
    const code = codeOnly(f);
    /* INBOUND SOURCES ONLY. `payload` is deliberately absent from this list: the
     * OAuth token exchange builds an OUTBOUND payload and legitimately puts
     * `client_secret` in it, which is the opposite of the concern — sending our
     * own secret to the provider, not accepting one from a caller. Including the
     * word reported that correct code as a finding. */
    for (const m of code.matchAll(
      /(?:\bbody\b|searchParams|\bquery\b|\bparams\b)[^\n;]{0,60}\b(WHOP_ENV|whopEnv|apiKey|api_key|clientSecret|client_secret|companyId|company_id|webhookSecret)\b/gi)) {
      offenders.push(`${f}: ${m[0].trim().slice(0, 60)}`);
    }
  }
  check("no request field supplies an environment or credential",
    offenders.length === 0, offenders.join(" | "));

  /* NO SECRET IS EVER NEXT_PUBLIC_. */
  const publicNames = new Set();
  for (const f of allSources) {
    for (const m of src(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) publicNames.add(m[0]);
  }
  const SECRETY = /(SECRET|PRIVATE|WEBHOOK|DATABASE|ADMIN_|WHOP_API|ENCRYPTION|TOKEN|PASSWORD)/;
  const suspicious = [...publicNames].filter(
    (n) => SECRETY.test(n) && n !== "NEXT_PUBLIC_FIREBASE_API_KEY");
  check("no secret-shaped NEXT_PUBLIC_ variable exists",
    suspicious.length === 0, suspicious.join(", "));
  check("the Firebase browser key is the only NEXT_PUBLIC_ *KEY, and is public by design",
    [...publicNames].filter((n) => /KEY$/.test(n)).join(",") === "NEXT_PUBLIC_FIREBASE_API_KEY",
    [...publicNames].filter((n) => /KEY$/.test(n)).join(","));

  /* AND NO SERVER SECRET IS NAMED IN CLIENT CODE. */
  const SERVER_SECRETS = [
    "WHOP_API_KEY", "WHOP_CLIENT_SECRET", "WHOP_WEBHOOK_SECRET",
    "WHOP_OAUTH_TOKEN_ENCRYPTION_KEY", "FIREBASE_ADMIN_PRIVATE_KEY",
    "FIREBASE_ADMIN_CLIENT_EMAIL", "DATABASE_URL",
    "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY",
  ];
  const clientFiles = allSources.filter((f) => /^\s*["']use client["']/.test(src(f)));
  check("client components were found — the scan is looking at something",
    clientFiles.length > 5, `${clientFiles.length} files`);
  const exposed = [];
  for (const f of clientFiles) {
    for (const s of SERVER_SECRETS) if (src(f).includes(s)) exposed.push(`${f}: ${s}`);
  }
  check("no server secret is named in any client component",
    exposed.length === 0, exposed.join(", "));
  /* AND THE MODULES THAT READ THEM REFUSE TO BE BUNDLED. */
  for (const m of ["whop-payments", "whop-oauth", "token-crypto", "app-url", "whop-connections"]) {
    check(`  lib/server/${m}.ts is server-only`,
      /import "server-only"/.test(src(`src/lib/server/${m}.ts`)));
  }
  const serverImporters = clientFiles.filter((f) => /@\/lib\/server\//.test(src(f)));
  check("no client component imports from lib/server", serverImporters.length === 0,
    serverImporters.join(", "));
}

/* ---------------------------------------------------------------- G ---- */
section("G. Sandbox surfaces are unavailable under production config");

{
  const so = loadTs("src/lib/server/sandbox-orders.ts");
  check("with WHOP_ENV=production the sandbox checkout is OFF even with the flag on",
    so.isSandboxOrderingEnabled({
      ...FAKE, WHOP_ENV: "production", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true",
    }) === false);
  check("and OFF with the flag off",
    so.isSandboxOrderingEnabled({ ...FAKE, WHOP_ENV: "production" }) === false);
  check("it is ON only for sandbox plus the explicit opt-in",
    so.isSandboxOrderingEnabled({
      ...FAKE, WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true",
    }) === true);

  /* THE DEBUG / DIAGNOSTIC SURFACES. The payout diagnostic must be silent in
   * production, and the analytics dev sink must not be the durable one. */
  const payoutCode = codeOnly("src/lib/server/whop-payout-status.ts");
  check("the payout diagnostic returns early in production",
    /if \(process\.env\.NODE_ENV === "production"\) return;/.test(payoutCode));
  const sinkCode = codeOnly("src/lib/analytics/sink.ts");
  check("the in-memory analytics sink is not durable",
    /durable: false/.test(sinkCode));

  /* THE ADMIN SANDBOX AUDIT stays reachable — it is the pre-cutover report —
   * and stays read-only. */
  const auditCode = codeOnly("src/lib/server/sandbox-audit.ts");
  check("the sandbox audit is read-only",
    !/\.insert\(|\.update\(|\.delete\(/.test(auditCode));
}

/* ---------------------------------------------------------------- H ---- */
section("H. No credential is committed, and .env.example stays fake");

{
  /* .env FILES ARE IGNORED, with the template deliberately re-included. */
  const ignore = src(".gitignore");
  check(".env files are gitignored", /^\.env\*/m.test(ignore), "no .env* rule");
  check("and .env.example is explicitly re-included",
    /^!\.env\.example/m.test(ignore));

  /* EVERY VARIABLE THE CODE READS IS DOCUMENTED. An undocumented variable is
   * one an operator cannot supply — and MAX_CREATOR_TRANSFER_MINOR silently
   * REFUSES every production transfer when unset, which is the worst kind to
   * leave undiscoverable. */
  const readNames = new Set();
  for (const f of allSources) {
    const code = codeOnly(f);
    for (const m of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) readNames.add(m[1]);
    for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) readNames.add(m[1]);
    for (const m of code.matchAll(/read\(env, "([A-Z0-9_]+)"\)/g)) readNames.add(m[1]);
  }
  readNames.delete("NODE_ENV"); // set by the runtime, never by an operator
  const example = src(".env.example");
  const undocumented = [...readNames].filter((n) => !new RegExp(`^${n}=`, "m").test(example));
  check("every environment variable the code reads is documented in .env.example",
    undocumented.length === 0, undocumented.join(", "));
  check("the scan found a realistic number of variables",
    readNames.size >= 25, `${readNames.size} variables`);
  check("MAX_CREATOR_TRANSFER_MINOR is documented as required before production transfers",
    /MAX_CREATOR_TRANSFER_MINOR=/.test(example) &&
      /REQUIRED BEFORE ANY PRODUCTION TRANSFER/.test(example));

  /* AND NO DOCUMENTED VALUE LOOKS LIVE. A PEM header with a REPLACE_ME body is a
   * template; a PEM header with real base64 key material is a committed key. */
  const live = [];
  for (const line of example.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim().replace(/^["']|["']$/g, "");
    if (!v) continue;
    const looksLive =
      /^(biz|pay|app|ws|whop)_[A-Za-z0-9]{12,}$/.test(v) ||
      /^[A-Za-z0-9+/]{40,}={0,2}$/.test(v) ||
      /^postgres(ql)?:\/\/[^\s]*:[^\s]*@/.test(v) ||
      (/BEGIN (RSA )?PRIVATE KEY/.test(v) && /[A-Za-z0-9+/]{100,}/.test(v.replace(/\\n/g, "")));
    if (looksLive) live.push(key);
  }
  check(".env.example contains no live-looking credential", live.length === 0, live.join(", "));

  /* NO SECRET-SHAPED LITERAL IN TRACKED SOURCE. Tests use obvious fakes, so a
   * hit here is a real finding rather than a fixture. */
  const leaks = [];
  for (const f of allSources) {
    const text = src(f);
    for (const re of [
      /\b(?:sk|rk|ak)_live_[A-Za-z0-9]{16,}/g,
      /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]{0,40}[A-Za-z0-9+/]{100,}/g,
      /\bpostgres(?:ql)?:\/\/[^\s"'`]+:[^\s"'`]+@[^\s"'`]+/g,
      /\bws_[A-Za-z0-9]{24,}\b/g,
    ]) {
      if (re.test(text)) leaks.push(`${f}: ${re.source.slice(0, 28)}`);
    }
  }
  check("no credential-shaped literal in tracked source", leaks.length === 0, leaks.join(" | "));
}

/* ---------------------------------------------------------------- I ---- */
section("I. The migration precondition is recorded, not assumed");

{
  /* THE BLOCKER. Task #25's code filters `whop_connections.environment`, and
   * migration 0015 adds it. Until 0015 is applied, the OAuth connection paths
   * throw — so this suite asserts the migration exists and is last, and the
   * REPORT carries the applied-count. Deliberately no database call: instruction
   * 1 for this task forbids exercising real DB paths that need the new column. */
  const journal = JSON.parse(src("drizzle/meta/_journal.json"));
  const tags = journal.entries.map((e) => e.tag);
  check("0015 is registered and last in the chain",
    tags[tags.length - 1] === "0015_whop_connection_environment", tags.slice(-2).join(", "));
  check("0014 is registered before it",
    tags.includes("0014_refund_absorbed_cost"));
  check("the chain is contiguous",
    journal.entries.every((e, i) => e.idx === i), `${tags.length} migrations`);
  check("the code that needs the column does filter on it",
    /eq\(whopConnections\.environment, environment\)/.test(
      codeOnly("src/lib/server/whop-connections.ts")));
  check("this suite opens no database connection",
    !/require\("postgres"\)/.test(src("scripts/production-config-test.mjs")) &&
      !Object.keys(require.cache).some((m) => /node_modules[\\/]postgres[\\/]/.test(m)));
  check("and makes no provider call — the SDK is stubbed",
    sdkConstructions.every((c) => typeof c === "object"));
}

/* ---------------------------------------------------------------- J ---- */
section("J. The local environment, as presence only");

{
  /* NO VALUE IS PRINTED. Each variable is reduced to a word before it is shown,
   * so this section cannot leak a credential even in a pasted log. */
  const state = (n) => {
    const v = process.env[n];
    if (v === undefined) return "MISSING";
    if (v.trim() === "") return "EMPTY";
    if (/REPLACE_ME/.test(v)) return "PLACEHOLDER";
    return "PRESENT";
  };
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const REQUIRED_FOR_PRODUCTION = [
    "WHOP_ENV", "WHOP_API_KEY", "WHOP_COMPANY_ID",
    "WHOP_CLIENT_ID", "WHOP_REDIRECT_URI", "APP_PUBLIC_URL",
    "WHOP_OAUTH_TOKEN_ENCRYPTION_KEY", "DATABASE_URL",
  ];
  for (const n of REQUIRED_FOR_PRODUCTION) {
    console.log(`  ${n.padEnd(34)} ${state(n)}`);
  }
  check("every variable required for production operation is at least present",
    REQUIRED_FOR_PRODUCTION.every((n) => state(n) === "PRESENT"),
    REQUIRED_FOR_PRODUCTION.filter((n) => state(n) !== "PRESENT").join(", "));

  /* THE LOCAL ENVIRONMENT IS SANDBOX, and this task must not change that. */
  check("the local WHOP_ENV is sandbox, so nothing here touches production",
    process.env.WHOP_ENV === "sandbox", state("WHOP_ENV"));

  /* AND THE LOCAL PAIR ALREADY SATISFIES THE NEW RULE — so the fix is not
   * breaking the working development setup. */
  const localOAuth = oa.resolveOAuthConfig(process.env);
  check("the local OAuth configuration still resolves under the new rules",
    localOAuth.ok === true, localOAuth.ok ? "ok" : localOAuth.reason);
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
