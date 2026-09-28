#!/usr/bin/env node
/**
 * TASK #28 — PRODUCTION CONNECTED ACCOUNTS / OAUTH LINKING READINESS.
 *
 * Asks whether a real creator could safely connect Whop in production, and
 * whether anything a sandbox link left behind could be mistaken for production
 * standing.
 *
 * Most of the answer was already yes, and most of it was made so by Task #25:
 * `whop_connections` and `whop_oauth_states` carry `environment`, every read is
 * scoped to it and fails closed without one, the anti-takeover rule holds inside
 * an environment and deliberately not across it, both `whop_accounts` uniqueness
 * rules are per-environment, KYC and payout readiness resolve the account from
 * `(session uid, server environment)` and never from a request, and readiness is
 * a provider retrieve that reports `ok: false` rather than "ready" on any error.
 *
 * WHAT WAS WRONG — the browser-side half of the OAuth state.
 *
 *   - `whop/connect` decided the state cookie's `Secure` attribute from
 *     `new URL(request.url).protocol`. Behind a reverse proxy that is not our
 *     scheme: Next reconstructs `request.url` from the forwarded scheme and the
 *     upstream host, which is the exact value `whop/callback` already refuses to
 *     trust for its redirect. A proxy terminating TLS and forwarding plain http
 *     would have shipped the cookie WITHOUT Secure in production — and that
 *     cookie is what binds the callback to the browser that began the flow. The
 *     sibling Google flow already derived the flag from configuration; Whop now
 *     does the same.
 *   - The cookie was set at `Path=/api/whop` and cleared at `path: "/"`. A
 *     browser keys a cookie on (name, domain, path), so the clear wrote a second
 *     empty cookie at the root and left the original until its Max-Age ran out.
 *     Not exploitable — the state ROW is consumed by one `DELETE … RETURNING` —
 *     but a flow that claims to clean up should.
 *
 * DB-BACKED, because the properties that matter are enforced by partial unique
 * indexes and by an atomic single-statement consume. No fake can demonstrate
 * either. Throwaway schema built from the full 16-migration chain.
 *
 * NO NETWORK. NO PROVIDER CALL. NO REAL LINK. Token exchange and userinfo are
 * injected so every branch is driven without a request leaving the process.
 *
 * NO TOKEN, SECRET OR KEY IS PRINTED. Fixtures are obvious fakes; anything read
 * from the real environment is reduced to a boolean first.
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
const bodyOnly = (p) =>
  codeOnly(p).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
function functionBody(text, name) {
  const at = text.indexOf(`export async function ${name}`);
  if (at < 0) return null;
  const next = text.indexOf("\nexport ", at + 10);
  return text.slice(at, next < 0 ? undefined : next);
}

const SCRATCH = "prod_connected_account_selftest";

/* Obvious fakes. Nothing here resembles a credential. */
const FAKE = {
  WHOP_API_KEY: "fake-not-a-real-key",
  WHOP_COMPANY_ID: "biz_fakeplatform",
  WHOP_CLIENT_ID: "app_fakeclient",
};
const PROD_ORIGIN = "https://app.example.com";

/* =========================================================================
   Loader. The database and process.env are the only seams.
   ========================================================================= */

const cache = new Map();
let DB = null;

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
    if (spec === "@whop/sdk") return { WhopClient: class {}, WhopError: class extends Error {} };
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

/** Runs `fn` with WHOP_ENV set (or removed), then restores it. */
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
section("A. Production OAuth endpoints are selected, and nothing falls back");

const oa = loadTs("src/lib/server/whop-oauth.ts");

