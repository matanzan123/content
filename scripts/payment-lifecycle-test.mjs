/**
 * PAYMENT LIFECYCLE TESTS.
 *
 * The question this suite answers is one the other suites do not: given a
 * SEQUENCE of deliveries in an arbitrary order, does the order end up where
 * the provider says it should?
 *
 * Whop guarantees at-least-once delivery and no ordering, so the interesting
 * cases are all sequences — `failed` after `succeeded`, `pending` after
 * `paid`, the same event three times, two instances at once. Those cannot be
 * tested by calling a pure function, so the mapping is driven against a FAKE
 * WHOP that returns whatever status a case needs, over a REAL Postgres in a
 * throwaway schema.
 *
 * NOTHING HERE TOUCHES `public`. Orders are created in `lifecycle_selftest`,
 * dropped before and after, so a test that marks an order failed cannot reach
 * the real settled sandbox order. The tail of the suite then reads the real
 * tables read-only to confirm that.
 *
 * Set LIFECYCLE_TEST_DB=0 to run only the pure parts.
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

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

/* ==========================================================================
   Loader. `@/lib/db` and the Whop client are the two seams; everything else
   is the real module.
   ========================================================================== */

const cache = new Map();
let DB = null; // set once the throwaway schema exists
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

const lifecycle = loadTs("src/lib/server/payment-lifecycle.ts");
const webhooks = loadTs("src/lib/server/whop-webhooks.ts");

/* ==========================================================================
   PART A — the contract and the state machine, pure
   ========================================================================== */

console.log("\n--- A. the provider status contract ---");

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

// The eight values, taken from the installed SDK enum rather than retyped.
const sdkStatuses = sdkEnumValues("ReceiptStatus");
check("our status list is exactly the SDK's ReceiptStatus",
  [...lifecycle.WHOP_PAYMENT_STATUSES].sort().join(",") === sdkStatuses.sort().join(","),
  lifecycle.WHOP_PAYMENT_STATUSES.join("|"));
check("there are eight statuses", lifecycle.WHOP_PAYMENT_STATUSES.length === 8);

const phase = lifecycle.classifyProviderStatus;
check("only `paid` is settled", phase("paid") === "settled");
check("`succeeded` is NOT a payment status — it is the event name",
  lifecycle.WHOP_PAYMENT_STATUSES.includes("succeeded") === false && phase("succeeded") === "unknown");
for (const s of ["draft", "open", "authorized", "pending", "unresolved"]) {
  check(`\`${s}\` is in flight`, phase(s) === "in_flight");
}
for (const s of ["void", "uncollectible"]) {
  check(`\`${s}\` is terminal and unpaid`, phase(s) === "terminal_unpaid");
}
check("an unrecognised status is `unknown`, not a guess", phase("teleported") === "unknown");
check("a non-string status is `unknown`", phase(null) === "unknown" && phase(undefined) === "unknown");
check("casing and padding are tolerated", phase("  PAID ") === "settled");

console.log("\n--- A. status → order state ---");

check("settled → paid", lifecycle.targetOrderStatus("settled") === "paid");
check("in flight → payment_pending", lifecycle.targetOrderStatus("in_flight") === "payment_pending");
check("terminal unpaid → failed", lifecycle.targetOrderStatus("terminal_unpaid") === "failed");
check("UNKNOWN → payment_pending, never failed and never paid",
  lifecycle.targetOrderStatus("unknown") === "payment_pending");

console.log("\n--- A. transition rules ---");

for (const rule of lifecycle.TRANSITION_RULES) {
  check(`${rule.from} → ${rule.to} ${rule.allowed ? "allowed" : "FORBIDDEN"} (${rule.why})`,
    lifecycle.isTransitionAllowed(rule.from, rule.to) === rule.allowed);
}
check("paid and cancelled are the only absorbing states",
  [...lifecycle.ABSORBING_ORDER_STATUSES].sort().join(",") === "cancelled,paid");
check("re-confirming the same state is not a transition",
  lifecycle.isTransitionAllowed("paid", "paid") === true);

console.log("\n--- A. lookup failure classification ---");

check("a provider error is always retryable",
  lifecycle.shouldRetryLookup("provider_error", 99) === true);
check("missing credentials are retryable — the config may be fixed",
  lifecycle.shouldRetryLookup("unconfigured", 99) === true);
