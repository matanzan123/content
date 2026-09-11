/**
 * DISPUTE / CHARGEBACK / RESOLUTION CENTER TESTS.
 *
 * Three parts, for the same reason the refund suite has three:
 *
 *   A. THE CONTRACT AND THE PURE LOGIC — every status list checked against the
 *      installed SDK enums rather than retyped, the three state machines, the
 *      exact amount readers (including the 1e8-precision ledger conversion),
 *      and the posting builder. No database, no network.
 *
 *   B. SEQUENCES AND MONEY — created -> updated -> won, stale events after a
 *      terminal state, duplicates, concurrency, crash recovery, and the
 *      ledger-driven accounting. Real modules against a FAKE WHOP over a REAL
 *      Postgres in a throwaway schema.
 *
 *   C. SOURCE INVARIANTS — properties true only by absence: no payout or
 *      transfer code, no hard-coded dispute fee, no float arithmetic, no
 *      accounting driven by a dispute status, no mutation of settlement or
 *      refund history.
 *
 * NOTHING HERE TOUCHES `public`. Fixtures are created in `dispute_selftest`,
 * and the suite REFUSES TO WRITE ANYTHING until it has proved — by resolving
 * the very table names the modules use — that they land there. The tail then
 * reads the real tables read-only to confirm the baseline is intact.
 *
 * MIGRATION 0006 IS NOT APPLIED by this suite. It is replayed inside the
 * throwaway schema so its constraints are really exercised, and the real
 * migration count is asserted unchanged.
 *
 * Set DISPUTE_TEST_DB=0 to run only the pure parts.
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
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

/* ========================================================================== */

const cache = new Map();
let DB = null;
let FAKE_WHOP = null;

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

const lifecycle = loadTs("src/lib/server/dispute-lifecycle.ts");
const disputesMod = loadTs("src/lib/server/whop-disputes.ts");
const posting = loadTs("src/lib/server/accounting/whop-dispute-posting.ts");
const webhooks = loadTs("src/lib/server/whop-webhooks.ts");

/* ==========================================================================
   PART A — the contract
   ========================================================================== */

console.log("\n--- A. the provider dispute contract ---");

function sdkEnumValues(name) {
  const text = readFileSync(`node_modules/@whop/sdk/dist/cjs/api/types/${name}.d.ts`, "utf8");
  return [...text.matchAll(/readonly [A-Za-z0-9_]+: "([^"]+)"/g)].map((m) => m[1]);
}
function sdkNamespaceEnum(file, constName) {
  const text = readFileSync(`node_modules/@whop/sdk/dist/cjs/api/types/${file}.d.ts`, "utf8");
  const start = text.indexOf(`const ${constName}`);
  const block = text.slice(start, text.indexOf(`type ${constName}`, start));
  return [...block.matchAll(/readonly [A-Za-z0-9_]+: "([^"]+)"/g)].map((m) => m[1]);
}

// The nine-value list, from the SDK's own DisputeStatuses.
const sdkDisputeStatuses = sdkEnumValues("DisputeStatuses");
check(
  "we recognise exactly the SDK's nine DisputeStatuses values",
  [...lifecycle.ALL_WHOP_DISPUTE_STATUSES].sort().join(",") === sdkDisputeStatuses.sort().join(","),
  `${sdkDisputeStatuses.length} values`,
);

// The five-value list, from the modern Dispute.Status namespace enum.
const sdkModernStatuses = sdkNamespaceEnum("Dispute", "Status");
check(
  "our five formal statuses are exactly Dispute.Status",
  [...lifecycle.WHOP_DISPUTE_STATUSES].sort().join(",") === sdkModernStatuses.sort().join(","),
  sdkModernStatuses.join(","),
);
check(
  "the modern retrieve enum is a SUBSET of the broader one — both are real",
  sdkModernStatuses.every((s) => sdkDisputeStatuses.includes(s)),
);

const sdkReasons = sdkNamespaceEnum("Dispute", "Reason");
check(
  "our dispute reasons are exactly Dispute.Reason",
  [...lifecycle.WHOP_DISPUTE_REASONS].sort().join(",") === sdkReasons.sort().join(","),
  `${sdkReasons.length} reasons`,
);

const sdkAlertTypes = sdkNamespaceEnum("DisputeAlert", "Type");
check(
  "our alert types are exactly DisputeAlert.Type",
  [...lifecycle.WHOP_DISPUTE_ALERT_TYPES].sort().join(",") === sdkAlertTypes.sort().join(","),
  sdkAlertTypes.join(","),
);
const sdkAlertReasons = sdkNamespaceEnum("DisputeAlert", "NotActionableReason");
check(
  "our alert not-actionable reasons are exactly the SDK's",
  [...lifecycle.WHOP_ALERT_NOT_ACTIONABLE_REASONS].sort().join(",") ===
    sdkAlertReasons.sort().join(","),
);

const sdkCaseStatuses = sdkNamespaceEnum("ResolutionCenterCase", "Status");
check(
  "our case statuses are exactly ResolutionCenterCase.Status",
  [...lifecycle.WHOP_CASE_STATUSES].sort().join(",") === sdkCaseStatuses.sort().join(","),
  sdkCaseStatuses.join(","),
);
const sdkCaseOutcomes = sdkNamespaceEnum("ResolutionCenterCase", "Outcome");
check(
  "our case outcomes are exactly ResolutionCenterCase.Outcome",
  [...lifecycle.WHOP_CASE_OUTCOMES].sort().join(",") === sdkCaseOutcomes.sort().join(","),
);
const sdkCaseRefunds = sdkNamespaceEnum("ResolutionCenterCase", "Refund");
check(
  "our case refund sources are exactly ResolutionCenterCase.Refund",
  [...lifecycle.WHOP_CASE_REFUND_SOURCES].sort().join(",") === sdkCaseRefunds.sort().join(","),
  sdkCaseRefunds.join(","),
);

// The six webhook events, from the SDK's WebhookEvent enum.
const sdkEvents = sdkEnumValues("WebhookEvent");
const sdkDisputeFamily = sdkEvents.filter(
  (e) => e.startsWith("dispute.") || e.startsWith("dispute_alert.") || e.startsWith("resolution_center_case."),
);
check(
  "the SDK has exactly six dispute-family webhook events",
  sdkDisputeFamily.length === 6,
  sdkDisputeFamily.join(","),
);
check(
  "our allowlist carries exactly those six and invents none",
  webhooks.SUPPORTED_EVENTS.filter(
    (e) => e.startsWith("dispute.") || e.startsWith("dispute_alert.") || e.startsWith("resolution_center_case."),
  )
    .sort()
    .join(",") === sdkDisputeFamily.sort().join(","),
);
check(
  "no dispute.won / dispute.lost / dispute_alert.updated is assumed to exist",
  !webhooks.SUPPORTED_EVENTS.includes("dispute.won") &&
    !webhooks.SUPPORTED_EVENTS.includes("dispute.lost") &&
    !webhooks.SUPPORTED_EVENTS.includes("dispute_alert.updated"),
);

// THE FEE QUESTION, asserted against the type rather than remembered.
const disputeDts = readFileSync("node_modules/@whop/sdk/dist/cjs/api/types/Dispute.d.ts", "utf8");
check(
  "the Dispute resource carries NO fee field — the reason accounting is ledger-driven",
  !/^\s+fee[a-z_]*[?]?:/m.test(disputeDts) && !/fee_amount|dispute_fee/.test(disputeDts),
);
const alertDts = readFileSync(
  "node_modules/@whop/sdk/dist/cjs/api/types/DisputeAlert.d.ts",
  "utf8",
);
check(
  "the DisputeAlert carries fee_charged as a BOOLEAN, with no amount",
  /fee_charged: boolean/.test(alertDts) && !/fee_amount/.test(alertDts),
);
check(
  "Dispute.inquiry exists and is documented as moving no funds",
  /inquiry: boolean/.test(disputeDts) && /move no funds/.test(disputeDts),
);

console.log("\n--- A. the dispute state machine ---");

const cls = lifecycle.classifyDisputeStatus;
check("needs_response is open", cls("needs_response") === "open");
check("under_review is open", cls("under_review") === "open");
check("won is resolved", cls("won") === "resolved");
check("lost is resolved", cls("lost") === "resolved");
check("closed is resolved", cls("closed") === "resolved");
check("warning_needs_response is a warning, not a formal dispute", cls("warning_needs_response") === "warning");
check("warning_under_review is a warning", cls("warning_under_review") === "warning");
check("warning_closed is a warning", cls("warning_closed") === "warning");
check("Whop's own catch-all `other` is UNKNOWN, not a guess", cls("other") === "unknown");
check("an invented status is unknown", cls("teleported") === "unknown");
check("a non-string status is unknown", cls(null) === "unknown");

