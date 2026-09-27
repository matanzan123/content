#!/usr/bin/env node
/**
 * TASK #23 — RATE LIMITING / ABUSE PROTECTION.
 *
 * The limiter's core was already sound: a single
 * `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` is a
 * genuinely atomic increment, not a read-then-write race. What was wrong sat
 * around it:
 *
 *   - `getClientIp` read the FIRST `x-forwarded-for` entry, which proxies append
 *     to and a direct caller therefore controls completely. That gave an attacker
 *     both a BYPASS (rotate the header for a fresh bucket every request) and a
 *     TARGETED LOCKOUT (send a victim's address and spend their budget), on the
 *     only brute-force guard the app has.
 *   - `Retry-After` was a flat 3600 regardless of how much of the fixed window
 *     remained, so a client told to wait an hour might have needed twelve
 *     seconds.
 *   - `admin/reconciliation/summary` fans out to up to 200 provider calls per
 *     request and nothing bounded how often it could be called.
 *   - `checkout/sandbox` creates a real sandbox Whop checkout per call, with no
 *     authentication and no limit.
 *   - `admin/earnings/record` answered a rate limit with a plain object, which
 *     `withAdminApi` serialises as HTTP 200 — a refused allocation that looked
 *     accepted.
 *   - an empty key would have put every caller that produced one into a single
 *     shared bucket.
 *
 * DB-BACKED, because the counter IS the database. Concurrency and window
 * behaviour cannot be demonstrated against a fake.
 *
 * NO NETWORK. NOTHING IS WRITTEN TO public — every table the modules name
 * resolves to a throwaway schema, verified before a single row is written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/* IMPORTS STRIPPED. An ordering check that indexes the whole file finds the
 * import of `writeAudit` long before the limiter and concludes the limiter runs
 * last — which is the opposite of the truth. Only the handler body orders
 * anything. */
const bodyOnly = (p) =>
  codeOnly(p).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");

/* The same .env.local reader the other DB-backed suites use — these scripts run
 * outside Next's env loading. */
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

/* TRUST NOTHING unless a section says otherwise. A developer machine with
 * TRUSTED_PROXY_HOPS set must not change what section B proves. */
delete process.env.TRUSTED_PROXY_HOPS;

const SCRATCH = "rate_limit_selftest";

/* =========================================================================
   Module loader. The only seam is the database.
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

const H = (obj) => new Headers(obj);

/* ---------------------------------------------------------------- A ---- */
section("A. The 429 response");

{
  const rl = loadTs("src/lib/server/rate-limit.ts");

  const res = rl.rateLimitResponse(42);
  check("it is a real HTTP 429, not a 200 carrying an error", res.status === 429, String(res.status));
  check("with retry-after in seconds", res.headers.get("retry-after") === "42");
  check("and no-store, so nothing caches a refusal",
    res.headers.get("cache-control") === "no-store");

  /* RETRY-AFTER IS THE TIME TO THE WINDOW BOUNDARY, not a flat hour. */
  const hour = 3_600_000;
  check("one second into a window, the wait is nearly the whole hour",
    rl.windowRetryAfterSeconds(hour * 10 + 1000) === 3599,
    String(rl.windowRetryAfterSeconds(hour * 10 + 1000)));
  check("near the end of a window, the wait is short",
    rl.windowRetryAfterSeconds(hour * 10 + (hour - 12_000)) === 12,
    String(rl.windowRetryAfterSeconds(hour * 10 + (hour - 12_000))));
  check("exactly on a boundary, the wait is the full window",
    rl.windowRetryAfterSeconds(hour * 10) === 3600);
  check("and it is never zero or negative",
    rl.windowRetryAfterSeconds(hour * 10 + (hour - 1)) >= 1,
    String(rl.windowRetryAfterSeconds(hour * 10 + (hour - 1))));

  const auto = rl.rateLimitResponse();
  const secs = Number(auto.headers.get("retry-after"));
  check("the default retry-after is within one window, not a constant hour",
    Number.isInteger(secs) && secs >= 1 && secs <= 3600, String(secs));
}

/* ---------------------------------------------------------------- B ---- */
section("B. Client identity is not taken from a forgeable header");

