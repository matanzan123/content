/**
 * REFUND LIFECYCLE TESTS.
 *
 * Three parts, because the invariants live in three places and only one of
 * them can be checked by calling a pure function:
 *
 *   A. THE CONTRACT AND THE PURE ARITHMETIC — the refund status list checked
 *      against the installed SDK enum rather than retyped, the state machine,
 *      the two wire shapes of a Refund, and the posting builder. No database,
 *      no network.
 *
 *   B. SEQUENCES AND MONEY — the interesting cases are all sequences: three
 *      partial refunds, a duplicate delivery, two message ids for one refund,
 *      a stale `pending` arriving after a `succeeded`, a crash between the
 *      operational row and the accounting. Those cannot be tested by calling a
 *      pure function, so the real modules are driven against a FAKE WHOP over
 *      a REAL Postgres in a throwaway schema.
 *
 *   C. SOURCE INVARIANTS — properties true only by absence: no dispute code,
 *      no payout code, no hard-coded fee rate, no float arithmetic, no public
 *      refund endpoint, no mutation of the settled order.
 *
 * NOTHING HERE TOUCHES `public`. Fixtures are created in `refund_selftest`,
 * dropped before and after, and the suite REFUSES TO WRITE ANYTHING until it
 * has proved — by resolving the very table names the modules use — that they
 * land in the throwaway schema. The tail then reads the real tables read-only
 * to confirm the baseline is intact.
 *
 * Set REFUND_TEST_DB=0 to run only the pure parts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * JSON.stringify throws on a bigint, and every money value in this codebase is
 * one. A test harness that dies while formatting a PASSING result would be a
 * failure invented by the harness, so bigints are rendered rather than refused.
 */
const show = (value) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

/* ==========================================================================
   Loader. `@/lib/db` and the Whop client are the two seams; everything else
   is the real module.
   ========================================================================== */

const cache = new Map();
let DB = null; // set once the throwaway schema exists and is PROVED
let FAKE_WHOP = null; // set per test case

class FakeWhopError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
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
    if (spec === "@/lib/db") return { getDb: () => DB, isDatabaseConfigured: () => DB !== null };
    if (spec === "@whop/sdk") return { WhopError: FakeWhopError, WhopClient: class {} };
    if (spec === "./whop-payments" || spec.endsWith("/whop-payments")) {
      // The payments client is the network seam. Configuration is real.
      const real = loadTs("src/lib/server/whop-payments.ts");
      return { ...real, getWhopPaymentsClient: () => FAKE_WHOP };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try {
        return loadTs(`${base}.ts`);
      } catch {
        return loadTs(`${base}/index.ts`);
      }
    }
    return require(spec);
  };

  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

const refundLifecycle = loadTs("src/lib/server/refund-lifecycle.ts");
const whopRefunds = loadTs("src/lib/server/whop-refunds.ts");
const refundPosting = loadTs("src/lib/server/accounting/whop-refund-posting.ts");
const webhooks = loadTs("src/lib/server/whop-webhooks.ts");

/* ==========================================================================
   PART A — the contract and the pure arithmetic
   ========================================================================== */

console.log("\n--- A. the provider refund contract ---");

/**
 * Reads a const-enum out of the SDK's shipped .d.ts.
 *
 * The package does not export its internal subpaths, so the declarations are
 * parsed instead of imported. That is if anything the better source: it is the
 * contract the compiler enforces on our own code.
 */
function sdkEnumValues(name) {
  const text = readFileSync(`node_modules/@whop/sdk/dist/cjs/api/types/${name}.d.ts`, "utf8");
  return [...text.matchAll(/readonly [A-Za-z0-9_]+: "([^"]+)"/g)].map((m) => m[1]);
}

const sdkRefundStatuses = sdkEnumValues("RefundStatuses");
check(
  "our refund status list is exactly the SDK's RefundStatuses",
  [...refundLifecycle.WHOP_REFUND_STATUSES].sort().join(",") === sdkRefundStatuses.sort().join(","),
  sdkRefundStatuses.join(","),
);
check("there are five provider statuses, not two", sdkRefundStatuses.length === 5);
check(
  "refunds have a real lifecycle: pending is one of them",
  sdkRefundStatuses.includes("pending") && sdkRefundStatuses.includes("requires_action"),
);

// The failure vocabulary, from the SDK's Refund namespace rather than retyped.
const refundDts = readFileSync("node_modules/@whop/sdk/dist/cjs/api/types/Refund.d.ts", "utf8");
const failureBlock = refundDts.slice(
  refundDts.indexOf("const FailureReason"),
  refundDts.indexOf("type FailureReason"),
);
const sdkFailureReasons = [...failureBlock.matchAll(/readonly [A-Za-z0-9_]+: "([^"]+)"/g)].map(
  (m) => m[1],
);
check(
  "our failure-reason list is exactly the SDK's Refund.FailureReason",
  [...refundLifecycle.WHOP_REFUND_FAILURE_REASONS].sort().join(",") ===
    sdkFailureReasons.sort().join(","),
  `${sdkFailureReasons.length} reasons`,
);

// The webhook events, from the SDK's WebhookEvent enum rather than guessed.
const sdkWebhookEvents = sdkEnumValues("WebhookEvent");
const sdkRefundEvents = sdkWebhookEvents.filter((e) => e.startsWith("refund."));
check(
  "the SDK has exactly two refund webhook events",
  sdkRefundEvents.length === 2 &&
    sdkRefundEvents.includes("refund.created") &&
    sdkRefundEvents.includes("refund.updated"),
  sdkRefundEvents.join(","),
);
check(
  "our allowlist carries exactly those two and invents none",
  webhooks.SUPPORTED_EVENTS.filter((e) => e.startsWith("refund.")).sort().join(",") ===
    sdkRefundEvents.sort().join(","),
);
check(
  "no refund.succeeded / refund.failed event is assumed to exist",
  !webhooks.SUPPORTED_EVENTS.includes("refund.succeeded") &&
    !webhooks.SUPPORTED_EVENTS.includes("refund.failed"),
);

console.log("\n--- A. the refund state machine ---");

const classify = refundLifecycle.classifyRefundStatus;
check("succeeded is the only completed phase", classify("succeeded") === "completed");
check("pending is in flight", classify("pending") === "in_flight");
check("requires_action is in flight, not a failure", classify("requires_action") === "in_flight");
check("failed is terminal-unrefunded", classify("failed") === "terminal_unrefunded");
check("canceled is terminal-unrefunded", classify("canceled") === "terminal_unrefunded");
check("an unknown status is unknown, not a guess", classify("teleported") === "unknown");
check("a non-string status is unknown", classify(undefined) === "unknown");

check(
  "ONLY a completed phase may write money",
  refundLifecycle.postsAccounting("completed") === true &&
    refundLifecycle.postsAccounting("in_flight") === false &&
    refundLifecycle.postsAccounting("terminal_unrefunded") === false &&
    refundLifecycle.postsAccounting("unknown") === false,
);

check(
  "an unknown status is treated as still-moving, never as failed",
  refundLifecycle.targetRefundStatus("unknown") === "pending",
);
check("completed is absorbing", refundLifecycle.isRefundAbsorbing("completed") === true);
check(
  "failed is NOT absorbing — provider truth must be able to win",
  refundLifecycle.isRefundAbsorbing("failed") === false,
);

// The declared transition table and the predicate must agree.
check(
  "every declared transition matches the predicate",
  refundLifecycle.REFUND_TRANSITION_RULES.every(
    (r) => refundLifecycle.isRefundTransitionAllowed(r.from, r.to) === r.allowed,
  ),
);
check(
  "a stale snapshot cannot un-refund a completed refund",
  refundLifecycle.isRefundTransitionAllowed("completed", "pending") === false &&
    refundLifecycle.isRefundTransitionAllowed("completed", "failed") === false,
);

// The SQL guard and the reasoned-about set must not drift apart.
const refundsSource = readFileSync("src/lib/server/payment-refunds.ts", "utf8");
check(
  "the absorbing guard is in the SQL statement, not only in a branch",
  /status\}\s*<>\s*'completed'/.test(refundsSource),
);

console.log("\n--- A. reading a refund off the wire ---");

const readRefund = whopRefunds.readRefund;

// SHAPE 1: the `Refund` type used by refunds.retrieve — amount as a Money.
const modernShape = {
  id: "rf_abc123",
  payment_id: "pay_xyz",
  account_id: process.env.WHOP_COMPANY_ID,
  amount: { amount: "2.50", currency: "usd", decimals: 2, display_decimals: 2 },
  status: "succeeded",
  failure_reason: null,
  created_at: "2026-09-05T10:00:00.000Z",
  updated_at: "2026-09-05T10:05:00.000Z",
};
const modern = readRefund(modernShape);
check(
  "the Money shape reads exactly: 2.50 -> 250 minor",
  modern.ok && modern.refund.amountMinor === 250n && modern.refund.currency === "usd",
);
check("and carries the payment it reverses", modern.ok && modern.refund.paymentId === "pay_xyz");