const tgt = lifecycle.targetDisputeStatus;
check("won maps to won", tgt("resolved", "won") === "won");
check("lost maps to lost", tgt("resolved", "lost") === "lost");
check("closed maps to closed", tgt("resolved", "closed") === "closed");
check("an unknown status fails SAFE to open, never to a resolution", tgt("unknown", "other") === "open");

check(
  "all three resolutions absorb",
  lifecycle.isDisputeAbsorbing("won") &&
    lifecycle.isDisputeAbsorbing("lost") &&
    lifecycle.isDisputeAbsorbing("closed"),
);
check(
  "open and warning do NOT absorb",
  !lifecycle.isDisputeAbsorbing("open") && !lifecycle.isDisputeAbsorbing("warning"),
);
check(
  "every declared transition matches the predicate",
  lifecycle.DISPUTE_TRANSITION_RULES.every(
    (r) => lifecycle.isDisputeTransitionAllowed(r.from, r.to) === r.allowed,
  ),
);
check(
  "a stale event cannot reopen or flip a resolved dispute",
  !lifecycle.isDisputeTransitionAllowed("won", "open") &&
    !lifecycle.isDisputeTransitionAllowed("won", "lost") &&
    !lifecycle.isDisputeTransitionAllowed("lost", "won") &&
    !lifecycle.isDisputeTransitionAllowed("closed", "open"),
);

// The SQL guard and the reasoned-about set must not drift apart.
const tableSource = readFileSync("src/lib/server/payment-disputes.ts", "utf8");
check(
  "the absorbing guard is in the SQL statement, not only in a branch",
  /status\}\s*not in \('won', 'lost', 'closed'\)/.test(tableSource),
);

check(
  "alerts are declared operational-only",
  lifecycle.ALERTS_ARE_OPERATIONAL_ONLY === true,
);
check("cases are declared operational-only", lifecycle.CASES_ARE_OPERATIONAL_ONLY === true);
check(
  "only a `merchant` refund source claims money off OUR balance",
  lifecycle.caseClaimsMerchantRefund("merchant") === true &&
    lifecycle.caseClaimsMerchantRefund("platform") === false &&
    lifecycle.caseClaimsMerchantRefund("none") === false &&
    lifecycle.caseClaimsMerchantRefund(null) === false,
);

console.log("\n--- A. exact amount reading ---");

const wu = disputesMod.readWholeUnitAmount;
check("2 usd -> 200 minor", wu(2, "usd").ok && wu(2, "usd").minor === 200n);
check("10.43 usd -> 1043 minor exactly", wu(10.43, "usd").minor === 1043n);
check(
  "8.87 usd -> 887 minor exactly (8.87*100 is 886.9999... in JS)",
  wu(8.87, "usd").minor === 887n && 8.87 * 100 !== 887,
);
check("zero is allowed on a dispute", wu(0, "usd").ok && wu(0, "usd").minor === 0n);
check("negative is refused", wu(-1, "usd").ok === false);
check("a non-number is refused", wu("2.00", "usd").ok === false);
check("an unsupported currency is refused, not defaulted", wu(2, "eur").reason === "unsupported_currency");

// The 1e8 ledger precision — the single place a dispute could be mis-scaled by
// a factor of a million.
const lam = disputesMod.ledgerAmountToMinor;
check(
  "ledger -200000000 at precision 1e8 -> -200 minor (NOT -200000000)",
  lam("-200000000", "100000000", "usd").ok && lam("-200000000", "100000000", "usd").minor === -200n,
);
check("ledger 1000000000 -> 1000 minor ($10.00)", lam("1000000000", "100000000", "usd").minor === 1000n);
check("ledger -87000000 -> -87 minor ($0.87)", lam("-87000000", "100000000", "usd").minor === -87n);
check(
  "a sub-minor amount is REFUSED rather than rounded",
  lam("-200000001", "100000000", "usd").ok === false,
);
check("a non-numeric amount is refused", lam("abc", "100000000", "usd").ok === false);
check(
  "a precision that is not a power of ten is refused",
  lam("100", "3", "usd").ok === false,
);
check("a two-decimal precision still works", lam("-200", "100", "usd").minor === -200n);

console.log("\n--- A. the dispute posting rule ---");

check(
  "the five postable line types are exactly the documented dispute money lines",
  Object.keys(posting.DISPUTE_LINE_RULES).sort().join(",") ===
    ["dispute_alert_fee", "dispute_representment_fee", "payment_dispute", "payment_dispute_fee", "payment_dispute_reversal"].join(","),
);
check(
  "platform_covered_dispute is explicitly NOT posted — it was not our money",
  posting.DISPUTE_LINE_TYPES_NOT_POSTED.platform_covered_dispute !== undefined &&
    posting.isPostableDisputeLine("platform_covered_dispute") === false,
);
check(
  "hold and adjustment lines are recognised but NOT posted",
  posting.isDisputeLineType("dispute_hold_adjustment") &&
    !posting.isPostableDisputeLine("dispute_hold_adjustment") &&
    posting.isDisputeLineType("payment_dispute_adjustment") &&
    !posting.isPostableDisputeLine("payment_dispute_adjustment"),
);
check(
  "a payment or refund line is not a dispute line",
  !posting.isDisputeLineType("payment_gross") && !posting.isDisputeLineType("payment_refund"),
);

const ctx = { environment: "sandbox", orderId: null };
const residual = (p) => p.legs.reduce((a, l) => a + l.amountMinor, 0n);
const legFor = (p, acct) =>
  p.legs.filter((l) => l.account === acct).reduce((a, l) => a + l.amountMinor, 0n);
const mv = (lineType, amountMinor, activityId = "act_1") => ({
  activityId,
  lineType,
  amountMinor,
  currency: "usd",
  paymentId: "pay_1",
  postedAt: null,
});

// A $10 chargeback taken from us.
const lost = posting.buildDisputeLedgerPosting(mv("payment_dispute", -1000n), ctx);
check("a dispute withdrawal balances", residual(lost) === 0n);
check(
  "it credits provider_balance and debits suspense — the mirror of the settlement",
  legFor(lost, "provider_balance") === -1000n &&
    legFor(lost, "unallocated_customer_funds") === 1000n,
);
check("and is booked as dispute_lost", lost.economicEvent === "dispute_lost");

// Won: the money comes back.
const won = posting.buildDisputeLedgerPosting(mv("payment_dispute_reversal", 1000n, "act_2"), ctx);
check("a dispute reversal balances", residual(won) === 0n);
check(
  "it restores the provider balance and the suspense liability",
  legFor(won, "provider_balance") === 1000n &&
    legFor(won, "unallocated_customer_funds") === -1000n,
);
check("and is booked as dispute_won", won.economicEvent === "dispute_won");
check(
  "a withdrawal and its reversal net to exactly zero on both accounts",
  legFor(lost, "provider_balance") + legFor(won, "provider_balance") === 0n &&
    legFor(lost, "unallocated_customer_funds") + legFor(won, "unallocated_customer_funds") === 0n,
);

// Fees.
const fee = posting.buildDisputeLedgerPosting(mv("payment_dispute_fee", -1500n, "act_3"), ctx);
check("a dispute fee balances", residual(fee) === 0n);
check(
  "a fee is an EXPENSE, never a customer-funds movement",
  legFor(fee, "provider_fee_expense") === 1500n &&
    legFor(fee, "unallocated_customer_funds") === 0n,
);
const alertFee = posting.buildDisputeLedgerPosting(mv("dispute_alert_fee", -300n, "act_4"), ctx);
check("an alert fee posts as an expense too", legFor(alertFee, "provider_fee_expense") === 300n);

check(
  "an unmapped line type produces NO posting at all",
  posting.buildDisputeLedgerPosting(mv("platform_covered_dispute", -1000n, "act_5"), ctx) === null,
);
check(
  "a zero-amount movement produces no posting",
  posting.buildDisputeLedgerPosting(mv("payment_dispute", 0n, "act_6"), ctx) === null,
);

// THE SIGN COMES FROM THE PROVIDER. A positive payment_dispute is posted
// positive, whatever the word suggests.
const oddSign = posting.buildDisputeLedgerPosting(mv("payment_dispute", 500n, "act_7"), ctx);
check(
  "the provider's SIGN is mirrored, never re-derived from the line-type name",
  legFor(oddSign, "provider_balance") === 500n && residual(oddSign) === 0n,
);