check("a malformed id is NEVER retried", lifecycle.shouldRetryLookup("invalid_resource_id", 0) === false);
check("a 404 is retried at first — provider reads are not read-your-writes",
  lifecycle.shouldRetryLookup("resource_not_found", 1) === true);
check("...but not forever",
  lifecycle.shouldRetryLookup("resource_not_found", lifecycle.MAX_DEFINITIVE_LOOKUP_ATTEMPTS) === false);

console.log("\n--- A. the webhook allowlist ---");

const sdkEvents = sdkEnumValues("WebhookEvent");
const supported = [...webhooks.SUPPORTED_EVENTS];
const paymentEvents = supported.filter((e) => e.startsWith("payment."));
check("all six documented payment lifecycle events are supported",
  paymentEvents.sort().join(",") ===
    "payment.authorized,payment.canceled,payment.created,payment.failed,payment.pending,payment.succeeded",
  paymentEvents.join("|"));
check("every supported event exists in the SDK's WebhookEvent enum",
  supported.every((e) => sdkEvents.includes(e)),
  supported.filter((e) => !sdkEvents.includes(e)).join(",") || "all present");
check("`payment.completed` is NOT accepted — it is not a webhook event",
  webhooks.isSupportedEvent("payment.completed") === false);
check("`app_payment.succeeded` is NOT accepted — different subject",
  webhooks.isSupportedEvent("app_payment.succeeded") === false);
check("`payment.affiliate_reward_created` is NOT accepted — no resolver",
  webhooks.isSupportedEvent("payment.affiliate_reward_created") === false);
check("an invented event is not accepted", webhooks.isSupportedEvent("payment.definitely_paid") === false);

const source = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
check("every payment event is ownership-gated", (() => {
  const start = source.indexOf("const OWNERSHIP_GATED");
  const gate = source.slice(start, source.indexOf("]);", start));
  return start > 0 && paymentEvents.every((e) => gate.includes(`"${e}"`));
})());
check("refunds are still recognised but NOT implemented",
  webhooks.isSupportedEvent("refund.created") === true &&
  source.includes("export async function handleWhopRefundCreated") &&
  /handleWhopRefundCreated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(source));
check("disputes are still recognised but NOT implemented",
  /handleWhopDisputeCreated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(source));
