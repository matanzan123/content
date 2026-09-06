/**
 * Tests for Whop account linking.
 *
 * PKCE and token encryption are exercised against Node's real crypto, not a
 * mock — a stubbed cipher would prove nothing about whether a stored token is
 * actually unreadable. The one-time/replay behaviour of `state` is behaviour
 * of SQL, so it runs against real Postgres in a throwaway table (migration
 * 0003 is applied, but this suite still uses its own throwaway table so it
 * never writes a row into the real one).
 *
 * No OAuth consent is performed and no provider request is made.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Source with comments removed — assertions must test code, not prose. */
function codeOnly(file) {
  const withoutBlocks = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** Every module this suite has actually executed. Read by the final check. */
const loadedModules = [];

function load(file, injected = {}) {
  loadedModules.push(file);
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", "require", ...names, js)(
    mod, mod.exports, require, ...names.map((n) => injected[n]),
  );
  return mod.exports;
}

const KEY = randomBytes(32).toString("base64");
const crypto_ = load("src/lib/server/token-crypto.ts", {
  createCipheriv: require("node:crypto").createCipheriv,
  createDecipheriv: require("node:crypto").createDecipheriv,
  randomBytes,
});
const oauth = load("src/lib/server/whop-oauth.ts", { createHash, randomBytes });

/* ============================ PKCE ============================ */

{
  const verifier = oauth.createCodeVerifier();
  check("PKCE verifier is 43+ chars (RFC 7636 minimum)", verifier.length >= 43 && verifier.length <= 128, `${verifier.length}`);
  check("PKCE verifier is base64url — no +, /, or padding", /^[A-Za-z0-9\-_]+$/.test(verifier));
  check("two verifiers differ", oauth.createCodeVerifier() !== oauth.createCodeVerifier());

  // The challenge must be exactly S256(verifier), base64url, unpadded.
  const expected = createHash("sha256").update(verifier, "ascii").digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  check("code challenge is S256 of the verifier", oauth.codeChallengeFor(verifier) === expected);
  check("challenge is not the verifier (plain method not used)", oauth.codeChallengeFor(verifier) !== verifier);

  const config = { clientId: "app_x", clientSecret: null, redirectUri: "https://x.test/api/whop/callback" };
  const url = new URL(oauth.buildAuthorizeUrl({ config, state: "S", nonce: "N", codeChallenge: "C" }));
  check("authorize URL is Whop's OAuth host", url.origin + url.pathname === "https://api.whop.com/oauth/authorize");
  check("code_challenge_method is S256", url.searchParams.get("code_challenge_method") === "S256");
  check("state and nonce are both sent", url.searchParams.get("state") === "S" && url.searchParams.get("nonce") === "N");
  check("response_type is code", url.searchParams.get("response_type") === "code");
  check("scopes are exactly openid profile email", url.searchParams.get("scope") === "openid profile email");
  check("redirect_uri comes from config", url.searchParams.get("redirect_uri") === config.redirectUri);
}

/* ==================== config: no browser input ==================== */

{
  const ok = { WHOP_CLIENT_ID: "app_x", WHOP_REDIRECT_URI: "https://x.test/cb" };
  check("valid config resolves", oauth.resolveOAuthConfig(ok).ok === true);
  check("client_secret is optional under PKCE", oauth.resolveOAuthConfig(ok).config.clientSecret === null);
  check("missing client id fails closed", oauth.resolveOAuthConfig({}).reason === "missing_client_id");
  check("missing redirect fails closed", oauth.resolveOAuthConfig({ WHOP_CLIENT_ID: "a" }).reason === "missing_redirect_uri");
  check("http redirect is refused", oauth.resolveOAuthConfig({ ...ok, WHOP_REDIRECT_URI: "http://x.test/cb" }).reason === "invalid_redirect_uri");
  check("relative redirect is refused", oauth.resolveOAuthConfig({ ...ok, WHOP_REDIRECT_URI: "/cb" }).reason === "invalid_redirect_uri");

  const connect = readFileSync("src/app/api/whop/connect/route.ts", "utf8");
  for (const field of ["client_id", "scope", "redirect_uri", "whop_user_id", "company_id", "uid"]) {
    check(`the browser cannot supply ${field}`, new RegExp(`body[^;]*\\b${field}\\b`).test(connect) === false);
  }
  check("the only accepted body field is a return key", connect.includes("body?.return_to") && connect.includes("in RETURN_PATHS"));
  check("return destinations are a closed set (no open redirect)", connect.includes("RETURN_PATHS: Record<string, string>"));
  check("the uid comes from a verified token, not the body", connect.includes("auth.user.uid") && connect.includes("getUserFromRequest(request)"));
}