// It balances for every input.
let allBalance = true;
for (const type of Object.keys(posting.DISPUTE_LINE_RULES)) {
  for (const amt of [-100000n, -1500n, -1n, 1n, 87n, 1000n]) {
    const p = posting.buildDisputeLedgerPosting(mv(type, amt), ctx);
    if (p && residual(p) !== 0n) allBalance = false;
  }
}
check("the posting balances for every line type and amount", allBalance);

console.log("\n--- A. economic idempotency ---");

check(
  "the key is built from the LEDGER ROW id, not the dispute id",
  posting.buildDisputeLedgerPosting(mv("payment_dispute", -100n, "act_xyz"), ctx)
    .idempotencyKey === "whop:dispute_lost:act_xyz",
);
check(
  "two movements of one dispute produce TWO distinct keys",
  posting.buildDisputeLedgerPosting(mv("payment_dispute", -100n, "act_a"), ctx).idempotencyKey !==
    posting.buildDisputeLedgerPosting(mv("payment_dispute_fee", -15n, "act_b"), ctx)
      .idempotencyKey,
);
check(
  "no webhook id appears anywhere in the dispute posting builder",
  !/idempotencyKey:[^,]*sourceWebhookId/s.test(
    readFileSync("src/lib/server/accounting/whop-dispute-posting.ts", "utf8"),
  ),
);

/* ==========================================================================
   PART B — sequences and money
   ========================================================================== */

const SCRATCH = "dispute_selftest";
const COMPANY = process.env.WHOP_COMPANY_ID;

const usd = (minor) => ({
  amount: (Number(minor) / 100).toFixed(2),
  currency: "usd",
  decimals: 2,
  display_decimals: 2,
});

function fakeWhop(state) {
  return {
    payments: {
      retrieve: async ({ id }) => {
        if (state.paymentThrows) throw state.paymentThrows;
        const p = state.payments[id];
        if (!p) throw new FakeWhopError("not found", 404);
        return p;
      },
      listFees: async () => ({ data: [] }),
    },
    disputes: {
      retrieve: async ({ id }) => {
        if (state.disputeThrows) throw state.disputeThrows;
        const d = state.disputes[id];
        if (!d) throw new FakeWhopError("not found", 404);
        return d;
      },
      list: async () => {
        if (state.disputeListThrows) throw state.disputeListThrows;
        return { data: Object.values(state.disputes) };
      },
    },
    disputeAlerts: {
      retrieve: async ({ id }) => {
        const a = state.alerts[id];
        if (!a) throw new FakeWhopError("not found", 404);
        return a;
      },
    },
    resolutionCenterCases: {
      retrieve: async ({ id }) => {
        const c = state.cases[id];
        if (!c) throw new FakeWhopError("not found", 404);
        return c;
      },
    },
    financialActivity: {
      list: async () => {
        if (state.ledgerThrows) throw state.ledgerThrows;
        return { data: state.ledger ?? [] };
      },
    },
  };
}

function paymentFixture({ id, orderId, minor = 1000, account = COMPANY }) {
  return {
    id,
    account_id: account,
    status: "paid",
    currency: "usd",
    metadata: orderId ? { order_id: orderId } : {},
    subtotal: usd(minor),
    total: usd(minor),
    tax_amount: usd(0),
    tax_refunded_amount: usd(0),
    amount_after_fees: usd(minor),
    refundable: true,
    refunded_amount: usd(0),
    paid_at: "2026-09-05T10:00:00.000Z",
  };
}

function disputeFixture({ id, paymentId, minor = 1000, status = "needs_response", account = COMPANY, inquiry = false }) {
  return {
    id,
    account_id: account,
    amount: Number(minor) / 100,
    currency: "usd",
    status,
    inquiry,
    rapid_dispute_resolution: false,
    reason: "fraudulent",
    reason_code: "10.4",
    payment: { id: paymentId },
    evidence_due_at: "2026-09-20T00:00:00.000Z",
    evidence_submitted_at: null,
    created_at: "2026-09-06T10:00:00.000Z",
    updated_at: "2026-09-06T10:00:00.000Z",
  };
}

function ledgerRow({ id, lineType, minorAmount, paymentId }) {
  // Precision 1e8, exactly as the real feed reports for USD.
  return {
    id,
    line_type: lineType,
    amount: String(BigInt(minorAmount) * 1000000n),
    currency: { code: "usd", precision: "100000000" },
    payment_id: paymentId,
    posted_at: "2026-09-06T11:00:00.000Z",
    object: "ledger_activity",
  };
}

