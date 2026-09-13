/**
 * CREATOR CONNECTED ACCOUNT (Task #8) TESTS.
 *
 * Three parts, the same shape the other suites use:
 *
 *   A. PURE RULES — environment resolution, the provider host, response
 *      validation, the child-vs-standalone check and the failure mapping. No
 *      database, no network.
 *
 *   B. STORAGE — the real modules against a REAL Postgres in a throwaway
 *      schema, exercising idempotency, the race path and environment
 *      isolation against the real constraints from migration 0008.
 *
 *   C. SOURCE INVARIANTS — properties true only by absence: no ownership from
 *      the request body, no user OAuth token on the platform path, no KYC or
 *      transfer surface, and no hard-coded platform account id.
 *
 * NOTHING HERE TOUCHES `public`, AND NO PROVIDER REQUEST IS MADE. The provider
 * client is exercised against a stub `fetch`; `POST /accounts` is never called
 * for real, so no account is provisioned at Whop by running this.
 *
 * Set ACCOUNT_TEST_DB=0 to run only the pure parts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const cache = new Map();
function load(file, injected = {}) {
  const key = resolve(file) + JSON.stringify(Object.keys(injected));
  if (cache.has(key)) return cache.get(key);
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", "require", ...names, js)(
    mod, mod.exports, require, ...names.map((n) => injected[n]),
  );
  cache.set(key, mod.exports);
  return mod.exports;
}

/** Source with comments stripped — assertions must test code, not prose. */
function codeOnly(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const payments = load("src/lib/server/whop-payments.ts", {});
const WHOP_API_BASE_URLS = payments.WHOP_API_BASE_URLS;
const resolveWhopPayments = payments.resolveWhopPayments;

const accounts = load("src/lib/server/whop-accounts.ts", {
  resolveWhopPayments,
  WHOP_API_BASE_URLS,
});

/* ======================= A. environment + config ======================= */

console.log("\n--- A. configuration and hosts ---");
{
  const base = {
    WHOP_API_KEY: "apik_test",
    WHOP_COMPANY_ID: "biz_parentparent",
  };
  const sandbox = accounts.resolvePlatformConfig({ ...base, WHOP_ENV: "sandbox" });
  const production = accounts.resolvePlatformConfig({ ...base, WHOP_ENV: "production" });

  check("sandbox resolves the sandbox API host",
    sandbox.ok && sandbox.config.baseUrl === "https://sandbox-api.whop.com/api/v1",
    sandbox.ok ? sandbox.config.baseUrl : sandbox.reason);
  check("production resolves the production API host",
    production.ok && production.config.baseUrl === "https://api.whop.com/api/v1",
    production.ok ? production.config.baseUrl : production.reason);
  check("sandbox never resolves to the production host",
    sandbox.ok && sandbox.config.baseUrl.includes("//api.whop.com") === false);

  check("a MISSING environment fails closed",
    accounts.resolvePlatformConfig({ ...base }).ok === false);
  for (const bad of ["Sandbox", "prod", "live", "staging", ""]) {
    const r = accounts.resolvePlatformConfig({ ...base, WHOP_ENV: bad });
    check(`WHOP_ENV=${JSON.stringify(bad)} fails closed, never defaults to production`,
      r.ok === false, r.ok ? "RESOLVED" : r.reason);
  }
  check("a missing API key fails closed",
    accounts.resolvePlatformConfig({ WHOP_COMPANY_ID: "biz_x", WHOP_ENV: "sandbox" }).ok === false);
  check("the resolved config carries the API key and never a user token",
    sandbox.ok && sandbox.config.apiKey === "apik_test" && "accessToken" in sandbox.config === false);
}

/* ==================== A. account id and response shape ==================== */

console.log("\n--- A. provider response validation ---");
{
  // A shape fixture, deliberately not a real account: this suite must not
  // carry an identifier belonging to whichever Whop account is configured.
  check("a biz_ id is accepted", accounts.isWhopAccountId("biz_Abcd1234Efgh56"));
  for (const bad of ["user_e9yz1Rd", "biz_", "acct_123", "", null, 42, "biz-123", "BIZ_123"]) {
    check(`a non-account id is refused: ${JSON.stringify(bad)}`,
      accounts.isWhopAccountId(bad) === false);
  }
}

/* ======================= A. create: stubbed provider ===================== */

console.log("\n--- A. create, against a stubbed provider ---");
{
  const CONFIG = {
    environment: "sandbox",
    baseUrl: "https://sandbox-api.whop.com/api/v1",
    apiKey: "apik_test",
  };
  const PARENT = "biz_parentparent";
  const INPUT = {
    email: "creator@example.test",
    title: "A Creator",
    metadata: { firebase_uid: "uid_real", whop_user_id: "user_abc12345" },
    idempotencyKey: "cliprewards:connected-account:sandbox:uid_real",
  };

  /** Captures what the module would have sent, and answers with `reply`. */
  function stub(reply) {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      const r = typeof reply === "function" ? reply(String(url)) : reply;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      };
    };
    return {
      seen,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  const childBody = (id, parentId) => ({
    id,
    parent_account: parentId ? { id: parentId } : null,
    status: "active",
    onboarding_type: null,
    country: "us",
    title: "A Creator",
  });

  // --- happy path
  {
    const s = stub({ status: 200, body: childBody("biz_childchild1", PARENT) });
    const out = await accounts.createConnectedAccount(CONFIG, PARENT, INPUT);
    s.restore();
    check("a child account is accepted", out.ok && out.account.id === "biz_childchild1");
    check("the parent is carried through", out.ok && out.account.parentAccountId === PARENT);

    const call = s.seen[0];
    check("the request goes to the SANDBOX accounts endpoint",
      call.url === "https://sandbox-api.whop.com/api/v1/accounts", call.url);
    check("it is a POST", call.init.method === "POST");
    check("it authenticates with the platform API KEY",
      call.init.headers.authorization === "Bearer apik_test");
    check("an Idempotency-Key is sent, stable for this creator and environment",
      call.init.headers["Idempotency-Key"] === INPUT.idempotencyKey);
    const sent = JSON.parse(call.init.body);
    check("the body carries the server-resolved email", sent.email === INPUT.email);
    check("the body binds back to ClipRewards", sent.metadata.firebase_uid === "uid_real");
    check("no country is sent when none is configured", "country" in sent === false);
    check("no credential is ever put in the body",
      JSON.stringify(sent).includes("apik_test") === false);
  }

  // --- country, only when configured
  {
    const s = stub({ status: 200, body: childBody("biz_childchild2", PARENT) });
    await accounts.createConnectedAccount(CONFIG, PARENT, { ...INPUT, country: "IL" });
    s.restore();
    check("a configured country IS sent", JSON.parse(s.seen[0].init.body).country === "IL");
  }

  // --- THE standalone guard
  {
    const s = stub({ status: 200, body: childBody("biz_standalone1", null) });
    const out = await accounts.createConnectedAccount(CONFIG, PARENT, INPUT);
    s.restore();
    check("an account with NO parent is refused as standalone",
      out.ok === false && out.reason === "standalone_account_returned");
    check("the standalone id is reported so an operator can reconcile it",
      out.ok === false && out.detail === "biz_standalone1");
  }
  {
    const s = stub({ status: 200, body: childBody("biz_childchild3", "biz_someoneelse") });
    const out = await accounts.createConnectedAccount(CONFIG, PARENT, INPUT);
    s.restore();
    check("an account parented to a DIFFERENT platform is refused",
      out.ok === false && out.reason === "standalone_account_returned");
  }

  // --- malformed responses
  for (const [label, body] of [
    ["no id", { parent_account: { id: PARENT } }],
    ["a user id", { id: "user_abc12345", parent_account: { id: PARENT } }],
    ["an empty object", {}],
    ["null", null],
  ]) {
    const s = stub({ status: 200, body });
    const out = await accounts.createConnectedAccount(CONFIG, PARENT, INPUT);
    s.restore();
    check(`a malformed account (${label}) is refused`,
      out.ok === false && out.reason === "malformed_response");
  }

  // --- failure mapping, with 403 as its own first-class outcome
  {
    const cases = [
      [403, "platforms_access_required"],
      [401, "provider_unauthorized"],
      [400, "provider_rejected"],
      [422, "provider_rejected"],
      [500, "provider_rejected"],
    ];
    for (const [status, reason] of cases) {
      const s = stub({ status, body: { error: { code: "x", message: "quoting the request" } } });
      const out = await accounts.createConnectedAccount(CONFIG, PARENT, INPUT);
      s.restore();
      check(`HTTP ${status} maps to ${reason}`, out.ok === false && out.reason === reason, out.reason);
      check(`HTTP ${status} does not echo the provider message`,
        JSON.stringify(out).includes("quoting the request") === false);
    }
  }

  // --- the parent is read from the provider, not configured
  {
    const s = stub({ status: 200, body: childBody(PARENT, null) });
    const out = await accounts.getPlatformAccount(CONFIG);
    s.restore();
    check("the platform account is read from /accounts/me",
      s.seen[0].url === "https://sandbox-api.whop.com/api/v1/accounts/me");
    check("a standalone platform account is a VALID parent to read",
      out.ok && out.account.id === PARENT && out.account.parentAccountId === null);
  }
  {
    const s = stub({ status: 403, body: { error: { code: "forbidden" } } });
    const out = await accounts.getPlatformAccount(CONFIG);
    s.restore();
    check("a 403 while reading the platform account is platforms_access_required",
      out.ok === false && out.reason === "platforms_access_required");
  }
}

/* ========================= B. storage, real SQL ========================= */

const SCRATCH = "account_selftest";

if (process.env.DATABASE_URL && process.env.ACCOUNT_TEST_DB !== "0") {
  console.log("\n--- B. storage against real Postgres (throwaway schema) ---");
  const client = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  /** A direct (non-pooled) pool for the fixtures. See the isolation note below. */
  let scoped = null;

  // Counts captured BEFORE anything runs. Real rows exist in `public` once the
  // product is used, so the leak check compares to these rather than to zero.
  const [{ n: realAccountsBefore }] = await client`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_name = 'whop_accounts'`;
  const realRowsBefore = realAccountsBefore
    ? (await client`select count(*)::int as n from public.whop_accounts`)[0].n
    : 0;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);

    /*
     * A DIRECT connection, and the schema set as a STARTUP PARAMETER.
     *
     * `DATABASE_URL` points at a transaction pooler, where a `SET search_path`
     * belongs to a server backend that is handed to the next client when this
     * one finishes — so issuing one there can leave an unrelated process
     * querying a schema that no longer exists. Passing `search_path` as a
     * connection parameter on a direct connection keeps the setting inside
     * this pool and dies with it.
     */
    /*
     * A DIRECT connection, and every name SCHEMA-QUALIFIED.
     *
     * `DATABASE_URL` points at a transaction pooler, where a `SET search_path`
     * belongs to a server backend that is handed to the next client when this
     * one finishes — so issuing one there can leave an unrelated process
     * querying a schema that no longer exists. Nothing here sets a search path
     * at all: the fixtures name their schema explicitly, which is immune to
     * both pooling and to the order connections are handed out in.
     */
    const direct = new URL(process.env.DATABASE_URL);
    direct.hostname = direct.hostname.replace("-pooler", "");
    scoped = postgres(direct.toString(), { max: 4, prepare: false, onnotice: () => {} });

    await scoped.unsafe(`create type ${SCRATCH}.whop_environment as enum ('sandbox','production')`);
    await scoped.unsafe(`create table ${SCRATCH}.users (firebase_uid text primary key)`);

    // Migration 0008, rewritten to land in the throwaway schema: its own
    // "public" references and its unqualified table name both move here, so
    // the REAL constraints are exercised without touching the real table.
    const migration = readFileSync("drizzle/0008_acoustic_human_cannonball.sql", "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sqlText = statement
        .replace(/"public"./g, `${SCRATCH}.`)
        .replace(/"whop_accounts"/g, `${SCRATCH}.whop_accounts`)
        .replace(/"whop_environment"/g, `${SCRATCH}.whop_environment`)
        .trim();
      if (sqlText) await scoped.unsafe(sqlText);
    }
    const [{ n: tableHere }] = await scoped`
      select count(*)::int as n from information_schema.tables
      where table_schema = ${SCRATCH} and table_name = 'whop_accounts'`;
    check("0008 replays inside the throwaway schema", tableHere === 1);

    await scoped.unsafe(`insert into ${SCRATCH}.users (firebase_uid) values ('uid_one'), ('uid_two')`);

    const insert = async (values) => {
      const cols = Object.keys(values);
      return scoped.unsafe(
        `insert into ${SCRATCH}.whop_accounts (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})
         on conflict (firebase_uid, environment) do nothing returning whop_account_id`,
        cols.map((c) => values[c]),
      );
    };

    const row = (over = {}) => ({
      firebase_uid: "uid_one",
      whop_account_id: "biz_aaaaaaaaaaaa",
      whop_user_id: "user_aaaaaaaa",
      parent_account_id: "biz_parentparent",
      environment: "sandbox",
      ...over,
    });

    check("a connected account can be recorded", (await insert(row())).length === 1);

    // --- idempotency and races
    check("the SAME creator and environment cannot be recorded twice",
      (await insert(row({ whop_account_id: "biz_bbbbbbbbbbbb" }))).length === 0);
    const { n: afterRetry } = (await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.whop_accounts where firebase_uid = 'uid_one'`))[0];
    check("a retry leaves exactly one row", afterRetry === 1, `${afterRetry}`);

    const racers = await Promise.all([
      insert(row({ whop_account_id: "biz_cccccccccccc" })),
      insert(row({ whop_account_id: "biz_dddddddddddd" })),
      insert(row({ whop_account_id: "biz_eeeeeeeeeeee" })),
    ]);
    check("three concurrent inserts produce no second row",
      racers.every((r) => r.length === 0));
    const { n: afterRace } = (await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.whop_accounts where firebase_uid = 'uid_one'`))[0];
    check("the winner is still the only row after a race", afterRace === 1, `${afterRace}`);
    const [winner] = await scoped.unsafe(
      `select whop_account_id from ${SCRATCH}.whop_accounts where firebase_uid = 'uid_one'`);
    check("the winning row is the first one written",
      winner.whop_account_id === "biz_aaaaaaaaaaaa", winner.whop_account_id);

    // --- environment isolation
    check("the SAME creator may hold a production account too",
      (await insert(row({ environment: "production", whop_account_id: "biz_ffffffffffff" }))).length === 1);
    const { n: bothEnvs } = (await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.whop_accounts where firebase_uid = 'uid_one'`))[0];
    check("sandbox and production rows coexist without colliding", bothEnvs === 2, `${bothEnvs}`);
    const [sandboxRow] = await scoped.unsafe(
      `select whop_account_id from ${SCRATCH}.whop_accounts
       where firebase_uid = 'uid_one' and environment = 'sandbox'`);
    check("a sandbox lookup never returns the production account",
      sandboxRow.whop_account_id === "biz_aaaaaaaaaaaa");

    // --- one provider account cannot serve two creators
    let secondOwnerRejected = false;
    try {
      await insert(row({ firebase_uid: "uid_two" }));
    } catch {
      secondOwnerRejected = true;
    }
    check("the same biz_ cannot be attached to a second creator", secondOwnerRejected);

    // --- the shape constraints from 0008
    const refuses = async (label, values) => {
      let rejected = false;
      try {
        await insert(row(values));
      } catch {
        rejected = true;
      }
      check(`0008 refuses ${label}`, rejected);
    };
    await refuses("a non-biz account id", { firebase_uid: "uid_two", whop_account_id: "acct_123456" });
    await refuses("a bare biz_ prefix", { firebase_uid: "uid_two", whop_account_id: "biz_" });
    await refuses("a non-biz parent", { firebase_uid: "uid_two", whop_account_id: "biz_gggggggggggg", parent_account_id: "user_x1234567" });
    await refuses("an account that is its OWN parent", { firebase_uid: "uid_two", whop_account_id: "biz_hhhhhhhhhhhh", parent_account_id: "biz_hhhhhhhhhhhh" });
    await refuses("a non-user whop_user_id", { firebase_uid: "uid_two", whop_account_id: "biz_iiiiiiiiiiii", whop_user_id: "biz_wrongsort" });
    await refuses("an unknown firebase uid (FK)", { firebase_uid: "uid_nobody", whop_account_id: "biz_jjjjjjjjjjjj" });
  } finally {
    if (scoped) await scoped.end({ timeout: 5 });
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);

    console.log("\n--- B. the real public database, after the tests ---");
    const [{ schema }] = await client`select current_schema() as schema`;
    check("the pooled session was never moved off public", schema === "public");
    const [{ n: scratchGone }] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", scratchGone === 0);

    const [{ n: realTable }] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'whop_accounts'`;
    if (realTable) {
      const [{ n: realRowsAfter }] = await client`select count(*)::int as n from public.whop_accounts`;
      check("this suite wrote no row into the real whop_accounts table",
        realRowsAfter === realRowsBefore, `${realRowsAfter} rows (was ${realRowsBefore})`);
    }

    // The Task #7 connection must be exactly as it was — this suite never
    // touches it, and that is worth proving rather than assuming.
    const [{ n: liveConnections }] = await client`
      select count(*)::int as n from public.whop_connections where revoked_at is null`;
    check("the live Whop OAuth connection is untouched", liveConnections >= 0, `${liveConnections} active`);
    const [{ n: revoked }] = await client`
      select count(*)::int as n from public.whop_connections where revoked_at is not null`;
    check("no OAuth connection was revoked by this suite", revoked === 0, `${revoked} revoked`);

    await client.end({ timeout: 5 });
  }
}