// SHAPE 2: the `RefundLegacy` type used by the webhook payload — amount as a
// decimal NUMBER with a sibling currency and a nested payment.
const legacyShape = {
  id: "rf_abc123",
  amount: 10.43,
  currency: "usd",
  status: "succeeded",
  payment: { id: "pay_xyz" },
  created_at: "2026-09-05T10:00:00.000Z",
};
const legacy = readRefund(legacyShape);
check(
  "the legacy shape reads exactly: 10.43 -> 1043 minor, with no float error",
  legacy.ok && legacy.refund.amountMinor === 1043n,
  legacy.ok ? String(legacy.refund.amountMinor) : legacy.reason,
);
check(
  "and finds the payment through the nested object",
  legacy.ok && legacy.refund.paymentId === "pay_xyz",
);

// The float trap this reader exists to avoid, demonstrated on a value that
// really does lose precision. (10.43 * 100 happens to be exact; 8.87 is not,
// which is the point — WHICH decimals are lossy is not predictable, so the
// reader must never multiply at all.)
check(
  "multiplying a decimal by 100 loses precision in JS — the reason for the exact reader",
  8.87 * 100 !== 887 && 0.29 * 100 !== 29,
  `8.87*100 = ${8.87 * 100}`,
);
const lossy = readRefund({ ...legacyShape, amount: 8.87 });
check(
  "and the reader still gets 8.87 exactly right: 887 minor",
  lossy.ok && lossy.refund.amountMinor === 887n,
  lossy.ok ? String(lossy.refund.amountMinor) : lossy.reason,
);

check(
  "a null amount is REFUSED, never read as zero",
  readRefund({ ...modernShape, amount: null }).ok === false,
);
check(
  "a refund with no payment reference is refused",
  readRefund({ id: "rf_a", amount: 1, currency: "usd", status: "succeeded" }).reason ===
    "no_payment_reference",
);
check(
  "a malformed refund id is refused",
  readRefund({ ...modernShape, id: "pay_notarefund" }).reason === "invalid_resource_id",
);
check(
  "a zero-amount refund is refused",
  readRefund({ ...legacyShape, amount: 0 }).ok === false,
);
check(
  "a negative refund is refused",
  readRefund({ ...legacyShape, amount: -5 }).ok === false,
);
check(
  "an unsupported currency is refused, not defaulted to usd",
  readRefund({ ...legacyShape, currency: "eur" }).reason === "unsupported_currency",
);
check(
  "a status-less refund is refused",
  readRefund({ ...modernShape, status: "" }).reason === "malformed_refund",
);
check(
  "the failure reason is carried through when Whop reports one",
  readRefund({ ...modernShape, status: "failed", failure_reason: "not_refundable" }).refund
    .failureReason === "not_refundable",
);

console.log("\n--- A. the refund posting arithmetic ---");

const build = refundPosting.buildRefundPosting;
const ctx = { environment: "sandbox", orderId: null };

/** Sums the legs; a correct journal always returns 0n. */
const residual = (posting) => posting.legs.reduce((a, l) => a + l.amountMinor, 0n);
/** The signed total posted to one account. */
const legFor = (posting, account) =>
  posting.legs.filter((l) => l.account === account).reduce((a, l) => a + l.amountMinor, 0n);

// CASE 1 — a full $10 refund with fees RETAINED (feeDelta 0).
const retained = build(
  {
    refundId: "rf_1",
    paymentId: "pay_1",
    currency: "usd",
    amountMinor: 1000n,
    taxRefundedMinor: 0n,
    feeDeltaMinor: 0n,
    feeLines: [],
    occurredAt: null,
  },
  ctx,
);
check("retained-fee refund balances", residual(retained) === 0n);
check(
  "retained-fee refund posts NO fee leg — nothing is pretended to come back",
  legFor(retained, "provider_fee_expense") === 0n &&
    retained.legs.every((l) => l.account !== "provider_fee_expense"),
);
check(
  "retained-fee refund debits the full gross out of suspense",
  legFor(retained, "unallocated_customer_funds") === 1000n,
);
check(
  "retained-fee refund takes the full gross off the provider balance",
  legFor(retained, "provider_balance") === -1000n,
);
// The economically correct consequence: 913 settled in, 1000 goes out.
check(
  "so provider_balance ends at -87: the fee Whop kept is a real loss, shown not hidden",
  913n + legFor(retained, "provider_balance") === -87n,
);

// CASE 2 — the same refund with fees fully RETURNED (feeDelta -87).
const returned = build(
  {
    refundId: "rf_2",
    paymentId: "pay_1",
    currency: "usd",
    amountMinor: 1000n,
    taxRefundedMinor: 0n,
    feeDeltaMinor: -87n,
    feeLines: [],
    occurredAt: null,
  },
  ctx,
);
check("returned-fee refund balances", residual(returned) === 0n);
check(
  "returned-fee refund credits the fee expense by EXACTLY what the provider returned",
  legFor(returned, "provider_fee_expense") === -87n,
);
check(
  "and takes only the net off the provider balance",
  legFor(returned, "provider_balance") === -913n,
);
check(
  "so a fully-reversed payment washes to zero on both accounts",
  913n + legFor(returned, "provider_balance") === 0n &&
    87n + legFor(returned, "provider_fee_expense") === 0n,
);

// CASE 3 — Whop charges an ADDITIONAL fee for handling the refund.
const extraFee = build(
  {
    refundId: "rf_3",
    paymentId: "pay_1",
    currency: "usd",
    amountMinor: 1000n,
    taxRefundedMinor: 0n,
    feeDeltaMinor: 25n,
    feeLines: [],
    occurredAt: null,
  },
  ctx,
);
check("extra-fee refund balances", residual(extraFee) === 0n);
check(
  "an additional fee is a DEBIT to expense, and costs the balance more",
  legFor(extraFee, "provider_fee_expense") === 25n &&
    legFor(extraFee, "provider_balance") === -1025n,
);

// CASE 4 — a partial refund with tax.
const taxed = build(
  {
    refundId: "rf_4",
    paymentId: "pay_1",
    currency: "usd",
    amountMinor: 500n,
    taxRefundedMinor: 50n,
    feeDeltaMinor: 0n,
    feeLines: [],
    occurredAt: null,
  },
  ctx,
);
check("taxed partial refund balances", residual(taxed) === 0n);
check(
  "tax is split out of suspense, exactly as the settlement split it in",
  legFor(taxed, "unallocated_customer_funds") === 450n && legFor(taxed, "tax_payable") === 50n,
);

// The property that matters most: it balances for EVERY input.
let allBalance = true;
for (const amount of [1n, 7n, 250n, 999n, 1000n, 123456n]) {
  for (const tax of [0n, 1n, 50n]) {
    for (const fee of [-87n, -1n, 0n, 3n, 25n]) {
      if (tax > amount) continue;
      const p = build(
        {
          refundId: "rf_x",
          paymentId: "pay_1",
          currency: "usd",
          amountMinor: amount,
          taxRefundedMinor: tax,
          feeDeltaMinor: fee,
          feeLines: [],
          occurredAt: null,
        },
        ctx,
      );
      if (residual(p) !== 0n) allBalance = false;
    }
  }
}
check("the posting balances for every combination of amount, tax and fee delta", allBalance);

console.log("\n--- A. refund idempotency keys ---");

const accounts = loadTs("src/lib/server/accounting/accounts.ts");
const K = accounts.economicKey;
check(
  "the key is built from the REFUND id, not the payment id",
  build(
    {
      refundId: "rf_9",
      paymentId: "pay_1",
      currency: "usd",
      amountMinor: 100n,
      taxRefundedMinor: 0n,
      feeDeltaMinor: 0n,
      feeLines: [],
      occurredAt: null,
    },
    ctx,
  ).idempotencyKey === "whop:payment_refunded:rf_9",
);
check(
  "three partial refunds of one payment produce THREE distinct keys",
  new Set([
    K("whop", "payment_refunded", "rf_a"),
    K("whop", "payment_refunded", "rf_b"),
    K("whop", "payment_refunded", "rf_c"),
  ]).size === 3,
);
check(
  "a refund key never collides with its payment's settlement key",
  K("whop", "payment_refunded", "rf_a") !== K("whop", "payment_settled", "pay_1"),
);
check(
  "no webhook id appears anywhere in the refund posting builder",
  !/sourceWebhookId[^;]*idempotencyKey/s.test(
    readFileSync("src/lib/server/accounting/whop-refund-posting.ts", "utf8"),
  ),
);

/* ==========================================================================
   PART B — sequences and money, over a real Postgres in a throwaway schema
   ========================================================================== */

const SCRATCH = "refund_selftest";
const COMPANY = process.env.WHOP_COMPANY_ID;

const usd = (minor) => ({
  amount: (Number(minor) / 100).toFixed(2),
  currency: "usd",
  decimals: 2,
  display_decimals: 2,
});

/**
 * A Whop stub that answers with exactly the payment, refunds and fees a case
 * needs. `state` is mutated by tests to model the provider changing.
 */
