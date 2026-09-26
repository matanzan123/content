#!/usr/bin/env node
/**
 * TASK #18 — PROVIDER FEE RECONCILIATION.
 *
 * Provider fees are posted from `listFees` at settlement. Sometimes Whop has
 * not reported them yet, or revises them afterwards, and the journal drifts
 * from the provider's own books. `reconcileProviderFees` posts the difference.
 *
 * THE BUG THIS SUITE EXISTS FOR. The correction was keyed on the payment id
 * alone, so exactly ONE correction could ever be posted for a payment — while
 * the module's own contract promised that calling again after a later fee
 * change would post the remaining delta. A second genuine divergence was
 * refused by the unique economic key and became unbookable.
 *
 * WHY THIS SUITE IS DB-BACKED. The idempotency it tests IS the unique index on
 * `accounting_transactions.idempotency_key`. A fake cannot prove a key
 * collides; only Postgres can. So the real journal runs against a real
 * database, inside a throwaway schema, with only the Whop client faked.
 *
 * NO NETWORK. NO MONEY MOVES. NOTHING IS WRITTEN TO public — every table the
 * modules name resolves to the throwaway schema, and that is verified before a
 * single fixture is written.
 *
 * Sections:
 *   A. The key's shape
 *   B. Settlement, then a later fee change
 *   C. Replay converges
 *   D. A SECOND divergence posts
 *   E. Convergence on provider truth, and balance
 *   F. Environment isolation
 *   G. Minor-unit arithmetic only
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

/**
 * `JSON.stringify` for detail strings, minus the bigint landmine.
 *
 * Results here carry bigint amounts, and a raw `JSON.stringify` on one THROWS.
 * That matters in a failure detail: the throw would abort the suite with
 * "Do not know how to serialize a BigInt" instead of printing the assertion
 * that actually failed — a red run that says nothing about why.
 */
const show = (v) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

const SCRATCH = "provider_fee_selftest";

/* =========================================================================
   Module loader. Only two seams: the database and the Whop client.
   ========================================================================= */