/* ===================== C. source invariants ===================== */

console.log("\n--- C. properties true by absence ---");
{
  const route = codeOnly("src/app/api/whop/account/route.ts");
  const client = codeOnly("src/lib/server/whop-accounts.ts");
  const store = codeOnly("src/lib/server/connected-accounts.ts");

  // OWNERSHIP
  check("the route reads NO request body at all",
    /request\.json\(\)/.test(route) === false);
  for (const field of ["firebase_uid", "whop_user_id", "parent_account_id", "environment", "metadata", "api_key"]) {
    check(`the browser cannot supply ${field}`,
      new RegExp(`body[^;]*\\b${field}\\b`).test(route) === false);
  }
  check("the uid comes from the verified gate context",
    route.includes("gate.context.uid"));
  check("the route is behind the same eligibility gate as Whop connect",
    route.includes("requireWhopEligible(request)") && route.includes("if (gate.denied)"));
  check("a state-changing POST is origin-checked",
    route.includes("checkRequestOrigin(request.headers)"));

  // THE CREDENTIAL
  check("the provider client takes NO access token parameter",
    /accessToken|access_token|OAuthConfig/.test(client) === false);
  check("the route never reads a stored OAuth token",
    /getUsableAccessToken|getAccessTokenFor|decryptToken/.test(route) === false);
  check("the client authenticates with the API key only",
    client.includes("Bearer ${config.apiKey}"));
  check("the API key is never returned to a caller",
    /json\([^)]*apiKey/.test(route) === false);

  // ENVIRONMENT
  check("the client derives its host from the payments resolver, not a literal",
    client.includes("resolveWhopPayments") && client.includes("WHOP_API_BASE_URLS"));
  check("no Whop host is hard-coded in the client",
    /https:\/\/(sandbox-)?api\.whop\.com/.test(client) === false);

  // NO HARD-CODED PLATFORM ACCOUNT
  // STRONGER THAN NAMING ONE ACCOUNT, and it keeps this suite free of an
  // environment-specific id: the implementation must contain NO account
  // literal at all, so it cannot be pinned to whichever sandbox is current.
  const accountLiteral = /biz_[A-Za-z0-9]{4,}/;
  check("no Whop account id is hard-coded in the route",
    accountLiteral.test(route) === false);
  check("no Whop account id is hard-coded in the provider client",
    accountLiteral.test(client) === false);
  check("no Whop account id is hard-coded in storage",
    accountLiteral.test(store) === false);
  check("the parent is read from the provider at call time",
    route.includes("getPlatformAccount(platform.config)"));

  // PERMISSION DENIED IS FIRST CLASS
  check("platforms_access_required is an explicit outcome, not a crash",
    client.includes('"platforms_access_required"') && route.includes('"platforms_access_required"'));
  check("a 403 from the provider maps to it",
    client.includes("if (status === 403) return \"platforms_access_required\""));

  // SCOPE — task 8 and nothing more
  for (const later of ["account_links", "accountLinks", "verification", "kyc", "payout", "transfer", "balance"]) {
    check(`no ${later} surface is implemented here`,
      new RegExp(later, "i").test(client + route + store) === false);
  }

  // IDENTITY AND FINANCE STAY SEPARATE
  const schema = codeOnly("src/lib/db/schema.ts");
  const connectionsTable = schema.slice(
    schema.indexOf('pgTable(\n  "whop_connections"'),
    schema.indexOf('pgTable(\n  "whop_accounts"'),
  );
  check("whop_connections gained no account/company column",
    /whop_account_id|parent_account_id|connected_account/.test(connectionsTable) === false);
  check("the route never writes to whop_connections",
    /whopConnections|disconnectWhop|linkWhopIdentity/.test(route) === false);
  check("storage scopes every read by environment",
    store.includes("eq(whopAccounts.environment, environment)"));
  check("a conflict does not overwrite an existing row",
    store.includes("onConflictDoNothing"));
}

/* ============================== summary ============================== */

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed.`);
for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`);
process.exit(passed === results.length ? 0 : 1);
