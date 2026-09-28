#!/usr/bin/env node
/**
 * TASK #30 — TEST-INFRASTRUCTURE GUARD.
 *
 * This suite tests the other suites. It exists because of a real incident, and
 * because that incident was the second occurrence of the same underlying hazard.
 *
 * THE HAZARD. `search_path` is SESSION state. A `postgres()` client with `max > 1`
 * opens several connections, and `SET search_path = scratch` binds to whichever
 * one executed it — every other connection in the pool still resolves `public`.
 * A suite that believes it is writing to a throwaway schema then writes some of
 * its rows into the real database, and which rows depends on connection
 * scheduling, so it is intermittent and invisible.
 *
 * IT HAS HAPPENED TWICE.
 *
 *   1. `payment-lifecycle-test` once issued `SET search_path` against the POOLED
 *      endpoint. PgBouncer hands that server connection to whoever comes next, so
 *      the setting leaked out of the test and into the application — real
 *      `payment_orders` lookups stopped resolving until the backends were reset by
 *      hand. That suite now uses the direct endpoint and keeps a read-only
 *      regression guard proving the pooled endpoint is unaffected.
 *
 *   2. `production-payout-e2e-test` (Task #29) raised its scoped client to
 *      `max: 4` to drive genuinely simultaneous requests, kept the `SET
 *      search_path`, and wrote a synthetic `revenue_split` into the real ledger.
 *      Accounting is append-only, so it could not be deleted; it had to be
 *      corrected by a compensating reversal.
 *
 * FOUR SAFE STRATEGIES, and a suite must use one of them:
 *
 *   A. `max: 1` plus `SET search_path` — one connection, so the setting cannot be
 *      missed. This is what most suites do.
 *   B. A pool plus `connection: { options: "-c search_path=…" }` — a libpq STARTUP
 *      parameter applies to every connection the pool opens. Note that the bare
 *      `connection: { search_path }` key is SILENTLY IGNORED by postgres.js; only
 *      the `options` form works, which is why it is matched specifically.
 *   C. A pool with every identifier SCHEMA-QUALIFIED and no `search_path` at all.
 *      Immune to pooling by construction, and arguably the strongest.
 *   D. Deliberately operating on `public` — a read-only inventory, or a suite that
 *      restores exactly what it touched. These are listed explicitly below so the
 *      set cannot grow silently.
 *
 * WHAT THIS GUARD REFUSES:
 *   - a scratch-schema suite with a pool and no per-connection isolation;
 *   - `SET search_path` issued against the POOLED endpoint (incident 1);
 *   - a scratch-schema suite that never drops its schema;
 *   - the ignored `connection: { search_path }` spelling, anywhere.
 *
 * Read-only. No database, no network.
 */

import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

/** Never read, never judged, never touched. */
const PROTECTED = new Set(["admin-shots.mjs", "env-uniqueness-audit.mjs"]);

/**
 * Scripts that work against `public` on purpose.
 *
 * Each is here with a reason, so adding one is a decision rather than a drift.
 * A script in this list must not create a scratch schema — if it does, it is
 * trying to be both things and the classification below will say so.
 */
const PUBLIC_BY_DESIGN = new Map([
  ["db-status.mjs", "read-only status report"],
  ["whop-checkout-test.mjs", "read-only assertions about real rows"],
  ["whop-concurrency-test.mjs", "read-only; exercises pooled concurrency against real reads"],
  ["whop-oauth-test.mjs", "read-only assertions about real rows"],
  ["whop-resources-test.mjs", "read-only assertions about real rows"],
  ["whop-retry-test.mjs", "drives the real receipt table and restores what it touched"],
  ["whop-webhook-test.mjs", "read-only assertions about real receipts"],
  ["production-webhook-test.mjs", "read-only receipt inventory, counted before and after"],
  ["accounting-backfill.mjs", "an operator tool, not a test"],
  ["grant-admin.mjs", "an operator tool, not a test"],
]);

const files = readdirSync("scripts").filter((f) => f.endsWith(".mjs")).sort();
const dbBacked = [];