check("payouts are still recognised but NOT implemented",
  /handleWhopPayoutUpdated\(\): Promise<HandlerResult> \{\s*return \{ kind: "business_mapping_not_implemented" \};/.test(source));
check("no transfer or withdrawal event was enabled",
  supported.some((e) => /transfer|withdrawal/.test(e)) === false);

console.log("\n--- A. the event name never decides the state ---");

const mappingSource = readFileSync("src/lib/server/whop-payment-mapping.ts", "utf8");
const decision = mappingSource.slice(mappingSource.indexOf("const phase = classifyProviderStatus"));
check("the order state is derived from the fetched status",
  decision.includes("const target = targetOrderStatus(phase)"));
check("`intent` does not appear in the state decision", (() => {
  const upToUpdate = decision.slice(0, decision.indexOf("recordOrderAttempt"));
  return /intent/.test(upToUpdate) === false;
})());
check("five of the six events share one resolver",
  source.includes('"payment.created": handleWhopPaymentPending') &&
  source.includes('"payment.authorized": handleWhopPaymentPending') &&
  source.includes('"payment.canceled": handleWhopPaymentFailed'));

/* ==========================================================================
   PART B — sequences, against real Postgres and a fake Whop
   ========================================================================== */

const SCRATCH = "lifecycle_selftest";
const COMPANY = process.env.WHOP_COMPANY_ID;

/** A Whop client stub that answers with exactly the payment a case needs. */
function fakeWhop(payment, options = {}) {
  return {
    payments: {
      retrieve: async () => {
        if (options.throws) throw options.throws;
        return payment;
      },
      listFees: async () => ({ data: options.fees ?? [] }),
    },
  };
}

function paymentFixture({ id, status, orderId, minor = 1000, currency = "usd", account = COMPANY }) {
  const money = (n) => ({
    amount: (n / 100).toFixed(2),
    currency,
    decimals: 2,
    display_decimals: 2,
  });
  return {
    id,
    account_id: account,
    status,
    currency,
    metadata: orderId ? { order_id: orderId } : {},
    subtotal: money(minor),
    total: money(minor),
    tax_amount: money(0),
    amount_after_fees: money(minor),
    paid_at: status === "paid" ? "2026-09-05T10:00:00.000Z" : null,
  };
}

async function sequences() {
  console.log("\n--- B. lifecycle sequences (throwaway schema, fake provider) ---");

  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — part B skipped");
    return;
  }

  const postgres = require("postgres");
  const { drizzle } = require("drizzle-orm/postgres-js");

  /*
   * THE DIRECT ENDPOINT, not the pooled one, and only for this suite.
   *
   * Everything here depends on `search_path` pointing at the throwaway
   * schema, and `search_path` is SESSION state. Neon's pooled endpoint is
   * PgBouncer in transaction mode: a SET can be issued on one backend and the
   * next statement served by another, so the setting silently lapses back to
   * `public` — mid-run, with no error. That is not a theoretical failure; it
   * is how an earlier version of this file wrote its fixtures into the real
   * payment_orders and the real ledger.
   *
   * The application keeps using the pooled endpoint, which is correct for it:
   * it never relies on session state, which is why `prepare: false` is set
   * there. Tests that DO rely on session state need a real session.
   */
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const before = await client`select count(*)::int as n from accounting_transactions`;
  const beforeOrders = await client`select order_id, status, paid_at from payment_orders order by created_at`;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);

    // Real DDL for the two tables the mapping touches, taken from the applied
    // migrations so column types and constraints cannot drift from production.
    const ddl = [
      readFileSync("drizzle/0002_misty_obadiah_stane.sql", "utf8"),
      readFileSync("drizzle/0004_thin_ben_urich.sql", "utf8"),
    ].join("\n--> statement-breakpoint\n");

    // The migration text creates its TABLES unqualified, so the schema they
    // land in is decided by search_path. Without this they would be attempted
    // in `public` — which is how this test first tried to create a second
    // `payment_orders` over the real one, and was refused by Postgres.
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

    /*
     * THE ISOLATION SEAM, and the one that has to be proved rather than
     * assumed.
     *
     * The real modules name their tables unqualified, so which schema they hit
     * is decided entirely by `search_path`. Setting it through postgres.js's
     * `connection` option looks right and is SILENTLY IGNORED by Neon's
     * pooler — the session comes back on `public`, and this suite happily
     * writes its fixtures over the real payment_orders and the real ledger.
     * That is not hypothetical: it is exactly what this file did before this
     * guard existed.
     *
     * So: max 1, so there is a single backend whose SET actually persists;
     * an explicit SET rather than a startup parameter, which Neon's pooler
     * rejects outright; and then a VERIFICATION that resolves the very table
     * name the modules will use and refuses to continue unless it landed in
     * the throwaway schema.
     */
    const scoped = postgres(direct.toString(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    // Resolve the bare name the modules use and ask which schema it landed
    // in. `to_regclass` renders unqualified when the table is first on the
    // path, so the namespace is looked up rather than string-matched.
    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('payment_orders')) as orders_schema,
             (select n.nspname from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('accounting_entries')) as entries_schema`;
    const isolated =
      where.schema === SCRATCH &&
      where.orders_schema === SCRATCH &&
      where.entries_schema === SCRATCH;
    if (!isolated) {
      throw new Error(
        `ISOLATION FAILED — refusing to run: schema=${where.schema} orders=${where.orders_schema} entries=${where.entries_schema}`,
      );
    }
    check("ISOLATION: the modules resolve to the throwaway schema, not public",
      isolated, `${where.orders_schema}/${where.entries_schema}`);

    const schema = loadTs("src/lib/db/schema.ts");
    DB = drizzle(scoped, { schema });

    const mapping = loadTs("src/lib/server/whop-payment-mapping.ts");
    const orders = loadTs("src/lib/server/payment-orders.ts");
    const journalMod = loadTs("src/lib/server/accounting/journal.ts");

    let seq = 0;
    const newOrder = async () => {
      const created = await orders.createPaymentOrder({
        amountMinor: BigInt(1000),
        currency: "usd",
        purpose: `lifecycle_${++seq}`,
      });
      if (!created.ok) throw new Error("order create failed: " + created.reason);
      return created.order.orderId;
    };
    const statusOf = async (id) => (await orders.getPaymentOrder(id)).status;

    /** Delivers one event: sets the fake provider status, then maps. */
    const deliver = async (orderId, paymentId, providerStatus, intent, extra = {}) => {
      FAKE_WHOP = fakeWhop(
        paymentFixture({ id: paymentId, status: providerStatus, orderId, ...extra }),
        extra,
      );
      return await mapping.mapPaymentToOrder(paymentId, intent);
    };

    /* ---------------- single events ---------------- */

    {
      const o = await newOrder();
      await deliver(o, "pay_c1", "open", "pending"); // payment.created
      check("payment.created (provider `open`) → payment_pending", (await statusOf(o)) === "payment_pending");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_p1", "pending", "pending");
      check("payment.pending (provider `pending`) → payment_pending", (await statusOf(o)) === "payment_pending");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_a1", "authorized", "pending"); // payment.authorized
      check("payment.authorized (funds held, not captured) → payment_pending",
        (await statusOf(o)) === "payment_pending");
    }
    {
      const o = await newOrder();
      const r = await deliver(o, "pay_f1", "void", "failed");
      check("payment.failed (provider `void`) → failed",
        (await statusOf(o)) === "failed" && r.kind === "failed_recorded");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_x1", "uncollectible", "failed");
      check("provider `uncollectible` → failed", (await statusOf(o)) === "failed");
    }
    {
      const o = await newOrder();
      const r = await deliver(o, "pay_s1", "paid", "succeeded");
      check("payment.succeeded (provider `paid`) → paid",
        (await statusOf(o)) === "paid" && r.kind === "paid" && r.alreadyPaid === false);
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_u1", "unresolved", "failed");
      check("a disputed/`unresolved` payment is NOT called failed",
        (await statusOf(o)) === "payment_pending");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_n1", "some_new_status", "failed");
      check("an unknown provider status never fails an order",
        (await statusOf(o)) === "payment_pending");
    }

    /* ---------------- sequences ---------------- */

    {
      const o = await newOrder();
      await deliver(o, "pay_q1", "pending", "pending");
      await deliver(o, "pay_q1", "paid", "succeeded");
      check("pending → succeeded ends paid", (await statusOf(o)) === "paid");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_q2", "void", "failed");
      check("  (failed first)", (await statusOf(o)) === "failed");
      await deliver(o, "pay_q2", "paid", "succeeded");
      check("failed → succeeded ends paid — a later attempt collected",
        (await statusOf(o)) === "paid");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_q3", "paid", "succeeded");
      // The stale failure: provider has since moved on, but an old delivery
      // arrives claiming failure. The provider is re-read and still says paid.
      const r = await deliver(o, "pay_q3", "paid", "failed");
      check("succeeded → failed does NOT downgrade — provider still says paid",
        (await statusOf(o)) === "paid" && r.kind === "paid");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_q4", "paid", "succeeded");
      // The harder case: the stale delivery arrives AND the provider read
      // returns an in-flight status for a retry attempt.
      const r = await deliver(o, "pay_q4", "pending", "pending");
      check("succeeded → pending does NOT downgrade",
        (await statusOf(o)) === "paid" && r.kind === "ignored");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_q5", "void", "failed");
      check("created → failed", (await statusOf(o)) === "failed");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_q6", "void", "failed");
      await deliver(o, "pay_q6", "pending", "pending");
      check("failed → pending is allowed — the provider retried",
        (await statusOf(o)) === "payment_pending");
      await deliver(o, "pay_q6", "paid", "succeeded");
      check("failed → pending → succeeded ends paid", (await statusOf(o)) === "paid");
    }
    {
      const o = await newOrder();
      // Arrival order reversed: the failure lands first, the success second,
      // and then the failure is redelivered.
      await deliver(o, "pay_q7", "paid", "failed");
      check("a `failed` delivery for an already-collected payment SETTLES it",
        (await statusOf(o)) === "paid");
      await deliver(o, "pay_q7", "paid", "failed");
      check("and repeating it changes nothing", (await statusOf(o)) === "paid");
    }

    /* ---------------- duplicates and concurrency ---------------- */

    {
      const o = await newOrder();
      const a = await deliver(o, "pay_d1", "void", "failed");
      const b = await deliver(o, "pay_d1", "void", "failed");
      check("a duplicate failed event is idempotent",
        (await statusOf(o)) === "failed" && a.kind === "failed_recorded" && b.kind === "failed_recorded");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_d2", "pending", "pending");
      await deliver(o, "pay_d2", "pending", "pending");
      await deliver(o, "pay_d2", "pending", "pending");
      check("a duplicate pending event is idempotent", (await statusOf(o)) === "payment_pending");
    }
    {
      const o = await newOrder();
      const r1 = await deliver(o, "pay_d3", "paid", "succeeded");
      const r2 = await deliver(o, "pay_d3", "paid", "succeeded");
      check("re-settling with the SAME payment reports alreadyPaid, not an error",
        r1.kind === "paid" && r2.kind === "paid" &&
        r1.alreadyPaid === false && r2.alreadyPaid === true,
        `${r1.alreadyPaid}/${r2.alreadyPaid}`);
      const [times] = await client.unsafe(
        `select paid_at = updated_at as untouched from ${SCRATCH}.payment_orders
          where whop_payment_id = 'pay_d3'`,
      );
      check("  and a settled order is not re-written at all", times.untouched === true);
    }
    {
      // Different webhook ids, same payment: the mapping does not see webhook
      // ids at all, so what matters is that N concurrent resolutions converge.
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_d4", status: "paid", orderId: o }));
      // Five overlapping resolutions. The isolation guard above pins this to a
      // single backend, so these interleave rather than run on five servers —
      // genuinely parallel writes are proved separately, in raw SQL, by
      // scripts/accounting-test.mjs. What this shows is that repeated
      // concurrent resolution of one payment converges instead of conflicting.
      const raced = await Promise.allSettled(
        [1, 2, 3, 4, 5].map(() => mapping.mapPaymentToOrder("pay_d4", "succeeded")),
      );
      const paid = raced.filter((r) => r.status === "fulfilled" && r.value.kind === "paid").length;
      check("five overlapping deliveries of one payment all converge on paid",
        paid === 5 && (await statusOf(o)) === "paid",
        raced.map((r) => (r.status === "fulfilled" ? r.value.kind : "throw")).join("/"));
      const [row] = await client.unsafe(
        `select count(*)::int as n from ${SCRATCH}.payment_orders where whop_payment_id = 'pay_d4'`,
      );
      check("and exactly one order carries that payment id", row.n === 1);
    }
    {
      // One payment must never settle two orders.
      const o1 = await newOrder();
      const o2 = await newOrder();
      await deliver(o1, "pay_d5", "paid", "succeeded");
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_d5", status: "paid", orderId: o2 }));
      const r = await mapping.mapPaymentToOrder("pay_d5", "succeeded");
      check("one payment cannot settle a SECOND order",
        r.kind === "rejected" && r.reason === "payment_already_used",
        JSON.stringify(r));
      check("and the second order stays unpaid", (await statusOf(o2)) !== "paid");
    }

    /* ---------------- provider outage ---------------- */

    {
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("gateway timeout", 504) });
      const r = await mapping.mapPaymentToOrder("pay_o1", "succeeded");
      check("a 504 is a provider_error, never a status guess",
        r.kind === "rejected" && r.reason === "provider_error");
      check("and the order is untouched", (await statusOf(o)) === "created");
    }
    {
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("rate limited", 429) });
      const r = await mapping.mapPaymentToOrder("pay_o2", "failed");
      check("a 429 does not fail an order either",
        r.kind === "rejected" && r.reason === "provider_error");
    }
    {
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("boom", 500) });
      const r = await mapping.mapPaymentToOrder("pay_o3", "pending");
      check("a 5xx is a provider_error", r.kind === "rejected" && r.reason === "provider_error");
    }
    {
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("nope", 404) });
      const r = await mapping.mapPaymentToOrder("pay_o4", "succeeded");
      check("a 404 is resource_not_found — a different fact from an outage",
        r.kind === "rejected" && r.reason === "resource_not_found");
    }
    {
      // Recovery: the same payment, once the provider answers again.
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("down", 503) });
      const down = await mapping.mapPaymentToOrder("pay_o5", "succeeded");
      const before = await statusOf(o);
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_o5", status: "paid", orderId: o }));
      const up = await mapping.mapPaymentToOrder("pay_o5", "succeeded");
      check("a retry after the provider recovers settles correctly",
        down.kind === "rejected" && before === "created" && up.kind === "paid" &&
        (await statusOf(o)) === "paid");
    }

    /* ---------------- the eight checks still hold ---------------- */

    {
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_w1", status: "paid", orderId: o, account: "biz_someoneelse" }));
      const r = await mapping.mapPaymentToOrder("pay_w1", "succeeded");
      check("wrong company is rejected", r.kind === "rejected" && r.reason === "wrong_company");
      check("  and the order is untouched", (await statusOf(o)) === "created");
    }
    {
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_w2", status: "paid", orderId: null }));
      const r = await mapping.mapPaymentToOrder("pay_w2", "succeeded");
      check("a payment with no order metadata is rejected",
        r.kind === "rejected" && r.reason === "no_order_reference");
    }
    {
      FAKE_WHOP = fakeWhop(paymentFixture({
        id: "pay_w3", status: "paid", orderId: "00000000-0000-4000-8000-000000000000",
      }));
      const r = await mapping.mapPaymentToOrder("pay_w3", "succeeded");
      check("metadata naming an order that does not exist is rejected",
        r.kind === "rejected" && r.reason === "order_not_found");
    }
    {
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_w4", status: "paid", orderId: o, minor: 999 }));
      const r = await mapping.mapPaymentToOrder("pay_w4", "succeeded");
      check("a one-cent amount mismatch is rejected",
        r.kind === "rejected" && r.reason === "amount_mismatch");
      check("  and the order is untouched", (await statusOf(o)) === "created");
    }
    {
      const o = await newOrder();
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_w5", status: "paid", orderId: o, currency: "eur" }));
      const r = await mapping.mapPaymentToOrder("pay_w5", "succeeded");
      check("a currency mismatch is rejected",
        r.kind === "rejected" && r.reason === "currency_mismatch");
    }
    {
      const r = await mapping.mapPaymentToOrder("not_a_payment_id", "succeeded");
      check("a malformed payment id never reaches the network",
        r.kind === "rejected" && r.reason === "invalid_payment_id");
    }

    /* ---------------- accounting stays exactly-once ---------------- */

    {
      const o = await newOrder();
      const fees = [{
        type: "processing_fee", origin: "payment_processing_fixed_fee", label: "fee",
        amount: { amount: "0.30", currency: "usd", decimals: 2, display_decimals: 2 },
        settlement_amount: { amount: "0.30", currency: "usd", decimals: 2, display_decimals: 2 },
        collected_at: "2026-09-05T10:00:00.000Z",
      }];
      const payment = paymentFixture({ id: "pay_acc1", status: "paid", orderId: o });
      payment.amount_after_fees = { amount: "9.70", currency: "usd", decimals: 2, display_decimals: 2 };
      FAKE_WHOP = fakeWhop(payment, { fees });

      const posting = loadTs("src/lib/server/accounting/whop-payment-posting.ts");
      const first = await posting.postWhopSettlement("pay_acc1", { environment: "sandbox", orderId: o });
      const second = await posting.postWhopSettlement("pay_acc1", { environment: "sandbox", orderId: o });
      const third = await Promise.allSettled([
        posting.postWhopSettlement("pay_acc1", { environment: "sandbox", orderId: o }),
        posting.postWhopSettlement("pay_acc1", { environment: "sandbox", orderId: o }),
      ]);
      check("the first posting writes a transaction", first.ok === true && first.alreadyPosted === false);
      check("the second converges on the same one",
        second.ok === true && second.alreadyPosted === true && second.transactionId === first.transactionId);
      check("concurrent postings do not duplicate money",
        third.every((r) => r.status === "fulfilled" && r.value.ok && r.value.transactionId === first.transactionId));
      const [txns] = await client.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions where provider_resource_id = 'pay_acc1'`,
      );
      check("exactly ONE payment_settled transaction exists for that payment", txns.n === 1, `${txns.n}`);
      const unbalanced = await journalMod.findUnbalancedTransactions();
      check("and the journal balances", unbalanced.length === 0);
    }

    /* ---------------- crash after settlement, before ledger ---------------- */

    {
      const o = await newOrder();
      const payment = paymentFixture({ id: "pay_crash", status: "paid", orderId: o });
      FAKE_WHOP = fakeWhop(payment, { fees: [] });

      // The crash: the order settles, then the process dies before posting.
      const settled = await mapping.mapPaymentToOrder("pay_crash", "succeeded");
      check("CRASH: the order is settled", settled.kind === "paid" && (await statusOf(o)) === "paid");
      const [none] = await client.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions where provider_resource_id = 'pay_crash'`,
      );
      check("CRASH: no accounting transaction was written", none.n === 0);

      const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
      const report = await reconcile.reconcileInternal();
      const missing = report.discrepancies.filter(
        (d) => d.code === "missing_ledger" && d.paymentId === "pay_crash",
      );
      check("RECOVERY: reconciliation detects the missing accounting", missing.length === 1);

      // The repair: the same authoritative path, run again.
      const backfill = loadTs("src/lib/server/accounting/backfill.ts");
      const repaired = await backfill.backfillOrder(o);
      check("RECOVERY: the backfill posts the missing transaction",
        repaired.result.kind === "posted", JSON.stringify(repaired.result));
      const again = await backfill.backfillOrder(o);
      check("RECOVERY: running it twice does not duplicate money",
        again.result.kind === "already_posted" &&
        again.result.transactionId === repaired.result.transactionId);
      const [one] = await client.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions where provider_resource_id = 'pay_crash'`,
      );
      check("RECOVERY: exactly one transaction afterwards", one.n === 1);
      const after = await reconcile.reconcileInternal();
      check("RECOVERY: reconciliation is clean again",
        after.discrepancies.filter((d) => d.paymentId === "pay_crash").length === 0);
    }

    /* ---------------- reconciliation detects conflicts ---------------- */

    {
      const o = await newOrder();
      await deliver(o, "pay_rec1", "paid", "succeeded");
      const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
      // Provider has since voided it: the serious conflict.
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_rec1", status: "void", orderId: o }));
      const found = await reconcile.reconcileOrderLifecycle(o);
      check("a paid order whose provider says `void` is reported as a conflict",
        found.length === 1 && found[0].code === "provider_status_conflict", JSON.stringify(found));
      check("  and nothing was rewritten", (await statusOf(o)) === "paid");
    }
    {
      const o = await newOrder();
      await deliver(o, "pay_rec2", "void", "failed");
      const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
      const backfill = loadTs("src/lib/server/accounting/backfill.ts");

      // A failed order holds NO provider payment id — that column is only
      // written on settlement — so the order-first check has nothing to ask
      // about and correctly says so rather than inventing a link.
      const order = await orders.getPaymentOrder(o);
      check("a failed order carries no provider payment id", order.whopPaymentId === null);
      check("so the order-first lifecycle check reports nothing for it",
        (await reconcile.reconcileOrderLifecycle(o)).length === 0);

      // The payment-first route is the one that works here. In production the
      // id comes from whop_webhook_receipts.resource_id.
      FAKE_WHOP = fakeWhop(paymentFixture({ id: "pay_rec2", status: "paid", orderId: o }));
      const found = await reconcile.reconcilePaymentAgainstProvider("pay_rec2");
      check("the payment-first check reports the settled payment with no paid order",
        found.some((d) => d.code === "provider_mismatch" || d.code === "missing_ledger"),
        JSON.stringify(found.map((d) => d.code)));

      const converged = await backfill.convergeFromPayment("pay_rec2");
      check("convergence from the payment settles it through the verified path",
        converged.result.kind === "posted" && (await statusOf(o)) === "paid",
        JSON.stringify(converged.result));
      const again = await backfill.convergeFromPayment("pay_rec2");
      check("  and repeating it posts nothing new",
        again.result.kind === "already_posted" &&
        again.result.transactionId === converged.result.transactionId);
      const clean = await reconcile.reconcileOrderLifecycle(o);
      check("  and the order-first check is clean now that a payment is attached",
        clean.length === 0);
    }
    {
      const o = await newOrder();
      const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
      FAKE_WHOP = fakeWhop(null, { throws: new FakeWhopError("down", 503) });
      await client.unsafe(
        `update ${SCRATCH}.payment_orders set whop_payment_id = 'pay_rec3' where order_id = '${o}'`,
      );
      const found = await reconcile.reconcileOrderLifecycle(o);
      check("an outage is reported as provider_unavailable, NOT as a conflict",
        found.length === 1 && found[0].code === "provider_unavailable", JSON.stringify(found));
    }
    {
      const o = await newOrder();
      const reconcile = loadTs("src/lib/server/accounting/reconcile.ts");
      await client.unsafe(
        `update ${SCRATCH}.payment_orders set status = 'payment_pending',
         updated_at = now() - make_interval(hours => ${reconcile.STALE_PENDING_HOURS + 1})
         where order_id = '${o}'`,
      );
      const report = await reconcile.reconcileInternal();
      check("an order stuck mid-flight is reported as stale_pending",
        report.discrepancies.some((d) => d.code === "stale_pending" && d.orderId === o));
    }
    {
      const backfill = loadTs("src/lib/server/accounting/backfill.ts");
      const o = await newOrder();
      await client.unsafe(
        `update ${SCRATCH}.payment_orders set status = 'cancelled', whop_payment_id = 'pay_canc'
         where order_id = '${o}'`,
      );
      const r = await backfill.convergeOrderFromProvider(o);
      check("convergence refuses to revive a cancelled order",
        r.result.kind === "skipped" && r.result.reason === "absorbing:cancelled",
        JSON.stringify(r.result));
    }

    await scoped.end({ timeout: 5 });
  } finally {
    DB = null;
    FAKE_WHOP = null;
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    // RESET, not SET. This suite runs on the direct endpoint precisely so its
    // session state cannot escape, but leaving a session pointed at a schema
    // that no longer exists is how the next thing to reuse it fails with a
    // baffling "relation does not exist".
    await client.unsafe("reset search_path");

    /* ---------------- the real database is untouched ---------------- */

    const after = await client`select count(*)::int as n from accounting_transactions`;
    check("REAL DB: accounting_transactions is unchanged", after[0].n === before[0].n, `${after[0].n}`);
    const [entries] = await client`
      select coalesce(sum(amount_minor),0)::text as s, count(*)::int as n from accounting_entries`;
    check("REAL DB: the real journal still balances with 7 legs",
      entries.n === 7 && entries.s === "0", `${entries.n} legs, residual ${entries.s}`);
    const [ledger] = await client`select count(*)::int as n from financial_ledger`;
    check("REAL DB: financial_ledger is still 0", ledger.n === 0);
    const afterOrders = await client`select order_id, status, paid_at from payment_orders order by created_at`;
    check("REAL DB: payment_orders is unchanged",
      JSON.stringify(afterOrders) === JSON.stringify(beforeOrders),
      afterOrders.map((o) => o.status).join(","));
    const [migrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("REAL DB: still 5 migrations — no schema change was applied", migrations.n === 5);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("REAL DB: the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });

    /*
     * THE POOLED ENDPOINT MUST BE UNTOUCHED.
     *
     * A regression guard for a specific bug this suite caused once: a
     * `SET search_path` issued on the POOLED endpoint does not stay inside
     * the client that issued it. PgBouncer hands the same server connection to
     * whoever comes next, so the setting leaked into every subsequent pooled
     * session — including the application's — and `payment_orders` stopped
     * resolving for everyone until the backends were reset by hand.
     *
     * Hence the direct endpoint above, and hence this: several fresh pooled
     * sessions must all still see the default path and resolve the real table.
     */
    const pooled = postgres(process.env.DATABASE_URL, { max: 4, prepare: false, onnotice: () => {} });
    try {
      const seen = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(async () => {
          const [r] = await pooled`select current_schema() as s, to_regclass('payment_orders')::text as t`;
          return `${r.s}:${r.t}`;
        }),
      );
      check("REAL DB: the POOLED endpoint still resolves payment_orders in public",
        seen.every((v) => v === "public:payment_orders"),
        [...new Set(seen)].join(" | "));
    } finally {
      await pooled.end({ timeout: 5 });
    }
  }
}

const run = process.env.LIFECYCLE_TEST_DB === "0" ? Promise.resolve() : sequences();

run
  .catch((e) => check("part B completed", false, String(e?.stack ?? e).slice(0, 400)))
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      for (const f of failed) console.log(`  - ${f.name}`);
      process.exit(1);
    }
  });