{
  const rl = loadTs("src/lib/server/rate-limit.ts");
  const saved = process.env.TRUSTED_PROXY_HOPS;

  /* WITH NO TRUSTED PROXY, NOTHING IN THE REQUEST IS AN IDENTITY. */
  delete process.env.TRUSTED_PROXY_HOPS;

  const forged = rl.clientIdentity(H({ "x-forwarded-for": "9.9.9.9" }));
  check("an x-forwarded-for value is NOT trusted by default", forged.trusted === false);
  check("and does not become the key",
    forged.key !== "9.9.9.9", forged.key);

  /* THE TWO ATTACKS, BOTH CLOSED. Rotating the header must not produce fresh
   * buckets, and naming a victim must not reach the victim's bucket. */
  const rotated = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"].map(
    (ip) => rl.clientIdentity(H({ "x-forwarded-for": ip })).key,
  );
  check("rotating the header cannot mint a fresh bucket per request",
    new Set(rotated).size === 1, rotated.join(","));
  check("so a forged header cannot be aimed at a particular victim's budget",
    new Set(rotated).size === 1 && !rotated.includes("1.1.1.1"));
  check("an absent header behaves the same as a forged one",
    rl.clientIdentity(H({})).key === forged.key);
  check("the key is never empty", forged.key.length > 0);

  /* CONFIGURED TRUST, read from the END of the chain — where a trusted proxy's
   * own observation sits — never from the client-supplied front. */
  process.env.TRUSTED_PROXY_HOPS = "1";
  const oneHop = rl.clientIdentity(H({ "x-forwarded-for": "9.9.9.9, 10.0.0.7" }));
  check("with one trusted hop, the LAST entry is the identity",
    oneHop.trusted === true && oneHop.key === "10.0.0.7", oneHop.key);
  check("and the client-supplied front of the chain is ignored",
    oneHop.key !== "9.9.9.9");

  process.env.TRUSTED_PROXY_HOPS = "2";
  const twoHops = rl.clientIdentity(H({ "x-forwarded-for": "9.9.9.9, 10.0.0.7, 10.0.0.8" }));
  check("with two trusted hops, the identity moves one further back",
    twoHops.key === "10.0.0.7", twoHops.key);

  process.env.TRUSTED_PROXY_HOPS = "1";
  check("x-real-ip is preferred when a proxy sets it",
    rl.clientIdentity(H({ "x-real-ip": "10.1.2.3", "x-forwarded-for": "9.9.9.9" })).key === "10.1.2.3");

  for (const bad of ["-1", "abc", ""]) {
    process.env.TRUSTED_PROXY_HOPS = bad;
    check(`a nonsensical TRUSTED_PROXY_HOPS ("${bad}") falls back to trusting nothing`,
      rl.clientIdentity(H({ "x-forwarded-for": "9.9.9.9" })).trusted === false);
  }

  if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = saved;

  /* THE OLD BEHAVIOUR IS GONE FROM THE SOURCE. */
  const code = codeOnly("src/lib/server/rate-limit.ts");
  check("the first forwarded-for entry is no longer read as an identity",
    !/xff\.split\(","\)\[0\]/.test(code));

  /* A SETTING THAT DEFAULTS TO SAFE STILL HAS TO BE DISCOVERABLE, or the day
   * someone puts this behind a proxy the per-caller limits quietly stay coarse
   * and nobody knows there was a knob. */
  const example = src(".env.example");
  check("TRUSTED_PROXY_HOPS is documented in .env.example",
    example.includes("TRUSTED_PROXY_HOPS="));
  check("and ships empty, so the default is to trust nothing",
    /TRUSTED_PROXY_HOPS=\s*$/m.test(example));
}

/* ---------------------------------------------------------------- C ---- */
section("C. Keys are built from authoritative identities only");