{
  const base = { ...FAKE, WHOP_REDIRECT_URI: `${PROD_ORIGIN}/api/whop/callback` };

  const prod = oa.resolveOAuthConfig({ ...base, WHOP_ENV: "production" });
  check("a production OAuth config resolves", prod.ok === true, prod.ok ? "ok" : prod.reason);
  check("to the production authorize/token/userinfo host",
    prod.ok && Object.values(prod.config.endpoints)
      .every((u) => new URL(u).origin === "https://api.whop.com"),
    prod.ok ? Object.values(prod.config.endpoints).join(" ") : "");
  check("and no endpoint mentions sandbox",
    prod.ok && !JSON.stringify(prod.config.endpoints).includes("sandbox"));

  const sbx = oa.resolveOAuthConfig({
    ...FAKE, WHOP_ENV: "sandbox",
    WHOP_REDIRECT_URI: "https://x.ngrok-free.app/api/whop/callback",
    APP_PUBLIC_URL: "https://x.ngrok-free.app",
  });
  check("sandbox resolves to the sandbox host",
    sbx.ok && Object.values(sbx.config.endpoints)
      .every((u) => new URL(u).origin === "https://sandbox-api.whop.com"));
  check("the two environments genuinely differ",
    prod.ok && sbx.ok && prod.config.endpoints.token !== sbx.config.endpoints.token);

  /* MISSING PRODUCTION CONFIG IS "UNAVAILABLE", NOT A FALLBACK. */
  for (const [label, env, reason] of [
    ["no environment", { ...base }, "missing_environment"],
    ["an invalid environment", { ...base, WHOP_ENV: "prod" }, "invalid_environment"],
    ["no client id", { WHOP_ENV: "production", WHOP_REDIRECT_URI: `${PROD_ORIGIN}/api/whop/callback` }, "missing_client_id"],
    ["no redirect URI", { ...FAKE, WHOP_ENV: "production" }, "missing_redirect_uri"],
  ]) {
    const r = oa.resolveOAuthConfig(env);
    check(`  ${label} fails closed as ${reason}`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }

  /* THE CALLBACK URI IS THE PRODUCTION ONE, and cannot be a dev host. */
  for (const [label, uri, reason] of [
    ["localhost", "https://localhost:3000/api/whop/callback", "local_redirect_uri"],
    ["a tunnel", "https://x.ngrok-free.app/api/whop/callback", "tunnel_redirect_uri"],
    ["a plaintext origin", "http://app.example.com/api/whop/callback", "invalid_redirect_uri"],
  ]) {
    const r = oa.resolveOAuthConfig({ ...FAKE, WHOP_ENV: "production", WHOP_REDIRECT_URI: uri });
    check(`  production refuses a ${label} callback (${reason})`,
      r.ok === false && r.reason === reason, JSON.stringify(r));
  }
  check("and refuses one that is not on APP_PUBLIC_URL's origin",
    oa.resolveOAuthConfig({
      ...FAKE, WHOP_ENV: "production", APP_PUBLIC_URL: PROD_ORIGIN,
      WHOP_REDIRECT_URI: "https://elsewhere.example.com/api/whop/callback",
    }).reason === "redirect_uri_origin_mismatch");

  /* THE AUTHORIZE URL CARRIES NOTHING A BROWSER CHOSE. */
  const url = new URL(oa.buildAuthorizeUrl({
    config: prod.config, state: "s".repeat(40), nonce: "n".repeat(40),
    codeChallenge: "c".repeat(43),
  }));
  check("the authorize URL is on the production host",
    url.origin === "https://api.whop.com", url.origin);
  check("it uses PKCE with S256",
    url.searchParams.get("code_challenge_method") === "S256" &&
      url.searchParams.get("code_challenge") === "c".repeat(43));
  check("it carries the configured client id and redirect, not a supplied one",
    url.searchParams.get("client_id") === FAKE.WHOP_CLIENT_ID &&
      url.searchParams.get("redirect_uri") === `${PROD_ORIGIN}/api/whop/callback`);
  check("and a fixed, minimal scope",
    url.searchParams.get("scope") === oa.WHOP_OAUTH_SCOPES);
  check("no secret is ever placed in the authorize URL",
    !url.search.includes("secret") && !url.search.includes("client_secret"));
}

/* ---------------------------------------------------------------- B ---- */
section("B. PKCE and the state token");

{
  const a = oa.createCodeVerifier();
  const b = oa.createCodeVerifier();
  check("a verifier meets RFC 7636's minimum length", a.length >= 43, String(a.length));
  check("it is base64url with no padding", /^[A-Za-z0-9\-_]+$/.test(a));
  check("two verifiers differ", a !== b);
  check("the challenge is not the verifier — S256, not plain",
    oa.codeChallengeFor(a) !== a);
  check("and is deterministic for one verifier",
    oa.codeChallengeFor(a) === oa.codeChallengeFor(a));

  const t1 = oa.createRandomToken();
  const t2 = oa.createRandomToken();
  check("a state token is long enough to be unguessable", t1.length >= 32, String(t1.length));
  check("and two differ", t1 !== t2);
  /* ENTROPY COMES FROM randomBytes, not Math.random. */
  check("the token generator uses a CSPRNG",
    /randomBytes\(/.test(codeOnly("src/lib/server/whop-oauth.ts")) &&
      !/Math\.random/.test(codeOnly("src/lib/server/whop-oauth.ts")));
}

/* ---------------------------------------------------------------- C ---- */
section("C. The state cookie: Secure from configuration, cleared where it was set");

{
  const connect = codeOnly("src/app/api/whop/connect/route.ts");
  const callback = codeOnly("src/app/api/whop/callback/route.ts");

  /* THE FIX. Deriving Secure from the request means deriving it from whatever a
   * proxy forwarded — the one value this flow refuses to trust for its redirect. */
  check("Secure is decided from APP_PUBLIC_URL, not from the request",
    /const isHttps = \(getAppPublicUrl\(\) \?\? "https:\/\/"\)\.startsWith\("https:\/\/"\)/.test(connect));
  check("the request's own protocol is no longer consulted",
    !/new URL\(request\.url\)\.protocol/.test(connect));
  check("and an unresolved public URL defaults to Secure rather than open",
    /\?\? "https:\/\/"/.test(connect));
  /* THE SIBLING FLOW USES THE SAME RULE, so the two cannot disagree. */
  check("the Google connect flow derives it the same way",
    /const isHttps = \(getAppPublicUrl\(\) \?\? "https:\/\/"\)\.startsWith\("https:\/\/"\)/.test(
      codeOnly("src/app/api/google/calendar/connect/route.ts")));

  /* THE OTHER ATTRIBUTES. HttpOnly so no script can read the binding; Lax
   * because the callback is a top-level GET from whop.com and Strict would
   * withhold the cookie on exactly that navigation. */
  check("the cookie is HttpOnly", /"HttpOnly"/.test(connect));
  check("SameSite=Lax, so the provider redirect carries it",
    /"SameSite=Lax"/.test(connect) && !/SameSite=Strict/.test(connect));
  check("its lifetime is bounded and matches the state row's TTL",
    /const LINK_COOKIE_MAX_AGE = 600;/.test(connect) &&
      loadTs("src/lib/server/whop-connections.ts").OAUTH_STATE_TTL_SECONDS === 600);

  /* SET AND CLEARED ON THE SAME PATH — one shared constant, so they cannot drift. */
  const conns = loadTs("src/lib/server/whop-connections.ts");
  check("the cookie path is a shared constant",
    conns.OAUTH_STATE_COOKIE_PATH === "/api/whop", String(conns.OAUTH_STATE_COOKIE_PATH));
  check("connect sets it on that path",
    /Path=\$\{OAUTH_STATE_COOKIE_PATH\}/.test(connect));
  check("and the callback clears it on the SAME path",
    /path: OAUTH_STATE_COOKIE_PATH, maxAge: 0/.test(callback));
  check("no clear at the root remains, which would not have deleted it",
    !/LINK_COOKIE, "", \{ path: "\/"/.test(callback));

  /* THE CALLBACK TRUSTS NO FORWARDED HOST for its redirect. */
  check("the callback builds its redirect from configuration",
    /const configured = getAppPublicUrl\(\);/.test(callback));
  check("and consults no forwarded header",
    !/x-forwarded/i.test(callback));
  check("refusing an absolute or protocol-relative return path",
    /startsWith\("\/"\)/.test(callback) && /startsWith\("\/\/"\)/.test(callback));
  /* AND IT REVEALS NOTHING. Outcomes are a closed set, never provider prose. */
  check("outcomes are a closed set",
    /type Outcome =/.test(callback) && !/error_description/.test(callback));
}

/* ---------------------------------------------------------------- D ---- */
section("D. Guard ordering: no provider call before every local guard passes");

{
  /* A PROVIDER MUTATION MUST BE THE LAST THING THAT HAPPENS. If auth, origin or
   * the rate limit can fail after the provider was contacted, a refused request
   * has already created or moved something. */
  for (const [route, provider] of [
    ["whop/connect", ["createAuthorization"]],
    ["whop/account", ["createConnectedAccount", "findConnectedAccountByUid", "getPlatformAccount"]],
    ["whop/kyc/start", ["createAccountLink"]],
    ["whop/payout/portal", ["createAccountLink"]],
    ["whop/payout/status", ["fetchPayoutStatus"]],
    ["whop/kyc/status", ["fetchKycStatus"]],
    ["whop/disconnect", ["disconnectWhop"]],
  ]) {
    const body = bodyOnly(`src/app/api/${route}/route.ts`);
    const originAt = body.indexOf("checkRequestOrigin");
    const authAt = Math.max(body.indexOf("requireWhopEligible"), body.indexOf("getUserFromRequest"));
    check(`${route}: origin checked first`, originAt >= 0 && originAt < authAt || authAt < 0, `origin@${originAt} auth@${authAt}`);
    for (const fn of provider) {
      const at = body.indexOf(fn);
      if (at < 0) continue;
      check(`  and ${fn} runs after authentication`, authAt >= 0 && authAt < at, `${authAt} < ${at}`);
      if (originAt >= 0) check(`  and after the origin check`, originAt < at);
      const rlAt = body.indexOf("checkRateLimit");
      if (rlAt >= 0) check(`  and after the rate limit`, rlAt < at, `${rlAt} < ${at}`);
    }
  }

  /* NOTHING IN THESE ROUTES TAKES AN ENVIRONMENT, AN ACCOUNT OR A UID FROM THE
   * CALLER. The uid comes from a verified session; the environment from server
   * config; the account is looked up from both. */
  for (const route of ["whop/account", "whop/kyc/start", "whop/kyc/status",
                       "whop/payout/portal", "whop/payout/status", "whop/disconnect",
                       "whop/connection"]) {
    const body = bodyOnly(`src/app/api/${route}/route.ts`);
    check(`${route} accepts no environment, account id or uid from the request`,
      !/(body|searchParams|params)[^\n;]{0,60}\b(environment|whop_account_id|whopAccountId|firebase_uid|firebaseUid|uid)\b/i.test(body),
      (body.match(/(body|searchParams|params)[^\n;]{0,50}(environment|account|uid)[^\n;]{0,10}/i) ?? [""])[0]);
  }
  /* THE ACCOUNT-CREATING ROUTE READS NO BODY AT ALL. */
  check("whop/account never parses a request body",
    !/request\.json\(\)|request\.text\(\)/.test(bodyOnly("src/app/api/whop/account/route.ts")));
}

/* ---------------------------------------------------------------- E ---- */
section("E. Readiness cannot come from anywhere but the current environment");

{
  /* KYC AND PAYOUT READINESS RESOLVE THE ACCOUNT FROM (session uid, server
   * environment). A sandbox account therefore cannot answer for production: the
   * lookup simply finds nothing and the route fails closed. */
  for (const route of ["whop/kyc/start", "whop/kyc/status", "whop/payout/portal", "whop/payout/status"]) {
    const body = bodyOnly(`src/app/api/${route}/route.ts`);
    check(`${route} resolves the account from uid + server environment`,
      /getConnectedAccount\(firebaseUid, platform\.config\.environment\)/.test(body));
    /* FAILING CLOSED LOOKS DIFFERENT FOR A READ AND FOR AN ACTION, and both are
     * correct: the ACTION routes refuse with 409 `account_not_provisioned`, while
     * the STATUS routes answer 200 `provisioned: false` — the honest answer to
     * "what is my standing here?" is "you have no account in this environment",
     * not an error. What neither may do is report readiness without an account. */
    const isAction = /kyc\/start|payout\/portal/.test(route);
    check(`  and fails closed when there is none (${isAction ? "409 refusal" : "provisioned: false"})`,
      isAction
        ? /if \(!account\) return json\(\{ error: "account_not_provisioned" \}, 409\)/.test(body)
        : /if \(!account\) return json\(\{ ok: true, provisioned: false \}, 200\)/.test(body),
      (body.match(/if \(!account\)[^\n]*/) ?? ["absent"])[0]);
    check(`  and never claims readiness without one`,
      !/canReceivePayout: true|readiness: "ready"|provisioned: true/.test(
        body.slice(0, body.indexOf("if (!account)") + 120)));
  }

  /* READINESS IS A PROVIDER RETRIEVE, and any provider failure is NOT "ready". */
  const ps = codeOnly("src/lib/server/whop-payout-status.ts");
  check("payout readiness retrieves the account from the provider",
    /await client\.accounts\.retrieve\(\{ id: accountId \}\)/.test(ps));
  check("an unconfigured provider is unavailable, never ready",
    /if \(!client\) return \{ ok: false, reason: "unconfigured" \}/.test(ps));
  check("a provider error is a failure, never ready",
    /return \{ ok: false, reason: classify\(error\) \}/.test(ps));
  check("a non-object response is a failure too",
    /if \(!account \|\| typeof account !== "object"\)/.test(ps));
  check("canReceivePayout is strictly readiness === ready",
    /canReceivePayout: readiness === "ready"/.test(ps));
  /* AND THE LOCAL STATUS COLUMN IS NOT THE AUTHORITY. The real database holds an
   * account whose stored status is null; readiness must not care. */
  const connectedAccounts = codeOnly("src/lib/server/connected-accounts.ts");
  check("the stored status column gates nothing financial",
    !/canReceivePayout|readiness/.test(connectedAccounts));
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const before = {};
  for (const t of ["whop_connections", "whop_oauth_states", "whop_accounts"]) {
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

    const tags = JSON.parse(src("drizzle/meta/_journal.json")).entries.map((e) => e.tag);
    for (const tag of tags) {
      for (const stmt of src(`drizzle/${tag}.sql`)
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
        .filter(Boolean)) {
        try { await client.unsafe(stmt); }
        catch (e) { throw new Error(`DDL FAILED in ${tag}: ${String(e?.message ?? e).slice(0, 200)}`); }
      }
    }
    check("the full migration chain applies", true, `${tags.length} migrations`);

    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);
    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('whop_connections')) as conns`;
    if (where.schema !== SCRATCH || where.conns !== SCRATCH) {
      throw new Error(`ISOLATION FAILED — refusing to write: ${where.schema}/${where.conns}`);
    }
    check("ISOLATION PROVED: whop_connections is in the throwaway schema", true, where.conns);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    process.env.WHOP_API_KEY ??= FAKE.WHOP_API_KEY;
    process.env.WHOP_COMPANY_ID ??= FAKE.WHOP_COMPANY_ID;
    process.env.WHOP_OAUTH_TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");

    const conns = loadTs("src/lib/server/whop-connections.ts");
    const accounts = loadTs("src/lib/server/connected-accounts.ts");

    /* ------------------------------------------------------------ F ---- */
    section("F. A state minted in one environment cannot be redeemed in the other");

    {
      const SANDBOX_STATE = "s".repeat(44);
      const PROD_STATE = "p".repeat(44);

      check("a sandbox authorization is recorded",
        (await withEnv("sandbox", () => conns.createAuthorization({
          state: SANDBOX_STATE, firebaseUid: "uid_a",
          codeVerifier: "v".repeat(50), returnPath: "/en/dashboard",
        }))) === true);
      check("a production authorization is recorded",
        (await withEnv("production", () => conns.createAuthorization({
          state: PROD_STATE, firebaseUid: "uid_b",
          codeVerifier: "v".repeat(50), returnPath: "/en/dashboard",
        }))) === true);
      check("each records its OWN environment, not a constant",
        (await scoped.unsafe(
          `select state, environment from ${SCRATCH}.whop_oauth_states order by environment`))
          .map((r) => `${r.state[0]}=${r.environment}`).sort().join(" ") === "p=production s=sandbox",
        (await scoped.unsafe(
          `select state, environment from ${SCRATCH}.whop_oauth_states`))
          .map((r) => `${r.state[0]}=${r.environment}`).join(" "));

      /* NEITHER DIRECTION CROSSES. */
      check("production cannot consume the sandbox state",
        (await withEnv("production", () => conns.consumeAuthorization(SANDBOX_STATE))) === null);
      check("sandbox cannot consume the production state",
        (await withEnv("sandbox", () => conns.consumeAuthorization(PROD_STATE))) === null);
      /* AND A FAILED CROSS-ENVIRONMENT ATTEMPT DOES NOT SPEND THE STATE. That is
       * the difference between a refusal and a denial of service: an attacker who
       * could burn a victim's in-flight state by guessing it in the wrong
       * environment would break every legitimate link. */
      check("both states survive the failed attempts",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_oauth_states`))[0].n === 2);

      /* ONE-TIME USE, in the right environment. */
      const consumed = await withEnv("sandbox", () => conns.consumeAuthorization(SANDBOX_STATE));
      check("the owning environment consumes it once",
        consumed !== null && consumed.firebaseUid === "uid_a" &&
          consumed.returnPath === "/en/dashboard" && consumed.codeVerifier === "v".repeat(50),
        JSON.stringify({ uid: consumed?.firebaseUid, path: consumed?.returnPath }));
      check("a replay finds nothing",
        (await withEnv("sandbox", () => conns.consumeAuthorization(SANDBOX_STATE))) === null);
      check("and the row is gone, not merely marked",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_oauth_states where state = $1`,
          [SANDBOX_STATE]))[0].n === 0);

      /* AN UNRESOLVED ENVIRONMENT CANNOT MINT OR REDEEM. */
      check("no authorization can be created without a resolved environment",
        (await withEnv(null, () => conns.createAuthorization({
          state: "x".repeat(44), firebaseUid: "uid_a",
          codeVerifier: "v".repeat(50), returnPath: "/en/dashboard",
        }))) === false);
      check("and none can be consumed",
        (await withEnv(null, () => conns.consumeAuthorization(PROD_STATE))) === null);

      /* EXPIRY IS EVALUATED BY POSTGRES, so a client with a fast clock cannot win. */
      const EXPIRED = "e".repeat(44);
      await scoped.unsafe(
        `insert into ${SCRATCH}.whop_oauth_states
           (state, firebase_uid, code_verifier_ciphertext, return_path, environment, expires_at)
         values ($1, 'uid_a', 'x', '/en/dashboard', 'sandbox', now() - interval '1 minute')`,
        [EXPIRED]);
      check("an expired state fails closed",
        (await withEnv("sandbox", () => conns.consumeAuthorization(EXPIRED))) === null);
      check("the expiry comparison happens in the database",
        /expiresAt\} > now\(\)/.test(codeOnly("src/lib/server/whop-connections.ts")));

      /* A MALFORMED STATE NEVER REACHES THE DATABASE. */
      for (const bad of ["", "short", "x".repeat(500)]) {
        check(`  a ${bad.length}-character state is refused outright`,
          (await withEnv("sandbox", () => conns.consumeAuthorization(bad))) === null);
      }
    }

    /* ------------------------------------------------------------ G ---- */
    section("G. A sandbox link is not a production identity");

    {
      const UID = "uid_creator";
      const SUB = "user_subject_1";

      const sbx = await withEnv("sandbox", () => conns.linkWhopIdentity({
        firebaseUid: UID, whopUserId: SUB, whopUsername: "creator",
        scopes: "openid profile email",
        accessToken: "sandbox-access-token-fake", refreshToken: "sandbox-refresh-token-fake",
        expiresInSeconds: 3600,
      }));
      check("a sandbox link is stored", sbx.ok === true, sbx.ok ? "ok" : sbx.reason);

      /* THE GATE `POST /api/whop/account` USES. A creator linked only in sandbox
       * must not be able to authorise the creation of a real production account. */
      check("sandbox sees the connection",
        (await withEnv("sandbox", () => conns.getActiveConnection(UID))) !== null);
      check("PRODUCTION DOES NOT — whop_identity_required stays closed",
        (await withEnv("production", () => conns.getActiveConnection(UID))) === null);
      check("and no production token can be read",
        (await withEnv("production", () => conns.getAccessTokenFor(UID))) === null);

      /* BOTH MAY EXIST SIDE BY SIDE — the per-environment partial unique index is
       * what makes a production link possible for a creator who already has a
       * sandbox one. Under the old index this insert was refused outright. */
      const prd = await withEnv("production", () => conns.linkWhopIdentity({
        firebaseUid: UID, whopUserId: SUB, whopUsername: "creator",
        scopes: "openid profile email",
        accessToken: "production-access-token-fake", refreshToken: "production-refresh-token-fake",
        expiresInSeconds: 3600,
      }));
      check("a production link for the same creator and subject is allowed",
        prd.ok === true, prd.ok ? "ok" : prd.reason);
      check("and it did not retire the sandbox link",
        prd.ok === true && prd.replacedPrevious === false);
      check("both are active, one per environment",
        (await scoped.unsafe(
          `select environment, count(*)::int as n from ${SCRATCH}.whop_connections
            where revoked_at is null group by environment`))
          .map((r) => `${r.environment}=${r.n}`).sort().join(" ") === "production=1 sandbox=1");

      /* TOKENS DO NOT CROSS. A sandbox refresh token presented to the production
       * host would be spent for nothing — Whop rotates on every exchange. */
      check("each environment reads only its own access token",
        (await withEnv("sandbox", () => conns.getAccessTokenFor(UID))) === "sandbox-access-token-fake" &&
        (await withEnv("production", () => conns.getAccessTokenFor(UID))) === "production-access-token-fake");
      let refreshCalls = 0;
      const prodRefresh = await withEnv("production", () =>
        conns.getUsableAccessToken("uid_nobody", async () => {
          refreshCalls += 1; return { ok: false, reason: "provider_error" };
        }));
      check("an unknown creator is not_connected, and no token is spent",
        prodRefresh.ok === false && prodRefresh.reason === "not_connected" && refreshCalls === 0,
        JSON.stringify(prodRefresh));
    }

    /* ------------------------------------------------------------ H ---- */
    section("H. Anti-takeover holds inside an environment, and only there");

    {
      const taken = await withEnv("sandbox", () => conns.linkWhopIdentity({
        firebaseUid: "uid_attacker", whopUserId: "user_subject_1",
        whopUsername: null, scopes: "openid",
        accessToken: "a-fake", refreshToken: "b-fake", expiresInSeconds: 60,
      }));
      check("a second creator claiming the same sandbox subject is refused",
        taken.ok === false && taken.reason === "whop_identity_taken", JSON.stringify(taken));
      check("and the original link is untouched",
        (await withEnv("sandbox", () => conns.getActiveConnection("uid_creator"))) !== null);

      /* THE SAME SUBJECT IN THE OTHER ENVIRONMENT IS NOT A TAKEOVER. Refusing it
       * would be a self-inflicted outage at cutover. */
      const across = await withEnv("production", () => conns.linkWhopIdentity({
        firebaseUid: "uid_other", whopUserId: "user_only_in_sandbox",
        whopUsername: null, scopes: "openid",
        accessToken: "a-fake", refreshToken: "b-fake", expiresInSeconds: 60,
      }));
      check("a subject unused in this environment may be claimed here",
        across.ok === true, across.ok ? "ok" : across.reason);
    }

    /* ------------------------------------------------------------ I ---- */
    section("I. Disconnect is scoped to one creator and one environment");

    {
      const dis = await withEnv("production", () => conns.disconnectWhop("uid_creator"));
      check("disconnecting in production succeeds", dis.ok === true, JSON.stringify(dis.ok));
      check("the production link is gone",
        (await withEnv("production", () => conns.getActiveConnection("uid_creator"))) === null);
      check("the SANDBOX link survives — a disconnect is not global",
        (await withEnv("sandbox", () => conns.getActiveConnection("uid_creator"))) !== null);
      /* CREDENTIALS ARE CLEARED IN THE SAME STATEMENT that marks the row revoked,
       * so a stale token cannot be read back afterwards. */
      check("the revoked row keeps no token material",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_connections
            where revoked_at is not null
              and (access_token_ciphertext is not null or refresh_token_ciphertext is not null)`))[0].n === 0);
      check("and no token can be read for it",
        (await withEnv("production", () => conns.getAccessTokenFor("uid_creator"))) === null);
      /* IDEMPOTENT. */
      const again = await withEnv("production", () => conns.disconnectWhop("uid_creator"));
      check("a repeat disconnect is not_connected, not an error",
        again.ok === false && again.reason === "not_connected", JSON.stringify(again));
      /* AND RECONNECTION IS POSSIBLE — revoked history must not block it. */
      const re = await withEnv("production", () => conns.linkWhopIdentity({
        firebaseUid: "uid_creator", whopUserId: "user_subject_1", whopUsername: "creator",
        scopes: "openid", accessToken: "fresh-fake", refreshToken: "fresh-fake-2",
        expiresInSeconds: 3600,
      }));
      check("the creator can reconnect after disconnecting", re.ok === true);
    }

    /* ------------------------------------------------------------ J ---- */
    section("J. Connected accounts are per environment, and converge");

    {
      /* THE CREATORS HAVE TO EXIST FIRST.
       *
       * `whop_accounts.firebase_uid` carries a foreign key to `users`, so a
       * connected account cannot exist without the creator it belongs to — a good
       * constraint, and one this fixture has to satisfy rather than work around.
       * (`whop_connections` has no such key, which is why the link fixtures above
       * needed no seeding.) */
      for (const uid of ["uid_creator", "uid_other", "uid_attacker", "uid_a", "uid_b"]) {
        /* AN APPROVAL IS A DECISION SOMEBODY MADE, and the schema insists on it:
         * `users_approved_has_time` requires `approved_at`, and
         * `users_decision_is_attributed` requires both `decided_by_uid` and
         * `decided_at` for any decided status. So the fixture records a complete,
         * attributed approval rather than a half-state the database would refuse. */
        await scoped.unsafe(
          `insert into ${SCRATCH}.users
             (firebase_uid, role, approval_status, approved_at, decided_by_uid, decided_at)
           values ($1, 'creator', 'approved', now(), 'uid_admin_fixture', now())
           on conflict do nothing`, [uid]);
      }
      check("the creators exist, so the account foreign key can be satisfied",
        (await scoped.unsafe(`select count(*)::int as n from ${SCRATCH}.users`))[0].n === 5);

      const record = (env, uid, acct) => withEnv(env, () => accounts.recordConnectedAccount({
        firebaseUid: uid, whopAccountId: acct, whopUserId: "user_subject_1",
        parentAccountId: FAKE.WHOP_COMPANY_ID, environment: env,
        status: null, onboardingType: null,
      }));

      const s1 = await record("sandbox", "uid_creator", "biz_child_one");
      check("a sandbox account is recorded", s1.ok === true && s1.created === true, JSON.stringify(s1.ok));

      /* DUPLICATE CREATION CONVERGES rather than making a second row — this is
       * what makes a retried request after a lost response safe. */
      const s2 = await record("sandbox", "uid_creator", "biz_child_one");
      check("recording it again converges on the same row",
        s2.ok === true && s2.created === false &&
          s2.account.whopAccountId === "biz_child_one", JSON.stringify(s2.ok));
      check("and only one row exists",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.whop_accounts where firebase_uid = 'uid_creator'`))[0].n === 1);

      /* THE SAME PROVIDER ACCOUNT ID IN THE OTHER ENVIRONMENT IS A DIFFERENT
       * ACCOUNT. Both unique indexes carry the environment. */
      const p1 = await record("production", "uid_creator", "biz_child_one");
      check("the same account id may exist once per environment",
        p1.ok === true && p1.created === true, JSON.stringify(p1.ok));
      check("giving two rows, one per environment",
        (await scoped.unsafe(
          `select environment, count(*)::int as n from ${SCRATCH}.whop_accounts group by environment`))
          .map((r) => `${r.environment}=${r.n}`).sort().join(" ") === "production=1 sandbox=1");

      /* AND A LOOKUP NEVER CROSSES. */
      check("sandbox reads the sandbox account",
        (await accounts.getConnectedAccount("uid_creator", "sandbox"))?.environment === "sandbox");
      check("production reads the production account",
        (await accounts.getConnectedAccount("uid_creator", "production"))?.environment === "production");
      check("a creator with no account in this environment reads nothing",
        (await accounts.getConnectedAccount("uid_nobody", "production")) === null);
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    section("K. The real database is untouched");
    for (const t of Object.keys(before)) {
      const [r] = await client.unsafe(`select count(*)::int as n from public.${t}`);
      check(`  public.${t} unchanged`, r.n === before[t], `${before[t]} -> ${r.n}`);
    }
    const [afterMig] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("no migration was applied", afterMig.n === beforeMig.n, `${beforeMig.n} applied`);
    const [prodRows] = await client`
      select (select count(*)::int from public.whop_connections where environment='production') as c,
             (select count(*)::int from public.whop_accounts where environment='production') as a`;
    check("and no production row was created", prodRows.c === 0 && prodRows.a === 0,
      `connections=${prodRows.c} accounts=${prodRows.a}`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) =>
  check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

/* ---------------------------------------------------------------- L ---- */
section("L. Tokens at rest, and nothing leaks");

{
  const crypto_ = loadTs("src/lib/server/token-crypto.ts");
  const KEY = Buffer.alloc(32, 5).toString("base64");
  const env = { WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: KEY };

  check("a 32-byte base64 key is accepted", crypto_.isTokenEncryptionConfigured(env) === true);
  for (const [label, value] of [
    ["unset", undefined], ["empty", ""], ["whitespace", "   "],
    ["a 16-byte key", Buffer.alloc(16, 1).toString("base64")],
    ["a 31-byte key", Buffer.alloc(31, 1).toString("base64")],
    ["non-base64 text", "not base64 at all !!!"],
  ]) {
    check(`  a ${label} key is refused`,
      crypto_.isTokenEncryptionConfigured({ WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: value }) === false);
  }

  /* AUTHENTICATED ENCRYPTION, BOUND TO THE OWNER. A row moved to another user
   * must fail to decrypt rather than yield someone else's token. */
  const ct = crypto_.encryptToken("a-fake-access-token", "uid_owner", env);
  check("a token encrypts to something that is not the plaintext",
    typeof ct === "string" && !ct.includes("a-fake-access-token"));
  check("and decrypts for its owner",
    crypto_.decryptToken(ct, "uid_owner", env) === "a-fake-access-token");
  check("but NOT for a different uid — the uid is authenticated data",
    crypto_.decryptToken(ct, "uid_thief", env) === null);
  check("a tampered ciphertext fails rather than decrypting to something else",
    crypto_.decryptToken(`${ct.slice(0, -4)}AAAA`, "uid_owner", env) === null);
  check("and a different key cannot read it",
    crypto_.decryptToken(ct, "uid_owner",
      { WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") }) === null);

  /* THE NONCE IS FRESH EVERY TIME — reusing one under GCM is catastrophic. */
  const many = new Set(
    Array.from({ length: 50 }, () => crypto_.encryptToken("same-fake-token", "uid_owner", env)));
  check("encrypting the same token 50 times gives 50 distinct envelopes",
    many.size === 50, `${many.size} distinct`);

  const cryptoCode = codeOnly("src/lib/server/token-crypto.ts");
  check("it uses AES-256-GCM, an authenticated mode",
    /aes-256-gcm/.test(cryptoCode));
  check("with a random IV per envelope",
    /randomBytes\(/.test(cryptoCode));
  check("and the uid as additional authenticated data",
    /setAAD\(/.test(cryptoCode));
  check("there is no plaintext fallback",
    !/return (value|token|plaintext);/.test(cryptoCode));

  /* NO TOKEN OR SECRET REACHES A RESPONSE OR THE BROWSER. */
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");
  const clientFiles = files.filter((f) => /^\s*["']use client["']/.test(src(f)));
  const leaks = clientFiles.filter((f) =>
    /WHOP_OAUTH_TOKEN_ENCRYPTION_KEY|WHOP_CLIENT_SECRET|WHOP_API_KEY|accessTokenCiphertext|refreshTokenCiphertext/
      .test(src(f)));
  check("no client component names a token, ciphertext column or secret",
    leaks.length === 0, leaks.join(", "));
  for (const m of ["token-crypto", "whop-oauth", "whop-connections", "connected-accounts"]) {
    check(`  lib/server/${m}.ts is server-only`,
      /import "server-only"/.test(src(`src/lib/server/${m}.ts`)));
  }
  /* THE STATUS ENDPOINT CARRIES NO CREDENTIAL. */
  const connectionRoute = codeOnly("src/app/api/whop/connection/route.ts");
  check("the connection status route returns no token material",
    !/accessToken|refreshToken|Ciphertext/.test(connectionRoute));
  check("and whop-connections never returns ciphertext from a read helper",
    !/accessTokenCiphertext,?\s*\n?\s*refreshTokenCiphertext/.test(
      (functionBody(codeOnly("src/lib/server/whop-connections.ts"), "getActiveConnection") ?? "")));
}

/* ---------------------------------------------------------------- M ---- */
section("M. Identity comes from the provider, never the browser");

{
  const callback = codeOnly("src/app/api/whop/callback/route.ts");
  /* THE SUBJECT COMES FROM userinfo, and the uid from the stored authorization —
   * neither from the query string the browser arrived with. */
  check("the Whop subject comes from the userinfo response",
    /whopUserId: identity\.identity\.sub/.test(callback));
  check("the creator comes from the stored authorization row",
    /firebaseUid: pending\.firebaseUid/.test(callback));
  check("neither is read from the callback's query string",
    !/searchParams\.get\("(uid|firebase_uid|sub|user)"\)/.test(callback));
  check("only code and state are read from the URL",
    /params\.get\("code"\)/.test(callback) && /params\.get\("state"\)/.test(callback));

  /* NO EMAIL IS A JOIN KEY — the classic account-takeover path. */
  const schemaText = src("src/lib/db/schema.ts");
  const connBlock = schemaText.slice(
    schemaText.indexOf("export const whopConnections = pgTable"),
    schemaText.indexOf("export const accountingTransactions"));
  check("whop_connections stores no email at all", !/email/i.test(connBlock));
  check("and the join key is the OIDC subject",
    /whopUserId: text\("whop_user_id"\)\.notNull\(\)/.test(connBlock));

  /* THE ACCOUNT ROUTE BINDS THE PROVIDER OBJECT TO US, with a key that carries
   * the environment so a retry in the other one cannot collide. */
  /* IMPORTS STRIPPED — the ordering claims below are about execution, and the
   * import block lists these helpers in an unrelated order. */
  const acct = bodyOnly("src/app/api/whop/account/route.ts");
  check("the connected account is created with an environment-scoped idempotency key",
    /idempotencyKey: `cliprewards:connected-account:\$\{environment\}:\$\{firebaseUid\}`/.test(acct));
  check("its metadata binds the provider object back to this creator",
    /firebase_uid: firebaseUid/.test(acct));
  /* AND A LOST DB WRITE IS RECOVERABLE: the next attempt finds the provider's
   * existing child by that metadata rather than creating a second one. */
  check("a retry reconciles an existing provider account instead of creating another",
    acct.indexOf("findConnectedAccountByUid") < acct.indexOf("createConnectedAccount"));
  check("and the creator's own OAuth connection is required first",
    acct.indexOf("getActiveConnection") < acct.indexOf("createConnectedAccount") &&
      /whop_identity_required/.test(acct));
}

/* ---------------------------------------------------------------- N ---- */
section("N. account.updated reaches the right creator, in the right environment");

{
  const router = codeOnly("src/lib/server/whop-child-router.ts");
  const rBody = functionBody(router, "resolveChildAccount") ?? "";
  check("the child account is resolved by provider id AND environment",
    /eq\(whopAccounts\.whopAccountId, companyId\)/.test(rBody) &&
      /eq\(whopAccounts\.environment, environment\)/.test(rBody));
  check("and fails closed without a resolved environment",
    /if \(!environment\) return null/.test(rBody));

  const hooks = codeOnly("src/lib/server/whop-webhooks.ts");
  const hBody = functionBody(hooks, "handleWhopAccountUpdated") ?? "";
  check("the handler resolves the environment from server config",
    /getWhopEnvironment\(\)/.test(hBody));
  check("it updates only a row that already exists",
    /resolveChildAccount\(/.test(hBody) && /never creates new rows|already exist/i.test(
      src("src/lib/server/whop-webhooks.ts")));
  check("the status write is scoped by account id and environment",
    /updateConnectedAccountStatus\(known\.whopAccountId, environment, status\)/.test(hBody));
  check("and a row that vanished concurrently is reported unmapped, not handled",
    /if \(!result\.updated\) return \{ kind: "business_mapping_not_implemented" \}/.test(hBody));

  /* THE NOTIFICATION GOES TO THE OWNER OF THAT ACCOUNT, IN THAT ENVIRONMENT. */
  const triggers = codeOnly("src/lib/server/notification-triggers.ts");
  const nBody = functionBody(triggers, "notifyAccountUpdated") ?? "";
  check("notifyAccountUpdated resolves the creator by account id and environment",
    /eq\(whopAccounts\.whopAccountId, whopAccountId\)/.test(nBody) &&
      /eq\(whopAccounts\.environment, environment\)/.test(nBody));
  check("and takes the environment from server config, never the payload",
    /getWhopEnvironment\(\)/.test(nBody) && !/data\.environment|body.*environment/.test(nBody));
}

/* ---------------------------------------------------------------- O ---- */
section("O. The local environment, as booleans only");

{
  const wp = loadTs("src/lib/server/whop-payments.ts");
  check("the local environment is sandbox, so nothing here touches production",
    process.env.WHOP_ENV === "sandbox");
  check("OAuth is configured locally", oa.isOAuthConfigured(process.env) === true);
  check("token encryption is configured locally",
    loadTs("src/lib/server/token-crypto.ts").isTokenEncryptionConfigured(process.env) === true);
  check("payments are configured locally", wp.isWhopPaymentsConfigured(process.env) === true);
  /* PRODUCTION CREDENTIALS ARE ABSENT, and that is a prerequisite rather than a
   * defect — what matters is that their absence fails closed, proved in §A. */
  check("and the configured environment is NOT production",
    wp.getWhopEnvironment(process.env) !== "production");
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