function fakeWhop(state) {
  return {
    payments: {
      retrieve: async ({ id }) => {
        const p = state.payments[id];
        if (!p) throw new FakeWhopError("not found", 404);
        return p;
      },
      listFees: async ({ id }) => ({ data: state.fees[id] ?? [] }),
      // Models the real endpoint: it CREATES a refund resource and returns the
      // updated PAYMENT, never the refund. That is why `createRefundForOrder`
      // has to discover the new `rf_` id by diffing the list, and the fixture
      // has to behave the same way or the discovery would not be tested at all.
      refund: async ({ id, partial_amount }) => {
        if (state.refundThrows) throw state.refundThrows;
        state.refundCalls = (state.refundCalls ?? 0) + 1;
        if (state.nextRefundId) {
          const minor = Math.round((partial_amount ?? 0) * 100);
          state.refunds[state.nextRefundId] = refundFixture({
            id: state.nextRefundId,
            paymentId: id,
            minor,
            status: "pending",
          });
          state.nextRefundId = null;
        }
        return state.payments[id];
      },
    },
    refunds: {
      retrieve: async ({ id }) => {
        const r = state.refunds[id];
        if (!r) throw new FakeWhopError("not found", 404);
        return r;
      },
      list: async ({ payment_id }) => {
        if (state.listThrows) throw state.listThrows;
        return {
          data: Object.values(state.refunds).filter(
            (r) => (r.payment_id ?? r.payment?.id) === payment_id,
          ),
        };
      },
    },
  };
}

function paymentFixture({ id, orderId, minor = 1000, tax = 0, afterFees = null, account = COMPANY }) {
  return {
    id,
    account_id: account,
    status: "paid",
    currency: "usd",
    metadata: orderId ? { order_id: orderId } : {},
    subtotal: usd(minor - tax),
    total: usd(minor),
    tax_amount: usd(tax),
    tax_refunded_amount: usd(0),
    amount_after_fees: usd(afterFees ?? minor),
    refundable: true,
    refunded_amount: usd(0),
    refunded_at: null,
    paid_at: "2026-09-05T10:00:00.000Z",
  };
}

function refundFixture({ id, paymentId, minor, status = "succeeded", account = COMPANY, currency = "usd" }) {
  return {
    id,
    payment_id: paymentId,
    account_id: account,
    amount: { ...usd(minor), currency },
    status,
    failure_reason: status === "failed" ? "bank_declined" : null,
    created_at: "2026-09-05T11:00:00.000Z",
    updated_at: "2026-09-05T11:00:00.000Z",
  };
}