{
  /* EVERY CALL SITE, AND WHAT IT KEYS ON. A limiter keyed on something the
   * caller can choose is not a limit; this walks the real call sites and refuses
   * any that interpolate request-controlled data. */
  const sites = [
    ["admin/earnings/record", "adminCtx.uid"],
    ["admin/fees/reconcile/[id]", "adminCtx.uid"],
    ["admin/transfer/creator", "adminContext.uid"],
    ["admin/withdrawals/[id]", "adminCtx.uid"],
    ["admin/withdrawals/reconcile", "adminCtx.uid"],
    ["admin/reconciliation/summary", "adminCtx.uid"],
    ["creator/withdraw", "firebaseUid"],
    ["interview/book", "gate.context.uid"],
    ["whop/connect", "auth.user.uid"],
    ["whop/kyc/start", "firebaseUid"],
    ["whop/payout/portal", "firebaseUid"],
    ["whop/payout/status", "firebaseUid"],
  ];

  for (const [route, identity] of sites) {
    const code = codeOnly(`src/app/api/${route}/route.ts`);
    const keys = [...code.matchAll(/checkRateLimit\(`([^`]+)`/g)].map((m) => m[1]);
    check(`${route} keys its limit on ${identity}`,
      /* A TRAILING TypeScript CAST IS STILL THE SAME IDENTITY — `interview/book`
       * writes `${gate.context.uid as string}` — so match the expression, not a
       * closing brace immediately after it. */
      keys.length > 0 && keys.some((k) => k.includes(`\${${identity}`)),
      keys.join(" | ") || "no key found");
    /* NOTHING REQUEST-DERIVED. `body.`, `searchParams`, `params` and payload
     * fields must never appear inside a limiter key. */
    check(`  and never from the request body, query or path`,
      keys.every((k) => !/body\.|searchParams|params\.|\breq\b/.test(k)),
      keys.join(" | "));
  }

  /* ACTION NAMESPACES MUST BE DISTINCT, or two unrelated routes share a budget. */
  const allKeys = [];
  for (const [route] of sites) {
    const code = codeOnly(`src/app/api/${route}/route.ts`);
    for (const m of code.matchAll(/checkRateLimit\(`([^`]+)`/g)) {
      allKeys.push(m[1].replace(/\$\{[^}]+\}/g, "*"));
    }
  }
  check("every route's action namespace is distinct",
    new Set(allKeys).size === allKeys.length,
    allKeys.join(" | "));
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — DB sections skipped");
    return;
  }

  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const [beforeCounters] = await client`select count(*)::int as n from public.rate_limit_counters`;
  const [beforeMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);

    const [{ schema }] = await client`select current_schema() as schema`;
    if (schema !== SCRATCH) throw new Error(`ISOLATION FAILED — DDL would run in ${schema}`);

    const journalFile = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    const tags = journalFile.entries.map((e) => e.tag);
    for (const tag of tags) {
      const sqlText = readFileSync(`drizzle/${tag}.sql`, "utf8");
      for (const stmt of sqlText
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
        .filter(Boolean)) {
        try {
          await client.unsafe(stmt);
        } catch (err) {
          throw new Error(`DDL FAILED in ${tag}: ${String(err?.message ?? err).slice(0, 200)}`);
        }
      }
    }
    check("the full migration chain applies into the throwaway schema", true, `${tags.length} migrations`);

    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('rate_limit_counters')) as counters`;
    if (where.schema !== SCRATCH || where.counters !== SCRATCH) {
      throw new Error(`ISOLATION FAILED — refusing to write: ${where.schema}/${where.counters}`);
    }
    check("ISOLATION PROVED: the counter table is in the throwaway schema", true, where.counters);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    const rl = loadTs("src/lib/server/rate-limit.ts");

    /* ------------------------------------------------------------ D ---- */
    section("D. The threshold");

    {
      const key = "test:threshold:alice";
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await rl.checkRateLimit(key, 3));

      check("requests below the threshold are allowed",
        results[0].ok && results[1].ok && results[2].ok,
        results.map((r) => r.ok).join(","));
      check("the request that exceeds it is refused",
        results[3].ok === false, String(results[3].ok));
      check("and every one after it stays refused", results[4].ok === false);
      check("remaining counts down and never goes negative",
        results.map((r) => r.remaining).join(",") === "2,1,0,0,0",
        results.map((r) => r.remaining).join(","));
      check("a refusal carries a usable retry-after",
        results[3].retryAfterSeconds >= 1 && results[3].retryAfterSeconds <= 3600,
        String(results[3].retryAfterSeconds));
    }

    /* ------------------------------------------------------------ E ---- */
    section("E. Buckets do not leak into each other");

    {
      /* DIFFERENT USERS. Alice exhausting her budget must not touch Bob. */
      for (let i = 0; i < 4; i++) await rl.checkRateLimit("test:isolation:alice", 3);
      const bob = await rl.checkRateLimit("test:isolation:bob", 3);
      check("one user exhausting a budget does not spend another's",
        bob.ok === true && bob.remaining === 2, JSON.stringify(bob));

      /* DIFFERENT ACTIONS. The same user in a different namespace is a different
       * budget, or a creator who read their balance could not withdraw. */
      for (let i = 0; i < 4; i++) await rl.checkRateLimit("test:action_a:carol", 3);
      const other = await rl.checkRateLimit("test:action_b:carol", 3);
      check("the same user in a different action namespace has a fresh budget",
        other.ok === true, JSON.stringify(other));

      /* ENVIRONMENT, where a key carries one. */
      for (let i = 0; i < 4; i++) await rl.checkRateLimit("test:env:sandbox:dave", 3);
      const prod = await rl.checkRateLimit("test:env:production:dave", 3);
      check("a key that carries an environment does not collide across them",
        prod.ok === true, JSON.stringify(prod));
    }

    /* ------------------------------------------------------------ F ---- */
    section("F. Concurrency cannot bypass the counter");

    {
      /* THE ATOMIC INCREMENT IS THE WHOLE POINT. Twenty simultaneous requests
       * against a limit of five must yield exactly five allowances — a
       * read-then-write limiter would let most of them through. */
      const key = "test:concurrent:eve";
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => rl.checkRateLimit(key, 5)),
      );
      const allowed = outcomes.filter((o) => o.ok).length;
      check("twenty concurrent requests against a limit of five allow exactly five",
        allowed === 5, `${allowed} allowed`);
      check("and the stored counter saw all twenty",
        BigInt((await scoped.unsafe(
          `select count from ${SCRATCH}.rate_limit_counters where key = $1`, [key]))[0].count) === 20n,
        (await scoped.unsafe(
          `select count from ${SCRATCH}.rate_limit_counters where key = $1`, [key]))[0].count);
    }

    /* ------------------------------------------------------------ G ---- */
    section("G. Windows reset, and only the current one counts");

    {
      /* A PREVIOUS WINDOW'S EXHAUSTED COUNTER MUST NOT BLOCK THIS ONE. Written
       * directly at the previous window key, which is what the passage of an hour
       * produces. */
      const key = "test:window:frank";
      const current = Math.floor(Date.now() / 3_600_000);
      await scoped.unsafe(
        `insert into ${SCRATCH}.rate_limit_counters (key, window_key, count)
         values ($1, $2, 9999)`, [key, String(current - 1)]);

      const now = await rl.checkRateLimit(key, 3);
      check("an exhausted PREVIOUS window does not block the current one",
        now.ok === true && now.remaining === 2, JSON.stringify(now));
      check("and the old row is left alone rather than mutated",
        (await scoped.unsafe(
          `select count from ${SCRATCH}.rate_limit_counters where key = $1 and window_key = $2`,
          [key, String(current - 1)]))[0].count === 9999);
    }

    /* ------------------------------------------------------------ H ---- */
    section("H. Malformed keys cannot collapse unrelated callers");

    {
      /* AN EMPTY KEY WOULD BE A SHARED BUCKET. If two callers whose identity
       * resolution failed both keyed on "", they would exhaust each other. */
      const a = await rl.checkRateLimit("", 100);
      const b = await rl.checkRateLimit("   ", 100);
      check("an empty key is redirected to an obviously-wrong bucket",
        a.ok === true && b.ok === true);
      const [row] = await scoped.unsafe(
        `select key, count from ${SCRATCH}.rate_limit_counters where key = '__malformed_key__'`);
      check("which is named so it stands out in the table",
        row?.key === "__malformed_key__" && row?.count === 2, JSON.stringify(row));
      check("and no row was ever stored under a blank key",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.rate_limit_counters where trim(key) = ''`))[0].n === 0);
    }

    /* ------------------------------------------------------------ I ---- */
    section("I. A limiter outage does not lock anyone out");

    {
      const saved = DB;
      DB = null;
      const out = await rl.checkRateLimit("test:outage:grace", 1);
      check("with no database the limiter opens rather than locking out",
        out.ok === true, JSON.stringify(out));
      check("and still reports a usable retry-after",
        out.retryAfterSeconds >= 1);
      DB = saved;
      /* FAIL-OPEN IS SAFE HERE because every money route needs this same
       * database to read a balance or write a row — the outage has already
       * closed what the limiter would have. */
      check("the limiter resumes counting once the database returns",
        (await rl.checkRateLimit("test:outage:grace", 1)).ok === true);
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    section("J. the real database is untouched");
    const [afterCounters] = await client`select count(*)::int as n from public.rate_limit_counters`;
    const [afterMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("this suite wrote no counter to the real table",
      afterCounters.n === beforeCounters.n, `${beforeCounters.n} -> ${afterCounters.n}`);
    check("nor applied any migration",
      afterMigrations.n === beforeMigrations.n, `${afterMigrations.n} migrations`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) =>
  check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

/* ---------------------------------------------------------------- K ---- */
section("K. Ordering on financial routes, and the 429 contract");

{
  /* THE LIMITER MUST RUN BEFORE ANYTHING IRREVERSIBLE. A refused request must
   * reach no provider, post no accounting, and write no audit row. */
  const ordered = [
    ["creator/withdraw", ["requestWithdrawal", "executeWithdrawal"]],
    ["admin/transfer/creator", ["initiateCreatorTransfer", "writeAudit"]],
    ["admin/earnings/record", ["recordCreatorEarning", "writeAudit"]],
    ["admin/fees/reconcile/[id]", ["reconcileProviderFees", "writeAudit"]],
    ["admin/withdrawals/reconcile", ["sweepPendingWithdrawals", "writeAudit"]],
    ["admin/reconciliation/summary", ["reconcileFeeDrift"]],
    ["checkout/sandbox", ["createWhopCheckoutForOrder"]],
  ];

  for (const [route, afters] of ordered) {
    const code = bodyOnly(`src/app/api/${route}/route.ts`);
    const limitAt = code.indexOf("checkRateLimit");
    check(`${route} calls the limiter`, limitAt >= 0);
    for (const after of afters) {
      const at = code.indexOf(after);
      if (at < 0) continue;
      check(`  and does so BEFORE ${after}`, limitAt < at, `${limitAt} < ${at}`);
    }
  }

  /* EVERY LIMITED ROUTE ANSWERS WITH THE SHARED 429 HELPER, so none of them can
   * quietly answer 200 with an error body. */
  const limited = [
    "admin/earnings/record", "admin/fees/reconcile/[id]", "admin/transfer/creator",
    "admin/withdrawals/[id]", "admin/withdrawals/reconcile", "admin/reconciliation/summary",
    "admin/session", "auth/session", "creator/withdraw", "interview/book",
    "whop/connect", "whop/kyc/start", "whop/payout/portal", "whop/payout/status",
    "checkout/sandbox",
  ];
  /* THE REFUSAL MUST BE CONDITIONAL ON THE LIMITER'S ANSWER.
   *
   * Asserting only that `rateLimitResponse` APPEARS in the file proved too
   * little: disabling the guard — `if (false) return rateLimitResponse(…)` —
   * leaves the mention untouched and the route unlimited, and a mutation run
   * showed exactly that surviving. So the guard itself is the assertion: the
   * refusal is reached when, and only when, the limiter said no. */
  for (const route of limited) {
    const code = bodyOnly(`src/app/api/${route}/route.ts`);
    const guards = [...code.matchAll(
      /if \(!(\w+)\.ok\)\s*return rateLimitResponse\((?:\1\.retryAfterSeconds)?\)/g)];
    check(`${route} refuses only when the limiter refuses`,
      guards.length > 0, `${guards.length} guard(s)`);
    /* AND THE GUARDED VARIABLE IS THE ONE THE LIMITER RETURNED, not a stale or
     * unrelated result — so the count matches the number of limiter calls. */
    const calls = (code.match(/await checkRateLimit\(/g) ?? []).length;
    check(`  and every checkRateLimit call it makes is acted on`,
      guards.length === calls, `${guards.length} guards / ${calls} calls`);
  }
  check("no route answers a rate limit with a plain object any more",
    !limited.some((r) => /return \{ error: "rate_limited" \}/.test(codeOnly(`src/app/api/${r}/route.ts`))));

  /* THE WRAPPER PASSTHROUGH TASK #18 FIXED MUST NOT REGRESS, or every admin 429
   * silently becomes a 200. */
  const guard = codeOnly("src/lib/server/admin-guard.ts");
  check("withAdminApi still passes a Response through untouched",
    /if \(body instanceof Response\) return body;/.test(guard));
  check("and still serialises a plain object as before",
    /return Response\.json\(body, \{ headers: \{ "cache-control": "no-store" \} \}\);/.test(guard));
}

/* ---------------------------------------------------------------- L ---- */
section("L. Webhook ingress is not user-rate-limited");

{
  const hook = codeOnly("src/lib/server/whop-webhooks.ts");
  const route = codeOnly("src/app/api/webhooks/whop/route.ts");

  /* A PROVIDER RETRY MUST NOT BE DROPPED. Whop retries deliveries, and a normal
   * per-caller limit would refuse legitimate retries and lose economic events. */
  check("the webhook route applies no per-caller rate limit",
    !/checkRateLimit/.test(route) && !/checkRateLimit/.test(hook));
  check("it verifies the signature rather than trusting the caller",
    /verif/i.test(route) || /verif/i.test(hook));
  check("and it has no origin check, which would break provider delivery",
    !/checkRequestOrigin/.test(route));
  /* IDEMPOTENCY, not rate limiting, is what bounds repeated deliveries. */
  check("duplicate deliveries are bounded by a receipt instead",
    /whopWebhookReceipts/.test(hook));
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