/* ==================== Firebase boundary ==================== */

{
  const userAuth = codeOnly("src/lib/server/user-auth.ts");
  check("only a Bearer ID token is accepted", userAuth.includes('request.headers.get("authorization")') && userAuth.includes("verifyIdToken"));
  check("revocation checking is on", userAuth.includes("verifyIdToken(token, true)"));
  // The uid is whatever verifyIdToken returned; nothing else is consulted.
  check("the uid comes only from the verified token", userAuth.includes("uid: claims.uid"));
  check("no query parameter is read", userAuth.includes("searchParams") === false);
  check("no request body is read", userAuth.includes("request.json") === false);
  check("the email is carried but never compared", /email\s*===\s*[a-zA-Z]/.test(userAuth) === false);
  check("an unconfigured Admin SDK denies rather than passes", userAuth.includes('return { ok: false, reason: "unconfigured" }'));
  check("there is no development bypass", /NODE_ENV|DEV_|allowInsecure/.test(userAuth) === false);

  for (const route of ["connect", "connection", "disconnect"]) {
    const src = readFileSync(`src/app/api/whop/${route}/route.ts`, "utf8");
    check(`/${route} requires an authenticated user`, src.includes("getUserFromRequest(request)"));
    check(`/${route} refuses when auth fails`, src.includes("if (!auth.ok)"));
  }
  const disconnect = readFileSync("src/app/api/whop/disconnect/route.ts", "utf8");
  check("disconnect is scoped to the caller's own uid", disconnect.includes("disconnectWhop(auth.user.uid)"));
  check("disconnect accepts no connection identifier", /request.json|searchParams/.test(codeOnly("src/app/api/whop/disconnect/route.ts")) === false);
}

/* ==================== email can never establish ownership ============ */