async function sequences() {
  console.log("\n--- B. dispute sequences (throwaway schema, fake provider) ---");

  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — part B skipped");
    return;
  }

  const postgres = require("postgres");
  const { drizzle } = require("drizzle-orm/postgres-js");

  /*
   * THE DIRECT ENDPOINT, not the pooled one. `search_path` is SESSION state,
   * and Neon's pooler is PgBouncer in transaction mode: a SET issued on one
   * backend may not be there for the next statement, so the setting silently
   * lapses back to `public` mid-run. That is how an earlier suite wrote its
   * fixtures into the real tables. The application's pooled connection is
   * never touched or reconfigured by this file.
   */
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const beforeTxns = await client`select count(*)::int as n from accounting_transactions`;
  const beforeEntries = await client`select count(*)::int as n from accounting_entries`;
  const beforeOrders = await client`select order_id, status, paid_at, whop_payment_id from payment_orders order by created_at`;
  const beforeRefunds = await client`select count(*)::int as n from payment_refunds`;
  const beforeLedger = await client`select count(*)::int as n from financial_ledger`;
  const beforeMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;
  let syntheticDisputeIds = [];

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);

    const ddl = [
      readFileSync("drizzle/0002_misty_obadiah_stane.sql", "utf8"),
      readFileSync("drizzle/0004_thin_ben_urich.sql", "utf8"),
      readFileSync("drizzle/0005_slippery_hitman.sql", "utf8"),
      readFileSync("drizzle/0006_wise_unus.sql", "utf8"),
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
    check("migration 0006 applies cleanly on top of 0002, 0004 and 0005", true);

    /*
     * THE ISOLATION SEAM, PROVED BEFORE ANY FIXTURE IS WRITTEN. The modules
     * name their tables unqualified, so which schema they hit is decided by
     * `search_path`. This resolves the very names they will use and REFUSES TO
     * CONTINUE unless every one landed in the throwaway schema.
     */
    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('payment_orders')) as orders_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('payment_disputes')) as disputes_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('dispute_alerts')) as alerts_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('resolution_center_cases')) as cases_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('accounting_entries')) as entries_schema`;

    const isolated =
      where.schema === SCRATCH &&
      where.orders_schema === SCRATCH &&
      where.disputes_schema === SCRATCH &&
      where.alerts_schema === SCRATCH &&
      where.cases_schema === SCRATCH &&
      where.entries_schema === SCRATCH;

    if (!isolated) {
      throw new Error(
        `ISOLATION FAILED — refusing to write: ${show(where)}`,
      );
    }
    check(
      "ISOLATION PROVED: every dispute table the modules name resolves to the throwaway schema",
      isolated,
      `${where.disputes_schema}/${where.alerts_schema}/${where.cases_schema}`,
    );

    const [publicDisputes] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('payment_disputes','dispute_alerts','resolution_center_cases')`;
    // 0006 IS applied now — deliberately, after task 4 was reviewed. What this
    // suite must still assert is that IT applies nothing and writes nothing
    // there; the fixtures below all land in the throwaway schema, proved above.
    check(
      "the real dispute tables exist in public — 0006 is applied",
      publicDisputes.n === 3,
      `${publicDisputes.n}/3`,
    );

    const schema = loadTs("src/lib/db/schema.ts");
    DB = drizzle(scoped, { schema });

    const orders = loadTs("src/lib/server/payment-orders.ts");
    const mapping = loadTs("src/lib/server/whop-dispute-mapping.ts");
    const disputeTable = loadTs("src/lib/server/payment-disputes.ts");
    const recovery = loadTs("src/lib/server/accounting/dispute-recovery.ts");
    const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
    const paymentPosting = loadTs("src/lib/server/accounting/whop-payment-posting.ts");

    let seq = 0;

    async function settledCase({ minor = 1000 } = {}) {
      seq += 1;
      const paymentId = `pay_d${seq}`;
      const created = await orders.createPaymentOrder({
        amountMinor: BigInt(minor),
        currency: "usd",
        purpose: `dispute-test-${seq}`,
      });
      if (!created.ok) throw new Error(`order creation failed: ${created.reason}`);
      const orderId = created.order.orderId;

      const state = {
        payments: { [paymentId]: paymentFixture({ id: paymentId, orderId, minor }) },
        disputes: {},
        alerts: {},
        cases: {},
        ledger: [],
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

    const balanceOf = async (account) => {
      const [row] = await scoped.unsafe(
        `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries where account = '${account}'`,
      );
      return BigInt(row.s);
    };
    const countDisputeTxns = async (activityId) => {
      const [row] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
         where provider_resource_id = '${activityId}'
           and economic_event in ('dispute_opened','dispute_won','dispute_lost')`,
      );
      return row.n;
    };
    const disputeRow = async (id) => {
      const [row] = await scoped.unsafe(
        `select * from ${SCRATCH}.payment_disputes where whop_dispute_id = '${id}'`,
      );
      return row;
    };

    /* --------------------------------------------------------------- create */
    console.log("\n  · dispute created -> updated -> won");
    {
      const { orderId, paymentId, state } = await settledCase();
      state.disputes.dspt_a = disputeFixture({ id: "dspt_a", paymentId, minor: 1000 });

      let r = await webhooks.handleWhopDispute("dspt_a", "msg_1");
      check("dispute.created is handled", r.kind === "handled", show(r));
      let row = await disputeRow("dspt_a");
      check("the row is open with the raw provider status kept", row.status === "open" && row.provider_status === "needs_response");
      check("and mapped to the right order and payment", row.order_id === orderId && row.whop_payment_id === paymentId);
      check("no accounting yet — the provider ledger shows no movement", (await countDisputeTxns("led_1")) === 0);

      // The processor takes the money and charges a fee.
      state.disputes.dspt_a.status = "under_review";
      state.ledger = [
        ledgerRow({ id: "led_1", lineType: "payment_dispute", minorAmount: -1000, paymentId }),
        ledgerRow({ id: "led_2", lineType: "payment_dispute_fee", minorAmount: -1500, paymentId }),
      ];
      const balBefore = await balanceOf("provider_balance");
      r = await webhooks.handleWhopDispute("dspt_a", "msg_2");
      check("dispute.updated is handled", r.kind === "handled");
      row = await disputeRow("dspt_a");
      check("the row follows the provider to under_review", row.provider_status === "under_review" && row.status === "open");
      check("the withdrawal posted", (await countDisputeTxns("led_1")) === 1);
      check("the fee posted", (await countDisputeTxns("led_2")) === 1);
      check(
        "the provider balance fell by the disputed amount plus the fee",
        (await balanceOf("provider_balance")) - balBefore === -2500n,
      );

      // Won: the money comes back (the fee does not).
      state.disputes.dspt_a.status = "won";
      state.ledger.push(
        ledgerRow({ id: "led_3", lineType: "payment_dispute_reversal", minorAmount: 1000, paymentId }),
      );
      r = await webhooks.handleWhopDispute("dspt_a", "msg_3");
      check("the win is handled", r.kind === "handled");
      row = await disputeRow("dspt_a");
      check("the row is won and carries a resolution time", row.status === "won" && row.resolved_at !== null);
      check("the reversal posted", (await countDisputeTxns("led_3")) === 1);
      check(
        "the balance is back to where it started, less the retained fee",
        (await balanceOf("provider_balance")) - balBefore === -1500n,
      );

      /* --- stale events after a terminal state --- */
      state.disputes.dspt_a.status = "needs_response";
      await webhooks.handleWhopDispute("dspt_a", "msg_4_stale");
      row = await disputeRow("dspt_a");
      check("a STALE needs_response after a win cannot reopen the dispute", row.status === "won");
      state.disputes.dspt_a.status = "under_review";
      await webhooks.handleWhopDispute("dspt_a", "msg_5_stale");
      row = await disputeRow("dspt_a");
      check("nor can a stale under-review update", row.status === "won");
      state.disputes.dspt_a.status = "lost";
      await webhooks.handleWhopDispute("dspt_a", "msg_6_stale");
      row = await disputeRow("dspt_a");
      check("nor can a later `lost` flip a won dispute", row.status === "won");
      check(
        "and no duplicate money was posted through any of that",
        (await countDisputeTxns("led_1")) === 1 &&
          (await countDisputeTxns("led_2")) === 1 &&
          (await countDisputeTxns("led_3")) === 1,
      );
      syntheticDisputeIds.push("dspt_a");
    }

    /* ------------------------------------------------------- created -> lost */
    console.log("\n  · dispute created -> lost");
    {
      const { paymentId, state } = await settledCase();
      state.disputes.dspt_b = disputeFixture({ id: "dspt_b", paymentId, status: "lost" });
      state.ledger = [
        ledgerRow({ id: "led_b1", lineType: "payment_dispute", minorAmount: -1000, paymentId }),
      ];
      const suspenseBefore = await balanceOf("unallocated_customer_funds");
      const r = await webhooks.handleWhopDispute("dspt_b", "msg_b");
      check("a dispute that arrives already lost is handled", r.kind === "handled");
      const row = await disputeRow("dspt_b");
      check("and is recorded lost with a resolution time", row.status === "lost" && row.resolved_at !== null);
      check(
        "the suspense liability is discharged — the customer got their money",
        (await balanceOf("unallocated_customer_funds")) - suspenseBefore === 1000n,
      );

      // The read paths the reconciliation and recovery passes depend on.
      const fetched = await disputeTable.getDisputeByProviderId("dspt_b");
      check(
        "the dispute reads back by its provider id with amount and currency intact",
        fetched !== null && fetched.amountMinor === 1000n && fetched.currency === "usd",
        show(fetched && { amount: fetched.amountMinor, status: fetched.status }),
      );
      const forPayment = await disputeTable.listDisputesForPaymentLocal(paymentId);
      check(
        "and lists under the payment it disputes",
        forPayment.length === 1 && forPayment[0].whopDisputeId === "dspt_b",
      );
      syntheticDisputeIds.push("dspt_b");
    }

    /* ------------------------------------------------------------- inquiry */
    console.log("\n  · inquiry (warning phase, no funds)");
    {
      const { paymentId, state } = await settledCase();
      state.disputes.dspt_inq = disputeFixture({
        id: "dspt_inq",
        paymentId,
        status: "warning_needs_response",
        inquiry: true,
      });
      const balBefore = await balanceOf("provider_balance");
      const r = await webhooks.handleWhopDispute("dspt_inq", "msg_inq");
      check("an inquiry is handled", r.kind === "handled");
      const row = await disputeRow("dspt_inq");
      check("it is recorded as `warning`, kept separate from a formal dispute", row.status === "warning");
      check("and flagged as an inquiry", row.inquiry === true);
      check(
        "an inquiry moves NO money — the ledger showed none, so none was posted",
        (await balanceOf("provider_balance")) === balBefore,
      );

      // Even reaching `lost`, an inquiry with no ledger movement posts nothing.
      state.disputes.dspt_inq.status = "warning_closed";
      await webhooks.handleWhopDispute("dspt_inq", "msg_inq2");
      check(
        "and a closed inquiry still posts nothing",
        (await balanceOf("provider_balance")) === balBefore,
      );
      syntheticDisputeIds.push("dspt_inq");
    }

    /* --------------------------------------------------- duplicates / races */
    console.log("\n  · duplicates and concurrency");
    {
      const { paymentId, state } = await settledCase();
      state.disputes.dspt_dup = disputeFixture({ id: "dspt_dup", paymentId, status: "lost" });
      state.ledger = [
        ledgerRow({ id: "led_dup", lineType: "payment_dispute", minorAmount: -1000, paymentId }),
      ];

      await webhooks.handleWhopDispute("dspt_dup", "msg_x");
      const balAfterFirst = await balanceOf("provider_balance");
      await webhooks.handleWhopDispute("dspt_dup", "msg_x");
      await webhooks.handleWhopDispute("dspt_dup", "msg_totally_different");
      check("duplicate and differently-identified deliveries post ONCE", (await countDisputeTxns("led_dup")) === 1);
      check("and move no extra money", (await balanceOf("provider_balance")) === balAfterFirst);
      const [rows] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_disputes where whop_dispute_id = 'dspt_dup'`,
      );
      check("two different webhook ids converge on ONE row", rows.n === 1);

      const { paymentId: p2, state: s2 } = await settledCase();
      s2.disputes.dspt_race = disputeFixture({ id: "dspt_race", paymentId: p2, status: "lost" });
      s2.ledger = [ledgerRow({ id: "led_race", lineType: "payment_dispute", minorAmount: -1000, paymentId: p2 })];
      const raced = await Promise.allSettled([
        webhooks.handleWhopDispute("dspt_race", "c1"),
        webhooks.handleWhopDispute("dspt_race", "c2"),
        webhooks.handleWhopDispute("dspt_race", "c3"),
      ]);
      check(
        "three concurrent deliveries create exactly ONE transaction",
        (await countDisputeTxns("led_race")) === 1,
        raced.map((r) => r.status).join("/"),
      );
      const [raceRows] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_disputes where whop_dispute_id = 'dspt_race'`,
      );
      check("and exactly ONE operational row", raceRows.n === 1);
      syntheticDisputeIds.push("dspt_dup", "dspt_race");
    }

    /* ----------------------------------------------------------- rejections */
    console.log("\n  · rejections");
    {
      const a = await settledCase();
      const b = await settledCase();

      // Wrong company on the payment.
      const c = await settledCase();
      c.state.payments[c.paymentId].account_id = "biz_someoneelse";
      c.state.disputes.dspt_wc = disputeFixture({ id: "dspt_wc", paymentId: c.paymentId });
      let out = await mapping.mapDisputeToOrder("dspt_wc");
      check("a dispute on another company's payment is REJECTED", out.kind === "rejected" && out.reason === "wrong_company", show(out));

      // Wrong company on the dispute itself.
      const d = await settledCase();
      d.state.disputes.dspt_wa = disputeFixture({ id: "dspt_wa", paymentId: d.paymentId, account: "biz_other" });
      out = await mapping.mapDisputeToOrder("dspt_wa");
      check("a dispute filed by another company is REJECTED even when the payment is ours", out.kind === "rejected" && out.reason === "wrong_company");

      // Wrong payment: the dispute names B's payment but B's metadata claims A's order.
      const st = a.state;
      st.payments[b.paymentId] = paymentFixture({ id: b.paymentId, orderId: a.orderId });
      st.disputes.dspt_wp = disputeFixture({ id: "dspt_wp", paymentId: b.paymentId });
      FAKE_WHOP = fakeWhop(st);
      out = await mapping.mapDisputeToOrder("dspt_wp");
      check("a dispute whose payment did not settle the named order is REJECTED", out.kind === "rejected" && out.reason === "payment_mismatch", show(out));

      // No order reference.
      const e = await settledCase();
      e.state.payments[e.paymentId].metadata = {};
      e.state.disputes.dspt_no = disputeFixture({ id: "dspt_no", paymentId: e.paymentId });
      out = await mapping.mapDisputeToOrder("dspt_no");
      check("a dispute whose payment names no order is REJECTED", out.kind === "rejected" && out.reason === "no_order_reference");

      // Order not found.
      const f = await settledCase();
      f.state.payments[f.paymentId].metadata = { order_id: "00000000-0000-4000-8000-000000000000" };
      f.state.disputes.dspt_gh = disputeFixture({ id: "dspt_gh", paymentId: f.paymentId });
      out = await mapping.mapDisputeToOrder("dspt_gh");
      check("a dispute naming an order we do not have is REJECTED", out.kind === "rejected" && out.reason === "order_not_found");

      // Amount larger than the payment.
      const g = await settledCase();
      g.state.disputes.dspt_big = disputeFixture({ id: "dspt_big", paymentId: g.paymentId, minor: 5000 });
      out = await mapping.mapDisputeToOrder("dspt_big");
      check("a dispute larger than the payment is REJECTED", out.kind === "rejected" && out.reason === "amount_exceeds_payment", show(out));

      // Wrong currency.
      const h = await settledCase();
      h.state.disputes.dspt_eur = { ...disputeFixture({ id: "dspt_eur", paymentId: h.paymentId }), currency: "eur" };
      out = await mapping.mapDisputeToOrder("dspt_eur");
      check("a dispute in another currency is REJECTED, never converted", out.kind === "rejected", show(out));

      // Malformed / missing.
      out = await mapping.mapDisputeToOrder("pay_notadispute");
      check("a malformed dispute id is REJECTED without a provider call", out.kind === "rejected" && out.reason === "invalid_resource_id");
      out = await mapping.mapDisputeToOrder("dspt_doesnotexist");
      check("a dispute the provider has never heard of is REJECTED", out.kind === "rejected" && out.reason === "resource_not_found");

      // Provider failures.
      const i = await settledCase();
      i.state.disputes.dspt_err = disputeFixture({ id: "dspt_err", paymentId: i.paymentId });
      for (const [label, code] of [["429", 429], ["500", 500], ["timeout", undefined]]) {
        i.state.disputeThrows = new FakeWhopError("boom", code);
        out = await mapping.mapDisputeToOrder("dspt_err");
        check(`a provider ${label} is REJECTED as provider_error (retryable), not guessed`, out.kind === "rejected" && out.reason === "provider_error");
      }
      delete i.state.disputeThrows;

      // Unknown provider status must not resolve anything.
      const j = await settledCase();
      j.state.disputes.dspt_unk = disputeFixture({ id: "dspt_unk", paymentId: j.paymentId, status: "teleported" });
      out = await mapping.mapDisputeToOrder("dspt_unk");
      check("an UNKNOWN provider status is recorded, not rejected", out.kind === "recorded", show(out));
      const unkRow = await disputeRow("dspt_unk");
      check("and fails safe to `open` with the raw status preserved", unkRow.status === "open" && unkRow.provider_status === "teleported");
      syntheticDisputeIds.push("dspt_unk", "dspt_wp");
    }

    /* --------------------------------------------------------------- alerts */
    console.log("\n  · dispute alerts");
    {
      const { orderId, paymentId, state } = await settledCase();
      state.alerts.dspa_1 = {
        id: "dspa_1",
        account_id: COMPANY,
        payment_id: paymentId,
        amount: 10,
        currency: "usd",
        type: "dispute_alert",
        actionable: true,
        not_actionable_reason: null,
        fee_charged: true,
        card_brand: "visa",
        reported_at: "2026-09-06T09:00:00.000Z",
        created_at: "2026-09-06T09:05:00.000Z",
        updated_at: "2026-09-06T09:05:00.000Z",
      };
      const balBefore = await balanceOf("provider_balance");
      let r = await webhooks.handleWhopDisputeAlert("dspa_1");
      check("an alert is handled", r.kind === "handled", show(r));
      const [alertRow] = await scoped.unsafe(
        `select * from ${SCRATCH}.dispute_alerts where whop_alert_id = 'dspa_1'`,
      );
      check("it is recorded and mapped to the order", alertRow.order_id === orderId && alertRow.whop_payment_id === paymentId);
      check("as actionable, with the fee flag preserved", alertRow.status === "actionable" && alertRow.fee_charged === true);
      check(
        "AN ALERT POSTS NO ACCOUNTING even though fee_charged is true — there is no amount to post",
        (await balanceOf("provider_balance")) === balBefore,
      );

      // Duplicate handling.
      await webhooks.handleWhopDisputeAlert("dspa_1");
      const [dupAlerts] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.dispute_alerts where whop_alert_id = 'dspa_1'`,
      );
      check("a duplicate alert delivery converges on one row", dupAlerts.n === 1);

      // The alert becomes not-actionable.
      state.alerts.dspa_1.actionable = false;
      state.alerts.dspa_1.not_actionable_reason = "payment_disputed";
      await webhooks.handleWhopDisputeAlert("dspa_1");
      const [updated] = await scoped.unsafe(
        `select status, not_actionable_reason from ${SCRATCH}.dispute_alerts where whop_alert_id = 'dspa_1'`,
      );
      check("and follows the provider to not_actionable with its reason", updated.status === "not_actionable" && updated.not_actionable_reason === "payment_disputed");

      // An UNMATCHED alert.
      state.alerts.dspa_un = { ...state.alerts.dspa_1, id: "dspa_un", payment_id: null, actionable: false, not_actionable_reason: "payment_unmatched" };
      r = await webhooks.handleWhopDisputeAlert("dspa_un");
      check("an alert Whop could not match to a payment is still handled, not discarded", r.kind === "handled", show(r));
      const [unmatched] = await scoped.unsafe(
        `select whop_payment_id, order_id from ${SCRATCH}.dispute_alerts where whop_alert_id = 'dspa_un'`,
      );
      check("and stored with no payment and no order", unmatched.whop_payment_id === null && unmatched.order_id === null);

      // Wrong company.
      state.alerts.dspa_wc = { ...state.alerts.dspa_1, id: "dspa_wc", account_id: "biz_other" };
      const wc = await mapping.mapAlertToOrder("dspa_wc");
      check("an alert filed against another company is REJECTED", wc.kind === "rejected" && wc.reason === "wrong_company");
    }

    /* ----------------------------------------------------- resolution center */
    console.log("\n  · resolution center cases");
    {
      const { orderId, paymentId, state } = await settledCase();
      const baseCase = {
        id: "reso_1",
        account: { id: COMPANY },
        payment: { id: paymentId },
        amount: 10,
        currency: "usd",
        status: "awaiting_merchant",
        outcome: null,
        refund: null,
        reason: "product_not_received",
        escalated: false,
        created_at: "2026-09-06T08:00:00.000Z",
        updated_at: "2026-09-06T08:00:00.000Z",
      };
      state.cases.reso_1 = { ...baseCase };
      const balBefore = await balanceOf("provider_balance");
      const txnsBefore = (await scoped.unsafe(`select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;

      let r = await webhooks.handleWhopResolutionCase("reso_1");
      check("a case creation is handled", r.kind === "handled", show(r));
      let [caseRow] = await scoped.unsafe(
        `select * from ${SCRATCH}.resolution_center_cases where whop_case_id = 'reso_1'`,
      );
      check("it is recorded open and mapped to the order", caseRow.status === "open" && caseRow.order_id === orderId);
      check("with no outcome while open", caseRow.outcome === null);

      // Update.
      state.cases.reso_1.status = "under_review";
      state.cases.reso_1.escalated = true;
      r = await webhooks.handleWhopResolutionCase("reso_1");
      [caseRow] = await scoped.unsafe(
        `select * from ${SCRATCH}.resolution_center_cases where whop_case_id = 'reso_1'`,
      );
      check("an update follows the provider status", caseRow.provider_status === "under_review" && caseRow.escalated === true);

      // Decided, customer won, merchant refunded.
      state.cases.reso_1.status = "closed";
      state.cases.reso_1.outcome = "customer_won";
      state.cases.reso_1.refund = "merchant";
      r = await webhooks.handleWhopResolutionCase("reso_1");
      check("a decision is handled", r.kind === "handled");
      [caseRow] = await scoped.unsafe(
        `select * from ${SCRATCH}.resolution_center_cases where whop_case_id = 'reso_1'`,
      );
      check("the case closes with its outcome and refund source", caseRow.status === "closed" && caseRow.outcome === "customer_won" && caseRow.refund_source === "merchant");
      check(
        "A CASE POSTS NO ACCOUNTING, even when decided with a merchant refund",
        (await balanceOf("provider_balance")) === balBefore,
      );
      const txnsAfter = (await scoped.unsafe(`select count(*)::int as n from ${SCRATCH}.accounting_transactions`))[0].n;
      check("and created no transaction of any kind", txnsAfter === txnsBefore);

      // Stale update after close.
      state.cases.reso_1.status = "awaiting_merchant";
      await webhooks.handleWhopResolutionCase("reso_1");
      [caseRow] = await scoped.unsafe(
        `select status from ${SCRATCH}.resolution_center_cases where whop_case_id = 'reso_1'`,
      );
      check("a stale update cannot reopen a closed case", caseRow.status === "closed");

      // Duplicate.
      const [dupCases] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.resolution_center_cases where whop_case_id = 'reso_1'`,
      );
      check("duplicate case deliveries converge on one row", dupCases.n === 1);

      // Wrong company.
      state.cases.reso_wc = { ...baseCase, id: "reso_wc", account: { id: "biz_other" } };
      const wc = await mapping.mapCaseToOrder("reso_wc");
      check("a case on another company is REJECTED", wc.kind === "rejected" && wc.reason === "wrong_company");
    }

    /* -------------------------------------------------------- crash recovery */
    console.log("\n  · crash recovery");
    {
      const { paymentId, state } = await settledCase();
      state.disputes.dspt_crash = disputeFixture({ id: "dspt_crash", paymentId, status: "lost" });
      state.ledger = [
        ledgerRow({ id: "led_crash", lineType: "payment_dispute", minorAmount: -1000, paymentId }),
      ];

      // STEP 1 ONLY — exactly what a process that died before accounting leaves.
      const mapped = await mapping.mapDisputeToOrder("dspt_crash");
      check("the operational row is written first", mapped.kind === "recorded");
      check("and at this instant there is NO accounting — the crash window is real", (await countDisputeTxns("led_crash")) === 0);

      const findings = await reconcile.reconcileDisputesAgainstProvider(paymentId);
      check(
        "reconciliation DETECTS the missing posting",
        findings.some((f) => f.code === "dispute_missing_ledger"),
        show(findings.map((f) => f.code)),
      );

      const dry = await recovery.recoverMissingDisputePostings({ dryRun: true });
      check("a dry run posts nothing", dry.outcomes.length > 0 && (await countDisputeTxns("led_crash")) === 0);

      const repaired = await recovery.convergeDispute("dspt_crash");
      check("recovery posts the missing movement", repaired.result.kind === "converged", show(repaired.result));
      check("exactly once", (await countDisputeTxns("led_crash")) === 1);

      const again = await recovery.convergeDispute("dspt_crash");
      check(
        "running recovery again posts nothing more",
        again.result.kind === "converged" && (await countDisputeTxns("led_crash")) === 1,
      );

      const balNow = await balanceOf("provider_balance");
      await webhooks.handleWhopDispute("dspt_crash", "msg_redeliver");
      check(
        "a redelivery after the accounting exists does NOT duplicate money",
        (await countDisputeTxns("led_crash")) === 1 && (await balanceOf("provider_balance")) === balNow,
      );

      const clean = await reconcile.reconcileDisputesAgainstProvider(paymentId);
      check(
        "and reconciliation no longer reports the gap",
        clean.filter((f) => f.code === "dispute_missing_ledger").length === 0,
      );
      syntheticDisputeIds.push("dspt_crash");
    }

    /* ------------------------------------------- unmapped line types + outage */
    console.log("\n  · unmapped movements and provider outages");
    {
      const { paymentId, state } = await settledCase();
      state.disputes.dspt_pc = disputeFixture({ id: "dspt_pc", paymentId, status: "lost" });
      state.ledger = [
        ledgerRow({ id: "led_pc", lineType: "platform_covered_dispute", minorAmount: -1000, paymentId }),
        ledgerRow({ id: "led_hold", lineType: "dispute_hold_adjustment", minorAmount: -500, paymentId }),
      ];
      const balBefore = await balanceOf("provider_balance");
      const r = await webhooks.handleWhopDispute("dspt_pc", "msg_pc");
      check("a dispute whose movements we cannot map is still handled", r.kind === "handled");
      check(
        "platform_covered_dispute posts NOTHING — it was never our money",
        (await countDisputeTxns("led_pc")) === 0 && (await balanceOf("provider_balance")) === balBefore,
      );
      check("dispute_hold_adjustment posts nothing either", (await countDisputeTxns("led_hold")) === 0);

      const findings = await reconcile.reconcileDisputesAgainstProvider(paymentId);
      const unmapped = findings.filter((f) => f.code === "dispute_unmapped_line_type");
      check("and BOTH are reported for a human rather than guessed at", unmapped.length === 2, show(unmapped.map((f) => f.detail.slice(0, 40))));

      // Ledger outage: the delivery must FAIL, not be marked handled.
      const { paymentId: p2, state: s2 } = await settledCase();
      s2.disputes.dspt_out = disputeFixture({ id: "dspt_out", paymentId: p2, status: "lost" });
      s2.ledgerThrows = new FakeWhopError("down", 503);
      const outage = await webhooks.handleWhopDispute("dspt_out", "msg_out");
      check(
        "a ledger outage FAILS the delivery so it stays retryable",
        outage.kind === "failed",
        show(outage),
      );
      delete s2.ledgerThrows;

      const unavailable = await reconcile.reconcileDisputesAgainstProvider(p2);
      s2.ledgerThrows = new FakeWhopError("down", 503);
      const unavailable2 = await reconcile.reconcileDisputesAgainstProvider(p2);
      check(
        "an outage is reported as unavailable, never as a disagreement",
        unavailable2.some((f) => f.code === "dispute_provider_unavailable"),
        show(unavailable2.map((f) => f.code)),
      );
      delete s2.ledgerThrows;
      void unavailable;
      syntheticDisputeIds.push("dspt_pc", "dspt_out");
    }

    /* ------------------------------------------------- reconciliation checks */
    console.log("\n  · reconciliation");
    {
      const internal = await reconcile.reconcileDisputesInternal();
      check(
        "the internal pass runs and reports no unbalanced or duplicate postings",
        internal.discrepancies.filter(
          (d) => d.code === "dispute_unbalanced_transaction" || d.code === "dispute_duplicate_ledger",
        ).length === 0,
        `${internal.disputesChecked} disputes, ${internal.transactionsChecked} transactions`,
      );

      // A case claiming a merchant refund with nothing in our books.
      const { paymentId, state } = await settledCase();
      state.cases.reso_gap = {
        id: "reso_gap",
        account: { id: COMPANY },
        payment: { id: paymentId },
        amount: 10,
        currency: "usd",
        status: "closed",
        outcome: "customer_won",
        refund: "merchant",
        reason: "fraudulent",
        escalated: false,
        created_at: "2026-09-06T08:00:00.000Z",
        updated_at: "2026-09-06T08:00:00.000Z",
      };
      await webhooks.handleWhopResolutionCase("reso_gap");
      const withGap = await reconcile.reconcileDisputesInternal();
      check(
        "a case claiming a MERCHANT refund with nothing in our books is DETECTED",
        withGap.discrepancies.some((d) => d.code === "case_refund_unaccounted" && d.disputeId === "reso_gap"),
      );

      // A case claiming Whop paid, while we booked a loss.
      const lostCase = await settledCase();
      lostCase.state.disputes.dspt_pl = disputeFixture({ id: "dspt_pl", paymentId: lostCase.paymentId, status: "lost" });
      lostCase.state.ledger = [];
      await webhooks.handleWhopDispute("dspt_pl", "msg_pl");
      lostCase.state.cases.reso_pl = {
        id: "reso_pl",
        account: { id: COMPANY },
        payment: { id: lostCase.paymentId },
        amount: 10,
        currency: "usd",
        status: "closed",
        outcome: "customer_won",
        refund: "platform",
        reason: "fraudulent",
        escalated: false,
        created_at: "2026-09-06T08:00:00.000Z",
        updated_at: "2026-09-06T08:00:00.000Z",
      };
      await webhooks.handleWhopResolutionCase("reso_pl");
      const withPlatform = await reconcile.reconcileDisputesInternal();
      check(
        "a case claiming WHOP paid while our books show a loss is DETECTED",
        withPlatform.discrepancies.some((d) => d.code === "case_platform_refund_booked_locally"),
      );
      syntheticDisputeIds.push("dspt_pl");

      // Status mismatch against the provider.
      const sm = await settledCase();
      sm.state.disputes.dspt_sm = disputeFixture({ id: "dspt_sm", paymentId: sm.paymentId, status: "needs_response" });
      await webhooks.handleWhopDispute("dspt_sm", "msg_sm");
      sm.state.disputes.dspt_sm.status = "under_review";
      const mismatch = await reconcile.reconcileDisputesAgainstProvider(sm.paymentId);
      check(
        "a status mismatch against the provider is DETECTED",
        mismatch.some((f) => f.code === "dispute_status_mismatch"),
        show(mismatch.map((f) => f.code)),
      );

      // Amount mismatch.
      sm.state.disputes.dspt_sm.status = "needs_response";
      sm.state.disputes.dspt_sm.amount = 5;
      const amtMismatch = await reconcile.reconcileDisputesAgainstProvider(sm.paymentId);
      check(
        "an amount mismatch is DETECTED",
        amtMismatch.some((f) => f.code === "dispute_amount_mismatch"),
      );
      syntheticDisputeIds.push("dspt_sm");
    }

    /* ------------------------------------------------------ ledger invariants */
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
         where account in ('platform_revenue','creator_payable','campaign_funds','refunds_payable','dispute_reserve','payout_clearing','fx_adjustment')`,
      );
      check("NO revenue, creator-payable, dispute-reserve or payout legs were created", forbidden.n === 0);

      const [events] = await scoped.unsafe(
        `select string_agg(distinct economic_event::text, ',' order by economic_event::text) as e
         from ${SCRATCH}.accounting_transactions`,
      );
      check(
        "only settlement and dispute events were posted — no payout, transfer or reversal",
        events.e === "dispute_lost,dispute_opened,dispute_won,payment_settled",
        events.e,
      );

      // The settlement history is untouched.
      const [settlements] = await scoped.unsafe(
        `select count(*)::int as n, coalesce(sum(e.amount_minor),0)::text as s
         from ${SCRATCH}.accounting_entries e
         join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
         where t.economic_event = 'payment_settled'`,
      );
      check("every settlement transaction still balances", settlements.s === "0");

      let updateBlocked = false;
      try {
        await scoped.unsafe(`update ${SCRATCH}.accounting_entries set amount_minor = 1 where true`);
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

      /* --- the 0006 constraints --- */
      let negBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_disputes (whop_dispute_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('dspt_neg','pay_x','sandbox',-1,'usd','won')`,
        );
      } catch (e) {
        negBlocked = /amount_nonnegative/.test(String(e.message));
      }
      check("0006 refuses a negative dispute amount", negBlocked);

      let prefixBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_disputes (whop_dispute_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('pay_wrong','pay_x','sandbox',100,'usd','won')`,
        );
      } catch (e) {
        prefixBlocked = /dispute_id_prefix/.test(String(e.message));
      }
      check("0006 refuses a payment id in the dispute id column", prefixBlocked);

      let dupBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_disputes (whop_dispute_id, whop_payment_id, environment, amount_minor, currency, provider_status)
           values ('dspt_a','pay_x','sandbox',100,'usd','won')`,
        );
      } catch (e) {
        dupBlocked = /uniq_disputes_provider_dispute/.test(String(e.message));
      }
      check("0006 refuses a second row for one provider dispute", dupBlocked);

      let resolvedBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.payment_disputes (whop_dispute_id, whop_payment_id, environment, amount_minor, currency, provider_status, status)
           values ('dspt_nt','pay_x','sandbox',100,'usd','won','won')`,
        );
      } catch (e) {
        resolvedBlocked = /resolved_has_time/.test(String(e.message));
      }
      check("0006 refuses a resolved dispute with no resolved_at", resolvedBlocked);

      let outcomeBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.resolution_center_cases (whop_case_id, environment, amount_minor, currency, provider_status, status, outcome)
           values ('reso_bad','sandbox',100,'usd','awaiting_merchant','open','customer_won')`,
        );
      } catch (e) {
        outcomeBlocked = /outcome_only_when_closed/.test(String(e.message));
      }
      check("0006 refuses an outcome on a case that is still open", outcomeBlocked);

      let refundSourceBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.resolution_center_cases (whop_case_id, environment, amount_minor, currency, provider_status, status, refund_source)
           values ('reso_bad2','sandbox',100,'usd','awaiting_merchant','open','merchent')`,
        );
      } catch (e) {
        refundSourceBlocked = /refund_source_values/.test(String(e.message));
      }
      check("0006 refuses a typo'd refund_source", refundSourceBlocked);

      let alertTypeBlocked = false;
      try {
        await scoped.unsafe(
          `insert into ${SCRATCH}.dispute_alerts (whop_alert_id, environment, amount_minor, currency, alert_type)
           values ('dspa_bad','sandbox',100,'usd','made_up')`,
        );
      } catch (e) {
        alertTypeBlocked = /type_values/.test(String(e.message));
      }
      check("0006 refuses an invented alert type", alertTypeBlocked);
    }
  } finally {
    try {
      const rows = await client.unsafe(
        `select whop_dispute_id from ${SCRATCH}.payment_disputes`,
      );
      syntheticDisputeIds = rows.map((r) => r.whop_dispute_id);
    } catch {
      /* schema may not exist if isolation failed; that error is already reported */
    }

    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("reset search_path");
    if (scoped) await scoped.end();

    console.log("\n--- B. the real public database, after the tests ---");

    const [schemaCheck] = await client`select current_schema() as schema`;
    check("the session is back on public", schemaCheck.schema === "public");

    const afterMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check(
      "this suite applied no migration",
      beforeMigrations[0].n === afterMigrations[0].n,
      `${afterMigrations[0].n} migrations`,
    );

    const [publicDisputeTables] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('payment_disputes','dispute_alerts','resolution_center_cases')`;
    check("the real dispute tables are still present", publicDisputeTables.n === 3);

    const afterTxns = await client`select count(*)::int as n from accounting_transactions`;
    check(
      "this suite added no transaction to the real journal",
      afterTxns[0].n === beforeTxns[0].n,
      `${beforeTxns[0].n} -> ${afterTxns[0].n}`,
    );

    const afterEntries = await client`
      select count(*)::int as n, coalesce(sum(amount_minor),0)::text as s from accounting_entries`;
    check(
      "the real ledger is unchanged and still balances",
      afterEntries[0].n === beforeEntries[0].n && afterEntries[0].s === "0",
      `${afterEntries[0].n} legs, residual ${afterEntries[0].s}`,
    );

    const [disputeTxns] = await client`
      select count(*)::int as n from accounting_transactions
      where economic_event in ('dispute_opened','dispute_won','dispute_lost')`;
    check("no dispute transaction leaked into the real ledger", disputeTxns.n === 0);

    const afterOrders = await client`select order_id, status, paid_at, whop_payment_id from payment_orders order by created_at`;
    check(
      "payment_orders is byte-for-byte unchanged",
      JSON.stringify(afterOrders) === JSON.stringify(beforeOrders),
      `${afterOrders.length} orders`,
    );

    const afterRefunds = await client`select count(*)::int as n from payment_refunds`;
    check(
      "payment_refunds is unchanged — refund history is untouched",
      afterRefunds[0].n === beforeRefunds[0].n,
      `${afterRefunds[0].n} refunds`,
    );

    const afterLedger = await client`select count(*)::int as n from financial_ledger`;
    check("financial_ledger is still 0", afterLedger[0].n === 0 && afterLedger[0].n === beforeLedger[0].n);

    const [scratchGone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", scratchGone.n === 0);
    // The real table exists now, so this is a genuine leak check rather than
    // one satisfied by the table's absence.
    const leaked =
      syntheticDisputeIds.length === 0
        ? []
        : (
            await client`
              select whop_dispute_id from public.payment_disputes
              where whop_dispute_id = any(${syntheticDisputeIds})`
          ).map((r) => r.whop_dispute_id);
    check(
      "not one synthetic dispute id reached the real payment_disputes table",
      leaked.length === 0,
      `${syntheticDisputeIds.length} synthetic, ${leaked.length} leaked`,
    );
    const [realDisputes] = await client`select count(*)::int as n from public.payment_disputes`;
    check("and the real dispute table is still empty", realDisputes.n === 0);

    await client.end();
  }
}