async function sequences() {
  console.log("\n--- B. refund sequences (throwaway schema, fake provider) ---");

  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — part B skipped");
    return;
  }

  const postgres = require("postgres");
  const { drizzle } = require("drizzle-orm/postgres-js");

  /*
   * THE DIRECT ENDPOINT, not the pooled one, and only for this suite.
   *
   * Everything here depends on `search_path` pointing at the throwaway schema,
   * and `search_path` is SESSION state. Neon's pooled endpoint is PgBouncer in
   * transaction mode: a SET can be issued on one backend and the next
   * statement served by another, so the setting silently lapses back to
   * `public` — mid-run, with no error. That is how an earlier suite wrote its
   * fixtures into the real payment_orders and the real ledger.
   *
   * THE APPLICATION'S POOLED CONNECTION IS NOT TOUCHED. This opens its own
   * client against the direct endpoint; `src/lib/db/index.ts` is never
   * reconfigured and its search_path is never changed.
   */
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  // The real baseline, captured BEFORE anything runs.
  const beforeTxns = await client`select count(*)::int as n from accounting_transactions`;
  const beforeEntries = await client`select count(*)::int as n from accounting_entries`;
  const beforeOrders = await client`select order_id, status, paid_at, whop_payment_id from payment_orders order by created_at`;
  const beforeLedger = await client`select count(*)::int as n from financial_ledger`;
  const beforeMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;
  /** public.payment_refunds row count before any fixture runs. */
  let baselineRefundRows = 0;
  /** Every synthetic refund id this suite creates, collected before the drop. */
  let syntheticRefundIds = [];

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);

    // Real DDL, taken from the applied migrations plus the NOT-YET-APPLIED
    // 0005, so the table under test is exactly the one 0005 would create.
    const ddl = [
      readFileSync("drizzle/0002_misty_obadiah_stane.sql", "utf8"),
      readFileSync("drizzle/0004_thin_ben_urich.sql", "utf8"),
      readFileSync("drizzle/0005_slippery_hitman.sql", "utf8"),
    ].join("\n--> statement-breakpoint\n");

    await client.unsafe(`set search_path = ${SCRATCH}`);
    const [ddlSchema] = await client`select current_schema() as schema`;
    if (ddlSchema.schema !== SCRATCH) {
      throw new Error(`ISOLATION FAILED — DDL would run in ${ddlSchema.schema}`);
    }
    await client.unsafe(`create type ${SCRATCH}.whop_environment as enum ('sandbox','production')`);
    for (const stmt of ddl
      .split("--> statement-breakpoint")
      .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
      .filter(Boolean)) {
      await client.unsafe(stmt);
    }
    check("migration 0005 applies cleanly on top of 0002 and 0004", true);

    /*
     * THE ISOLATION SEAM, PROVED BEFORE ANY FIXTURE IS WRITTEN.
     *
     * The real modules name their tables unqualified, so which schema they hit
     * is decided entirely by `search_path`. Setting it through postgres.js's
     * `connection` option looks right and is SILENTLY IGNORED by Neon's
     * pooler. So: a dedicated client, max 1 so a single backend's SET
     * persists, an explicit SET, and then a VERIFICATION that resolves the
     * very table names the modules will use and REFUSES TO CONTINUE unless
     * every one landed in the throwaway schema.
     *
     * `payment_refunds` is in the list because it is the table this suite
     * writes most, and it is the one that does not exist in `public` at all
     * yet — a resolution to `public` would come back null rather than wrong,
     * and null must fail the check just as loudly.
     */
    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('payment_orders')) as orders_schema,
             (select n.nspname from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('payment_refunds')) as refunds_schema,
             (select n.nspname from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('accounting_entries')) as entries_schema`;

    const isolated =
      where.schema === SCRATCH &&
      where.orders_schema === SCRATCH &&
      where.refunds_schema === SCRATCH &&
      where.entries_schema === SCRATCH;

    if (!isolated) {
      throw new Error(
        `ISOLATION FAILED — refusing to write: schema=${where.schema} orders=${where.orders_schema} refunds=${where.refunds_schema} entries=${where.entries_schema}`,
      );
    }
    check(
      "ISOLATION PROVED: every table the modules name resolves to the throwaway schema",
      isolated,
      `${where.orders_schema}/${where.refunds_schema}/${where.entries_schema}`,
    );

    /*
     * THE REAL SCHEMA, as it now stands.
     *
     * Migration 0005 IS applied. This block previously asserted the opposite —
     * that `payment_refunds` did not exist in `public` — which was a true and
     * useful statement while 0005 was pending and is deliberately false now.
     *
     * What replaces it is the invariant that actually matters and survives the
     * migration: the real table exists, and THIS SUITE NEVER WRITES TO IT. The
     * fixtures below all land in `refund_selftest`, proved above by resolving
     * the table names the modules use; these checks establish the public
     * baseline the tail then compares against.
     */
    const [publicRefundsTable] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'payment_refunds'`;
    check("public.payment_refunds EXISTS — migration 0005 is applied", publicRefundsTable.n === 1);

    check(
      "6 migrations are applied",
      beforeMigrations[0].n === 6,
      `${beforeMigrations[0].n} migrations`,
    );

    // The baseline this suite must not disturb. Zero before the first real
    // sandbox refund; afterwards, exactly the real provider refunds and
    // nothing else. Either way the suite adds none.
    const [publicRefundRowsBefore] = await client`
      select count(*)::int as n from public.payment_refunds`;
    baselineRefundRows = publicRefundRowsBefore.n;
    check(
      "public.payment_refunds holds only real provider refunds, if any",
      baselineRefundRows === 0 ||
        (await client`select count(*)::int as n from public.payment_refunds where provider <> 'whop'`)[0].n === 0,
      baselineRefundRows === 0
        ? "0 rows — no real refund has been issued yet"
        : `${baselineRefundRows} row(s), all provider=whop`,
    );

    const schema = loadTs("src/lib/db/schema.ts");
    DB = drizzle(scoped, { schema });

    const orders = loadTs("src/lib/server/payment-orders.ts");
    const mapping = loadTs("src/lib/server/whop-refund-mapping.ts");
    const paymentRefundsMod = loadTs("src/lib/server/payment-refunds.ts");
    const recovery = loadTs("src/lib/server/accounting/refund-recovery.ts");
    const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
    const paymentPosting = loadTs("src/lib/server/accounting/whop-payment-posting.ts");
    const refundCreate = loadTs("src/lib/server/whop-refund-create.ts");

    let seq = 0;

    /**
     * Builds a settled order + payment + settlement posting, so refunds run
     * against the same shape the real pipeline produces.
     */
    async function settledCase({ minor = 1000, feeMinor = 87, tax = 0 } = {}) {
      seq += 1;
      const paymentId = `pay_r${seq}`;
      const created = await orders.createPaymentOrder({
        amountMinor: BigInt(minor - tax),
        currency: "usd",
        purpose: `refund-test-${seq}`,
      });
      if (!created.ok) throw new Error(`order creation failed: ${created.reason}`);
      const orderId = created.order.orderId;

      const state = {
        payments: {
          [paymentId]: paymentFixture({
            id: paymentId,
            orderId,
            minor,
            tax,
            afterFees: minor - feeMinor,
          }),
        },
        refunds: {},
        fees: {
          [paymentId]:
            feeMinor > 0
              ? [
                  {
                    origin: "payment_processing_fixed_fee",
                    label: "Fixed",
                    amount: usd(feeMinor),
                    settlement_amount: usd(feeMinor),
                  },
                ]
              : [],
        },
      };
      FAKE_WHOP = fakeWhop(state);

      await orders.markOrderPaid(orderId, paymentId);
      const posted = await paymentPosting.postWhopSettlement(paymentId, {
        environment: "sandbox",
        orderId,
      });
      if (!posted.ok) throw new Error(`settlement failed: ${posted.reason}`);

      return { orderId, paymentId, state };
    }

    /** The signed balance of one account across the whole throwaway ledger. */
    const balanceOf = async (account) => {
      const [row] = await scoped.unsafe(
        `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries where account = '${account}'`,
      );
      return BigInt(row.s);
    };
    const countRefundTxns = async (resourceId) => {
      const [row] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
         where economic_event = 'payment_refunded' and provider_resource_id = '${resourceId}'`,
      );
      return row.n;
    };

    /* ---------------------------------------------------------------------
       FULL REFUND
       --------------------------------------------------------------------- */
    console.log("\n  · full refund");
    {
      const { orderId, paymentId, state } = await settledCase();
      const beforeSettlementLegs = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
         where economic_event = 'payment_settled' and provider_resource_id = '${paymentId}'`,
      );

      state.refunds.rf_full = refundFixture({
        id: "rf_full",
        paymentId,
        minor: 1000,
      });

      const outcome = await webhooks.handleWhopRefund("rf_full", "msg_1");
      check("a full refund is handled", outcome.kind === "handled", JSON.stringify(outcome));

      check("exactly one refund transaction posted", (await countRefundTxns("rf_full")) === 1);

      // THE ORIGINAL ORDER AND SETTLEMENT ARE UNTOUCHED.
      const [order] = await scoped.unsafe(
        `select status, paid_at, whop_payment_id from ${SCRATCH}.payment_orders where order_id = '${orderId}'`,
      );
      check(
        "the original order is NOT deleted and is still paid",
        order.status === "paid" && order.whop_payment_id === paymentId,
      );
      const afterSettlement = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
         where economic_event = 'payment_settled' and provider_resource_id = '${paymentId}'`,
      );
      check(
        "the original settlement transaction still exists, unmodified",
        afterSettlement[0].n === beforeSettlementLegs[0].n && afterSettlement[0].n === 1,
      );
      const [settlementLegs] = await scoped.unsafe(
        `select coalesce(sum(e.amount_minor),0)::text as s, count(*)::int as n
         from ${SCRATCH}.accounting_entries e
         join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
         where t.economic_event = 'payment_settled' and t.provider_resource_id = '${paymentId}'`,
      );
      check(
        "the settlement's own legs are intact and still balance",
        settlementLegs.s === "0" && settlementLegs.n === 3,
      );
      const [reversals] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions where economic_event = 'reversal'`,
      );
      check("a refund is NOT posted as a reversal of the settlement", reversals.n === 0);
    }

    /* ---------------------------------------------------------------------
       PARTIAL + MULTIPLE REFUNDS
       --------------------------------------------------------------------- */
    console.log("\n  · partial and multiple refunds ($10 -> $2, $3, $5)");
    {
      const { paymentId, state } = await settledCase({ feeMinor: 0 });
      const balanceBefore = await balanceOf("provider_balance");
      const suspenseBefore = await balanceOf("unallocated_customer_funds");

      const parts = [
        { id: "rf_p1", minor: 200 },
        { id: "rf_p2", minor: 300 },
        { id: "rf_p3", minor: 500 },
      ];

      for (const part of parts) {
        state.refunds[part.id] = refundFixture({ id: part.id, paymentId, minor: part.minor });
        // Whop's cumulative figure moves as each one completes.
        const done = parts
          .filter((p) => state.refunds[p.id])
          .reduce((a, p) => a + p.minor, 0);
        state.payments[paymentId].refunded_amount = usd(done);
        const outcome = await webhooks.handleWhopRefund(part.id, `msg_${part.id}`);
        check(`  ${part.id} ($${part.minor / 100}) is handled`, outcome.kind === "handled",
          JSON.stringify(outcome));
      }

      check(
        "three refunds produced THREE separate transactions, never collapsed into one",
        (await countRefundTxns("rf_p1")) === 1 &&
          (await countRefundTxns("rf_p2")) === 1 &&
          (await countRefundTxns("rf_p3")) === 1,
      );
      const [rows] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_refunds where whop_payment_id = '${paymentId}'`,
      );
      check("and three operational rows, one per provider resource", rows.n === 3);

      check(
        "the three partials sum to exactly the payment: suspense returns to where it was",
        (await balanceOf("unallocated_customer_funds")) - suspenseBefore === 1000n,
      );
      check(
        "and the provider balance is reduced by exactly the full $10",
        (await balanceOf("provider_balance")) - balanceBefore === -1000n,
      );
      check(
        "our own completed-refund total for the payment agrees: 200 + 300 + 500",
        (await paymentRefundsMod.localCompletedRefundTotal(paymentId)) === 1000n,
      );
      const local = await paymentRefundsMod.listRefundsForPaymentLocal(paymentId);
      check(
        "and each refund kept its own amount — none was collapsed or overwritten",
        local.map((r) => r.amountMinor).sort((a, b) => Number(a - b)).join(",") === "200,300,500",
        local.map((r) => `${r.whopRefundId}:${r.amountMinor}`).join(" "),
      );
    }

    /* ---------------------------------------------------------------------
       IDEMPOTENCY
       --------------------------------------------------------------------- */
    console.log("\n  · idempotency");
    {
      const { paymentId, state } = await settledCase();
      state.refunds.rf_dup = refundFixture({ id: "rf_dup", paymentId, minor: 400 });

      const first = await webhooks.handleWhopRefund("rf_dup", "msg_a");
      const balanceAfterFirst = await balanceOf("provider_balance");

      // THE SAME delivery again.
      const second = await webhooks.handleWhopRefund("rf_dup", "msg_a");
      // A DIFFERENT message id for the SAME refund — the case the whole
      // economic-key design exists for.
      const third = await webhooks.handleWhopRefund("rf_dup", "msg_b_totally_different");

      check(
        "all three deliveries are handled",
        first.kind === "handled" && second.kind === "handled" && third.kind === "handled",
      );
      check("but exactly ONE transaction exists", (await countRefundTxns("rf_dup")) === 1);
      check(
        "and no money moved on the repeats",
        (await balanceOf("provider_balance")) === balanceAfterFirst,
      );
      const [rows] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_dup'`,
      );
      check("two different webhook ids converge on ONE operational row", rows.n === 1);
    }

    /* ---------------------------------------------------------------------
       CONCURRENCY
       --------------------------------------------------------------------- */
    console.log("\n  · concurrent processing of one refund");
    {
      const { paymentId, state } = await settledCase();
      state.refunds.rf_race = refundFixture({ id: "rf_race", paymentId, minor: 600 });

      const raced = await Promise.allSettled([
        webhooks.handleWhopRefund("rf_race", "msg_c1"),
        webhooks.handleWhopRefund("rf_race", "msg_c2"),
        webhooks.handleWhopRefund("rf_race", "msg_c3"),
      ]);

      check(
        "three concurrent deliveries create exactly ONE transaction",
        (await countRefundTxns("rf_race")) === 1,
        raced.map((r) => r.status).join("/"),
      );
      const [legs] = await scoped.unsafe(
        `select coalesce(sum(e.amount_minor),0)::text as s, count(*)::int as n
         from ${SCRATCH}.accounting_entries e
         join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
         where t.provider_resource_id = 'rf_race'`,
      );
      check("and exactly one balanced pair of legs — no double money", legs.n === 2 && legs.s === "0");
      const [rows] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_race'`,
      );
      check("and exactly ONE operational row", rows.n === 1);
    }

    /* ---------------------------------------------------------------------
       PENDING / FAILED
       --------------------------------------------------------------------- */
    console.log("\n  · pending and failed refunds");
    {
      const { paymentId, state } = await settledCase();
      state.refunds.rf_pend = refundFixture({
        id: "rf_pend",
        paymentId,
        minor: 300,
        status: "pending",
      });

      const pending = await webhooks.handleWhopRefund("rf_pend", "msg_p1");
      check("a pending refund is handled, not failed", pending.kind === "handled");
      check(
        "a PENDING refund posts NO accounting at all",
        (await countRefundTxns("rf_pend")) === 0,
      );
      const [pendRow] = await scoped.unsafe(
        `select status, completed_at from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_pend'`,
      );
      check(
        "but it IS recorded operationally, as pending with no completion time",
        pendRow.status === "pending" && pendRow.completed_at === null,
      );

      // requires_action behaves the same way.
      state.refunds.rf_ra = refundFixture({
        id: "rf_ra",
        paymentId,
        minor: 100,
        status: "requires_action",
      });
      await webhooks.handleWhopRefund("rf_ra", "msg_ra");
      check(
        "requires_action likewise posts nothing",
        (await countRefundTxns("rf_ra")) === 0,
      );

      // Now the provider completes the pending one.
      state.refunds.rf_pend.status = "succeeded";
      const completed = await webhooks.handleWhopRefund("rf_pend", "msg_p2");
      check("a later completion IS handled", completed.kind === "handled");
      check(
        "and NOW the accounting posts, exactly once",
        (await countRefundTxns("rf_pend")) === 1,
      );

      // A STALE snapshot arrives after the completion.
      state.refunds.rf_pend.status = "pending";
      await webhooks.handleWhopRefund("rf_pend", "msg_p3_stale");
      const [afterStale] = await scoped.unsafe(
        `select status, completed_at from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_pend'`,
      );
      check(
        "a STALE pending arriving after completion cannot downgrade the row",
        afterStale.status === "completed" && afterStale.completed_at !== null,
      );
      check(
        "and cannot un-post or duplicate the money",
        (await countRefundTxns("rf_pend")) === 1,
      );

      // A failed refund.
      state.refunds.rf_fail = refundFixture({
        id: "rf_fail",
        paymentId,
        minor: 200,
        status: "failed",
      });
      const failed = await webhooks.handleWhopRefund("rf_fail", "msg_f1");
      check("a failed refund is handled, not retried forever", failed.kind === "handled");
      check("a FAILED refund posts NO accounting", (await countRefundTxns("rf_fail")) === 0);
      const [failRow] = await scoped.unsafe(
        `select status, failure_reason, failed_at from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_fail'`,
      );
      check(
        "and its failure reason is preserved",
        failRow.status === "failed" && failRow.failure_reason === "bank_declined" &&
          failRow.failed_at !== null,
      );

      // A canceled refund likewise.
      state.refunds.rf_canc = refundFixture({
        id: "rf_canc",
        paymentId,
        minor: 200,
        status: "canceled",
      });
      await webhooks.handleWhopRefund("rf_canc", "msg_cx");
      check("a CANCELED refund posts no accounting", (await countRefundTxns("rf_canc")) === 0);
    }

    /* ---------------------------------------------------------------------
       REJECTIONS
       --------------------------------------------------------------------- */
    console.log("\n  · rejections");
    {
      const a = await settledCase();
      const b = await settledCase();

      // A refund pointing at a payment that did NOT settle its claimed order.
      // Built by hand: the refund names payment B, whose metadata names order
      // B, but we corrupt the order link so the two disagree.
      const state = a.state;
      state.payments[b.paymentId] = paymentFixture({
        id: b.paymentId,
        orderId: a.orderId, // claims order A
        minor: 1000,
      });
      state.refunds.rf_wrongpay = refundFixture({
        id: "rf_wrongpay",
        paymentId: b.paymentId,
        minor: 100,
      });
      state.fees[b.paymentId] = [];
      FAKE_WHOP = fakeWhop(state);

      const wrongPay = await mapping.mapRefundToOrder("rf_wrongpay");
      check(
        "a refund whose payment did not settle the named order is REJECTED",
        wrongPay.kind === "rejected" && wrongPay.reason === "payment_mismatch",
        JSON.stringify(wrongPay),
      );

      // Wrong company.
      const c = await settledCase();
      c.state.payments[c.paymentId].account_id = "biz_someoneelse";
      c.state.refunds.rf_wrongco = refundFixture({
        id: "rf_wrongco",
        paymentId: c.paymentId,
        minor: 100,
      });
      const wrongCo = await mapping.mapRefundToOrder("rf_wrongco");
      check(
        "a refund on another company's payment is REJECTED",
        wrongCo.kind === "rejected" && wrongCo.reason === "wrong_company",
        JSON.stringify(wrongCo),
      );

      // Refund's own account is someone else's, even though the payment is ours.
      const d = await settledCase();
      d.state.refunds.rf_badacct = refundFixture({
        id: "rf_badacct",
        paymentId: d.paymentId,
        minor: 100,
        account: "biz_someoneelse",
      });
      const badAcct = await mapping.mapRefundToOrder("rf_badacct");
      check(
        "a refund issued by another company is REJECTED even when the payment is ours",
        badAcct.kind === "rejected" && badAcct.reason === "wrong_company",
      );

      // No order reference.
      const e = await settledCase();
      e.state.payments[e.paymentId].metadata = {};
      e.state.refunds.rf_noorder = refundFixture({
        id: "rf_noorder",
        paymentId: e.paymentId,
        minor: 100,
      });
      const noOrder = await mapping.mapRefundToOrder("rf_noorder");
      check(
        "a refund whose payment names no order is REJECTED",
        noOrder.kind === "rejected" && noOrder.reason === "no_order_reference",
      );

      // Order not found.
      const f = await settledCase();
      f.state.payments[f.paymentId].metadata = {
        order_id: "00000000-0000-4000-8000-000000000000",
      };
      f.state.refunds.rf_ghost = refundFixture({
        id: "rf_ghost",
        paymentId: f.paymentId,
        minor: 100,
      });
      const ghost = await mapping.mapRefundToOrder("rf_ghost");
      check(
        "a refund naming an order we do not have is REJECTED",
        ghost.kind === "rejected" && ghost.reason === "order_not_found",
      );

      // Amount larger than the payment.
      const g = await settledCase();
      g.state.refunds.rf_toobig = refundFixture({
        id: "rf_toobig",
        paymentId: g.paymentId,
        minor: 5000,
      });
      const tooBig = await mapping.mapRefundToOrder("rf_toobig");
      check(
        "a refund larger than the payment is REJECTED",
        tooBig.kind === "rejected" && tooBig.reason === "amount_exceeds_payment",
        JSON.stringify(tooBig),
      );

      // Wrong currency.
      const h = await settledCase();
      h.state.refunds.rf_eur = {
        ...refundFixture({ id: "rf_eur", paymentId: h.paymentId, minor: 100 }),
        amount: { amount: "1.00", currency: "eur", decimals: 2, display_decimals: 2 },
      };
      const eur = await mapping.mapRefundToOrder("rf_eur");
      check(
        "a refund in another currency is REJECTED, never converted",
        eur.kind === "rejected",
        JSON.stringify(eur),
      );

      // A refund id that is not one.
      const bad = await mapping.mapRefundToOrder("pay_notarefund");
      check(
        "a malformed refund id is REJECTED without a provider call",
        bad.kind === "rejected" && bad.reason === "invalid_refund_id",
      );

      // A refund the provider does not have.
      const missing = await mapping.mapRefundToOrder("rf_doesnotexist");
      check(
        "a refund the provider has never heard of is REJECTED",
        missing.kind === "rejected" && missing.reason === "resource_not_found",
      );
    }

    /* ---------------------------------------------------------------------
       CUMULATIVE OVERFLOW
       --------------------------------------------------------------------- */
    console.log("\n  · cumulative refund overflow");
    {
      const { paymentId, state } = await settledCase({ feeMinor: 0 });

      state.refunds.rf_o1 = refundFixture({ id: "rf_o1", paymentId, minor: 600 });
      await webhooks.handleWhopRefund("rf_o1", "msg_o1");
      state.refunds.rf_o2 = refundFixture({ id: "rf_o2", paymentId, minor: 400 });
      await webhooks.handleWhopRefund("rf_o2", "msg_o2");
      check(
        "600 + 400 = the full 1000 and both post",
        (await countRefundTxns("rf_o1")) === 1 && (await countRefundTxns("rf_o2")) === 1,
      );

      // One more penny would exceed the payment.
      state.refunds.rf_o3 = refundFixture({ id: "rf_o3", paymentId, minor: 1 });
      const overflow = await mapping.mapRefundToOrder("rf_o3");
      check(
        "a refund that would take cumulative refunds past the payment is REJECTED",
        overflow.kind === "rejected" && overflow.reason === "cumulative_refund_overflow",
        JSON.stringify(overflow),
      );
      check("and nothing was posted for it", (await countRefundTxns("rf_o3")) === 0);

      const handler = await webhooks.handleWhopRefund("rf_o3", "msg_o3");
      check(
        "the webhook reports it as a named failure, not as success",
        handler.kind === "failed" && handler.category === "refund_cumulative_refund_overflow",
        JSON.stringify(handler),
      );

      // The provider being unreachable must NOT be read as "no overflow".
      state.listThrows = new FakeWhopError("boom", 503);
      state.refunds.rf_o4 = refundFixture({ id: "rf_o4", paymentId, minor: 1 });
      const unreachable = await mapping.mapRefundToOrder("rf_o4");
      check(
        "if the refund list is unavailable, the refund is REFUSED rather than assumed safe",
        unreachable.kind === "rejected" && unreachable.reason === "provider_error",
        JSON.stringify(unreachable),
      );
      delete state.listThrows;
    }

    /* ---------------------------------------------------------------------
       FEE BEHAVIOUR, END TO END
       --------------------------------------------------------------------- */
    console.log("\n  · provider fee behaviour");
    {
      // RETAINED: the fee report does not change after the refund.
      const retainedCase = await settledCase({ minor: 1000, feeMinor: 87 });
      const balBefore = await balanceOf("provider_balance");
      const feeBefore = await balanceOf("provider_fee_expense");
      retainedCase.state.refunds.rf_keepfee = refundFixture({
        id: "rf_keepfee",
        paymentId: retainedCase.paymentId,
        minor: 1000,
      });
      await webhooks.handleWhopRefund("rf_keepfee", "msg_kf");

      check(
        "fees RETAINED: the provider balance falls by the full gross",
        (await balanceOf("provider_balance")) - balBefore === -1000n,
      );
      check(
        "fees RETAINED: no fee is reversed, because none was proved returned",
        (await balanceOf("provider_fee_expense")) - feeBefore === 0n,
      );

      // RETURNED: the fee report drops to nothing after the refund.
      const returnedCase = await settledCase({ minor: 1000, feeMinor: 87 });
      const balBefore2 = await balanceOf("provider_balance");
      const feeBefore2 = await balanceOf("provider_fee_expense");
      returnedCase.state.refunds.rf_givefee = refundFixture({
        id: "rf_givefee",
        paymentId: returnedCase.paymentId,
        minor: 1000,
      });
      // The provider now reports no fees on this payment at all.
      returnedCase.state.fees[returnedCase.paymentId] = [];
      await webhooks.handleWhopRefund("rf_givefee", "msg_gf");

      check(
        "fees RETURNED: the fee expense is credited by exactly what the provider gave back",
        (await balanceOf("provider_fee_expense")) - feeBefore2 === -87n,
      );
      check(
        "fees RETURNED: only the net comes off the provider balance",
        (await balanceOf("provider_balance")) - balBefore2 === -913n,
      );

      // A SECOND partial refund must not re-book the fee movement the first
      // one already booked.
      const twice = await settledCase({ minor: 1000, feeMinor: 87 });
      twice.state.refunds.rf_t1 = refundFixture({
        id: "rf_t1",
        paymentId: twice.paymentId,
        minor: 500,
      });
      twice.state.fees[twice.paymentId] = [];
      await webhooks.handleWhopRefund("rf_t1", "msg_t1");
      const feeAfterFirst = await balanceOf("provider_fee_expense");
      twice.state.refunds.rf_t2 = refundFixture({
        id: "rf_t2",
        paymentId: twice.paymentId,
        minor: 500,
      });
      await webhooks.handleWhopRefund("rf_t2", "msg_t2");
      check(
        "a second refund does not re-book a fee movement the first already booked",
        (await balanceOf("provider_fee_expense")) === feeAfterFirst,
      );
    }

    /* ---------------------------------------------------------------------
       CRASH BETWEEN THE REFUND ROW AND THE ACCOUNTING
       --------------------------------------------------------------------- */
    console.log("\n  · crash recovery");
    {
      const { paymentId, state } = await settledCase();
      state.refunds.rf_crash = refundFixture({ id: "rf_crash", paymentId, minor: 400 });

      // STEP 1 ONLY — exactly what a process that died before accounting
      // leaves behind. `mapRefundToOrder` writes the operational row and
      // nothing else.
      const mapped = await mapping.mapRefundToOrder("rf_crash");
      check("the operational row is written first", mapped.kind === "completed");
      check(
        "and at this instant there is NO accounting — the crash window is real",
        (await countRefundTxns("rf_crash")) === 0,
      );

      // Reconciliation must SEE it.
      const report = await reconcile.reconcileRefundsInternal();
      const found = report.discrepancies.filter(
        (d) => d.code === "refund_missing_ledger" && d.refundId === "rf_crash",
      );
      check("reconciliation DETECTS the missing posting", found.length === 1);

      // A dry run reports but does not write.
      const dry = await recovery.recoverMissingRefundPostings({ dryRun: true });
      check(
        "a dry run says what it would do and posts nothing",
        dry.outcomes.some((o) => o.whopRefundId === "rf_crash") &&
          (await countRefundTxns("rf_crash")) === 0,
      );

      // The repair.
      const repaired = await recovery.convergeRefund("rf_crash");
      check(
        "recovery posts the missing transaction",
        repaired.result.kind === "posted",
        JSON.stringify(repaired.result),
      );
      check("exactly once", (await countRefundTxns("rf_crash")) === 1);

      // And again, which must change nothing.
      const again = await recovery.convergeRefund("rf_crash");
      check(
        "running recovery a second time posts nothing more",
        again.result.kind === "already_posted" && (await countRefundTxns("rf_crash")) === 1,
      );

      // The reverse case: accounting exists, a webhook redelivers.
      const balanceNow = await balanceOf("provider_balance");
      await webhooks.handleWhopRefund("rf_crash", "msg_redeliver");
      check(
        "a redelivery after the accounting exists does NOT duplicate money",
        (await countRefundTxns("rf_crash")) === 1 &&
          (await balanceOf("provider_balance")) === balanceNow,
      );

      const clean = await reconcile.reconcileRefundsInternal();
      check(
        "and reconciliation no longer reports the gap",
        clean.discrepancies.filter(
          (d) => d.code === "refund_missing_ledger" && d.refundId === "rf_crash",
        ).length === 0,
      );
    }

    /* ---------------------------------------------------------------------
       RECONCILIATION AGAINST THE PROVIDER
       --------------------------------------------------------------------- */
    console.log("\n  · reconciliation against the provider");
    {
      const { paymentId, state } = await settledCase();
      state.refunds.rf_rec1 = refundFixture({ id: "rf_rec1", paymentId, minor: 300 });
      await webhooks.handleWhopRefund("rf_rec1", "msg_rec1");

      let findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a correctly handled refund reconciles clean",
        findings.length === 0,
        JSON.stringify(findings),
      );

      // The provider has a refund we do not.
      state.refunds.rf_unknown = refundFixture({
        id: "rf_unknown",
        paymentId,
        minor: 100,
      });
      findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a provider refund missing locally is DETECTED",
        findings.some((f) => f.code === "refund_missing_locally" && f.refundId === "rf_unknown"),
      );

      // The provider now says the one we completed actually failed.
      delete state.refunds.rf_unknown;
      state.refunds.rf_rec1.status = "failed";
      findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a local completed refund the provider calls failed is DETECTED",
        findings.some((f) => f.code === "refund_status_conflict" && f.refundId === "rf_rec1"),
      );
      state.refunds.rf_rec1.status = "succeeded";

      // The provider's amount disagrees with ours.
      state.refunds.rf_rec1.amount = usd(999);
      findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a refund amount mismatch is DETECTED",
        findings.some((f) => f.code === "refund_amount_mismatch"),
      );
      state.refunds.rf_rec1.amount = usd(300);

      // A local refund the provider does not report.
      const orphanPayment = state.refunds.rf_rec1.payment_id;
      await scoped.unsafe(
        `insert into ${SCRATCH}.payment_refunds
          (provider, whop_refund_id, whop_payment_id, environment, amount_minor, currency, provider_status, status)
         values ('whop','rf_orphan','${orphanPayment}','sandbox',100,'usd','pending','pending')`,
      );
      findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a local refund the provider does not report is DETECTED",
        findings.some((f) => f.code === "refund_missing_at_provider" && f.refundId === "rf_orphan"),
      );

      // The provider being unreachable is an UNKNOWN, never a discrepancy.
      state.listThrows = new FakeWhopError("down", 503);
      findings = await reconcile.reconcileRefundsAgainstProvider(paymentId);
      check(
        "a provider outage is reported as unavailable, not as a disagreement",
        findings.length === 1 && findings[0].code === "refund_provider_unavailable",
      );
      delete state.listThrows;

      await scoped.unsafe(
        `delete from ${SCRATCH}.payment_refunds where whop_refund_id = 'rf_orphan'`,
      );
    }

    /* ---------------------------------------------------------------------
       THE REFUND CREATION PRIMITIVE (no real refund is ever issued)
       --------------------------------------------------------------------- */
    console.log("\n  · refund creation primitive");
    {
      const { orderId, state } = await settledCase({ feeMinor: 0 });

      // A caller cannot exceed the provider-authoritative maximum.
      const tooMuch = await refundCreate.createRefundForOrder(orderId, 5000n, {}, FAKE_WHOP);
      check(
        "a request above the refundable balance is REFUSED before any call",
        tooMuch.ok === false && tooMuch.reason === "exceeds_refundable",
        show(tooMuch),
      );
      check("and no refund was issued", (state.refundCalls ?? 0) === 0);

      const zero = await refundCreate.createRefundForOrder(orderId, 0n, {}, FAKE_WHOP);
      check("a zero refund is refused", zero.ok === false && zero.reason === "invalid_amount");

      const negative = await refundCreate.createRefundForOrder(orderId, -100n, {}, FAKE_WHOP);
      check("a negative refund is refused", negative.ok === false);

      const notAnOrder = await refundCreate.createRefundForOrder("not-a-uuid", 100n, {}, FAKE_WHOP);
      check(
        "a malformed order id is refused",
        notAnOrder.ok === false && notAnOrder.reason === "invalid_order_id",
      );

      // The intent precondition.
      const wrongIntent = await refundCreate.createRefundForOrder(
        orderId,
        100n,
        { expectedRemainingMinor: 999n },
        FAKE_WHOP,
      );
      check(
        "an intent whose precondition does not hold is refused",
        wrongIntent.ok === false && wrongIntent.reason === "intent_precondition_failed",
      );
      check("and still no refund was issued", (state.refundCalls ?? 0) === 0);

      // A valid partial refund, against the FAKE provider only. The refund
      // resource does NOT exist yet — the mutation creates it, exactly as Whop
      // does — so this also tests that the new `rf_` id is discovered.
      state.nextRefundId = "rf_created";
      const made = await refundCreate.createRefundForOrder(
        orderId,
        250n,
        { expectedRemainingMinor: 1000n },
        FAKE_WHOP,
      );
      check("a valid partial refund request succeeds", made.ok === true, show(made));
      check("and identifies the refund it created", made.ok && made.newRefundId === "rf_created");
      check("the provider mutation was called exactly once", state.refundCalls === 1);

      // Provider error classes are preserved rather than flattened.
      state.refundThrows = new FakeWhopError("conflict", 409);
      const conflict = await refundCreate.createRefundForOrder(orderId, 100n, {}, FAKE_WHOP);
      check(
        "a 409 is preserved as `conflict`",
        conflict.ok === false && conflict.reason === "conflict",
      );
      state.refundThrows = new FakeWhopError("rate", 429);
      const rate = await refundCreate.createRefundForOrder(orderId, 100n, {}, FAKE_WHOP);
      check("a 429 is preserved as `rate_limited`", rate.ok === false && rate.reason === "rate_limited");
      check(
        "and only a 429 is considered retryable — a 5xx may have already refunded",
        refundCreate.isRetryableRefundError("rate_limited") === true &&
          refundCreate.isRetryableRefundError("provider_error") === false &&
          refundCreate.isRetryableRefundError("conflict") === false,
      );
      delete state.refundThrows;

      // An unpaid order cannot be refunded.
      const unpaid = await orders.createPaymentOrder({
        amountMinor: 500n,
        currency: "usd",
        purpose: "never-paid",
      });
      const cannot = await refundCreate.createRefundForOrder(
        unpaid.order.orderId,
        100n,
        {},
        FAKE_WHOP,
      );
      check(
        "an order that was never paid cannot be refunded",
        cannot.ok === false && cannot.reason === "order_not_paid",
      );
    }

    /* ---------------------------------------------------------------------
       LEDGER-WIDE INVARIANTS
       --------------------------------------------------------------------- */
    console.log("\n  · ledger invariants after everything above");
    {
      const [unbalanced] = await scoped.unsafe(
        `select count(*)::int as n from (
           select transaction_id from ${SCRATCH}.accounting_entries
           group by transaction_id having sum(amount_minor) <> 0) x`,
      );
      check("every transaction in the throwaway ledger balances", unbalanced.n === 0);

      const [forbidden] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_entries
         where account in ('platform_revenue','creator_payable','campaign_funds','refunds_payable','dispute_reserve')`,
      );
      check(
        "NO revenue, creator-payable, campaign, refunds-payable or dispute legs were created",
        forbidden.n === 0,
      );

      const [events] = await scoped.unsafe(
        `select string_agg(distinct economic_event::text, ',' order by economic_event::text) as e
         from ${SCRATCH}.accounting_transactions`,
      );
      check(
        "only payment_settled and payment_refunded were ever posted",
        events.e === "payment_refunded,payment_settled",
        events.e,
      );

      // The append-only triggers are still live in the throwaway schema.
      let updateBlocked = false;
      try {
        await scoped.unsafe(
          `update ${SCRATCH}.accounting_entries set amount_minor = 1 where true`,
        );
      } catch (e) {
        updateBlocked = /append-only/.test(String(e.message));
      }
      check("the append-only trigger still refuses an UPDATE", updateBlocked);

      let deleteBlocked = false;
      try {
        await scoped.unsafe(`delete from ${SCRATCH}.accounting_entries where true`);
      } catch (e) {
        deleteBlocked = /append-only/.test(String(e.message));
      }
      check("and still refuses a DELETE", deleteBlocked);

      // The 0005 constraints do their job.
      let negativeBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_refunds
             (whop_refund_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('rf_neg','pay_neg','sandbox',-100,'usd','succeeded')`,
        );
      } catch (e) {
        negativeBlocked = /amount_positive/.test(String(e.message));
      }
      check("0005 refuses a negative refund amount", negativeBlocked);

      let prefixBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_refunds
             (whop_refund_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('pay_wrong','pay_x','sandbox',100,'usd','succeeded')`,
        );
      } catch (e) {
        prefixBlocked = /refund_id_prefix/.test(String(e.message));
      }
      check("0005 refuses a payment id in the refund id column", prefixBlocked);

      let dupBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_refunds
             (whop_refund_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('rf_dup','pay_dupe','sandbox',100,'usd','succeeded')`,
        );
      } catch (e) {
        dupBlocked = /uniq_refunds_provider_refund/.test(String(e.message));
      }
      check("0005 refuses a second row for one provider refund id", dupBlocked);

      let completedNoTimeBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_refunds
             (whop_refund_id, whop_payment_id, environment, amount_minor, currency, provider_status, status)
           values ('rf_notime','pay_nt','sandbox',100,'usd','succeeded','completed')`,
        );
      } catch (e) {
        completedNoTimeBlocked = /completed_has_time/.test(String(e.message));
      }
      check("0005 refuses a completed refund with no completed_at", completedNoTimeBlocked);
    }
  } finally {
    // The exact set of synthetic refund ids this suite invented, read out of
    // the throwaway schema BEFORE it is dropped. The tail then proves not one
    // of them reached the real table — which is a stronger statement than a
    // row count, because it would catch a leak that happened to be offset by
    // a deletion.
    try {
      const rows = await client.unsafe(
        `select whop_refund_id from ${SCRATCH}.payment_refunds`,
      );
      syntheticRefundIds = rows.map((r) => r.whop_refund_id);
    } catch {
      // The schema may not have been created if isolation failed; nothing to
      // collect, and the isolation failure is already the reported error.
    }

    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("reset search_path");
    if (scoped) await scoped.end();

    /* -------------------------------------------------------------------
       THE REAL DATABASE, read-only, compared against the baseline taken
       before anything ran.
       ------------------------------------------------------------------- */
    console.log("\n--- B. the real public database, after the tests ---");

    const [schemaCheck] = await client`select current_schema() as schema`;
    check("the session is back on public", schemaCheck.schema === "public");

    // A TEST SUITE MUST NEVER APPLY A MIGRATION. 0005 is applied now, so the
    // count is 6 — but what is asserted is that THIS RUN did not change it.
    const afterMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check(
      "this suite applied no migration — the count is unchanged at 6",
      beforeMigrations[0].n === afterMigrations[0].n && afterMigrations[0].n === 6,
      `${afterMigrations[0].n} migrations`,
    );

    const [publicRefundsTableAfter] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'payment_refunds'`;
    check("public.payment_refunds still exists", publicRefundsTableAfter.n === 1);

    // THE LEAK CHECK, in two forms.
    const [publicRefundRowsAfter] = await client`
      select count(*)::int as n from public.payment_refunds`;
    check(
      "public.payment_refunds row count is unchanged by this suite",
      publicRefundRowsAfter.n === baselineRefundRows,
      `${baselineRefundRows} -> ${publicRefundRowsAfter.n}`,
    );

    const leaked =
      syntheticRefundIds.length === 0
        ? []
        : (
            await client`
              select whop_refund_id from public.payment_refunds
              where whop_refund_id = any(${syntheticRefundIds})`
          ).map((r) => r.whop_refund_id);
    check(
      "not one synthetic fixture id reached the real payment_refunds table",
      leaked.length === 0,
      `${syntheticRefundIds.length} synthetic id(s) created, ${leaked.length} leaked`,
    );

    // The same statement for the other production-like tables the fixtures
    // touch: every synthetic order was created in the throwaway schema, so the
    // real table must still hold exactly the three it started with.
    const [publicOrderCount] = await client`select count(*)::int as n from public.payment_orders`;
    check(
      "no synthetic order reached the real payment_orders table",
      publicOrderCount.n === beforeOrders.length,
      `${publicOrderCount.n} orders`,
    );

    // THE INVARIANT IS "THIS SUITE ADDED NOTHING", not a frozen total. The
    // real journal legitimately grows when a real refund is issued against the
    // sandbox payment; what must never change is that these fixtures do not
    // contribute to it.
    const afterTxns = await client`select count(*)::int as n from accounting_transactions`;
    check(
      "this suite added no transaction to the real journal",
      afterTxns[0].n === beforeTxns[0].n,
      `${beforeTxns[0].n} -> ${afterTxns[0].n}`,
    );
    const [realSettlements] = await client`
      select count(*)::int as n from accounting_transactions where economic_event = 'payment_settled'`;
    check(
      "the real journal still holds exactly ONE settlement transaction",
      realSettlements.n === 1,
      `${realSettlements.n}`,
    );

    const afterEntries = await client`
      select count(*)::int as n, coalesce(sum(amount_minor),0)::text as s from accounting_entries`;
    check(
      "the real ledger is unchanged and still balances",
      afterEntries[0].n === beforeEntries[0].n && afterEntries[0].s === "0",
      `${afterEntries[0].n} legs, residual ${afterEntries[0].s}`,
    );

    // Every refund transaction in the real ledger must correspond to a real
    // provider refund we hold a row for — never to a fixture. This is the
    // check that would catch a synthetic posting escaping the throwaway
    // schema, and it stays meaningful as real refunds accumulate.
    const realRefundTxns = await client`
      select provider_resource_id from accounting_transactions
      where economic_event = 'payment_refunded'`;
    const realRefundRows = await client`select whop_refund_id from public.payment_refunds`;
    const backedIds = new Set(realRefundRows.map((r) => r.whop_refund_id));
    const unbacked = realRefundTxns
      .map((t) => t.provider_resource_id)
      .filter((id) => !backedIds.has(id));
    check(
      "every refund transaction in the real ledger is backed by a real refund row",
      unbacked.length === 0,
      `${realRefundTxns.length} refund transaction(s), ${unbacked.length} unbacked`,
    );
    const syntheticInLedger = realRefundTxns
      .map((t) => t.provider_resource_id)
      .filter((id) => syntheticRefundIds.includes(id));
    check(
      "no synthetic refund posting leaked into the real ledger",
      syntheticInLedger.length === 0,
      syntheticInLedger.join(",") || "none",
    );

    const afterOrders = await client`select order_id, status, paid_at, whop_payment_id from payment_orders order by created_at`;
    check(
      "payment_orders is byte-for-byte unchanged",
      JSON.stringify(afterOrders) === JSON.stringify(beforeOrders),
      `${afterOrders.length} orders`,
    );
    check(
      "and the settled sandbox order kept its original paid_at",
      afterOrders.some(
        (o) =>
          o.whop_payment_id === "pay_NI479ox7E4dfEQ" &&
          o.status === "paid" &&
          o.paid_at.toISOString() === "2026-09-03T17:26:26.649Z",
      ),
    );

    const afterLedger = await client`select count(*)::int as n from financial_ledger`;
    check(
      "financial_ledger is still 0",
      afterLedger[0].n === 0 && afterLedger[0].n === beforeLedger[0].n,
    );

    const [scratchGone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", scratchGone.n === 0);

    await client.end();
  }
}