const cache = new Map();
let DB = null;
let FAKE_WHOP = null;
let ENVIRONMENT = "sandbox";
/** The admin the faked guard admits, or null for an unauthenticated caller. */
let ADMIN = { uid: "admin_fee_test", email: "admin@example.test", name: null, authTime: 0 };
let ORIGIN_OK = true;
/* Seams for the REAL admin guard, exercised in Section M. */
let SESSION_COOKIE = "session-cookie";
let SESSION_CLAIMS = { uid: "admin_fee_test", admin: true, email: "admin@example.test", auth_time: 1 };
let FIREBASE_UP = true;

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
    /* The two things the REAL admin guard reaches for, so Section M can test
     * the real wrapper instead of a copy of it. Neither exists in a plain node
     * process: `next/headers` needs a Next request scope, and the Firebase
     * Admin SDK needs credentials. */
    if (spec === "next/headers") {
      return { cookies: async () => ({ get: () => (SESSION_COOKIE ? { value: SESSION_COOKIE } : undefined) }) };
    }
    if (spec === "./firebase-admin" || spec.endsWith("/firebase-admin")) {
      return {
        getAdminAuth: () => (FIREBASE_UP
          ? { verifySessionCookie: async () => SESSION_CLAIMS }
          : null),
      };
    }
    // The REAL schema and a REAL db: the unique index is the thing under test.
    if (spec === "@/lib/db") {
      return {
        getDb: () => DB,
        isDatabaseConfigured: () => DB !== null,
        schema: loadTs("src/lib/db/schema.ts"),
      };
    }
    if (spec === "@whop/sdk") {
      return {
        WhopError: class WhopError extends Error {
          constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
        },
        WhopClient: class WhopClient {},
      };
    }
    if (spec === "../whop-payments" || spec.endsWith("/whop-payments")) {
      const real = loadTs("src/lib/server/whop-payments.ts");
      return {
        ...real,
        getWhopPaymentsClient: () => FAKE_WHOP,
        getWhopEnvironment: () => ENVIRONMENT,
      };
    }
    /*
     * THE ADMIN GUARD, FAKED — and faked to the REAL wrapper's semantics.
     *
     * The real one reads a Firebase session cookie through `next/headers`,
     * neither of which exists in a plain node process. What matters for a route
     * test is that the handler's return value is wrapped exactly as production
     * wraps it: a `Response` passed straight through, anything else serialised
     * as JSON with status 200 and no-store, and a terse 401/403 when the caller
     * is not an admin. Anything else and the test would be asserting against a
     * response shape the app never produces.
     *
     * THE PASS-THROUGH IS THE POINT, and it is mirrored here deliberately: the
     * wrapper used to hand a handler's `Response` to `Response.json`, turning a
     * 429 into a 200 carrying `{}`. Section M asserts the real wrapper's
     * behaviour directly, so this fake cannot be the only thing that knows.
     */
    if (spec === "@/lib/server/admin-guard") {
      return {
        withAdminApi: async (handler) => {
          if (!ADMIN) {
            return Response.json({ error: "unauthorized" }, {
              status: 401, headers: { "cache-control": "no-store" },
            });
          }
          const body = await handler(ADMIN);
          if (body instanceof Response) return body;
          return Response.json(body, { headers: { "cache-control": "no-store" } });
        },
      };
    }
    // The CSRF check is a toggle here; what it guards is asserted, not its own
    // internals, which have their own coverage.
    if (spec === "@/lib/server/request-origin") {
      return { checkRequestOrigin: () => ({ ok: ORIGIN_OK }) };
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

/**
 * A Whop client whose fee lines this suite dictates.
 *
 * `settlement_amount` is a `Whop.Money`, and the module checks
 * `raw.decimals` against the currency before trusting the amount — so a fake
 * that omitted `decimals` was rejected as `amount_unreadable`, which proved
 * nothing about the code under test. Shaped to the SDK type exactly: an exact
 * decimal STRING in major units, the ISO code lowercase, and the precision the
 * charge runs at.
 */
const fakeWhop = (lines) => ({
  payments: {
    listFees: async () => ({
      data: lines.map((l) => ({
        origin: l.origin,
        label: l.origin,
        type: "processing_fee",
        settlement_amount: {
          amount: l.amount,
          currency: "usd",
          decimals: 2,
          display_decimals: 2,
        },
      })),
    }),
  },
});

/* ---------------------------------------------------------------- A ---- */
section("A. The key's shape");

{
  const src = readFileSync("src/lib/server/accounting/whop-fee-reconciliation.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  check(
    "the correction key carries a discriminator, not the payment id alone",
    /economicKey\(\s*"whop",\s*"provider_fee_reconciled",\s*`\$\{paymentId\}:\$\{corrections\}`,?\s*\)/.test(code),
  );
  check(
    "and the old payment-only key is gone",
    !/economicKey\("whop", "provider_fee_reconciled", paymentId\)/.test(code),
  );
  check(
    "the discriminator is a COUNT of prior corrections, which only increases",
    /async function reconciliationCount/.test(code) &&
      /count\(\*\)::int/.test(code) &&
      /eq\(accountingTransactions\.economicEvent, "provider_fee_reconciled"\)/.test(code),
  );
  check(
    "the count is environment-scoped, like the posted total it pairs with",
    /reconciliationCount[\s\S]{0,900}eq\(accountingTransactions\.environment, environment\)/.test(code),
  );
  check(
    "no webhook delivery id is used as a discriminator",
    !/sourceWebhookId|webhookId/.test(code),
  );
  check(
    "the reasoning against a value-based discriminator is recorded",
    /WHY NOT THE PREVIOUS POSTED TOTAL/.test(src),
  );
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — DB sections skipped");
    return;
  }

  /*
   * THE DIRECT ENDPOINT, not the pooled one. `search_path` is SESSION state,
   * and Neon's pooler is PgBouncer in transaction mode: a SET can be issued on
   * one backend and the next statement served by another, so the setting
   * silently lapses back to `public` mid-run. `max: 1` keeps one backend.
   */
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  // Baselines on the REAL tables, captured before anything runs.
  const [beforeTxns] = await client`select count(*)::int as n from public.accounting_transactions`;
  const [beforeEntries] = await client`select count(*)::int as n from public.accounting_entries`;
  const [beforeMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);

    const [{ schema }] = await client`select current_schema() as schema`;
    if (schema !== SCRATCH) throw new Error(`ISOLATION FAILED — DDL would run in ${schema}`);

    /*
     * THE WHOLE MIGRATION CHAIN, IN JOURNAL ORDER, plus any migration that is
     * written but not yet journalled. Naming migrations individually is how
     * four other suites fell behind the schema; nothing here names one.
     */
    const journalFile = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    const journalledTags = journalFile.entries.map((e) => e.tag);
    const PENDING = ["0014_refund_absorbed_cost"];
    const tags = [...journalledTags, ...PENDING.filter((t) => !journalledTags.includes(t))];

    for (const tag of tags) {
      const sql = readFileSync(`drizzle/${tag}.sql`, "utf8");
      for (const stmt of sql
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

    /*
     * THE ISOLATION SEAM, PROVED BEFORE ANY FIXTURE IS WRITTEN. The modules
     * name their tables unqualified, so which schema they hit is decided
     * entirely by `search_path`. Resolve the very names they will use and
     * refuse to continue unless every one landed in the throwaway schema.
     */
    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('accounting_transactions')) as txns,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('accounting_entries')) as entries`;

    const isolated =
      where.schema === SCRATCH && where.txns === SCRATCH && where.entries === SCRATCH;
    if (!isolated) {
      throw new Error(
        `ISOLATION FAILED — refusing to write: schema=${where.schema} txns=${where.txns} entries=${where.entries}`,
      );
    }
    check("ISOLATION PROVED: every table the modules name is in the throwaway schema",
      isolated, `${where.txns}/${where.entries}`);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    const journal = loadTs("src/lib/server/accounting/journal.ts");
    const fees = loadTs("src/lib/server/accounting/whop-fee-reconciliation.ts");

    /** Net provider_fee_expense for one payment, straight from SQL. */
    const feeTotal = async (paymentId) => {
      const [r] = await scoped.unsafe(
        `select coalesce(sum(e.amount_minor),0)::text as s
           from ${SCRATCH}.accounting_entries e
           join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
          where e.account = 'provider_fee_expense'
            and (t.provider_resource_id = '${paymentId}'
                 or t.metadata->>'payment_id' = '${paymentId}')`,
      );
      return BigInt(r.s);
    };

    const correctionCount = async (paymentId) => {
      const [r] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
          where economic_event = 'provider_fee_reconciled'
            and (provider_resource_id = '${paymentId}'
                 or metadata->>'payment_id' = '${paymentId}')`,
      );
      return r.n;
    };

    /** A settlement posting: 1000 gross, `fee` of provider fees. */
    const settle = async (paymentId, fee) => {
      const r = await journal.postTransaction({
        economicEvent: "payment_settled",
        provider: "whop",
        providerResourceId: paymentId,
        environment: ENVIRONMENT,
        currency: "usd",
        idempotencyKey: `whop:payment_settled:${paymentId}`,
        description: `settlement ${paymentId}`,
        legs: [
          { account: "provider_balance", amountMinor: BigInt(1000) - fee,
            counterpartyType: "provider", counterpartyId: "whop" },
          { account: "provider_fee_expense", amountMinor: fee,
            counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_fee" },
          { account: "unallocated_customer_funds", amountMinor: BigInt(-1000),
            counterpartyType: "customer" },
        ].filter((l) => l.amountMinor !== BigInt(0)),
      });
      if (!r.ok) throw new Error(`settlement failed: ${r.reason} ${r.detail ?? ""}`);
    };

    /* ------------------------------------------------------------ B ---- */
    section("B. Settlement, then a later fee change");

    const PAY = "pay_fee_seq";
    await settle(PAY, BigInt(87));
    check("settlement posted the provider fees Whop reported at the time",
      (await feeTotal(PAY)) === BigInt(87), `${await feeTotal(PAY)}`);
    check("and no correction exists yet", (await correctionCount(PAY)) === 0);

    // Whop now reports MORE fee than settlement recorded.
    FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }, { origin: "fx_fee", amount: "0.13" }]);
    const first = await fees.reconcileProviderFees(PAY);
    check("the first reconciliation posts exactly the delta",
      first.ok === true && first.posted === true && first.deltaMinor === BigInt(13),
      first.ok ? `delta=${first.deltaMinor}` : `reason=${first.reason}`);
    check("and the ledger now holds the provider's total",
      (await feeTotal(PAY)) === BigInt(100), `${await feeTotal(PAY)}`);
    check("recorded as correction #0", (await correctionCount(PAY)) === 1);

    /* ------------------------------------------------------------ C ---- */
    section("C. Replay converges");

    const replay = await fees.reconcileProviderFees(PAY);
    check("replaying with unchanged provider fees posts nothing",
      replay.ok === true && replay.posted === false && replay.deltaMinor === BigInt(0),
      replay.ok ? `delta=${replay.deltaMinor} posted=${replay.posted}` : `reason=${replay.reason}`);
    check("the fee total is unchanged by the replay",
      (await feeTotal(PAY)) === BigInt(100));
    check("and no second correction was written",
      (await correctionCount(PAY)) === 1, `${await correctionCount(PAY)}`);

    /* ------------------------------------------------------------ D ---- */
    section("D. A SECOND divergence posts");

    // Whop revises fees UP again. Under the old payment-only key this delta was
    // refused as `already_reconciled` and could never be booked.
    FAKE_WHOP = fakeWhop([
      { origin: "stripe_fee", amount: "0.87" },
      { origin: "fx_fee", amount: "0.13" },
      { origin: "cross_border_fee", amount: "0.25" },
    ]);
    const second = await fees.reconcileProviderFees(PAY);
    check("a SECOND genuine divergence posts its own delta",
      second.ok === true && second.posted === true && second.deltaMinor === BigInt(25),
      second.ok ? `delta=${second.deltaMinor}` : `reason=${second.reason}`);
    check("two corrections now exist", (await correctionCount(PAY)) === 2);

    // And a THIRD, downward this time.
    FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }]);
    const third = await fees.reconcileProviderFees(PAY);
    check("a downward revision posts a NEGATIVE delta",
      third.ok === true && third.posted === true && third.deltaMinor === BigInt(-38),
      third.ok ? `delta=${third.deltaMinor}` : `reason=${third.reason}`);

    /* THE COLLISION THE COUNT AVOIDS. Fees return to a total already seen
     * (100). A key built from the posted total, or from from/to, would repeat a
     * key already used and refuse this correction. */
    FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }, { origin: "fx_fee", amount: "0.13" }]);
    const fourth = await fees.reconcileProviderFees(PAY);
    check("a fee total returning to a PREVIOUSLY SEEN value still posts",
      fourth.ok === true && fourth.posted === true && fourth.deltaMinor === BigInt(13),
      fourth.ok ? `delta=${fourth.deltaMinor}` : `reason=${fourth.reason}`);
    check("four corrections exist, each its own economic event",
      (await correctionCount(PAY)) === 4, `${await correctionCount(PAY)}`);

    /* ------------------------------------------------------------ E ---- */
    section("E. Convergence on provider truth, and balance");

    check("provider_fee_expense equals the provider's authoritative total",
      (await feeTotal(PAY)) === BigInt(100), `${await feeTotal(PAY)}`);

    const [unbalanced] = await scoped.unsafe(
      `select count(*)::int as n from (
         select transaction_id from ${SCRATCH}.accounting_entries
          group by transaction_id having sum(amount_minor) <> 0) x`,
    );
    check("every accounting transaction balances", unbalanced.n === 0, `${unbalanced.n} unbalanced`);

    const [residual] = await scoped.unsafe(
      `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries`,
    );
    check("and the whole scratch ledger sums to zero", BigInt(residual.s) === BigInt(0),
      `residual=${residual.s}`);

    // Each correction is a two-leg entry against provider_balance.
    const [pairs] = await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_transactions t
        where t.economic_event = 'provider_fee_reconciled'
          and (select count(*) from ${SCRATCH}.accounting_entries e
                where e.transaction_id = t.transaction_id) = 2`,
    );
    check("each correction is a two-leg fee/balance entry", pairs.n === 4, `${pairs.n} of 4`);

    /* ------------------------------------------------------------ F ---- */
    section("F. Environment isolation");

    // A production correction for the SAME payment id must be its own event and
    // must not see the sandbox corrections.
    ENVIRONMENT = "production";
    await settle(`${PAY}_prod_anchor`, BigInt(87));
    FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }]);
    const prodNoop = await fees.reconcileProviderFees(`${PAY}_prod_anchor`);
    check("a production payment reconciles against production entries only",
      prodNoop.ok === true && prodNoop.deltaMinor === BigInt(0),
      prodNoop.ok ? `delta=${prodNoop.deltaMinor}` : `reason=${prodNoop.reason}`);

    const [crossEnv] = await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_transactions
        where provider_resource_id = '${PAY}' and environment <> 'sandbox'`,
    );
    check("no sandbox payment's transactions leaked into production",
      crossEnv.n === 0, `${crossEnv.n}`);
    ENVIRONMENT = "sandbox";

    /* ------------------------------------------------------------ G ---- */
    section("G. Minor-unit arithmetic only");

    check("every delta this suite observed was a bigint",
      [first, second, third, fourth].every((r) => typeof r.deltaMinor === "bigint"));

    const src = readFileSync("src/lib/server/accounting/whop-fee-reconciliation.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the module uses no floating-point arithmetic",
      !/parseFloat|Number\.parseFloat|Math\.round|Math\.floor/.test(src));
    check("amounts are converted through the shared minor-unit helper",
      /decimalToMinor/.test(src));

    /* ------------------------------------------------------------ I ---- */
    section("I. Drift DETECTION (read-only)");

    {
      const drift = loadTs("src/lib/server/accounting/reconcile.ts");

      /* Four settlements covering the cases the old predicate could and could
       * not see. `flag` is what `fees_are_actual` said AT settlement; it must
       * decide nothing. */
      const seed = async (paymentId, fee, flag) => {
        const r = await journal.postTransaction({
          economicEvent: "payment_settled",
          provider: "whop",
          providerResourceId: paymentId,
          environment: ENVIRONMENT,
          currency: "usd",
          idempotencyKey: `whop:payment_settled:${paymentId}`,
          description: `settlement ${paymentId}`,
          metadata: flag === null ? { note: "legacy" } : { fees_are_actual: flag },
          legs: [
            { account: "provider_balance", amountMinor: BigInt(1000) - fee,
              counterpartyType: "provider", counterpartyId: "whop" },
            { account: "provider_fee_expense", amountMinor: fee,
              counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_fee" },
            { account: "unallocated_customer_funds", amountMinor: BigInt(-1000),
              counterpartyType: "customer" },
          ].filter((l) => l.amountMinor !== BigInt(0)),
        });
        if (!r.ok) throw new Error(`seed failed: ${r.reason} ${r.detail ?? ""}`);
      };

      // Settled with NO fee and flagged false — the only case the old scan saw.
      await seed("pay_drift_false", BigInt(0), false);
      // Settled WITH fees and flagged true — invisible to the old scan.
      await seed("pay_drift_true", BigInt(87), true);
      // Legacy: no `fees_are_actual` key at all — invisible to the old scan.
      await seed("pay_drift_legacy", BigInt(87), null);
      // Settled with fees that still agree with the provider — must NOT report.
      await seed("pay_drift_insync", BigInt(87), true);

      /* The provider now reports 100 for every payment it is asked about. So:
       *   pay_drift_false   posted 0  -> drift +100
       *   pay_drift_true    posted 87 -> drift +13
       *   pay_drift_legacy  posted 87 -> drift +13
       *   pay_drift_insync  posted 87 -> asked separately, in sync */
      FAKE_WHOP = fakeWhop([
        { origin: "stripe_fee", amount: "0.87" },
        { origin: "fx_fee", amount: "0.13" },
      ]);

      const report = await drift.reconcileFeeDrift();
      const found = new Map(report.driftCandidates.map((c) => [c.paymentId, c]));

      check("a fees_are_actual=FALSE settlement is detected when fees differ",
        found.has("pay_drift_false") && found.get("pay_drift_false").deltaMinor === BigInt(100),
        `delta=${found.get("pay_drift_false")?.deltaMinor}`);
      check("a fees_are_actual=TRUE settlement is ALSO detected when fees later differ",
        found.has("pay_drift_true") && found.get("pay_drift_true").deltaMinor === BigInt(13),
        `delta=${found.get("pay_drift_true")?.deltaMinor}`);
      check("a LEGACY settlement with no fees_are_actual key is considered",
        found.has("pay_drift_legacy") && found.get("pay_drift_legacy").deltaMinor === BigInt(13),
        `delta=${found.get("pay_drift_legacy")?.deltaMinor}`);

      check("the flag is carried as a hint, and null stays null",
        found.get("pay_drift_true").feesWereActualAtSettlement === true &&
          found.get("pay_drift_false").feesWereActualAtSettlement === false &&
          found.get("pay_drift_legacy").feesWereActualAtSettlement === null);

      check("posted and actual totals are both reported, in minor units",
        found.get("pay_drift_true").postedFeeMinor === BigInt(87) &&
          found.get("pay_drift_true").actualFeeMinor === BigInt(100));
      check("every reported amount is a bigint",
        report.driftCandidates.every((c) =>
          typeof c.deltaMinor === "bigint" &&
          typeof c.postedFeeMinor === "bigint" &&
          typeof c.actualFeeMinor === "bigint"));

      /* IN SYNC IS NOT DRIFT. The provider agrees with the journal for this one,
       * and the old scan would have reported it purely on its flag. */
      FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }]);
      const inSync = await drift.reconcileFeeDrift();
      const inSyncFound = new Map(inSync.driftCandidates.map((c) => [c.paymentId, c]));
      check("a settlement matching the provider is NOT reported as drift",
        !inSyncFound.has("pay_drift_insync"),
        `reported: ${[...inSyncFound.keys()].join(",") || "none"}`);
      check("while a genuinely zero-fee settlement still is",
        inSyncFound.has("pay_drift_false"));

      /* THE SCAN IS READ-ONLY. Nothing it does may post. */
      const txnsBefore = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const entriesBefore = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_entries`))[0].n;
      await drift.reconcileFeeDrift();
      const txnsAfter = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const entriesAfter = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_entries`))[0].n;
      check("the scan posts no accounting transaction", txnsBefore === txnsAfter,
        `${txnsBefore} -> ${txnsAfter}`);
      check("and no accounting entry", entriesBefore === entriesAfter,
        `${entriesBefore} -> ${entriesAfter}`);

      /* FAILURE ISOLATION. One payment's provider lookup throws; the others must
       * still be examined and the failure must be reported, not dropped. */
      const failing = "pay_drift_true";
      FAKE_WHOP = {
        payments: {
          listFees: async ({ id }) => {
            if (id === failing) throw new Error("provider down for this payment");
            return {
              data: [
                { origin: "stripe_fee", label: "stripe_fee", type: "processing_fee",
                  settlement_amount: { amount: "0.87", currency: "usd", decimals: 2, display_decimals: 2 } },
                { origin: "fx_fee", label: "fx_fee", type: "processing_fee",
                  settlement_amount: { amount: "0.13", currency: "usd", decimals: 2, display_decimals: 2 } },
              ],
            };
          },
        },
      };
      const isolated = await drift.reconcileFeeDrift();
      const isolatedIds = isolated.driftCandidates.map((c) => c.paymentId);
      check("one payment's provider failure does not hide the others",
        isolatedIds.includes("pay_drift_false") && isolatedIds.includes("pay_drift_legacy"),
        isolatedIds.join(","));
      check("and the failure is REPORTED, never silently dropped",
        isolated.unresolved.some((u) => u.paymentId === failing),
        isolated.unresolved.map((u) => `${u.paymentId}:${u.reason}`).join(",") || "none");
      check("a failed lookup is not counted as drift",
        !isolatedIds.includes(failing));

      /* BOUNDED AND DETERMINISTICALLY PAGED. */
      FAKE_WHOP = fakeWhop([{ origin: "stripe_fee", amount: "0.87" }, { origin: "fx_fee", amount: "0.13" }]);
      const page1 = await drift.reconcileFeeDrift(2, 0);
      const page2 = await drift.reconcileFeeDrift(2, 2);
      check("an explicit limit bounds how many settlements are examined",
        page1.settlementsScanned === 2, `${page1.settlementsScanned}`);
      /* THE CLAMP IS ASSERTED IN SOURCE, not by row count.
       *
       * A behavioural check cannot see it here: the throwaway schema holds far
       * fewer than the maximum, so "scanned <= 200" is true whether the clamp
       * exists or not — it passed with the clamp removed, which is exactly the
       * kind of assertion that looks like coverage and is not. Seeding 200+
       * settlements to observe it would cost a minute per run to prove one
       * `Math.min`. */
      check("a huge requested limit still returns at most what exists",
        (await drift.reconcileFeeDrift(100000)).settlementsScanned <= 200);
      check("and the page size is clamped to the module maximum in source",
        /Math\.min\(limit, FEE_DRIFT_MAX_PAGE\)/.test(
          readFileSync("src/lib/server/accounting/reconcile.ts", "utf8"),
        ));
      check("the maximum is a single named constant, not a scattered literal",
        /const FEE_DRIFT_MAX_PAGE = [0-9]+;/.test(
          readFileSync("src/lib/server/accounting/reconcile.ts", "utf8"),
        ));
      check("paging with an offset returns a DIFFERENT page",
        page1.driftCandidates.concat(page2.driftCandidates).length >= 2 &&
          page1.driftCandidates.every((c) =>
            !page2.driftCandidates.some((d) => d.transactionId === c.transactionId)),
        `p1=${page1.driftCandidates.length} p2=${page2.driftCandidates.length}`);
      check("repeating the same page returns the same rows — ordering is deterministic",
        JSON.stringify((await drift.reconcileFeeDrift(2, 0)).driftCandidates.map((c) => c.transactionId)) ===
          JSON.stringify(page1.driftCandidates.map((c) => c.transactionId)));

      /* ENVIRONMENT ISOLATION, both directions. */
      ENVIRONMENT = "production";
      await seed("pay_drift_prod", BigInt(87), true);
      const prodScan = await drift.reconcileFeeDrift();
      const prodIds = prodScan.driftCandidates.map((c) => c.paymentId)
        .concat(prodScan.unresolved.map((u) => u.paymentId));
      check("a PRODUCTION scan cannot inspect sandbox settlements",
        !prodIds.some((id) => id.startsWith("pay_drift_") && id !== "pay_drift_prod"),
        prodIds.join(",") || "none");

      ENVIRONMENT = "sandbox";
      const sbScan = await drift.reconcileFeeDrift();
      const sbIds = sbScan.driftCandidates.map((c) => c.paymentId)
        .concat(sbScan.unresolved.map((u) => u.paymentId));
      check("a SANDBOX scan cannot inspect production settlements",
        !sbIds.includes("pay_drift_prod"), sbIds.join(",") || "none");

      /* THE OLD PREDICATE IS GONE, and provider fees stay out of Task #17. */
      const reconcileSrc = readFileSync("src/lib/server/accounting/reconcile.ts", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      /* THE SQL PROPERTIES NOW LIVE IN THE SHARED SELECTOR.
       *
       * They were asserted against `reconcileFeeDrift`'s own body, which held
       * the query until the admin repair runner needed the same candidate set.
       * Copying the predicate into a second caller is how a detector and a
       * repairer come to disagree about which payments are in scope, so the
       * selection was extracted — and these checks follow the property to the
       * function that now owns it rather than being dropped. */
      const sliceFn = (name) => {
        const from = reconcileSrc.indexOf(`export async function ${name}`);
        const rest = reconcileSrc.slice(from);
        return rest.slice(0, rest.indexOf("\n}"));
      };
      const selectBody = sliceFn("selectFeeDriftCandidates");
      const driftBody = sliceFn("reconcileFeeDrift");

      check("the selector no longer filters on fees_are_actual",
        !/'fees_are_actual'\)::text = 'false'/.test(selectBody));
      check("it scopes by environment in the predicate",
        /eq\(accountingTransactions\.environment, environment\)/.test(selectBody));
      check("it orders deterministically, with a tiebreaker",
        /desc\(accountingTransactions\.postedAt\), desc\(accountingTransactions\.transactionId\)/.test(selectBody));
      check("the selector makes no provider call — it only decides WHO to ask",
        !/listFees|inspectProviderFeeDrift|reconcileProviderFees/.test(selectBody));
      check("the scan uses the shared provider comparison, not its own fee arithmetic",
        /inspectProviderFeeDrift\(candidate\.paymentId\)/.test(driftBody) &&
          !/listFees/.test(driftBody));
      check("the scan reuses the shared selector rather than its own query",
        /selectFeeDriftCandidates\(limit, offset\)/.test(driftBody) &&
          !/accountingTransactions\.economicEvent/.test(driftBody));
      check("and neither touches creator or platform-revenue accounts",
        !/creator_payable|platform_revenue|creatorEarnings/.test(driftBody) &&
          !/creator_payable|platform_revenue|creatorEarnings/.test(selectBody));
    }

    /* ------------------------------------------------------------ J ---- */
    section("J. The bounded admin batch repair runner");

    {
      const recovery = loadTs("src/lib/server/accounting/fee-recovery.ts");

      const stripped = (f) => readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const RECOVERY_FILE = "src/lib/server/accounting/fee-recovery.ts";
      const ROUTE_FILE = "src/app/api/admin/reconciliation/repair/fees/route.ts";
      const recSrc = stripped(RECOVERY_FILE);
      const routeSrc = stripped(ROUTE_FILE);

      /*
       * A fake that answers PER PAYMENT and COUNTS its calls.
       *
       * Counting is not decoration. The whole point of the runner's shape is
       * that a live run goes straight to the corrector instead of inspecting
       * first and correcting second — two calls per candidate, deciding from
       * one read and acting on another. The only way to prove it does not is to
       * count what the provider was asked.
       */
      let listFeeCalls = 0;
      const asked = [];
      const perPayment = (feeByPayment, throwsFor = new Set()) => ({
        payments: {
          listFees: async ({ id }) => {
            listFeeCalls += 1;
            asked.push(id);
            if (throwsFor.has(id)) throw new Error("provider down for this payment");
            const amount = feeByPayment[id] ?? "0.87";
            return {
              data: [{
                origin: "stripe_fee", label: "stripe_fee", type: "processing_fee",
                settlement_amount: { amount, currency: "usd", decimals: 2, display_decimals: 2 },
              }],
            };
          },
        },
      });

      const seedRepair = async (paymentId, fee) => {
        const r = await journal.postTransaction({
          economicEvent: "payment_settled",
          provider: "whop",
          providerResourceId: paymentId,
          environment: ENVIRONMENT,
          currency: "usd",
          idempotencyKey: `whop:payment_settled:${paymentId ?? "noid"}`,
          description: `settlement ${paymentId ?? "noid"}`,
          metadata: { fees_are_actual: true },
          legs: [
            { account: "provider_balance", amountMinor: BigInt(1000) - fee,
              counterpartyType: "provider", counterpartyId: "whop" },
            { account: "provider_fee_expense", amountMinor: fee,
              counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_fee" },
            { account: "unallocated_customer_funds", amountMinor: BigInt(-1000),
              counterpartyType: "customer" },
          ].filter((l) => l.amountMinor !== BigInt(0)),
        });
        if (!r.ok) throw new Error(`seed failed: ${r.reason} ${r.detail ?? ""}`);
      };

      await seedRepair("pay_rep_sync", BigInt(87));    // provider agrees
      await seedRepair("pay_rep_drift", BigInt(87));   // provider says 1.00 -> +13
      await seedRepair("pay_rep_zero", BigInt(0));     // provider says 1.00 -> +100
      await seedRepair("pay_rep_fail", BigInt(87));    // provider unreachable
      await seedRepair(null, BigInt(87));              // no payment id at all

      const FEES = {
        pay_rep_sync: "0.87",
        pay_rep_drift: "1.00",
        pay_rep_zero: "1.00",
      };
      const byPayment = (r) => new Map(r.outcomes.map((o) => [o.paymentId, o.result]));

      /* ---- DRY RUN ---- */
      FAKE_WHOP = perPayment(FEES, new Set(["pay_rep_fail"]));
      listFeeCalls = 0;

      const txnsBeforeDry = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const entriesBeforeDry = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_entries`))[0].n;

      const dry = await recovery.recoverProviderFeeDrift();
      const dryCalls = listFeeCalls;
      const dryOut = byPayment(dry);

      const txnsAfterDry = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const entriesAfterDry = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_entries`))[0].n;

      check("a dry run posts no accounting transaction", txnsBeforeDry === txnsAfterDry,
        `${txnsBeforeDry} -> ${txnsAfterDry}`);
      check("and no accounting entry", entriesBeforeDry === entriesAfterDry,
        `${entriesBeforeDry} -> ${entriesAfterDry}`);
      check("the default IS a dry run — a bare call writes nothing",
        txnsBeforeDry === txnsAfterDry &&
          /dryRun = true/.test(readFileSync(RECOVERY_FILE, "utf8")));

      check("a dry run reports a settlement agreeing with the provider as in_sync",
        dryOut.get("pay_rep_sync")?.kind === "in_sync",
        JSON.stringify(dryOut.get("pay_rep_sync")));
      check("a dry run reports a genuine drift as would_post, with both totals",
        dryOut.get("pay_rep_drift")?.kind === "would_post" &&
          dryOut.get("pay_rep_drift").deltaMinor === "13" &&
          dryOut.get("pay_rep_drift").postedMinor === "87" &&
          dryOut.get("pay_rep_drift").actualMinor === "100",
        JSON.stringify(dryOut.get("pay_rep_drift")));
      check("a settlement with NO provider fee posted is reported too",
        dryOut.get("pay_rep_zero")?.kind === "would_post" &&
          dryOut.get("pay_rep_zero").deltaMinor === "100",
        JSON.stringify(dryOut.get("pay_rep_zero")));
      check("an unreachable payment is reported as failed, never silently dropped",
        dryOut.get("pay_rep_fail")?.kind === "failed",
        JSON.stringify(dryOut.get("pay_rep_fail")));
      check("and one payment's failure does not hide the rest of the page",
        dryOut.has("pay_rep_sync") && dryOut.has("pay_rep_drift") && dryOut.has("pay_rep_zero"));
      check("a settlement naming no payment is reported as skipped, with the reason",
        [...dryOut.entries()].some(([id, r]) =>
          !id && r.kind === "skipped" && r.reason === "missing_payment_id"),
        JSON.stringify([...dryOut.entries()].filter(([id]) => !id)));
      check("every outcome carries the transaction it came from",
        dry.outcomes.every((o) => typeof o.transactionId === "string" && o.transactionId.length > 0));

      /* AMOUNTS ARE STRINGS. This report is serialised to JSON by the route, and
       * `JSON.stringify` THROWS on a bigint — a runner that returned bigints
       * would 500 the endpoint on the first drift it ever found. */
      check("reported amounts are strings, so the route can serialise them",
        typeof dryOut.get("pay_rep_drift").deltaMinor === "string" &&
          JSON.stringify(dry.outcomes).length > 0);

      /* ONE PROVIDER CALL PER CANDIDATE. */
      check("a dry run asks the provider exactly once per candidate with a payment id",
        dryCalls === dry.examined - 1, `${dryCalls} calls / ${dry.examined} examined`);
      check("and never asks about a settlement with no payment id",
        !asked.includes("") && !asked.includes(null) && !asked.includes(undefined));

      /* ---- LIVE RUN ---- */
      listFeeCalls = 0;
      asked.length = 0;
      const live = await recovery.recoverProviderFeeDrift({ dryRun: false });
      const liveCalls = listFeeCalls;
      const liveOut = byPayment(live);

      check("a live run posts the correction a real drift needs",
        liveOut.get("pay_rep_drift")?.kind === "posted" &&
          liveOut.get("pay_rep_drift").deltaMinor === "13",
        JSON.stringify(liveOut.get("pay_rep_drift")));
      check("a zero-fee settlement is corrected to the provider's full total",
        liveOut.get("pay_rep_zero")?.kind === "posted" &&
          liveOut.get("pay_rep_zero").deltaMinor === "100",
        JSON.stringify(liveOut.get("pay_rep_zero")));
      check("a zero delta is a NO-OP — nothing is posted for an in-sync settlement",
        liveOut.get("pay_rep_sync")?.kind === "in_sync",
        JSON.stringify(liveOut.get("pay_rep_sync")));

      /* THE JOURNAL, DIRECTLY. The outcome claiming a posting is not proof of
       * one; the correction has to be in the books, with the right sign. */
      const correctionFor = async (paymentId) => (await scoped.unsafe(
        `select coalesce(sum(e.amount_minor), 0)::text as total
           from ${SCRATCH}.accounting_entries e
           join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
          where t.economic_event = 'provider_fee_reconciled'
            and t.provider_resource_id = $1
            and e.account = 'provider_fee_expense'`, [paymentId]))[0].total;
      check("the correction is really in the journal, as provider_fee_expense",
        (await correctionFor("pay_rep_drift")) === "13" &&
          (await correctionFor("pay_rep_zero")) === "100",
        `drift=${await correctionFor("pay_rep_drift")} zero=${await correctionFor("pay_rep_zero")}`);
      check("and nothing was posted for the settlement already in sync",
        (await correctionFor("pay_rep_sync")) === "0");

      check("a live run reports an unreachable payment as failed and keeps going",
        liveOut.get("pay_rep_fail")?.kind === "failed" &&
          liveOut.get("pay_rep_drift")?.kind === "posted",
        JSON.stringify(liveOut.get("pay_rep_fail")));

      check("a live run also asks the provider exactly once per candidate — it does "
        + "NOT inspect and then reconcile",
        liveCalls === live.examined - 1, `${liveCalls} calls / ${live.examined} examined`);

      /* REPLAY. The provider has not changed its mind, so a second live run must
       * add nothing — the runner inherits `reconcileProviderFees`' idempotency
       * rather than implementing its own. */
      const txnsBeforeReplay = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const replay = await recovery.recoverProviderFeeDrift({ dryRun: false });
      const txnsAfterReplay = (await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      const replayOut = byPayment(replay);
      check("replaying a live run posts nothing further — it converges",
        txnsBeforeReplay === txnsAfterReplay, `${txnsBeforeReplay} -> ${txnsAfterReplay}`);
      check("and the now-corrected settlements report as in_sync, not as errors",
        replayOut.get("pay_rep_drift")?.kind === "in_sync" &&
          replayOut.get("pay_rep_zero")?.kind === "in_sync",
        `${replayOut.get("pay_rep_drift")?.kind} / ${replayOut.get("pay_rep_zero")?.kind}`);
      check("the correction total is unchanged after replay",
        (await correctionFor("pay_rep_drift")) === "13");

      /* A LATER, GENUINE fee change still posts — the repair runner must not
       * have re-introduced the one-correction-per-payment ceiling. */
      FAKE_WHOP = perPayment({ ...FEES, pay_rep_drift: "1.05" }, new Set(["pay_rep_fail"]));
      const later = await recovery.recoverProviderFeeDrift({ dryRun: false });
      check("a LATER genuine fee change still posts through the runner",
        byPayment(later).get("pay_rep_drift")?.kind === "posted" &&
          byPayment(later).get("pay_rep_drift").deltaMinor === "5",
        JSON.stringify(byPayment(later).get("pay_rep_drift")));
      check("and the journal now holds the provider's full current total",
        (await correctionFor("pay_rep_drift")) === "18");

      /* BOUNDS. */
      FAKE_WHOP = perPayment(FEES, new Set(["pay_rep_fail"]));
      const bounded = await recovery.recoverProviderFeeDrift({ limit: 2 });
      check("an explicit limit bounds how many candidates a run examines",
        bounded.examined === 2, `${bounded.examined}`);
      /* The clamp itself cannot be proven by row count here — the scratch schema
       * holds far fewer than 200 settlements, so an unclamped run would pass
       * too. Proven at the source instead: the runner declares NO maximum of its
       * own and defers to the selector's, which Section I already tests. */
      check("an absurd limit is accepted without error and stays bounded",
        (await recovery.recoverProviderFeeDrift({ limit: 100000 })).examined <= 200);
      check("the runner declares no second maximum — it defers to the shared one",
        /limit = FEE_DRIFT_MAX_PAGE/.test(recSrc) &&
          !/Math\.min\(\s*limit,\s*\d/.test(recSrc) &&
          !/= \d{2,}/.test(recSrc));
      const off0 = await recovery.recoverProviderFeeDrift({ limit: 2, offset: 0 });
      const off2 = await recovery.recoverProviderFeeDrift({ limit: 2, offset: 2 });
      check("offset pages to a DIFFERENT set of candidates",
        off0.outcomes.every((o) =>
          !off2.outcomes.some((p) => p.transactionId === o.transactionId)),
        `${off0.outcomes.map((o) => o.transactionId).join(",")} vs ${off2.outcomes.map((o) => o.transactionId).join(",")}`);

      /* ENVIRONMENT ISOLATION, both directions. The runner takes no environment
       * argument at all; it reads server configuration, like everything else. */
      ENVIRONMENT = "production";
      const prodRepair = await recovery.recoverProviderFeeDrift();
      check("a PRODUCTION run cannot examine sandbox settlements",
        !prodRepair.outcomes.some((o) => o.paymentId.startsWith("pay_rep_")),
        prodRepair.outcomes.map((o) => o.paymentId).join(",") || "none");
      ENVIRONMENT = "sandbox";
      const sbRepair = await recovery.recoverProviderFeeDrift();
      check("a SANDBOX run cannot examine production settlements",
        !sbRepair.outcomes.some((o) => o.paymentId === "pay_drift_prod"));

      /* ---- SOURCE INVARIANTS: the runner and its route ---- */
      check("the runner reuses the shared candidate selector, not its own query",
        /selectFeeDriftCandidates\(limit, offset\)/.test(recSrc) &&
          !/accountingTransactions|from\(accounting/.test(recSrc));
      check("it reuses the existing corrector rather than duplicating posting logic",
        /reconcileProviderFees\(candidate\.paymentId\)/.test(recSrc) &&
          !/postTransaction|economicKey|accountingEntries/.test(recSrc));
      /* THE INSPECTOR IS REACHED FROM THE DRY BRANCH ONLY. Both it and the
       * corrector fetch `listFees`, so an inspect-then-reconcile live path would
       * double every provider call in the batch and decide from one read while
       * acting on another. Proven structurally, not only by the call count. */
      check("a live run never calls the inspector — that is what would double the calls",
        (recSrc.match(/inspectProviderFeeDrift/g) ?? []).length === 2 &&
          recSrc.indexOf("await inspectProviderFeeDrift") >= 0 &&
          recSrc.indexOf("await inspectProviderFeeDrift") < recSrc.indexOf("await reconcileProviderFees") &&
          !/inspectProviderFeeDrift/.test(recSrc.slice(recSrc.indexOf("if (dryRun)") === -1
            ? 0
            : recSrc.indexOf("await reconcileProviderFees"))));
      check("the runner touches no creator or platform-revenue account",
        !/creator_payable|platform_revenue|creatorEarnings|creator_earnings/.test(recSrc));
      check("every candidate is isolated in its own try/catch",
        (recSrc.match(/catch \(error\)/g) ?? []).length === 2);

      check("the route rejects a cross-origin request before doing anything",
        /if \(!checkRequestOrigin\(request\.headers\)\.ok\)/.test(routeSrc) &&
          routeSrc.indexOf("checkRequestOrigin") < routeSrc.indexOf("recoverProviderFeeDrift"));
      check("the route is admin-guarded",
        /withAdminApi\(async \(admin\)/.test(routeSrc));
      check("the route defaults to a dry run — only an explicit false is live",
        /const dryRun = body\.dry_run !== false;/.test(routeSrc));
      check("the route clamps to the drift scan's OWN maximum, not a second one",
        /Math\.min\(limitRaw, FEE_DRIFT_MAX_PAGE\)/.test(routeSrc) &&
          !/MAX_LIMIT/.test(routeSrc));
      check("the route accepts NO environment from the request body",
        !/body\.environment|environment:/.test(routeSrc));
      check("it audits a live run, and does not audit a dry run",
        /if \(!dryRun\)[\s\S]{0,400}action: "repair_fee_postings"/.test(routeSrc));
      check("the response follows the existing repair-route shape",
        /dry_run: dryRun,\s*examined: report\.examined,\s*outcomes: report\.outcomes,/.test(routeSrc));
      check("malformed JSON is rejected, not treated as an empty body",
        /invalid_json/.test(routeSrc));
      check("the OFFSET paging limitation is documented rather than claimed safe",
        /not[\s*]+snapshot-safe/i.test(readFileSync(ROUTE_FILE, "utf8")));
    }

    /* ------------------------------------------------------------ K ---- */
    section("K. Rate limiting on the single-payment route");

    {
      const route = loadTs("src/app/api/admin/fees/reconcile/[id]/route.ts");
      const RL_KEY = "admin:fee_reconcile:admin_fee_test";
      const RL_ROUTE_FILE = "src/app/api/admin/fees/reconcile/[id]/route.ts";
      const REPAIR_FEES_FILE = "src/app/api/admin/reconciliation/repair/fees/route.ts";

      /* A fake that counts BOTH provider calls. A rate-limited request must
       * reach neither, and counting only listFees would miss the retrieve. */
      let listCalls = 0;
      let retrieveCalls = 0;
      const countingFake = (amount) => ({
        payments: {
          listFees: async () => {
            listCalls += 1;
            return {
              data: [{
                origin: "stripe_fee", label: "stripe_fee", type: "processing_fee",
                settlement_amount: { amount, currency: "usd", decimals: 2, display_decimals: 2 },
              }],
            };
          },
          retrieve: async () => { retrieveCalls += 1; return { id: "x", currency: "usd" }; },
        },
      });

      const seedCur = async (paymentId, fee, currency) => {
        const r = await journal.postTransaction({
          economicEvent: "payment_settled",
          provider: "whop",
          providerResourceId: paymentId,
          environment: ENVIRONMENT,
          currency,
          idempotencyKey: "whop:payment_settled:" + paymentId,
          description: "settlement " + paymentId,
          metadata: { fees_are_actual: true },
          legs: [
            { account: "provider_balance", amountMinor: BigInt(1000) - fee,
              counterpartyType: "provider", counterpartyId: "whop" },
            { account: "provider_fee_expense", amountMinor: fee,
              counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_fee" },
            { account: "unallocated_customer_funds", amountMinor: BigInt(-1000),
              counterpartyType: "customer" },
          ].filter((l) => l.amountMinor !== BigInt(0)),
        });
        if (!r.ok) throw new Error("seed failed: " + r.reason + " " + (r.detail ?? ""));
      };

      const post = (paymentId) => route.POST(
        new Request("https://app.test/api/admin/fees/reconcile/" + paymentId, { method: "POST" }),
        { params: Promise.resolve({ id: paymentId }) },
      );
      const counts = async () => {
        const [t] = await scoped.unsafe(
          "select count(*)::int as n from " + SCRATCH + ".accounting_transactions");
        const [a] = await scoped.unsafe(
          "select count(*)::int as n from " + SCRATCH + ".admin_audit_log");
        return { txns: t.n, audits: a.n };
      };
      const setCounter = async (n) => {
        const windowKey = Math.floor(Date.now() / 3600000).toString();
        await scoped.unsafe(
          "insert into " + SCRATCH + ".rate_limit_counters (key, window_key, count) " +
          "values ($1, $2, $3) on conflict (key, window_key) do update set count = $3",
          [RL_KEY, windowKey, n]);
      };
      const clearCounter = async () => {
        await scoped.unsafe(
          "delete from " + SCRATCH + ".rate_limit_counters where key = $1", [RL_KEY]);
      };

      await seedCur("pay_rl_ok", BigInt(87), "usd");
      await seedCur("pay_rl_blocked", BigInt(87), "usd");

      /* ---- A NORMAL AUTHORIZED REQUEST STILL WORKS ---- */
      await clearCounter();
      ORIGIN_OK = true;
      ADMIN = { uid: "admin_fee_test", email: "admin@example.test", name: null, authTime: 0 };
      FAKE_WHOP = countingFake("1.00");

      const beforeOk = await counts();
      const okRes = await post("pay_rl_ok");
      const okBody = await okRes.json();
      const afterOk = await counts();

      check("an authorized in-budget request still reconciles the payment",
        okRes.status === 200 && okBody.ok === true && okBody.delta_minor === "13" &&
          okBody.posted === true,
        okRes.status + " " + JSON.stringify(okBody));
      check("it posts the correction and writes exactly one audit row",
        afterOk.txns === beforeOk.txns + 1 && afterOk.audits === beforeOk.audits + 1,
        JSON.stringify(beforeOk) + " -> " + JSON.stringify(afterOk));
      check("and the limiter counted that request",
        (await scoped.unsafe(
          "select count from " + SCRATCH + ".rate_limit_counters where key = $1",
          [RL_KEY]))[0]?.count === 1);

      /* ---- OVER BUDGET ---- */
      await setCounter(60);
      listCalls = 0;
      retrieveCalls = 0;
      const beforeRl = await counts();
      const rlRes = await post("pay_rl_blocked");
      const rlBody = await rlRes.json();
      const afterRl = await counts();

      /* THE SHARED LIMITER'S OWN RESPONSE, INTACT.
       *
       * The route returns `rateLimitResponse()` and `withAdminApi` passes a
       * `Response` through untouched, so the client sees the real 429 and the
       * `retry-after` the helper set. Before the wrapper fix this same code
       * answered 200 with a body of `{}` — see Section M. */
      check("a rate-limited request answers with the established error body",
        rlBody.error === "rate_limited", JSON.stringify(rlBody));
      check("and with a real 429, not a 200",
        rlRes.status === 429, String(rlRes.status));
      check("carrying retry-after and no-store, as the shared helper set them",
        rlRes.headers.get("retry-after") === "3600" &&
          rlRes.headers.get("cache-control") === "no-store",
        `retry-after=${rlRes.headers.get("retry-after")}`);
      check("a rate-limited request makes ZERO provider calls",
        listCalls === 0 && retrieveCalls === 0,
        "listFees=" + listCalls + " retrieve=" + retrieveCalls);
      check("a rate-limited request posts ZERO accounting transactions",
        afterRl.txns === beforeRl.txns, beforeRl.txns + " -> " + afterRl.txns);
      check("a rate-limited request writes no audit row either — the limiter runs "
        + "before the audit, as in the transfer and withdrawal routes",
        afterRl.audits === beforeRl.audits, beforeRl.audits + " -> " + afterRl.audits);

      /* AND IT IS THE LIMITER, not something permanently broken. */
      await clearCounter();
      FAKE_WHOP = countingFake("1.00");
      const recovered = await post("pay_rl_blocked");
      const recoveredBody = await recovered.json();
      check("clearing the window lets the same request through — the refusal was the limiter",
        recovered.status === 200 && recoveredBody.ok === true && recoveredBody.delta_minor === "13",
        JSON.stringify(recoveredBody));

      /* ORIGIN AND ADMIN PROTECTION REMAIN, and both still short-circuit
       * BEFORE the limiter, the provider and the journal. */
      ORIGIN_OK = false;
      listCalls = 0;
      retrieveCalls = 0;
      const beforeXo = await counts();
      const xoRes = await post("pay_rl_ok");
      const xoBody = await xoRes.json();
      check("a cross-origin request is still refused with 403",
        xoRes.status === 403 && xoBody.error === "forbidden",
        xoRes.status + " " + JSON.stringify(xoBody));
      check("and it reaches neither the provider nor the journal",
        listCalls === 0 && retrieveCalls === 0 &&
          (await counts()).txns === beforeXo.txns);
      ORIGIN_OK = true;

      ADMIN = null;
      const unauthRes = await post("pay_rl_ok");
      check("an unauthenticated caller is still refused by the admin guard",
        unauthRes.status === 401, String(unauthRes.status));
      ADMIN = { uid: "admin_fee_test", email: "admin@example.test", name: null, authTime: 0 };

      const invalidRes = await post("no");
      check("an unusable payment id is still rejected before anything else",
        invalidRes.status === 400, String(invalidRes.status));

      /* ---- SOURCE: the shared limiter, the shared key shape, the right order ---- */
      const rlFull = readFileSync(RL_ROUTE_FILE, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      /* THE HANDLER ONLY. Import order is not execution order, and comparing
       * positions across the import block would assert nothing about what runs
       * first — the imports happen to list withAdminApi before the origin check. */
      const rlSrc = rlFull.slice(rlFull.indexOf("export async function POST"));

      check("the route uses the SHARED limiter, not one of its own",
        /import \{ checkRateLimit, rateLimitResponse \} from "@\/lib\/server\/rate-limit";/.test(rlFull) &&
          !/rateLimitCounters|windowKey/.test(rlFull));
      check("and the shared 429 response, not a hand-rolled error object",
        /if \(!rl\.ok\) return rateLimitResponse\(\);/.test(rlSrc) &&
          !/error: "rate_limited"/.test(rlSrc));
      check("keyed per ADMIN, in the same shape as the other finance routes",
        /checkRateLimit\(.admin:fee_reconcile:\$\{adminCtx\.uid\}., 60\)/.test(rlSrc));
      check("the limiter runs inside the admin guard, after origin and id checks",
        rlSrc.indexOf("checkRequestOrigin") < rlSrc.indexOf("withAdminApi") &&
          rlSrc.indexOf("withAdminApi") < rlSrc.indexOf("checkRateLimit"));
      check("and before the audit and the reconciliation",
        rlSrc.indexOf("checkRateLimit") < rlSrc.indexOf("writeAudit") &&
          rlSrc.indexOf("checkRateLimit") < rlSrc.indexOf("reconcileProviderFees"));

      /* THE BATCH REPAIR ROUTES ARE DELIBERATELY NOT LIMITED, because the
       * repair convention in this repo does not limit them. Adding one there
       * would have been a new convention, not the existing one. */
      check("the batch repair routes are left unlimited, matching their convention",
        !/checkRateLimit/.test(readFileSync(REPAIR_FEES_FILE, "utf8")) &&
          !/checkRateLimit/.test(readFileSync(
            "src/app/api/admin/reconciliation/repair/refunds/route.ts", "utf8")));
    }

    /* ------------------------------------------------------------ L ---- */
    section("L. Currency comes from the provider, or not at all");

    {
      const fees = loadTs("src/lib/server/accounting/whop-fee-reconciliation.ts");
      const recovery2 = loadTs("src/lib/server/accounting/fee-recovery.ts");
      const drift2 = loadTs("src/lib/server/accounting/reconcile.ts");

      /*
       * A fake with explicit control over both halves of the currency question:
       * what the fee lines say, and what the PAYMENT says. An empty line list is
       * the case the old code answered with a hard-coded "usd".
       */
      let retrieveCount = 0;
      const curFake = ({ lines, paymentCurrency, retrieveThrows = false }) => ({
        payments: {
          listFees: async () => ({
            data: lines.map((l) => ({
              origin: l.origin, label: l.origin, type: "processing_fee",
              settlement_amount: {
                amount: l.amount, currency: l.currency,
                decimals: l.decimals ?? 2, display_decimals: l.decimals ?? 2,
              },
            })),
          }),
          retrieve: async () => {
            retrieveCount += 1;
            if (retrieveThrows) throw new Error("payment lookup unavailable");
            return { id: "pay", currency: paymentCurrency };
          },
        },
      });

      const seedCur2 = async (paymentId, fee, currency) => {
        const r = await journal.postTransaction({
          economicEvent: "payment_settled",
          provider: "whop",
          providerResourceId: paymentId,
          environment: ENVIRONMENT,
          currency,
          idempotencyKey: "whop:payment_settled:" + paymentId,
          description: "settlement " + paymentId,
          metadata: { fees_are_actual: true },
          legs: [
            { account: "provider_balance", amountMinor: BigInt(1000) - fee,
              counterpartyType: "provider", counterpartyId: "whop" },
            { account: "provider_fee_expense", amountMinor: fee,
              counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_fee" },
            { account: "unallocated_customer_funds", amountMinor: BigInt(-1000),
              counterpartyType: "customer" },
          ].filter((l) => l.amountMinor !== BigInt(0)),
        });
        if (!r.ok) throw new Error("seed failed: " + r.reason + " " + (r.detail ?? ""));
      };

      await seedCur2("pay_cur_eur_zero", BigInt(0), "eur");
      await seedCur2("pay_cur_eur_drop", BigInt(50), "eur");
      await seedCur2("pay_cur_eur_line", BigInt(87), "eur");
      await seedCur2("pay_cur_jpy", BigInt(0), "jpy");
      await seedCur2("pay_cur_mixed", BigInt(87), "usd");
      await seedCur2("pay_cur_unprovable", BigInt(0), "usd");
      await seedCur2("pay_cur_contradict", BigInt(87), "usd");
      await seedCur2("pay_cur_usd", BigInt(87), "usd");

      const txnCount = async () => (await scoped.unsafe(
        "select count(*)::int as n from " + SCRATCH + ".accounting_transactions"))[0].n;

      /* ---- ZERO FEE LINES USE THE PAYMENT'S OWN CURRENCY ---- */
      FAKE_WHOP = curFake({ lines: [], paymentCurrency: "eur" });
      retrieveCount = 0;
      const zeroEur = await fees.inspectProviderFeeDrift("pay_cur_eur_zero");
      check("with no fee lines, the currency comes from the PAYMENT, not from usd",
        zeroEur.ok === true && zeroEur.currency === "eur",
        show(zeroEur.ok ? zeroEur.currency : zeroEur));
      check("a zero-fee state still reports a zero total, in minor units",
        zeroEur.ok && zeroEur.actualMinor === BigInt(0) &&
          typeof zeroEur.actualMinor === "bigint" && zeroEur.deltaMinor === BigInt(0));
      check("the payment is looked up only because the fee lines proved nothing",
        retrieveCount === 1, String(retrieveCount));

      /* A NON-USD CORRECTION IS POSTED IN THAT CURRENCY. The strongest form of
       * the proof: the journal row itself must say eur. */
      const dropRes = await fees.reconcileProviderFees("pay_cur_eur_drop");
      check("a non-USD payment whose fees vanished posts a NEGATIVE eur correction",
        dropRes.ok === true && dropRes.posted === true && dropRes.deltaMinor === BigInt(-50),
        show(dropRes.ok ? String(dropRes.deltaMinor) : dropRes));
      const [dropRow] = await scoped.unsafe(
        "select currency from " + SCRATCH + ".accounting_transactions " +
        "where economic_event = 'provider_fee_reconciled' and provider_resource_id = $1",
        ["pay_cur_eur_drop"]);
      check("and the correction is booked in eur in the journal, not in usd",
        dropRow?.currency === "eur", String(dropRow?.currency));

      /* JPY: zero decimals. Proves no 2-decimal assumption rides along. */
      FAKE_WHOP = curFake({ lines: [], paymentCurrency: "jpy" });
      const zeroJpy = await fees.inspectProviderFeeDrift("pay_cur_jpy");
      check("a zero-decimal currency survives the same path",
        zeroJpy.ok === true && zeroJpy.currency === "jpy",
        show(zeroJpy.ok ? zeroJpy.currency : zeroJpy));

      /* ---- A FEE LINE'S OWN CURRENCY IS PRESERVED ---- */
      FAKE_WHOP = curFake({
        lines: [{ origin: "stripe_fee", amount: "1.00", currency: "eur" }],
        paymentCurrency: "usd",
      });
      retrieveCount = 0;
      const lineEur = await fees.inspectProviderFeeDrift("pay_cur_eur_line");
      check("when a fee line supplies a currency, that currency is used",
        lineEur.ok === true && lineEur.currency === "eur" && lineEur.actualMinor === BigInt(100),
        show(lineEur.ok ? lineEur.currency : lineEur));
      check("and no payment lookup is made — the cheaper source proved it",
        retrieveCount === 0, String(retrieveCount));

      /* ---- UNPROVABLE OR CONTRADICTORY FAILS CLOSED, POSTING NOTHING ---- */

      // (a) Two fee lines that disagree with each other.
      FAKE_WHOP = curFake({
        lines: [
          { origin: "stripe_fee", amount: "0.50", currency: "usd" },
          { origin: "fx_fee", amount: "0.50", currency: "eur" },
        ],
        paymentCurrency: "usd",
      });
      let before = await txnCount();
      const mixed = await fees.reconcileProviderFees("pay_cur_mixed");
      check("two fee lines in different currencies fail closed",
        mixed.ok === false && mixed.reason === "currency_mismatch", show(mixed));
      check("and post nothing", (await txnCount()) === before, "txns " + before);

      // (b) The provider cannot prove a currency at all. whop_usd is a real Whop
      // value — internal credits, not an ISO currency — so this is the shape the
      // old fallback was silently turning into dollars.
      FAKE_WHOP = curFake({ lines: [], paymentCurrency: "whop_usd" });
      before = await txnCount();
      const unprovable = await fees.reconcileProviderFees("pay_cur_unprovable");
      check("a payment currency the provider cannot prove fails closed",
        unprovable.ok === false && unprovable.reason === "unsupported_currency",
        show(unprovable));
      check("and posts nothing", (await txnCount()) === before, "txns " + before);

      FAKE_WHOP = curFake({ lines: [], paymentCurrency: null });
      const missing = await fees.reconcileProviderFees("pay_cur_unprovable");
      check("an absent payment currency is refused, never defaulted",
        missing.ok === false && missing.reason === "unsupported_currency",
        show(missing));

      // (c) A payment lookup that fails is a provider error, not a guess.
      FAKE_WHOP = curFake({ lines: [], paymentCurrency: "usd", retrieveThrows: true });
      const lookupDown = await fees.reconcileProviderFees("pay_cur_unprovable");
      check("an unreachable payment lookup is a provider error, not a default",
        lookupDown.ok === false && lookupDown.reason === "provider_error",
        show(lookupDown));

      // (d) The provider's currency contradicts the currency we booked.
      FAKE_WHOP = curFake({
        lines: [{ origin: "stripe_fee", amount: "1.00", currency: "eur" }],
        paymentCurrency: "eur",
      });
      before = await txnCount();
      const contradict = await fees.reconcileProviderFees("pay_cur_contradict");
      check("provider fees in a currency other than the booked settlement fail closed",
        contradict.ok === false && contradict.reason === "currency_mismatch",
        show(contradict));
      check("and post nothing — a delta across two currencies is not a number",
        (await txnCount()) === before, "txns " + before);

      /* ---- USD BEHAVIOUR IS UNCHANGED ---- */
      FAKE_WHOP = curFake({
        lines: [{ origin: "stripe_fee", amount: "1.00", currency: "usd" }],
        paymentCurrency: "usd",
      });
      const usd = await fees.reconcileProviderFees("pay_cur_usd");
      check("a usd payment still reconciles exactly as before",
        usd.ok === true && usd.posted === true && usd.deltaMinor === BigInt(13),
        show(usd.ok ? String(usd.deltaMinor) : usd));
      check("no hard-coded usd fallback remains in the module",
        !/currency: "usd"/.test(readFileSync(
          "src/lib/server/accounting/whop-fee-reconciliation.ts", "utf8")));

      /* ---- DETECTION AND THE BATCH RUNNER STILL WORK ---- */
      FAKE_WHOP = curFake({
        lines: [{ origin: "stripe_fee", amount: "0.87", currency: "usd" }],
        paymentCurrency: "usd",
      });
      const driftAfter = await drift2.reconcileFeeDrift();
      check("drift detection still runs and still reports findings",
        driftAfter.configured === true && driftAfter.settlementsScanned > 0,
        "scanned " + driftAfter.settlementsScanned);
      check("a currency failure surfaces as UNRESOLVED, never as a silent skip",
        driftAfter.unresolved.some((u) => u.reason === "currency_mismatch"),
        driftAfter.unresolved.map((u) => u.reason).join(",") || "none");
      check("and never as drift — an uncomparable payment has no delta",
        !driftAfter.driftCandidates.some((c) => c.paymentId === "pay_cur_eur_line"));

      const repairAfter = await recovery2.recoverProviderFeeDrift();
      check("the batch runner still runs against the new result shape",
        repairAfter.configured === true && repairAfter.examined > 0,
        "examined " + repairAfter.examined);
      check("and reports a currency failure as failed, with the reason",
        repairAfter.outcomes.some((o) =>
          o.result.kind === "failed" && o.result.reason === "currency_mismatch"),
        repairAfter.outcomes.filter((o) => o.result.kind === "failed")
          .map((o) => o.result.reason).join(",") || "none");
    }


    /* ------------------------------------------------------------ M ---- */
    section("M. withAdminApi passes a handler's own Response through");

    {
      /* THE REAL WRAPPER, not the harness copy of it. Loaded by path so the
       * loader's admin-guard interceptor does not stand in for it, with only
       * the session cookie and the Firebase verifier faked — the two things a
       * plain node process cannot provide.
       *
       * THE BUG THIS SECTION EXISTS FOR. The wrapper ended with
       * `Response.json(body)` unconditionally. Several admin handlers already
       * return a real `Response` — `rateLimitResponse()` (429), an invalid-body
       * 400 — and `Response.json` has no idea what to do with one: it
       * serialises it to `{}` and sends it with status 200. Every such refusal
       * reached the client as "200 OK, here is nothing", which a caller cannot
       * distinguish from success. */
      const guard = loadTs("src/lib/server/admin-guard.ts");
      const limiter = loadTs("src/lib/server/rate-limit.ts");

      SESSION_COOKIE = "session-cookie";
      FIREBASE_UP = true;
      SESSION_CLAIMS = {
        uid: "admin_fee_test", admin: true,
        email: "admin@example.test", auth_time: 1,
      };

      /* ---- A Response passes through, whole ---- */
      const passed = await guard.withAdminApi(async () => limiter.rateLimitResponse());
      const passedBody = await passed.json();

      check("a handler's own Response keeps its STATUS",
        passed.status === 429, String(passed.status));
      check("and its BODY",
        passedBody.error === "rate_limited", JSON.stringify(passedBody));
      check("and its HEADERS, retry-after among them",
        passed.headers.get("retry-after") === "3600" &&
          passed.headers.get("cache-control") === "no-store",
        "retry-after=" + passed.headers.get("retry-after"));

      /* The failure mode, stated as an assertion rather than a memory: the old
       * wrapper produced exactly this. */
      const reserialised = await Response.json(limiter.rateLimitResponse()).json();
      check("serialising a Response would have produced an empty 200 body — the bug",
        JSON.stringify(reserialised) === "{}" &&
          Response.json(limiter.rateLimitResponse()).status === 200);

      /* Not only 429. A handler's 400 survives too — the transfer route's
       * invalid-body answer. */
      const custom = await guard.withAdminApi(async () =>
        Response.json({ error: "invalid_body" }, { status: 400, headers: { "x-probe": "kept" } }));
      const customBody = await custom.json();
      check("a handler's 400 passes through with its own status, body and headers",
        custom.status === 400 && customBody.error === "invalid_body" &&
          custom.headers.get("x-probe") === "kept",
        custom.status + " " + JSON.stringify(customBody));

      /* ---- An ordinary object still serialises exactly as before ---- */
      const plain = await guard.withAdminApi(async () => ({ ok: true, n: 1 }));
      const plainBody = await plain.json();
      check("an ordinary object return still becomes a 200 JSON body",
        plain.status === 200 && plainBody.ok === true && plainBody.n === 1,
        plain.status + " " + JSON.stringify(plainBody));
      check("with no-store, unchanged",
        plain.headers.get("cache-control") === "no-store");

      const nullish = await guard.withAdminApi(async () => ({ error: "unsupported_currency" }));
      check("and an in-handler error object is still a 200 with { error }, as those routes rely on",
        nullish.status === 200 && (await nullish.json()).error === "unsupported_currency");

      /* ---- AUTHENTICATION IS UNTOUCHED, and the handler is never reached ---- */
      let handlerRan = false;
      const runs = async () => { handlerRan = true; return { ok: true }; };

      SESSION_COOKIE = null;
      handlerRan = false;
      const noCookie = await guard.withAdminApi(runs);
      check("no session cookie is still 401, and the handler never runs",
        noCookie.status === 401 && (await noCookie.json()).error === "unauthorized" && !handlerRan,
        String(noCookie.status));

      SESSION_COOKIE = "session-cookie";
      SESSION_CLAIMS = { uid: "u1", admin: "true", email: null, auth_time: 1 };
      handlerRan = false;
      const notAdmin = await guard.withAdminApi(runs);
      check("a non-boolean admin claim is still 403, and the handler never runs",
        notAdmin.status === 403 && (await notAdmin.json()).error === "forbidden" && !handlerRan,
        String(notAdmin.status));

      FIREBASE_UP = false;
      handlerRan = false;
      const unconfigured = await guard.withAdminApi(runs);
      check("an unverifiable server is still a denial, not a pass",
        unconfigured.status === 401 && !handlerRan, String(unconfigured.status));

      // Restore, so nothing after this section inherits a denied guard.
      FIREBASE_UP = true;
      SESSION_CLAIMS = {
        uid: "admin_fee_test", admin: true,
        email: "admin@example.test", auth_time: 1,
      };

      /* ---- SOURCE: the pass-through is a guard, not a rewrite ---- */
      const guardSrc = readFileSync("src/lib/server/admin-guard.ts", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      check("the wrapper checks for a Response before serialising",
        /if \(body instanceof Response\) return body;/.test(guardSrc) &&
          guardSrc.indexOf("body instanceof Response") <
            guardSrc.lastIndexOf("Response.json(body"));
      check("and the object path is byte-for-byte the old one",
        /return Response\.json\(body, \{ headers: \{ "cache-control": "no-store" \} \}\);/.test(guardSrc));
    }


    /* ------------------------------------------------------------ N ---- */
    section("N. Tax remittance reconciles against tax_payable, not fees");

    {
      const fees = loadTs("src/lib/server/accounting/whop-fee-reconciliation.ts");

      /* WHY THIS BELONGS IN THE DB SUITE. Whop remits sales tax when it FILES —
       * days or weeks after settlement — so the remittance line usually appears
       * on a later `listFees`, which means this path, not the settlement
       * posting, is where `tax_payable` actually gets discharged in production.
       * Proving it needs the real posted totals, which need the real journal. */

      const seedTaxed = async (paymentId, feeMinor, taxMinor) => {
        const r = await journal.postTransaction({
          economicEvent: "payment_settled",
          provider: "whop",
          providerResourceId: paymentId,
          environment: ENVIRONMENT,
          currency: "usd",
          idempotencyKey: "whop:payment_settled:" + paymentId,
          description: "settlement " + paymentId,
          metadata: { fees_are_actual: true },
          legs: [
            /* Whop still HOLDS the tax at this point — it has not filed yet, so
             * the remittance is not a fee line and the balance is only net of
             * the real fees: 10.80 - 0.07. The tax leaves this balance later,
             * which is exactly the movement this section is about. */
            { account: "provider_balance", amountMinor: BigInt(1080) - feeMinor,
              counterpartyType: "provider", counterpartyId: "whop" },
            { account: "provider_fee_expense", amountMinor: feeMinor,
              counterpartyType: "provider", counterpartyId: "whop", sourceDetail: "stripe_radar_fee" },
            { account: "tax_payable", amountMinor: -taxMinor,
              counterpartyType: "tax_authority", sourceDetail: "US" },
            { account: "unallocated_customer_funds", amountMinor: -(BigInt(1080) - taxMinor),
              counterpartyType: "customer" },
          ].filter((l) => l.amountMinor !== BigInt(0)),
        });
        if (!r.ok) throw new Error("seed failed: " + r.reason + " " + (r.detail ?? ""));
      };

      const acctTotal = async (paymentId, account) => BigInt((await scoped.unsafe(
        "select coalesce(sum(e.amount_minor), 0)::text as total" +
        "  from " + SCRATCH + ".accounting_entries e" +
        "  join " + SCRATCH + ".accounting_transactions t on t.transaction_id = e.transaction_id" +
        " where e.account = $2" +
        "   and (t.provider_resource_id = $1 or t.metadata->>'payment_id' = $1)",
        [paymentId, account]))[0].total);

      const residualFor = async (paymentId) => BigInt((await scoped.unsafe(
        "select coalesce(sum(e.amount_minor), 0)::text as total" +
        "  from " + SCRATCH + ".accounting_entries e" +
        "  join " + SCRATCH + ".accounting_transactions t on t.transaction_id = e.transaction_id" +
        " where t.provider_resource_id = $1 or t.metadata->>'payment_id' = $1",
        [paymentId]))[0].total);

      /* A payment of 10.80 including 0.80 tax, settled with 0.07 of fees and the
       * tax NOT yet remitted. `tax_payable` therefore stands at -80: owed. */
      await seedTaxed("pay_tax_remit", BigInt(7), BigInt(80));
      check("before reconciliation the tax liability is outstanding",
        (await acctTotal("pay_tax_remit", "tax_payable")) === BigInt(-80),
        String(await acctTotal("pay_tax_remit", "tax_payable")));

      /* Whop now reports the remittance alongside the unchanged fee. */
      FAKE_WHOP = fakeWhop([
        { origin: "stripe_radar_fee", amount: "0.07" },
        { origin: "sales_tax_remittance", amount: "0.80" },
      ]);

      const remit = await fees.reconcileProviderFees("pay_tax_remit");
      check("a remittance arriving with NO fee change still posts — it is a real movement",
        remit.ok === true && remit.posted === true,
        show(remit));
      check("and the fee delta it reports is zero, because no fee changed",
        remit.ok && remit.deltaMinor === BigInt(0), show(remit.ok ? String(remit.deltaMinor) : remit));

      check("tax_payable is DISCHARGED by the provider's own remittance",
        (await acctTotal("pay_tax_remit", "tax_payable")) === BigInt(0),
        String(await acctTotal("pay_tax_remit", "tax_payable")));
      check("and provider_fee_expense is untouched by the tax",
        (await acctTotal("pay_tax_remit", "provider_fee_expense")) === BigInt(7),
        String(await acctTotal("pay_tax_remit", "provider_fee_expense")));
      check("every transaction for the payment still balances exactly",
        (await residualFor("pay_tax_remit")) === BigInt(0),
        String(await residualFor("pay_tax_remit")));

      /* THE LEG IS AUDITABLE AND DISTINGUISHABLE. */
      const [remitLeg] = await scoped.unsafe(
        "select e.source_detail, e.amount_minor::text as amount" +
        "  from " + SCRATCH + ".accounting_entries e" +
        "  join " + SCRATCH + ".accounting_transactions t on t.transaction_id = e.transaction_id" +
        " where t.economic_event = 'provider_fee_reconciled'" +
        "   and t.provider_resource_id = $1 and e.account = 'tax_payable'",
        ["pay_tax_remit"]);
      check("the correction's tax leg is labelled as a net remittance movement",
        remitLeg?.source_detail === "sales_tax_remittance_net" && remitLeg?.amount === "80",
        JSON.stringify(remitLeg));

      /* REPLAY CONVERGES. The provider has not changed its mind. */
      const replayTax = await fees.reconcileProviderFees("pay_tax_remit");
      check("replaying it posts nothing further",
        replayTax.ok === true && replayTax.posted === false, show(replayTax));
      check("and the liability stays discharged, not double-discharged",
        (await acctTotal("pay_tax_remit", "tax_payable")) === BigInt(0));

      /* A REVERSAL RESTORES IT, in whatever sign the provider uses. */
      FAKE_WHOP = fakeWhop([
        { origin: "stripe_radar_fee", amount: "0.07" },
        { origin: "sales_tax_remittance", amount: "0.80" },
        { origin: "sales_tax_remittance_reversal", amount: "-0.80" },
      ]);
      const reversed = await fees.reconcileProviderFees("pay_tax_remit");
      check("a remittance reversal posts against tax_payable",
        reversed.ok === true && reversed.posted === true, show(reversed));
      check("and restores the liability to outstanding",
        (await acctTotal("pay_tax_remit", "tax_payable")) === BigInt(-80),
        String(await acctTotal("pay_tax_remit", "tax_payable")));
      check("the payment's transactions still all balance",
        (await residualFor("pay_tax_remit")) === BigInt(0));

      /* stripe_sales_tax_fee IS A FEE. One word apart, different account. */
      await seedTaxed("pay_tax_svc", BigInt(7), BigInt(80));
      FAKE_WHOP = fakeWhop([
        { origin: "stripe_radar_fee", amount: "0.07" },
        { origin: "stripe_sales_tax_fee", amount: "0.05" },
      ]);
      const svc = await fees.reconcileProviderFees("pay_tax_svc");
      check("a Stripe tax-SERVICE fee reconciles as a fee",
        svc.ok === true && svc.posted === true && svc.deltaMinor === BigInt(5),
        show(svc.ok ? String(svc.deltaMinor) : svc));
      check("it lands in provider_fee_expense",
        (await acctTotal("pay_tax_svc", "provider_fee_expense")) === BigInt(12),
        String(await acctTotal("pay_tax_svc", "provider_fee_expense")));
      check("and leaves the tax liability alone",
        (await acctTotal("pay_tax_svc", "tax_payable")) === BigInt(-80),
        String(await acctTotal("pay_tax_svc", "tax_payable")));

      /* BOTH CLASSES MOVING AT ONCE: one transaction, three legs, balanced. */
      await seedTaxed("pay_tax_both", BigInt(7), BigInt(80));
      FAKE_WHOP = fakeWhop([
        { origin: "stripe_radar_fee", amount: "0.10" },
        { origin: "sales_tax_remittance", amount: "0.80" },
      ]);
      const both = await fees.reconcileProviderFees("pay_tax_both");
      check("a fee change and a remittance post together",
        both.ok === true && both.posted === true && both.deltaMinor === BigInt(3),
        show(both.ok ? String(both.deltaMinor) : both));
      check("each class reaches its own account",
        (await acctTotal("pay_tax_both", "provider_fee_expense")) === BigInt(10) &&
          (await acctTotal("pay_tax_both", "tax_payable")) === BigInt(0),
        (await acctTotal("pay_tax_both", "provider_fee_expense")) + "/" +
          (await acctTotal("pay_tax_both", "tax_payable")));
      check("and the combined correction balances",
        (await residualFor("pay_tax_both")) === BigInt(0));

      /* THE DRIFT INSPECTION REPORTS THE TWO SEPARATELY. */
      const inspected = await fees.inspectProviderFeeDrift("pay_tax_both");
      check("the inspection reports fee and tax totals as distinct figures",
        inspected.ok === true && inspected.actualMinor === BigInt(10) &&
          inspected.taxRemittanceActualMinor === BigInt(80),
        show(inspected.ok
          ? { fee: String(inspected.actualMinor), tax: String(inspected.taxRemittanceActualMinor) }
          : inspected));
      check("and both are bigints, in minor units",
        inspected.ok && typeof inspected.taxRemittanceDeltaMinor === "bigint" &&
          typeof inspected.deltaMinor === "bigint");

      /* THE CLASSIFIER IS SHARED, not re-implemented here. */
      const reconSrc = readFileSync("src/lib/server/accounting/whop-fee-reconciliation.ts", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      check("the reconciler uses the shared classifier",
        /from "\.\/fee-classification"/.test(reconSrc) &&
          !/"sales_tax_remittance"\s*===/.test(reconSrc));
      check("and compares each class against its own posted total",
        /postedTaxRemittanceTotal/.test(reconSrc) &&
          /account, "tax_payable"/.test(reconSrc));
      check("a zero fee delta alone is no longer treated as nothing to do",
        /delta === BigInt\(0\) && taxDelta === BigInt\(0\)/.test(reconSrc));
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    /* THE REAL DATABASE, AFTER. The invariant is "this suite added nothing". */
    section("H. the real database is untouched");
    const [afterTxns] = await client`select count(*)::int as n from public.accounting_transactions`;
    const [afterEntries] = await client`select count(*)::int as n from public.accounting_entries`;
    const [afterMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("this suite added no transaction to the real journal",
      afterTxns.n === beforeTxns.n, `${beforeTxns.n} -> ${afterTxns.n}`);
    check("nor any entry", afterEntries.n === beforeEntries.n,
      `${beforeEntries.n} -> ${afterEntries.n}`);
    check("nor applied any migration", afterMigrations.n === beforeMigrations.n,
      `${afterMigrations.n} migrations`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) => check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