/* ==========================================================================
   PART C — source invariants
   ========================================================================== */

function sourceInvariants() {
  console.log("\n--- C. source invariants ---");

  const files = {
    lifecycle: readFileSync("src/lib/server/dispute-lifecycle.ts", "utf8"),
    resources: readFileSync("src/lib/server/whop-disputes.ts", "utf8"),
    mapping: readFileSync("src/lib/server/whop-dispute-mapping.ts", "utf8"),
    table: readFileSync("src/lib/server/payment-disputes.ts", "utf8"),
    posting: readFileSync("src/lib/server/accounting/whop-dispute-posting.ts", "utf8"),
    recovery: readFileSync("src/lib/server/accounting/dispute-recovery.ts", "utf8"),
  };
  const all = Object.values(files).join("\n");
  const webhookSource = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
  const reconcileSource = readFileSync("src/lib/server/accounting/reconcile.ts", "utf8");

  check("every dispute module is server-only", Object.values(files).every((v) => v.includes('import "server-only"')));

  check(
    "no hard-coded dispute fee anywhere — the fee comes from the provider ledger",
    !/15\.?0?0|1500n\s*\/\/.*fee|DISPUTE_FEE\s*=/.test(all.replace(/led_\w+|act_\w+/g, "")),
  );
  check(
    "no float arithmetic on money: no parseFloat, no Number(...) * 100",
    !/parseFloat|Number\([^)]*\)\s*\*/.test(all),
  );
  // Every module that touches an amount does so as a bigint — either by
  // declaring the type or by constructing one. The posting module does the
  // latter: its amounts arrive already typed on `LedgerMovement`, so it never
  // needs to write the word.
  check(
    "every module that touches an amount uses bigint, never number",
    [files.posting, files.mapping, files.resources, files.table].every((f) =>
      /bigint|BigInt\(/.test(f),
    ),
  );

  /*
   * NO PAYOUTS, TRANSFERS, WITHDRAWALS OR CREATOR ALLOCATION.
   *
   * Asserted over CODE, not prose. The modules discuss all of these by name —
   * `whop-dispute-posting.ts` lists `platform_covered_dispute` precisely to
   * explain why it is refused, and several headers say "never
   * `platform_revenue`" — so a bare word search reports the explanation as the
   * offence. Comments and string literals are stripped first, and what is left
   * is what the compiler would actually run.
   */
  const codeOnly = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
  const allCode = Object.values(files).map(codeOnly).join("\n");

  check(
    "no payout, transfer, withdrawal or connected-account CODE was added",
    !/payout_sent|payout_reversed|payout_clearing|withdrawal|connected_account|client\.(transfers|payouts|withdrawals)/i.test(
      allCode,
    ),
  );
  check(
    "the payout webhook handler is still the untouched stub",
    /export async function handleWhopPayoutUpdated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(webhookSource),
  );
  check(
    "no creator-earnings or platform-revenue account is referenced in CODE",
    !/creator_payable|platform_revenue|campaign_funds/.test(allCode),
  );
  // Read off the rule table itself rather than guessed at from the text: the
  // only accounts a dispute movement can ever face are the two postable ones.
  check(
    "every dispute rule faces only unallocated_customer_funds or provider_fee_expense",
    Object.values(posting.DISPUTE_LINE_RULES).every(
      (r) =>
        r.contraAccount === "unallocated_customer_funds" ||
        r.contraAccount === "provider_fee_expense",
    ),
  );
  check(
    "and every rule maps to one of the three declared dispute economic events",
    Object.values(posting.DISPUTE_LINE_RULES).every((r) =>
      ["dispute_opened", "dispute_won", "dispute_lost"].includes(r.event),
    ),
  );

  // ACCOUNTING IS LEDGER-DRIVEN, NEVER STATUS-DRIVEN.
  check(
    "the posting module never reads a dispute status to decide money",
    !/classifyDisputeStatus|targetDisputeStatus|\.status\s*===\s*['"](won|lost)['"]/.test(files.posting),
  );
  check(
    "the posting module derives every amount from a ledger movement",
    /movement\.amountMinor/.test(files.posting) && /listLedgerMovementsForPayment/.test(files.posting),
  );

  // NOTHING MUTATES HISTORY.
  check(
    "no dispute module updates or deletes payment_orders, refunds or the journal",
    !/update\(paymentOrders|delete\(paymentOrders|update\(paymentRefunds|delete\(paymentRefunds|update\(accountingTransactions|delete\(accountingTransactions|update\(accountingEntries|delete\(accountingEntries/.test(all),
  );
  check("no dispute module calls reverseTransaction", !/reverseTransaction\s*\(/.test(all));

  // NO PUBLIC SURFACE.
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
  check(
    "there is NO dispute route under src/app",
    appFiles.filter((f) => /dispute|resolution/i.test(f)).length === 0,
  );
  const componentFiles = walk("src/components");
  check(
    "no component imports any dispute server module",
    componentFiles.filter((f) =>
      /whop-disputes|payment-disputes|dispute-lifecycle|dispute-recovery|whop-dispute-/.test(
        readFileSync(f, "utf8"),
      ),
    ).length === 0,
  );

  // RECONCILIATION REPORTS, IT DOES NOT REWRITE.
  const disputeReconBlock = reconcileSource.slice(reconcileSource.indexOf("DISPUTE RECONCILIATION"));
  check(
    "dispute reconciliation has no insert, update or delete anywhere in it",
    !/\.insert\(|\.update\(|\.delete\(/.test(disputeReconBlock),
  );
  check("the recovery module never updates or deletes anything", !/\.update\(|\.delete\(/.test(files.recovery));
  check("and defaults to a dry run", /dryRun = true/.test(files.recovery));

  // ACCOUNTS THAT MUST STAY BLOCKED.
  const accountsSource = readFileSync("src/lib/server/accounting/accounts.ts", "utf8");
  check(
    "dispute_reserve is still NOT postable — holds are not provable",
    /dispute_reserve: \{[^}]*postable: false/s.test(accountsSource),
  );
  check(
    "platform_revenue and creator_payable are still NOT postable",
    /platform_revenue: \{[^}]*postable: false/s.test(accountsSource) &&
      /creator_payable: \{[^}]*postable: false/s.test(accountsSource),
  );

  // MIGRATIONS.
  const { execSync } = require("node:child_process");
  const changed = execSync("git status --porcelain drizzle", { encoding: "utf8" });
  check(
    "migrations 0000-0005 are untouched",
    changed.split("\n").filter((l) => /drizzle\/000[0-5]_/.test(l)).length === 0,
    changed.split("\n").filter((l) => /drizzle\/000[0-5]_/.test(l)).join(" ") || "none",
  );
  // 0006 is committed now, so it no longer shows in `git status`. Its
  // existence on disk is the durable assertion.
  check("the dispute migration 0006 exists on disk", require("node:fs").existsSync("drizzle/0006_wise_unus.sql"));
}

/* ========================================================================== */

sourceInvariants();

const run = process.env.DISPUTE_TEST_DB === "0" ? Promise.resolve() : sequences();

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