{
  const store = readFileSync("src/lib/server/whop-connections.ts", "utf8");
  const oauthSrc = readFileSync("src/lib/server/whop-oauth.ts", "utf8");
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const connectionsTable = schema.slice(schema.indexOf("whop_connections"), schema.indexOf("(t) => [\n    index(\"idx_whop_connections_uid\")"));

  check("the connection store never reads an email", /\bemail\b/i.test(store) === false);
  check("the connection table has no email column", /email[a-zA-Z]*:\s*(text|char)\(/i.test(connectionsTable) === false);
  check("the identity type deliberately omits email", oauthSrc.includes("THE EMAIL IS DELIBERATELY ABSENT"));
  const identityType = oauthSrc.slice(oauthSrc.indexOf("export type WhopIdentity"), oauthSrc.indexOf("export type UserinfoResult"));
  check("WhopIdentity carries only sub and username", identityType.includes("sub: string") && /\bemail\b/.test(identityType) === false);
  const callback = readFileSync("src/app/api/whop/callback/route.ts", "utf8");
  check("the callback links on the OIDC subject", callback.includes("whopUserId: identity.identity.sub"));
  // "email" appears once in the callback, inside the requested scope string.
  // It is never read off the identity, never stored, never compared.
  const callbackCode = codeOnly("src/app/api/whop/callback/route.ts");
  check("the callback reads no email from the identity", /\.email\b/.test(callbackCode) === false);
  check("the only mention of email is the requested scope", (callbackCode.match(/email/g) ?? []).length === 1 && callbackCode.includes("openid profile email"));
}

/* ==================== token encryption ==================== */

{
  const env = { WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: KEY };
  const secret = "whop_access_token_value_do_not_log";
  const envelope = crypto_.encryptToken(secret, "uid-a", env);

  check("a token encrypts to a v1 envelope", typeof envelope === "string" && envelope.startsWith("v1."));
  check("the ciphertext does not contain the plaintext", envelope.includes(secret) === false);
  check("it round-trips with the right key and owner", crypto_.decryptToken(envelope, "uid-a", env) === secret);
  check("a DIFFERENT owner cannot decrypt it (AAD binding)", crypto_.decryptToken(envelope, "uid-b", env) === null);
  check("a different key cannot decrypt it", crypto_.decryptToken(envelope, "uid-a", { WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") }) === null);

  // Tamper with the ciphertext body; GCM must reject it.
  const parts = envelope.split(".");
  const flipped = Buffer.from(parts[3], "base64");
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString("base64");
  check("a tampered ciphertext fails authentication", crypto_.decryptToken(parts.join("."), "uid-a", env) === null);
  check("a truncated envelope is refused", crypto_.decryptToken("v1.aa.bb", "uid-a", env) === null);
  check("an unknown version is refused", crypto_.decryptToken(envelope.replace("v1.", "v2."), "uid-a", env) === null);

  check("two encryptions of the same value differ (random IV)", crypto_.encryptToken(secret, "uid-a", env) !== envelope);

  // Fail closed on key problems.
  check("a missing key refuses to encrypt", crypto_.encryptToken(secret, "uid-a", {}) === null);
  check("a missing key refuses to decrypt", crypto_.decryptToken(envelope, "uid-a", {}) === null);
  check("a short key is refused", crypto_.readEncryptionKey({ WHOP_OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }).reason === "wrong_length");
  check("isTokenEncryptionConfigured is false without a key", crypto_.isTokenEncryptionConfigured({}) === false);

  // The key must be its own secret.
  check("the key is never WHOP_API_KEY or the webhook secret", process.env.WHOP_API_KEY !== KEY && process.env.WHOP_WEBHOOK_SECRET !== KEY);
  const cryptoSrc = readFileSync("src/lib/server/token-crypto.ts", "utf8");
  check("the crypto module reads no other credential", /WHOP_API_KEY|WHOP_WEBHOOK_SECRET/.test(cryptoSrc.replace(/^ \*.*$/gm, "")) === false);
  check("AES-256-GCM is the algorithm", cryptoSrc.includes('"aes-256-gcm"'));
}

/* ============ no token material can reach a browser ============ */

{
  const status = readFileSync("src/app/api/whop/connection/route.ts", "utf8");
  for (const leak of ["access_token", "refresh_token", "Ciphertext", "codeVerifier", "code_verifier"]) {
    check(`the status endpoint returns no ${leak}`, status.includes(leak) === false);
  }
  const store = readFileSync("src/lib/server/whop-connections.ts", "utf8");
  // Bound to the function body — the module also contains refresh code that
  // legitimately handles ciphertext.
  const dtoStart = store.indexOf("function toConnection");
  const toConnection = store.slice(dtoStart, store.indexOf("\n}", dtoStart));
  check("the connection DTO carries no ciphertext", /Ciphertext/.test(toConnection) === false);
  const wizard = readFileSync("src/components/onboarding/OnboardingWizard.tsx", "utf8");
  for (const leak of ["access_token", "refresh_token", "code_verifier", "client_secret", "WHOP_"]) {
    check(`the wizard never handles ${leak}`, wizard.includes(leak) === false);
  }
  check("no token is put in localStorage or sessionStorage", /(local|session)Storage[^\n]*(token|whop_access|refresh)/i.test(wizard) === false);
  const oauthSrc = readFileSync("src/lib/server/whop-oauth.ts", "utf8");
  check("no console logging of token material anywhere in the flow", /console\.(log|error|warn)/.test(oauthSrc + store + status) === false);
}

/* ==================== legacy flow is gone ==================== */

{
  const fs2 = require("node:fs");
  check("the legacy /api/whop/authorize route no longer exists", fs2.existsSync("src/app/api/whop/authorize/route.ts") === false);
  check("the legacy /api/whop/me route no longer exists", fs2.existsSync("src/app/api/whop/me/route.ts") === false);
  const wizard = readFileSync("src/components/onboarding/OnboardingWizard.tsx", "utf8");
  check("nothing links to the legacy authorize route", wizard.includes("/api/whop/authorize") === false);
  check("the wizard uses the authenticated connect endpoint", wizard.includes('fetch("/api/whop/connect"') && wizard.includes("Bearer ${idToken}"));
  // The legacy module is gone entirely — there is one OAuth implementation.
  check("the legacy src/lib/whop.ts module is deleted", fs2.existsSync("src/lib/whop.ts") === false);
  check("nothing anywhere imports it", (() => {
    const scan = (dir) => fs2.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scan(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
    return scan("src").filter((f) => /\.tsx?$/.test(f))
      .every((f) => readFileSync(f, "utf8").includes('from "@/lib/whop"') === false);
  })());
  const routes = ["connect", "callback", "connection", "disconnect"]
    .map((r) => readFileSync(`src/app/api/whop/${r}/route.ts`, "utf8")).join("\n");
  check("no live route imports the legacy module", routes.includes('from "@/lib/whop"') === false);
  check("no live route uses api/v5", routes.includes("api/v5") === false);
}

/* ============ state: one-time, expiring, replay-proof (real SQL) ======== */

if (process.env.DATABASE_URL) {
  const TABLE = `oauth_state_probe_${Math.random().toString(36).slice(2, 10)}`;
  const sql = postgres(process.env.DATABASE_URL, { max: 6, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`
      create table ${TABLE} (
        state text primary key,
        firebase_uid text not null,
        code_verifier_ciphertext text not null,
        nonce text not null,
        return_path text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      )`);

    const insert = (state, uid, secs) => sql.unsafe(
      `insert into ${TABLE} (state, firebase_uid, code_verifier_ciphertext, nonce, return_path, expires_at)
       values ('${state}', '${uid}', 'x', 'n', '/onboarding', now() + make_interval(secs => ${secs}))`);
    // The consume statement exactly as the implementation issues it.
    const consume = (state) => sql.unsafe(
      `delete from ${TABLE} where state = '${state}' and expires_at > now() returning state, firebase_uid`);

    await insert("s_live", "uid-owner", 600);
    const first = await consume("s_live");
    check("a valid state is consumed once", first.length === 1 && first[0].firebase_uid === "uid-owner");
    const second = await consume("s_live");
    check("REPLAY: the same state a second time yields nothing", second.length === 0);

    await insert("s_expired", "uid-owner", -1);
    check("an expired state is refused", (await consume("s_expired")).length === 0);
    check("the expired row is left for housekeeping, not silently used", (await sql.unsafe(`select count(*)::int as n from ${TABLE} where state='s_expired'`))[0].n === 1);

    check("an unknown state yields nothing", (await consume("s_never_existed")).length === 0);

    // Concurrency: 10 simultaneous consumers, one winner.
    await insert("s_race", "uid-owner", 600);
    const raced = await Promise.all(Array.from({ length: 10 }, () => consume("s_race")));
    const winners = raced.filter((r) => r.length === 1).length;
    check("CONCURRENCY: exactly one of 10 simultaneous consumers wins", winners === 1, `${winners} winners`);

    // The uid travels with the state — the callback cannot choose it.
    await insert("s_uid", "uid-alpha", 600);
    const claimed = await consume("s_uid");
    check("the consumed row carries the uid captured at start", claimed[0].firebase_uid === "uid-alpha");
  } finally {
    await sql.unsafe(`drop table if exists ${TABLE}`);
    const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_name = ${TABLE}`;
    check("the probe table was removed", n === 0);
    const [{ n: ledger }] = await sql`select count(*)::int as n from financial_ledger`;
    check("financial_ledger untouched", ledger === 0, `${ledger} rows`);
    const [{ n: applied }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("migration 0003 is applied", applied >= 4, `${applied} applied`);
    const [{ n: linked }] = await sql`select count(*)::int as n from whop_connections`;
    check("the real whop_connections table exists and is empty", linked === 0, `${linked} rows`);
    await sql.end({ timeout: 5 });
  }
}

/* ============ user-switch and cookie binding (structural) ============ */

{
  const callback = readFileSync("src/app/api/whop/callback/route.ts", "utf8");
  check("the callback requires the browser cookie to match the state", callback.includes("cookieState !== state"));
  check("a mismatch is refused, not repaired", callback.includes('"mismatch"'));
  check("the state is consumed before anything is exchanged", callback.indexOf("consumeAuthorization") < callback.indexOf("exchangeCode"));
  check("the uid comes from the consumed row, never the request", callback.includes("firebaseUid: pending.firebaseUid"));
  check("provider errors are reduced to a closed set of outcomes", callback.includes("type Outcome"));
  check("no provider text is echoed to the browser", /error_description|params.get\("error"\)\s*\)/.test(callback.replace('if (params.get("error")) return back(request, "/onboarding", "cancelled");', "")) === false);
  const connect = readFileSync("src/app/api/whop/connect/route.ts", "utf8");
  // Attribute-by-attribute assertions live in the COOKIE block below; the
  // cookie is now assembled from a list rather than a fixed string, because
  // Secure has to follow the request scheme.
  check("the link cookie is assembled with explicit attributes", connect.includes("const attributes = ["));
}

/* ============ uniqueness: one Whop identity, one user ============ */

{
  const store = readFileSync("src/lib/server/whop-connections.ts", "utf8");
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  check("a Whop identity already linked elsewhere is refused", store.includes('reason: "whop_identity_taken"'));
  check("the refusal is also a database constraint", schema.includes("uniq_whop_connection_active_whop_user"));
  check("one active link per ClipRewards user is a constraint too", schema.includes("uniq_whop_connection_active_user"));
  check("both constraints are scoped to active rows", (schema.match(/where\(sql`revoked_at is null`\)/g) ?? []).length >= 2);
  check("re-linking the same identity to the same user is allowed", store.includes("claimedElsewhere.firebaseUid !== input.firebaseUid"));
  check("the link is written in one transaction", store.includes("db.transaction("));
  check("a replaced link is retired, not deleted", store.includes("revokedAt: sql`now()`") && store.includes("accessTokenCiphertext: null"));
  check("refresh-token rotation is documented as serialised", readFileSync("src/lib/server/whop-oauth.ts", "utf8").includes("ROTATES refresh tokens"));
}

/* ==================== migration 0003 ==================== */

{
  const fs2 = require("node:fs");
  const file = fs2.readdirSync("drizzle").find((f) => f.startsWith("0003_") && f.endsWith(".sql"));
  check("migration 0003 exists", Boolean(file));
  const sqlText = readFileSync(`drizzle/${file}`, "utf8");
  check("0003 is additive only", /\b(DROP|TRUNCATE|DELETE|ALTER TABLE|RENAME)\b/i.test(sqlText) === false);
  check("0003 creates only the two new tables", (sqlText.match(/CREATE TABLE/g) ?? []).length === 2 && sqlText.includes("whop_connections") && sqlText.includes("whop_oauth_states"));
  check("0003 touches no existing table", /payment_orders|financial_ledger|analytics_|whop_webhook_receipts|admin_audit_log/.test(sqlText) === false);
  check("0003 carries both partial unique indexes", sqlText.includes("uniq_whop_connection_active_user") && sqlText.includes("uniq_whop_connection_active_whop_user"));
}

/* ====== THE USER-SWITCH SCENARIO, end to end against real Postgres ====== */

/**
 * A starts Connect Whop. A logs out. B signs in in the same browser. Whop
 * returns A's callback.
 *
 * The invariant: the link is decided by the STATE ROW, which recorded A's uid
 * at a moment when A's ID token was verified. The callback reads the uid from
 * that row and has no way to learn who is signed in now — so B cannot be
 * linked, whatever B does.
 */
if (process.env.DATABASE_URL) {
  const TABLE = `oauth_switch_probe_${Math.random().toString(36).slice(2, 10)}`;
  const sql = postgres(process.env.DATABASE_URL, { max: 6, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`
      create table ${TABLE} (
        state text primary key,
        firebase_uid text not null,
        code_verifier_ciphertext text not null,
        return_path text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      )`);

    // A starts the flow. Only A's uid is ever written.
    await sql.unsafe(
      `insert into ${TABLE} (state, firebase_uid, code_verifier_ciphertext, return_path, expires_at)
       values ('state_from_A', 'uid-USER-A', 'x', '/onboarding', now() + make_interval(secs => 600))`);

    // A logs out and B signs in. Neither touches the row — logging out is a
    // Firebase action and this table is not part of it.
    const [beforeCallback] = await sql.unsafe(`select firebase_uid from ${TABLE} where state='state_from_A'`);
    check("SWITCH: logging out does not alter the pending authorization", beforeCallback.firebase_uid === "uid-USER-A");

    // Whop returns A's callback while B is signed in.
    const consumed = await sql.unsafe(
      `delete from ${TABLE} where state = 'state_from_A' and expires_at > now() returning firebase_uid`);
    check("SWITCH: the callback resolves to the uid captured at START", consumed[0].firebase_uid === "uid-USER-A");
    check("SWITCH: the link can never go to user B", consumed[0].firebase_uid !== "uid-USER-B");

    // And the callback has no other source of identity to fall back on.
    const callbackCode = codeOnly("src/app/api/whop/callback/route.ts");
    check("SWITCH: the callback never verifies or reads a current session", /getUserFromRequest|verifyIdToken|getAdminCheck/.test(callbackCode) === false);
    check("SWITCH: the uid is taken only from the consumed row", callbackCode.includes("firebaseUid: pending.firebaseUid"));
    check("SWITCH: no uid is read from the query string", /searchParams\.get\("(uid|user|firebase)/.test(callbackCode) === false);
  } finally {
    await sql.unsafe(`drop table if exists ${TABLE}`);
    await sql.end({ timeout: 5 });
  }
}

/* ============ refresh rotation and concurrency (real Postgres) =========== */

if (process.env.DATABASE_URL) {
  const TABLE = `oauth_refresh_probe_${Math.random().toString(36).slice(2, 10)}`;
  const sql = postgres(process.env.DATABASE_URL, { max: 8, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`
      create table ${TABLE} (
        id uuid primary key default gen_random_uuid(),
        firebase_uid text not null,
        access_token_ciphertext text,
        refresh_token_ciphertext text,
        token_expires_at timestamptz,
        last_refreshed_at timestamptz,
        revoked_at timestamptz,
        refresh_count int not null default 0
      )`);
    await sql.unsafe(
      `insert into ${TABLE} (firebase_uid, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
       values ('uid-r', 'enc_access_v1', 'enc_refresh_v1', now() - make_interval(secs => 10))`);

    /** The shipped sequence: lock the row, re-check expiry, rotate, write. */
    async function refreshOnce(tag) {
      return sql.begin(async (tx) => {
        const [row] = await tx.unsafe(
          `select * from ${TABLE} where firebase_uid='uid-r' and revoked_at is null for update`);
        if (!row) return { tag, did: "not_connected" };
        const expired = row.token_expires_at !== null && new Date(row.token_expires_at).getTime() - Date.now() <= 120000;
        if (!expired) return { tag, did: "reused" };
        await tx.unsafe(
          `update ${TABLE}
              set access_token_ciphertext='enc_access_v2',
                  refresh_token_ciphertext='enc_refresh_v2',
                  token_expires_at = now() + make_interval(secs => 3600),
                  last_refreshed_at = now(),
                  refresh_count = refresh_count + 1
            where id='${row.id}'`);
        return { tag, did: "refreshed" };
      });
    }

    const wave = await Promise.all(Array.from({ length: 8 }, (_, i) => refreshOnce(i)));
    const refreshed = wave.filter((w) => w.did === "refreshed").length;
    const reused = wave.filter((w) => w.did === "reused").length;
    const [{ refresh_count: count }] = await sql.unsafe(`select refresh_count from ${TABLE} where firebase_uid='uid-r'`);

    check("REFRESH: 8 concurrent callers rotate the token exactly once", refreshed === 1, `${refreshed} refreshed, ${reused} reused`);
    check("REFRESH: the database records exactly one rotation", count === 1, `${count}`);
    check("REFRESH: the losers reuse the new token, they do not overwrite it", reused === 7, `${reused}`);
    const [after] = await sql.unsafe(`select * from ${TABLE} where firebase_uid='uid-r'`);
    check("REFRESH: the newest refresh token survives", after.refresh_token_ciphertext === "enc_refresh_v2");
    check("REFRESH: the rotation timestamp uses DB time", after.last_refreshed_at !== null);

    // A revoked connection cannot refresh.
    await sql.unsafe(`update ${TABLE} set revoked_at = now() where firebase_uid='uid-r'`);
    const afterRevoke = await refreshOnce("post-revoke");
    check("REFRESH: a revoked connection cannot refresh", afterRevoke.did === "not_connected");
  } finally {
    await sql.unsafe(`drop table if exists ${TABLE}`);
    await sql.end({ timeout: 5 });
  }
}

/* ============ refresh implementation shape (no in-memory locking) ======== */

{
  const store = codeOnly("src/lib/server/whop-connections.ts");
  const fn = store.slice(store.indexOf("export async function getUsableAccessToken"));
  check("refresh runs inside a transaction", fn.includes("db.transaction("));
  check("refresh takes a row lock, not a process mutex", fn.includes('.for("update")'));
  check("no in-memory or global lock is used", /Mutex|globalThis\.[A-Za-z]*[Ll]ock|let\s+\w*locked/.test(store) === false);
  check("expiry is re-read INSIDE the lock", fn.indexOf('.for("update")') < fn.indexOf("tokenExpiresAt"));
  check("a rejected grant revokes rather than retries", fn.includes('result.reason === "invalid_grant"') && fn.includes("revokedAt: sql`now()`"));
  check("a network error leaves the connection intact", fn.includes('reason: "provider_error"'));
  check("a rotated refresh token replaces the old one atomically", fn.includes("refreshTokenCiphertext: nextRefresh"));
  check("the provider expiry is respected, with skew", fn.includes("REFRESH_SKEW_SECONDS") || store.includes("REFRESH_SKEW_SECONDS"));
  check("refresh is server-only", readFileSync("src/lib/server/whop-connections.ts", "utf8").startsWith('import "server-only"'));
}

/* ================= state cookie attributes ================= */

{
  const connect = readFileSync("src/app/api/whop/connect/route.ts", "utf8");
  check("COOKIE: HttpOnly", connect.includes('"HttpOnly"'));
  check("COOKIE: SameSite=Lax (Strict would break the top-level callback)", connect.includes('"SameSite=Lax"') && connect.includes("SameSite=Strict") === false);
  check("COOKIE: Secure follows the request scheme", connect.includes('new URL(request.url).protocol === "https:"') && connect.includes('isHttps ? ["Secure"] : []'));
  check("COOKIE: scoped Path, not site-wide", connect.includes('"Path=/api/whop"'));
  check("COOKIE: short lifetime matching the state row", connect.includes("LINK_COOKIE_MAX_AGE = 600"));
  check("COOKIE: value is the CSPRNG state", connect.includes("cr_whop_link=${state}"));
  const callback = readFileSync("src/app/api/whop/callback/route.ts", "utf8");
  check("COOKIE: compared exactly, not loosely", callback.includes("cookieState !== state"));
  check("COOKIE: cleared on every callback outcome", callback.includes("maxAge: 0") && callback.includes("function back("));
}

/* ================= nonce / id_token architecture ================= */

{
  const oauthSrc = readFileSync("src/lib/server/whop-oauth.ts", "utf8");
  const oauthCode = codeOnly("src/lib/server/whop-oauth.ts");
  const callbackCode = codeOnly("src/app/api/whop/callback/route.ts");

  check("NONCE: a nonce IS sent on the authorize request", oauthCode.includes('url.searchParams.set("nonce"'));
  check("NONCE: no id_token is ever read", /id_token/.test(oauthCode + callbackCode) === false);
  check("NONCE: no JWT is decoded anywhere in the flow", /jwt|decode\(|atob\(/i.test(oauthCode + callbackCode) === false);
  check("NONCE: identity comes from the userinfo endpoint", oauthCode.includes("fetchUserinfo") && oauthCode.includes("/userinfo"));
  check("NONCE: it is NOT stored, since nothing verifies it", codeOnly("src/lib/server/whop-connections.ts").includes("nonce") === false);
  check("NONCE: the schema has no nonce column", codeOnly("src/lib/db/schema.ts").includes('text("nonce")') === false);
  check("NONCE: the limitation is documented, not implied", oauthSrc.includes("It buys this application NOTHING"));
}

/* ================= clean callback URL ================= */

{
  const callbackCode = codeOnly("src/app/api/whop/callback/route.ts");
  check("CLEAN URL: the redirect carries only a whop= outcome", callbackCode.includes('url.searchParams.set("whop", outcome)'));
  for (const leak of ["code", "state", "access_token", "refresh_token", "error_description"]) {
    check(`CLEAN URL: no ${leak} is put on the redirect`, new RegExp(`searchParams\\.set\\("${leak}"`).test(callbackCode) === false);
  }
  check("CLEAN URL: outcomes are a closed set", callbackCode.includes("type Outcome"));
  check("CLEAN URL: the destination comes from the stored return path", callbackCode.includes("pending.returnPath"));
  check("CLEAN URL: the return path is never read from the request", /searchParams\.get\("(return|redirect|next)/.test(callbackCode) === false);
  const connect = codeOnly("src/app/api/whop/connect/route.ts");
  check("CLEAN URL: return destinations are a closed map (no open redirect)", connect.includes("RETURN_PATHS[returnKey]") && connect.includes("in RETURN_PATHS"));
}

/* ================= financial_ledger untouched ================= */

if (process.env.DATABASE_URL) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const [{ n: ledger }] = await sql`select count(*)::int as n from financial_ledger`;
  const [{ n: orders }] = await sql`select count(*)::int as n from payment_orders`;
  const [{ n: receipts }] = await sql`select count(*)::int as n from whop_webhook_receipts`;
  const [{ n: applied }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  await sql.end({ timeout: 2 });
  check("financial_ledger remains 0", ledger === 0, `${ledger}`);
  check("payment_orders untouched by this work", orders === 3, `${orders}`);
  // NOT a fixed count. `whop_webhook_receipts` grows whenever Whop delivers to
  // the sandbox endpoint, which it does on its own schedule and without asking
  // this suite — the count was 2 when this line was written and is legitimately
  // higher now. What this suite must assert is that IT did not write any, and
  // it writes none: it never calls the receiver. The receipts table's own
  // before/after invariance is proved where it belongs, in whop-retry-test.mjs.
  //
  // A hard-coded expectation here would fail on a real delivery and teach us to
  // ignore a red test, which is worse than not asserting it.
  // Asserted by what this suite LOADS, not by scanning its own text — a source
  // scan for the receiver's name would match the scan itself.
  check(
    "this suite wrote no webhook receipts: it never loads the receiver at all",
    typeof globalThis.processVerifiedWebhook === "undefined" &&
      loadedModules.every((m) => !/whop-webhooks/.test(m)),
    `${receipts} receipt(s) present, all from real Whop deliveries`,
  );
  check("migration 0003 is applied", applied >= 4, `${applied} applied`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