/** This file. Excluded, or the guard reports its own detection patterns. */
const SELF = "test-infra-guard.mjs";

for (const f of files) {
  if (PROTECTED.has(f) || f === SELF) continue;
  const raw = readFileSync(`scripts/${f}`, "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/require\("postgres"\)|from "postgres"/.test(code)) continue;

  /* EACH `postgres(` CALL, read as a bounded window rather than a greedy match.
   *
   * A `[^;]*?\{([^}]*)\}` pattern spans statements and swallows unrelated braces,
   * and `/^postgres(ql)?:\/\//` inside an unrelated regex literal looks like a
   * call. So: require an assignment before the call, and read a fixed window
   * after it for the options that matter. */
  const clients = [];
  for (const m of code.matchAll(/(?:=|return)\s*postgres\(/g)) {
    const at = m.index ?? 0;
    const window = code.slice(at, at + 400);
    const max = /max:\s*(\d+)/.exec(window);
    const firstArg = /postgres\(([^,)]*)/.exec(window)?.[1] ?? "";
    clients.push({
      arg: firstArg.replace(/\s+/g, " ").trim().slice(0, 50),
      max: max ? Number(max[1]) : 10,
      startupSearchPath: /options:\s*[`'"][^`'"]*search_path/.test(window),
      bareSearchPathKey:
        /connection:\s*\{[^}]*\bsearch_path\s*:/.test(window) && !/options:/.test(window),
    });
  }

  dbBacked.push({
    file: f,
    code,
    clients,
    setsSearchPath: /set search_path/i.test(code),
    createsSchema: /create schema/i.test(code),
    dropsSchema: /drop schema/i.test(code),
    schemaQualified: /\$\{SCRATCH\}\./.test(code),
    probeAborts: /throw new Error\([^)]*ISOLATION FAILED/.test(code),
  });
}

section(`A. ${dbBacked.length} database-backed scripts discovered`);
check("scripts were discovered at all", dbBacked.length >= 15, `${dbBacked.length} found`);
check("both protected scripts were skipped without being read",
  files.filter((f) => PROTECTED.has(f)).length === 2 &&
    !dbBacked.some((r) => PROTECTED.has(r.file)));

section("B. Every database-backed script is classified");
{
  const unclassified = [];
  for (const r of dbBacked) {
    r.strategy =
      PUBLIC_BY_DESIGN.has(r.file) ? "public-by-design"
      : !r.createsSchema ? "UNCLASSIFIED"
      : r.clients.some((c) => c.startupSearchPath) ? "pool + startup search_path"
      : r.setsSearchPath ? "SET search_path"
      : r.schemaQualified ? "schema-qualified, no search_path"
      : "UNCLASSIFIED";
    if (r.strategy === "UNCLASSIFIED") unclassified.push(r.file);
    const maxes = r.clients.map((c) => c.max).join("/");
    console.log(`  ${r.file.padEnd(38)} max=${(maxes || "-").padEnd(8)} ${r.strategy}`);
  }
  check("no script is unclassified", unclassified.length === 0, unclassified.join(", "));
}

section("C. THE HAZARD: a pool must never rely on a statement-scoped search_path");
{
  const offenders = [];
  for (const r of dbBacked) {
    if (!r.createsSchema || !r.setsSearchPath) continue;
    /* The clients that do the scratch work. A pooled client used ONLY for a
     * read-only check is not the hazard — `payment-lifecycle-test` keeps one on
     * purpose, to prove the leak it once caused stays fixed. */
    for (const c of r.clients) {
      if (c.max > 1 && !c.startupSearchPath) {
        offenders.push({ file: r.file, max: c.max, arg: c.arg });
      }
    }
  }
  /* KNOWN-SAFE POOLED CLIENTS, keyed `file|max`, each justified individually so
   * the rule is never weakened wholesale. And the justification is CHECKED, not
   * taken on trust: the claim is that this pool only reads, so the guard verifies
   * the suite issues no insert/update/delete through it. */
  const ALLOWED = new Map([
    ["payment-lifecycle-test.mjs|4",
      "read-only regression guard: proves the POOLED endpoint still resolves public"],
  ]);
  const real = offenders.filter((o) => !ALLOWED.has(`${o.file}|${o.max}`));
  check("no scratch-schema suite pools connections without per-connection isolation",
    real.length === 0, real.map((o) => `${o.file} max=${o.max}`).join(" | "));

  for (const [key, why] of ALLOWED) {
    const [file] = key.split("|");
    const r = dbBacked.find((x) => x.file === file);
    console.log(`  allowed: ${key} — ${why}`);
    if (!r) { check(`  ${file} still exists`, false); continue; }
    /* THE CLAIM, VERIFIED. The allowance rests on that client being read-only, so
     * if a write ever appears through a pooled client in this suite the allowance
     * must stop applying. `pooled` is the variable name it uses. */
    check(`  ${file}'s pooled client performs no write`,
      !/pooled(?:`|\.unsafe\()[^;]{0,200}(insert|update|delete)\s/i.test(r.code),
      "the allowance depends on it being read-only");
  }
}

section("D. SET search_path is never issued against the pooled endpoint");
{
  /* INCIDENT 1. `SET search_path` on a PgBouncer connection outlives the client:
   * the backend is handed to whoever comes next, so the setting leaks into the
   * application. Every suite that sets a path must do it on a DIRECT endpoint. */
  const offenders = [];
  for (const r of dbBacked) {
    if (!r.setsSearchPath) continue;
    const usesDirect = /hostname\.replace\("-pooler", ""\)/.test(r.code);
    if (!usesDirect) offenders.push(r.file);
  }
  check("every suite that sets a search_path first strips -pooler from the host",
    offenders.length === 0, offenders.join(", "));
}

section("E. The silently-ignored spelling is used nowhere");
{
  /* `connection: { search_path: … }` looks right and does nothing — postgres.js
   * ignores unknown connection keys, so every connection stays on `public` while
   * the code reads as though it were isolated. Verified empirically in Task #29.
   * Only `connection: { options: "-c search_path=…" }` works. */
  const offenders = [];
  for (const r of dbBacked) {
    for (const c of r.clients) if (c.bareSearchPathKey) offenders.push(r.file);
  }
  check("no script uses connection.search_path, which postgres.js ignores",
    offenders.length === 0, offenders.join(", "));
  const anyStartup = dbBacked.filter((r) => r.clients.some((c) => c.startupSearchPath));
  for (const r of anyStartup) {
    check(`  ${r.file} uses the options form that actually works`,
      /options:\s*`-c search_path=/.test(r.code));
  }
}

section("F. Scratch schemas are always dropped");
{
  const leaks = dbBacked.filter((r) => r.createsSchema && !r.dropsSchema);
  check("every suite that creates a schema also drops it", leaks.length === 0, leaks.map((r) => r.file).join(", "));

  /* THE DROP MUST BE IN THE `finally`, and that is not the same as "a drop exists
   * somewhere". Most suites open with `drop schema if exists … cascade` to clear a
   * previous run, so a bare search for `drop schema` stays satisfied even after the
   * cleanup is deleted — a mutation run proved exactly that. A schema left behind
   * on failure is a real cost: the next run's `create schema` fails, and the stale
   * tables sit in the database holding synthetic financial rows. */
  const noCleanup = dbBacked.filter((r) => {
    if (!r.createsSchema) return false;
    /* ANY finally block, not the last one. A suite may have several —
     * `payment-lifecycle-test` closes a second, read-only client in a later
     * `finally`, and keying on `lastIndexOf` looked past the real cleanup and
     * reported a false positive. */
    const blocks = [...r.code.matchAll(/finally\s*\{/g)].map((m) => m.index ?? 0);
    if (blocks.length === 0) return true;
    return !blocks.some((at) => /drop schema/i.test(r.code.slice(at, at + 800)));
  });
  check("and drops it from inside the finally, so a failure still cleans up",
    noCleanup.length === 0, noCleanup.map((r) => r.file).join(", "));
}

section("F2. Suites that create tables in public sweep their own leftovers");
{
  /* `finally` IS NOT A GUARANTEE. Two suites create a uniquely-named probe table
   * in `public` — they test real Postgres behaviour a throwaway schema would not
   * change — and drop it in a `finally`. A timeout, Ctrl-C or OOM kill skips that,
   * and Task #30 found EIGHT such tables left in the real database from earlier
   * runs, each holding a row of synthetic data. Harmless one at a time; the set
   * only grows, and litter in a production-bound database eventually gets mistaken
   * for real state.
   *
   * So a suite that creates a public table must also sweep its own prefix on the
   * way IN, which makes the mess self-healing and needs no manual DB surgery. */
  const creators = dbBacked.filter((r) =>
    /create table \$\{TABLE\}|create table \$\{PROBE/.test(r.code) ||
    /const TABLE = `\w+_probe_/.test(r.code));
  check("the public-table-creating suites were found", creators.length >= 2,
    creators.map((r) => r.file).join(", "));
  for (const r of creators) {
    check(`${r.file} sweeps leftover probe tables before creating one`,
      /sweepProbeTables\(/.test(r.code), "a killed predecessor would otherwise leak a table");
    check(`  and still drops its own table in a finally`,
      [...r.code.matchAll(/finally\s*\{/g)].some((m) =>
        /drop table/i.test(r.code.slice(m.index ?? 0, (m.index ?? 0) + 400))));
  }
  /* THE SWEEPER ITSELF MUST NOT BE ABLE TO REACH AN APPLICATION TABLE. */
  const sweeper = "scripts/lib/probe-sweep.mjs";
  const sweepCode = readFileSync(sweeper, "utf8");
  check("the sweeper only drops approved probe prefixes",
    /ALLOWED_PREFIXES/.test(sweepCode) &&
      /refusing to sweep an unapproved prefix/.test(sweepCode));
  check("and re-checks the name before interpolating it into a DROP",
    /name\.startsWith\(prefix\)/.test(sweepCode) && /\^\[a-z0-9_\]\+\$/.test(sweepCode));
  check("it never drops anything without a prefix match",
    !/drop table if exists public\."\$\{name\}"/.test(
      sweepCode.slice(0, sweepCode.indexOf("name.startsWith(prefix)"))));
}

section("G. Suites that write to a scratch schema prove isolation before writing");
{
  /* A PROBE THAT DOES NOT ABORT IS DECORATION. The Task #29 failure was caught by
   * a probe that threw before any write — which is the behaviour that matters. */
  const writers = dbBacked.filter((r) => r.createsSchema && !PUBLIC_BY_DESIGN.has(r.file));
  const pooledWriters = writers.filter((r) =>
    r.clients.some((c) => c.max > 1 && c.startupSearchPath));
  for (const r of pooledWriters) {
    check(`${r.file} aborts before writing if the probe fails`, r.probeAborts);
    check(`  and probes more than one backend`,
      /Promise\.all\(Array\.from\(\{ length: \d+ \}/.test(r.code) ||
      /pg_backend_pid/.test(r.code),
      "a single probe would pass under the very bug it guards");
  }
  check("at least one pooled writer exists to be checked", pooledWriters.length >= 1,
    `${pooledWriters.length}`);
}

section("H. The public-by-design list is honest");
{
  for (const [f, why] of PUBLIC_BY_DESIGN) {
    const r = dbBacked.find((x) => x.file === f);
    if (!r) { console.log(`  note ${f} is listed but not database-backed (or absent)`); continue; }
    check(`${f} does not also create a scratch schema`, !r.createsSchema, why);
  }
  const unlisted = dbBacked.filter((r) => !r.createsSchema && !PUBLIC_BY_DESIGN.has(r.file));
  check("no unlisted script touches public without a scratch schema",
    unlisted.length === 0, unlisted.map((r) => r.file).join(", "));
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