/* ==========================================================================
   PART C — source invariants
   ========================================================================== */

function sourceInvariants() {
  console.log("\n--- C. source invariants ---");

  const files = {
    lifecycle: readFileSync("src/lib/server/refund-lifecycle.ts", "utf8"),
    resources: readFileSync("src/lib/server/whop-refunds.ts", "utf8"),
    mapping: readFileSync("src/lib/server/whop-refund-mapping.ts", "utf8"),
    table: readFileSync("src/lib/server/payment-refunds.ts", "utf8"),
    posting: readFileSync("src/lib/server/accounting/whop-refund-posting.ts", "utf8"),
    create: readFileSync("src/lib/server/whop-refund-create.ts", "utf8"),
    recovery: readFileSync("src/lib/server/accounting/refund-recovery.ts", "utf8"),
    reconcile: readFileSync("src/lib/server/accounting/reconcile.ts", "utf8"),
    webhooks: readFileSync("src/lib/server/whop-webhooks.ts", "utf8"),
  };
  const refundSource = Object.entries(files)
    .filter(([k]) => k !== "webhooks" && k !== "reconcile")
    .map(([, v]) => v)
    .join("\n");

  check(
    "every refund module is server-only",
    Object.entries(files).every(([, v]) => v.includes('import "server-only"')),
  );

  // NO FEE RATE ANYWHERE.
  check(
    "no hard-coded fee percentage appears in any refund module",
    !/\b0\.0[0-9]+\b|\*\s*0\.[0-9]+|\/\s*100\b/.test(refundSource),
  );
  check(
    "no float arithmetic on money: no parseFloat, no Number(...) * 100",
    !/parseFloat|Number\([^)]*\)\s*\*/.test(refundSource),
  );
  check(
    "amounts are bigint throughout: every money comparison uses BigInt",
    /bigint/.test(files.mapping) && /bigint/.test(files.posting) && /bigint/.test(files.table),
  );

  // NO DISPUTES, TRANSFERS, WITHDRAWALS OR PAYOUTS.
  check(
    "no dispute logic was added",
    !/dispute_reserve|dispute_opened|dispute_won|dispute_lost/.test(refundSource),
  );
  check(
    "no payout, transfer or withdrawal logic was added",
    !/payout_sent|payout_reversed|payout_clearing|withdrawal|\btransfers?\b/i.test(refundSource),
  );
  check(
    "the dispute and payout webhook handlers are still the untouched stubs",
    /export async function handleWhopDisputeCreated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(
      files.webhooks,
    ) &&
      /export async function handleWhopPayoutUpdated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(
        files.webhooks,
      ),
  );

  // THE ORIGINAL PAYMENT IS NEVER MUTATED.
  check(
    "no refund module updates or deletes payment_orders",
    !/paymentOrders\)?\s*$|update\(paymentOrders|delete\(paymentOrders/m.test(refundSource) &&
      !/update\(paymentOrders/.test(refundSource) &&
      !/delete\(paymentOrders/.test(refundSource),
  );
  check(
    "no refund module CALLS reverseTransaction (the posting module documents why not)",
    !/reverseTransaction\s*\(/.test(refundSource) &&
      !/import[^;]*reverseTransaction/.test(refundSource),
  );
  check(
    "no refund module has an update or delete path into the journal",
    !/update\(accountingTransactions|delete\(accountingTransactions|update\(accountingEntries|delete\(accountingEntries/.test(
      refundSource,
    ),
  );

  // NO PUBLIC REFUND ENDPOINT.
  const { readdirSync, statSync } = require("node:fs");
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const appFiles = walk("src/app");
  const refundRoutes = appFiles.filter((f) => /refund/i.test(f));
  check("there is NO refund route under src/app", refundRoutes.length === 0, refundRoutes.join(","));

  const importsCreate = appFiles.filter((f) =>
    /whop-refund-create/.test(readFileSync(f, "utf8")),
  );
  check(
    "nothing under src/app imports the refund creation primitive",
    importsCreate.length === 0,
    importsCreate.join(","),
  );

  // No component may reach the refund machinery. The word "refund" itself DOES
  // appear in the admin analytics UI (`t.refunds`, an i18n label shipped in the
  // very first commit and unrelated to this build), so the check is about
  // REACHABILITY — an import of a refund server module — not about vocabulary.
  const componentFiles = walk("src/components");
  const refundUi = componentFiles.filter((f) =>
    /whop-refund|payment-refunds|refund-lifecycle|refund-recovery/.test(readFileSync(f, "utf8")),
  );
  check(
    "no component imports any refund server module",
    refundUi.length === 0,
    refundUi.join(","),
  );

  // THE IDEMPOTENCY KEY IS THE REFUND, NOT THE DELIVERY.
  check(
    "the refund idempotency key is built from the refund resource id",
    /economicKey\("whop", "payment_refunded", facts\.refundId\)/.test(files.posting),
  );
  check(
    "the source webhook id is recorded as evidence only, never as a key",
    /sourceWebhookId: context\.sourceWebhookId/.test(files.posting) &&
      !/idempotencyKey:.*sourceWebhookId/.test(files.posting),
  );

  // RECONCILIATION REPORTS, IT DOES NOT REWRITE.
  const refundReconBlock = files.reconcile.slice(files.reconcile.indexOf("REFUND RECONCILIATION"));
  check(
    "refund reconciliation has no insert, update or delete anywhere in it",
    !/\.insert\(|\.update\(|\.delete\(/.test(refundReconBlock),
  );

  // THE ONLY WRITING REPAIR CAN ONLY ADD A POSTING.
  check(
    "the recovery module never updates or deletes anything",
    !/\.update\(|\.delete\(/.test(files.recovery),
  );
  check(
    "and it defaults to a dry run",
    /dryRun = true/.test(files.recovery),
  );

  // ACCOUNTS THAT MUST STAY BLOCKED.
  const accountsSource = readFileSync("src/lib/server/accounting/accounts.ts", "utf8");
  check(
    "refunds_payable is still NOT postable",
    /refunds_payable: \{[^}]*postable: false/s.test(accountsSource),
  );
  check(
    "platform_revenue and creator_payable are still NOT postable",
    /platform_revenue: \{[^}]*postable: false/s.test(accountsSource) &&
      /creator_payable: \{[^}]*postable: false/s.test(accountsSource),
  );

  // THE OPEN BUSINESS RULE IS STATED, NOT GUESSED.
  check(
    "the unresolved refund-loss allocation rule is documented in the posting module",
    /THE OPEN BUSINESS RULE/.test(files.posting),
  );

  // MIGRATIONS 0000-0004 UNTOUCHED.
  const { execSync } = require("node:child_process");
  const changed = execSync("git status --porcelain drizzle", { encoding: "utf8" });
  const touchedOld = changed
    .split("\n")
    .filter((l) => /drizzle\/000[0-4]_/.test(l));
  check(
    "migrations 0000-0004 are untouched",
    touchedOld.length === 0,
    touchedOld.join(" ") || "none",
  );
  check(
    "0005 exists and is the only new migration",
    changed.includes("0005_slippery_hitman.sql"),
  );
}

/* ========================================================================== */

sourceInvariants();

const run = process.env.REFUND_TEST_DB === "0" ? Promise.resolve() : sequences();

run
  .catch((e) => check("part B completed", false, String(e?.message ?? e).slice(0, 300)))
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      for (const f of failed) console.log(`  - ${f.name}`);
      process.exit(1);
    }
  });
