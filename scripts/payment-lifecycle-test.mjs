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
// The gate is a MAP now rather than a Set — refunds join it with their own
// verifier, because an `rf_` id cannot be proved by the payment verifier — so
// the block is sliced to its closing brace instead of a closing bracket.
const gateBlock = (() => {
  const start = source.indexOf("const OWNERSHIP_GATED");
  return start > 0 ? source.slice(start, source.indexOf("\n};", start)) : "";
})();
check("every payment event is ownership-gated",
  gateBlock.length > 0 &&
  paymentEvents.every((e) => gateBlock.includes(`"${e}": verifyPaymentOwnership`)));
// REFUNDS ARE NOW IMPLEMENTED. This assertion previously recorded that they
// were not; it is replaced rather than deleted, because "refunds are wired to
// a real resolver and a real ownership verifier" is the property that now has
// to stay true.
check("refunds are recognised AND implemented, with their own ownership verifier",
  webhooks.isSupportedEvent("refund.created") === true &&
  webhooks.isSupportedEvent("refund.updated") === true &&
  gateBlock.includes('"refund.created": verifyRefundOwnership') &&
  gateBlock.includes('"refund.updated": verifyRefundOwnership') &&
  /export async function handleWhopRefund\(/.test(source) &&
  !/handleWhopRefundCreated/.test(source));
// DISPUTES ARE NOW IMPLEMENTED (task 4). This previously recorded that they
// were not; it is replaced rather than deleted, because "the dispute family is
// wired to real resolvers and its own ownership verifiers" is the property that
// now has to stay true.
check("the six dispute-family events are recognised AND implemented",
  ["dispute.created", "dispute.updated", "dispute_alert.created",
   "resolution_center_case.created", "resolution_center_case.updated",
   "resolution_center_case.decided"].every((e) => webhooks.isSupportedEvent(e)) &&
  /export async function handleWhopDispute\(/.test(source) &&
  /export async function handleWhopDisputeAlert\(/.test(source) &&
  /export async function handleWhopResolutionCase\(/.test(source) &&
  !/handleWhopDisputeCreated/.test(source));
check("and each is ownership-gated by a verifier for its own resource kind",
  gateBlock.includes('"dispute.created": verifyDisputeOwnership') &&
  gateBlock.includes('"dispute_alert.created": verifyAlertOwnership') &&
  gateBlock.includes('"resolution_center_case.decided": verifyCaseOwnership'));
// PAYOUTS ARE NOW IMPLEMENTED. This previously recorded that the handler was
// an untouched stub returning `business_mapping_not_implemented` outright; it
// is replaced rather than deleted, because "payout events are routed to a real
// handler that delegates to the transfer service and still cannot invent
// money" is the property that now has to stay true.
const payoutHandler = source.slice(
  source.indexOf("export async function handleWhopPayoutUpdated"),
  source.indexOf("export async function handleWhopAccountUpdated"),
);
const payoutEvents = ["payout.created", "payout.updated", "payout.reversed"];
check("the three payout events are recognised AND routed to the implemented handler",
  payoutHandler.length > 0 &&
  payoutEvents.every((e) => webhooks.isSupportedEvent(e)) &&
  payoutEvents.every((e) => source.includes(`"${e}": (id, wid, body) => handleWhopPayoutUpdated(id, wid, body)`)));
// THE HANDLER NO LONGER READS THE PAYLOAD'S STATUS, DELIBERATELY.
//
// This previously asserted that the outcome came from `payoutStatus` in the
// event body rather than from the event name. Both were wrong sources: the
// statuses it matched (`paid`, `completed`, `reversed`) are not Whop TRANSFER
// statuses at all — that resource has exactly `processing`, `succeeded`,
// `failed` — so the handler was writing money state from values the resource
// never emits, and `failed` posted a reversal for money that had never moved.
//
// Replaced rather than deleted: the property that must hold is now stronger —
// the payload decides NOTHING, and the provider is asked instead.
check("the payout handler reads no status out of the payload",
  !/payoutStatus/.test(payoutHandler) &&
  !/"paid"/.test(payoutHandler) &&
  !/isReversed|isCompleted/.test(payoutHandler));
check("a payout id is required before anything is mapped",
  /if \(!payoutId\) return \{ kind: "business_mapping_not_implemented" \};/.test(payoutHandler));
check("the handler delegates to a provider-authoritative refresh, not to raw SQL",
  /await refreshTransferFromProvider\(payoutId\)/.test(payoutHandler) &&
  /\bdb\.|insert\(|\.update\(|\.delete\(/.test(payoutHandler) === false);
check("an unrecognised payout id is acknowledged, never forced into a mapping",
  /if \(!refreshed\.ok\)/.test(payoutHandler) &&
  /return \{ kind: "business_mapping_not_implemented" \};/.test(payoutHandler));
check("the payout handler never writes the ledger itself",
  /financialLedger|postTransaction|accountingTransactions/.test(payoutHandler) === false);

/*
 * GAP A IS CLOSED, and this check is its inversion.
 *
 * It used to read: "payout events are not ownership-gated, though their path
 * can post". That was true and dangerous — `payout.*` is not in
 * OWNERSHIP_GATED, yet the handler reached a money-moving posting one
 * delegation away, with only the webhook signature standing behind it.
 *
 * The gap is now closed without adding a gate entry, because the handler no
 * longer trusts the event at all. It resolves the transfer locally, scoped to
 * our environment, and then asks `transfers.retrieve` — and retrieving the
 * resource with our own platform key IS the ownership proof the gate wanted.
 * An id we do not hold never reaches the provider; an id belonging to someone
 * else is not readable with our key.
 *
 * Asserted as the property, not the absence: if a future change lets the
 * handler write money state from the payload again, this fails.
 */
check("GAP A CLOSED: the payout path proves ownership by retrieving the resource",
  /await refreshTransferFromProvider\(payoutId\)/.test(payoutHandler) &&
  !/markTransfer(Completed|Reversed)/.test(source) &&
  /retrieveTransfer\(/.test(readFileSync("src/lib/server/creator-transfers.ts", "utf8")));

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
   A. TRANSFER STATE CHANGES ARE ENVIRONMENT-SCOPED

   `provider_transfer_id` is WHOP's identifier. Sandbox and production are
   separate id spaces, so nothing guarantees a value is unique across them —
   matching on it alone would let a sandbox `payout.*` delivery settle or
   reverse a PRODUCTION transfer.

   Proved FUNCTIONALLY rather than by reading the source: the module is
   transpiled with a fake drizzle that records the predicate it is handed and a
   two-row store holding the SAME provider id in both environments. If the
   scope were dropped, the production row would move and these would fail.

   Entirely in-process — no database, no network.
   ========================================================================== */

console.log("\n--- A. transfer state changes are environment-scoped ---");

{
  // Drizzle exposes rows with camelCase properties, so the fake column tags and
  // the fake row keys use the same names the module actually reads.
  const COL = {
    transferId: "transferId",
    providerTransferId: "providerTransferId",
    environment: "environment",
    status: "status",
    createdAt: "createdAt",
  };

  const matches = (cond, row) => {
    if (!cond) return true;
    if (cond.op === "and") return cond.parts.every((p) => matches(p, row));
    if (cond.op === "eq") return row[cond.col] === cond.val;
    // The sweep's age filter arrives as a drizzle `sql` template —
    // sql`${createdAt} < ${cutoff}` — so the tag captures both interpolations
    // and the comparison is evaluated for real rather than waved through.
    if (cond.op === "lt") return row[cond.col] < cond.val;
    // The status guard arrives as inArray(status, allowedFrom): the service
    // puts its terminal-state protection in the WHERE clause, so the fake has
    // to evaluate it or every guarded update would silently match nothing.
    if (cond.op === "in") return cond.vals.includes(row[cond.col]);
    return false;
  };

  /** Builds the module over an in-memory store; returns it plus a call log. */
  function loadTransfers({ rows, environment }) {
    const log = { wheres: [], updated: [], inserted: [], retrieved: [] };
    const store = rows.map((r) => ({ ...r }));

    const updateBuilder = () => ({
      set(values) {
        this._values = values;
        return this;
      },
      where(cond) {
        log.wheres.push(cond);
        this._hit = [];
        for (const row of store) {
          if (matches(cond, row)) {
            Object.assign(row, this._values);
            log.updated.push(row.transferId);
            this._hit.push(row);
          }
        }
        // Stays chainable: the service calls .returning() after .where() to
        // learn whether its GUARDED update matched. Returning a bare promise
        // made that throw, which the service read as "transition refused".
        return this;
      },
      returning() { return Promise.resolve((this._hit ?? []).map((r) => ({ transferId: r.transferId }))); },
      then(res, rej) { return Promise.resolve(this._hit ?? []).then(res, rej); },
    });

    const selectBuilder = () => ({
      from() { return this; },
      where(cond) { log.wheres.push(cond); this._cond = cond; return this; },
      limit() { return Promise.resolve(store.filter((r) => matches(this._cond, r))); },
      then(res, rej) { return Promise.resolve(store.filter((r) => matches(this._cond, r))).then(res, rej); },
    });

    const tx = {
      insert() {
        return {
          values(v) {
            log.inserted.push(v);
            return { returning: () => Promise.resolve([{ transactionId: "txn_fake" }]) };
          },
        };
      },
      update: updateBuilder,
    };

    const DB = {
      select: selectBuilder,
      update: updateBuilder,
      insert: tx.insert,
      transaction: async (fn) => fn(tx),
    };

    const js = ts.transpileModule(readFileSync("src/lib/server/creator-transfers.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    const req = (spec) => {
      if (spec === "server-only") return {};
      if (spec === "crypto") return require("node:crypto");
      if (spec === "drizzle-orm") {
        return {
          eq: (col, val) => ({ op: "eq", col, val }),
          and: (...parts) => ({ op: "and", parts: parts.filter(Boolean) }),
          inArray: (col, vals) => ({ op: "in", col, vals }),
          sql: (_strings, col, val) => ({ op: "lt", col, val }),
        };
      }
      if (spec === "@/lib/db") return { getDb: () => DB, schema: { creatorTransfers: COL, accountingTransactions: {}, accountingEntries: {}, whopAccounts: {} } };
      if (spec.endsWith("whop-payments")) return { getWhopEnvironment: () => environment };
      // Configured, and matching the environment under test: reconcileTransfer
      // resolves the platform config before it will touch a row, so a stubbed
      // failure here would make every scoping assertion pass vacuously.
      if (spec.endsWith("whop-accounts")) {
        return {
          resolvePlatformConfig: () =>
            environment ? { ok: true, config: { environment } } : { ok: false, reason: "unconfigured" },
        };
      }
      if (spec.endsWith("whop-payout-status")) return { fetchPayoutStatus: async () => null };
      if (spec.endsWith("whop-transfers")) {
        return {
          createLedgerTransfer: async () => ({ ok: false, outcome: "ambiguous", reason: "network_error" }),
          retrieveTransfer: async (id) => {
            log.retrieved.push(id);
            return { ok: true, transfer: { providerTransferId: id, status: "succeeded", confirmedAmountMinor: null, currency: "usd", failureCode: null } };
          },
        };
      }
      if (spec.endsWith("accounting/journal")) {
        return { reverseTransaction: async () => ({ ok: true, transactionId: "rev", alreadyReversed: false }) };
      }
      return require(spec);
    };

    const mod = { exports: {} };
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return { mod: mod.exports, log, store };
  }

  // The same provider id exists in BOTH environments — the collision the fix
  // is for. Only the sandbox row may ever move.
  const twoEnvRows = () => [
    { transferId: "t_sandbox", providerTransferId: "tr_collide", environment: "sandbox", status: "pending", amountMinor: 1n, currency: "usd", whopAccountId: "biz_a" },
    { transferId: "t_prod", providerTransferId: "tr_collide", environment: "production", status: "pending", amountMinor: 1n, currency: "usd", whopAccountId: "biz_b" },
  ];

  const carriesEnvironment = (cond, value) =>
    cond?.op === "and" &&
    cond.parts.some((p) => p.op === "eq" && p.col === COL.environment && p.val === value) &&
    cond.parts.some((p) => p.op === "eq" && p.col === COL.providerTransferId);

  /* --- the provider-authoritative refresh is environment-scoped --- */
  //
  // RE-BASELINED. This section previously drove `markTransferCompleted` and
  // `markTransferReversed`, which wrote money state from a webhook payload's
  // `status` string. Those statuses were not real — a Whop transfer has only
  // `processing`, `succeeded`, `failed` — and `failed` posted a reversal for
  // money that had never moved. They were replaced by
  // `refreshTransferFromProvider`, which treats the event as a trigger and
  // asks `transfers.retrieve` instead.
  //
  // The property under test has NOT changed and is still the point: a
  // provider transfer id is Whop's namespace and is not unique across
  // environments, so resolving one must be scoped to ours.
  {
    const { mod, log, store } = loadTransfers({ rows: twoEnvRows(), environment: "sandbox" });
    const r = await mod.refreshTransferFromProvider("tr_collide");
    check("the refresh scopes its lookup by environment",
      carriesEnvironment(log.wheres[0], "sandbox"));
    check("it resolves ONLY the row in the running environment",
      r.ok === true && store.find((x) => x.transferId === "t_prod").status === "pending");
    check("and the sandbox row followed the provider's answer",
      store.find((x) => x.transferId === "t_sandbox").status === "completed");
  }

  /* --- the cross-environment case, stated directly --- */
  {
    // Running as PRODUCTION, with only a sandbox row present: nothing matches.
    const rows = [{ transferId: "t_sandbox", providerTransferId: "tr_collide", environment: "sandbox", status: "submitted", amountMinor: 1n, currency: "usd", whopAccountId: "biz_a" }];
    const prod = loadTransfers({ rows, environment: "production" });
    const r = await prod.mod.refreshTransferFromProvider("tr_collide");
    check("an id match in ANOTHER environment is not ours and is left alone",
      r.ok === false && prod.store[0].status === "submitted");
    check("and the provider is never asked about a row we do not hold",
      prod.log.retrieved.length === 0, `${prod.log.retrieved.length}`);
  }

  /* --- fail closed --- */
  {
    const { mod, log, store } = loadTransfers({ rows: twoEnvRows(), environment: null });
    const r = await mod.refreshTransferFromProvider("tr_collide");
    check("an unresolvable environment fails CLOSED, with no query issued",
      r.ok === false && log.wheres.length === 0);
    check("and mutates nothing",
      store.every((x) => x.status === "pending"));
    check("the refresh takes only a provider id — no caller-chosen environment",
      mod.refreshTransferFromProvider.length === 1);
  }


  /* --- the reconciliation sweep is scoped too --- */
  {
    const sweepRows = () => [
      { transferId: "t_sandbox_old", providerTransferId: "tr_a", environment: "sandbox", status: "pending", createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      { transferId: "t_prod_old", providerTransferId: "tr_b", environment: "production", status: "pending", createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      { transferId: "t_sandbox_done", providerTransferId: "tr_c", environment: "sandbox", status: "completed", createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      { transferId: "t_sandbox_fresh", providerTransferId: "tr_d", environment: "sandbox", status: "pending", createdAt: new Date() },
    ];

    const sandbox = loadTransfers({ rows: sweepRows(), environment: "sandbox" });
    const found = await sandbox.mod.getPendingTransfersOlderThanMinutes(30);
    check("the sweep returns only PENDING rows from the active environment",
      found.map((r) => r.transferId).join(",") === "t_sandbox_old", found.map((r) => r.transferId).join(","));
    check("a production row is invisible in sandbox mode",
      found.some((r) => r.transferId === "t_prod_old") === false);
    check("the sweep still filters by status — a completed row is excluded",
      found.some((r) => r.transferId === "t_sandbox_done") === false);
    check("the sweep still filters by age — a fresh row is excluded",
      found.some((r) => r.transferId === "t_sandbox_fresh") === false);

    const prod = loadTransfers({ rows: sweepRows(), environment: "production" });
    const foundProd = await prod.mod.getPendingTransfersOlderThanMinutes(30);
    check("a sandbox row is invisible in production mode",
      foundProd.map((r) => r.transferId).join(",") === "t_prod_old", foundProd.map((r) => r.transferId).join(","));

    const unset = loadTransfers({ rows: sweepRows(), environment: null });
    const none = await unset.mod.getPendingTransfersOlderThanMinutes(30);
    check("an unresolvable environment performs NO broad query and returns nothing",
      none.length === 0 && unset.log.wheres.length === 0);

    check("the sweep takes no environment argument a caller could aim",
      unset.mod.getPendingTransfersOlderThanMinutes.length === 1);
  }
}

/* ==========================================================================
   A. THE NOTIFICATION TRIGGERS NEVER TAKE ENVIRONMENT FROM THE PAYLOAD

   `account.updated` used to read the environment out of the webhook body
   (`data.environment ?? root.environment`) and hand it to the account lookup.
   Externally-supplied JSON could therefore choose which environment's
   `whop_accounts` row to resolve, so a sandbox delivery claiming
   `"environment": "production"` would have resolved — and notified — a
   PRODUCTION creator.

   Proved functionally against an in-memory store, with the payload actively
   lying about the environment. No database, no network.
   ========================================================================== */

console.log("\n--- A. notification triggers ignore payload environment ---");

{
  const COL = {
    whopAccountId: "whopAccountId",
    whopPaymentId: "whopPaymentId",
    providerTransferId: "providerTransferId",
    environment: "environment",
    firebaseUid: "firebaseUid",
  };

  const matches = (cond, row) => {
    if (!cond) return true;
    if (cond.op === "and") return cond.parts.every((p) => matches(p, row));
    if (cond.op === "eq") return row[cond.col] === cond.val;
    return false;
  };

  function loadTriggers({ accounts = [], earnings = [], transfers = [], environment }) {
    const log = { wheres: [], notifications: [] };

    const selectBuilder = () => ({
      from(table) { this._rows = table; return this; },
      where(cond) { log.wheres.push(cond); this._cond = cond; return this; },
      limit() { return Promise.resolve(this._rows.filter((r) => matches(this._cond, r))); },
    });

    const DB = { select: selectBuilder };

    const js = ts.transpileModule(readFileSync("src/lib/server/notification-triggers.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    const req = (spec) => {
      if (spec === "server-only") return {};
      if (spec === "drizzle-orm") {
        return {
          eq: (col, val) => ({ op: "eq", col, val }),
          and: (...parts) => ({ op: "and", parts: parts.filter(Boolean) }),
        };
      }
      if (spec === "@/lib/db") return { getDb: () => DB };
      if (spec === "@/lib/db/schema") {
        return { creatorEarnings: earnings, creatorTransfers: transfers, whopAccounts: accounts };
      }
      if (spec.endsWith("whop-payments")) return { getWhopEnvironment: () => environment };
      if (spec.endsWith("notifications")) {
        return { writeNotification: async (n) => { log.notifications.push(n); } };
      }
      return require(spec);
    };

    const mod = { exports: {} };
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return { triggers: mod.exports, log };
  }

  /** A row array that also carries the column tags, so it doubles as a table. */
  const table = (rows) => Object.assign(rows, COL);

  // The SAME whop account id in both environments, owned by different creators.
  const collidingAccounts = () => table([
    { whopAccountId: "biz_collide", environment: "sandbox", firebaseUid: "uid_sandbox" },
    { whopAccountId: "biz_collide", environment: "production", firebaseUid: "uid_production" },
  ]);

  /* --- the trusted environment decides, not the caller --- */
  {
    const { triggers, log } = loadTriggers({ accounts: collidingAccounts(), environment: "sandbox" });
    await triggers.notifyAccountUpdated("biz_collide", "active");
    check("the account lookup is scoped to the TRUSTED environment",
      log.wheres[0]?.op === "and" &&
      log.wheres[0].parts.some((p) => p.col === COL.environment && p.val === "sandbox"));
    check("the notification goes to the sandbox creator, not the production one",
      log.notifications.length === 1 && log.notifications[0].firebaseUid === "uid_sandbox",
      log.notifications[0]?.firebaseUid);
  }

  /* --- a lying payload reaches the dispatcher and is still ignored --- */
  {
    const { triggers, log } = loadTriggers({ accounts: collidingAccounts(), environment: "sandbox" });
    // The dispatcher is the seam the payload actually arrives through. Running
    // as SANDBOX, with the body insisting it is production, twice over.
    await triggers.fireWebhookNotifications("account.updated", "biz_collide", {
      data: { id: "biz_collide", status: "active", environment: "production" },
      environment: "production",
    });
    check("a payload claiming the OTHER environment cannot select it",
      log.wheres.length > 0 &&
      log.wheres.every((w) =>
        w.op === "and" && w.parts.some((p) => p.col === COL.environment && p.val === "sandbox")));
    check("and the creator notified is still the one in the running environment",
      log.notifications.length > 0 &&
      log.notifications.every((n) => n.firebaseUid === "uid_sandbox"),
      log.notifications.map((n) => n.firebaseUid).join(","));
  }

  /* --- the existing behaviour still works for the active environment --- */
  {
    const { triggers, log } = loadTriggers({ accounts: collidingAccounts(), environment: "production" });
    await triggers.fireWebhookNotifications("account.updated", "biz_collide", {
      data: { id: "biz_collide", status: "active" },
    });
    check("with no environment in the payload at all, the notification still fires",
      log.notifications.length === 1 && log.notifications[0].type === "kyc_approved");
    check("and it reaches the creator in the running environment",
      log.notifications[0].firebaseUid === "uid_production");
  }

  /* --- fail closed --- */
  {
    const { triggers, log } = loadTriggers({ accounts: collidingAccounts(), environment: null });
    await triggers.notifyAccountUpdated("biz_collide", "active");
    check("an unresolvable environment performs NO lookup and sends nothing",
      log.wheres.length === 0 && log.notifications.length === 0);
  }

  /* --- the signature itself leaves no seam --- */
  {
    const source = readFileSync("src/lib/server/notification-triggers.ts", "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("notifyAccountUpdated takes no environment parameter",
      /export async function notifyAccountUpdated\(\s*whopAccountId: string,\s*newStatus: string,\s*\)/.test(code));
    check("the dispatcher never reads an environment field from the payload",
      !/data\.environment|root\.environment/.test(code));
    check("every trigger resolves the environment from the trusted helper",
      (code.match(/const environment = getWhopEnvironment\(\);/g) ?? []).length === 5);
    check("and no trigger queries an env-scoped table without the predicate",
      !/\.where\(eq\((creatorEarnings|creatorTransfers|whopAccounts)\./.test(code));
  }
}

/* ==========================================================================
   A. THE FINANCIAL LOOKUPS CANNOT CROSS ENVIRONMENTS

   Driven against an in-memory store holding the SAME Whop payment id in BOTH
   environments, owned by different creators. `creator_earnings` makes this
   concrete: its unique index is (whop_payment_id, firebase_uid), so a payment
   id genuinely CAN appear in sandbox and production at once — the collision is
   not hypothetical, and before the fix a sandbox dispute could freeze and
   reverse a production creator's earning.

   In-process only. No database, no network, no provider.
   ========================================================================== */

console.log("\n--- A. financial lookups cannot cross environments ---");

{
  const COL = {
    earningId: "earningId", whopPaymentId: "whopPaymentId", firebaseUid: "firebaseUid",
    environment: "environment", status: "status", grossAmountMinor: "grossAmountMinor",
    platformFeeMinor: "platformFeeMinor", netAmountMinor: "netAmountMinor",
    platformFeeBps: "platformFeeBps", currency: "currency", frozenByDispute: "frozenByDispute",
    frozenByDisputeId: "frozenByDisputeId", holdUntil: "holdUntil", reversedAt: "reversedAt",
    updatedAt: "updatedAt", amountMinor: "amountMinor", whopRefundId: "whopRefundId",
    whopDisputeId: "whopDisputeId", createdAt: "createdAt", provider: "provider",
  };

  const matches = (cond, row) => {
    if (!cond) return true;
    if (cond.op === "and") return cond.parts.every((p) => matches(p, row));
    if (cond.op === "eq") return row[cond.col] === cond.val;
    if (cond.op === "sqlNe") return row[cond.col] !== cond.val;
    return true; // an opaque sql fragment must not silently exclude rows
  };

  /** Builds a module over an in-memory store, recording every predicate. */
  function loadWithStore(file, { rows, environment, extra = {} }) {
    const log = { wheres: [], updated: [], selects: 0 };
    const store = rows.map((r) => ({ ...r }));

    let inserted = 0;
    const builder = () => ({
      from() { return this; },
      set(v) { this._values = v; return this; },
      // `insert(t).values(v).returning(...)` — the row is appended to the store
      // so a follow-up read sees it, and an id is handed back like Postgres
      // would. Marked with `_insert` so `where` is not mistaken for an update.
      values(v) {
        this._insert = { earningId: `e_new_${++inserted}`, ...v };
        store.push(this._insert);
        return this;
      },
      returning() {
        if (this._insert) return Promise.resolve([this._insert]);
        return Promise.resolve(store.filter((r) => matches(this._cond, r)));
      },
      where(cond) {
        log.wheres.push(cond);
        this._cond = cond;
        if (this._values) {
          for (const row of store) {
            if (matches(cond, row)) { Object.assign(row, this._values); log.updated.push(row.earningId ?? row.whopRefundId); }
          }
          return Promise.resolve();
        }
        return this;
      },
      orderBy() { return this; },
      groupBy() { return this; },
      innerJoin() { return this; },
      limit() { return Promise.resolve(store.filter((r) => matches(this._cond, r))); },
      then(res, rej) {
        log.selects++;
        return Promise.resolve(store.filter((r) => matches(this._cond, r))).then(res, rej);
      },
    });

    const DB = { select: builder, update: builder, insert: builder, transaction: async (fn) => fn(DB) };

    const js = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    const req = (spec) => {
      if (spec === "server-only") return {};
      if (spec === "drizzle-orm") {
        return {
          eq: (col, val) => ({ op: "eq", col, val }),
          and: (...p) => ({ op: "and", parts: p.filter(Boolean) }),
          or: (...p) => ({ op: "or", parts: p.filter(Boolean) }),
          asc: () => ({}), lte: () => ({}), inArray: () => ({}),
          sql: (strings, col, val) => {
            const t = strings.join("?");
            if (/!=/.test(t)) return { op: "sqlNe", col, val };
            return { op: "sql" };
          },
        };
      }
      if (spec === "@/lib/db") {
        return { getDb: () => DB, schema: { creatorEarnings: COL, paymentRefunds: COL, paymentDisputes: COL, accountingTransactions: COL, accountingEntries: COL } };
      }
      if (spec === "@/lib/db/schema") {
        return { creatorEarnings: COL, paymentRefunds: COL, paymentDisputes: COL, accountingTransactions: COL, accountingEntries: COL, disputeAlerts: COL, resolutionCenterCases: COL, whopAccounts: COL, paymentOrders: COL };
      }
      if (spec.endsWith("whop-payments")) return { getWhopEnvironment: () => environment };
      if (extra[spec]) return extra[spec];
      // The earnings POLICY is pure arithmetic — hold windows, the fee split,
      // the balance reduction. Stubbing it would make the balance assertions
      // meaningless, so it is loaded for real.
      if (spec.endsWith("creator-earnings-policy")) {
        const pjs = ts.transpileModule(readFileSync("src/lib/server/creator-earnings-policy.ts", "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const pm = { exports: {} };
        new Function("module", "exports", "require", pjs)(pm, pm.exports, req);
        return pm.exports;
      }
      return new Proxy({}, { get: () => () => undefined });
    };

    const mod = { exports: {} };
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return { mod: mod.exports, log, store };
  }

  /* --- creator earnings: the same payment id in both environments --- */
  const collidingEarnings = () => [
    { earningId: "e_sandbox", whopPaymentId: "pay_collide", firebaseUid: "uid_sandbox", environment: "sandbox", status: "available", frozenByDispute: false, grossAmountMinor: 1000n, platformFeeMinor: 200n, netAmountMinor: 800n, platformFeeBps: 2000, currency: "usd" },
    { earningId: "e_prod", whopPaymentId: "pay_collide", firebaseUid: "uid_production", environment: "production", status: "available", frozenByDispute: false, grossAmountMinor: 9999n, platformFeeMinor: 1999n, netAmountMinor: 8000n, platformFeeBps: 2000, currency: "usd" },
  ];

  const EARNINGS = "src/lib/server/creator-earnings.ts";
  const posts = [];
  const postingStub = {
    "./accounting/revenue-split-posting": {
      postRevenueSplit: async () => ({ ok: true }),
      postRevenueSplitReversal: async (i) => { posts.push(i); return { ok: true }; },
    },
  };

  {
    const { mod, store } = loadWithStore(EARNINGS, { rows: collidingEarnings(), environment: "sandbox", extra: postingStub });
    const r = await mod.freezeForDispute("pay_collide", "dp_1");
    check("freezeForDispute freezes ONLY the sandbox earning",
      r.ok === true &&
      store.find((x) => x.earningId === "e_sandbox").frozenByDispute === true &&
      store.find((x) => x.earningId === "e_prod").frozenByDispute === false);
  }
  {
    const rows = collidingEarnings().map((r) => ({ ...r, frozenByDispute: true, frozenByDisputeId: "dp_1" }));
    const { mod, store } = loadWithStore(EARNINGS, { rows, environment: "sandbox", extra: postingStub });
    await mod.unfreezeFromDispute("pay_collide");
    check("unfreezeFromDispute unfreezes ONLY the sandbox earning",
      store.find((x) => x.earningId === "e_sandbox").frozenByDispute === false &&
      store.find((x) => x.earningId === "e_prod").frozenByDispute === true);
  }
  {
    posts.length = 0;
    const { mod, store } = loadWithStore(EARNINGS, { rows: collidingEarnings(), environment: "sandbox", extra: postingStub });
    const r = await mod.reverseForDispute({ whopPaymentId: "pay_collide", whopDisputeId: "dp_1", environment: "sandbox" });
    check("reverseForDispute reverses ONLY the sandbox earning",
      r.ok === true &&
      store.find((x) => x.earningId === "e_sandbox").status === "reversed" &&
      store.find((x) => x.earningId === "e_prod").status === "available");
    check("and it posts a reversal for the sandbox creator only",
      posts.length === 1 && posts[0].creatorFirebaseUid === "uid_sandbox",
      posts.map((p) => p.creatorFirebaseUid).join(","));
    check("the reversal keeps the dispute id as its idempotency anchor",
      posts[0].refundOrDisputeId === "dp_1");
  }
  {
    posts.length = 0;
    const { mod, store } = loadWithStore(EARNINGS, { rows: collidingEarnings(), environment: "production", extra: postingStub });
    const r = await mod.reverseForRefund({ whopPaymentId: "pay_collide", refundId: "rf_1", refundAmountMinor: 9999n, currency: "usd", environment: "production" });
    check("reverseForRefund in PRODUCTION cannot touch the sandbox earning",
      r.ok === true &&
      store.find((x) => x.earningId === "e_prod").status === "reversed" &&
      store.find((x) => x.earningId === "e_sandbox").status === "available");
    check("and the refund id remains the reversal's idempotency anchor",
      posts.length === 1 && posts[0].refundOrDisputeId === "rf_1");
  }
  {
    const { mod, log, store } = loadWithStore(EARNINGS, { rows: collidingEarnings(), environment: null, extra: postingStub });
    const a = await mod.freezeForDispute("pay_collide", "dp_1");
    const b = await mod.unfreezeFromDispute("pay_collide");
    const c = await mod.reverseForDispute({ whopPaymentId: "pay_collide", whopDisputeId: "dp_1", environment: "sandbox" });
    const d = await mod.reverseForRefund({ whopPaymentId: "pay_collide", refundId: "rf_1", refundAmountMinor: 1n, currency: "usd", environment: "sandbox" });
    check("an unresolvable environment fails CLOSED on every earnings path",
      [a, b, c, d].every((x) => x.ok === false));
    check("and issues NO query and mutates NOTHING",
      log.wheres.length === 0 && log.updated.length === 0 &&
      store.every((x) => x.status === "available" && x.frozenByDispute === false));
  }

  /* --- refunds: the same payment id in both environments --- */
  {
    const rows = [
      { whopRefundId: "rf_sandbox", whopPaymentId: "pay_collide", environment: "sandbox", status: "completed", amountMinor: 500n, provider: "whop", createdAt: new Date(1) },
      { whopRefundId: "rf_prod", whopPaymentId: "pay_collide", environment: "production", status: "completed", amountMinor: 7777n, provider: "whop", createdAt: new Date(2) },
    ];
    const sandbox = loadWithStore("src/lib/server/payment-refunds.ts", { rows, environment: "sandbox" });
    const listed = await sandbox.mod.listRefundsForPaymentLocal("pay_collide");
    check("listRefundsForPaymentLocal returns only this environment's refunds",
      listed.length === 1 && listed[0].whopRefundId === "rf_sandbox",
      listed.map((r) => r.whopRefundId).join(","));

    const prod = loadWithStore("src/lib/server/payment-refunds.ts", { rows, environment: "production" });
    const listedProd = await prod.mod.listRefundsForPaymentLocal("pay_collide");
    check("and in production mode the sandbox refund is invisible",
      listedProd.length === 1 && listedProd[0].whopRefundId === "rf_prod");

    const unset = loadWithStore("src/lib/server/payment-refunds.ts", { rows, environment: null });
    const none = await unset.mod.listRefundsForPaymentLocal("pay_collide");
    const zero = await unset.mod.localCompletedRefundTotal("pay_collide");
    check("an unresolvable environment returns nothing and issues no refund query",
      none.length === 0 && zero === BigInt(0) && unset.log.wheres.length === 0);
  }

  /* --- disputes: the same payment id in both environments --- */
  {
    const rows = [
      { whopDisputeId: "dp_sandbox", whopPaymentId: "pay_collide", environment: "sandbox", status: "lost", provider: "whop", createdAt: new Date(1) },
      { whopDisputeId: "dp_prod", whopPaymentId: "pay_collide", environment: "production", status: "lost", provider: "whop", createdAt: new Date(2) },
    ];
    const sandbox = loadWithStore("src/lib/server/payment-disputes.ts", { rows, environment: "sandbox" });
    const listed = await sandbox.mod.listDisputesForPaymentLocal("pay_collide");
    check("listDisputesForPaymentLocal returns only this environment's disputes",
      listed.length === 1 && listed[0].whopDisputeId === "dp_sandbox",
      listed.map((r) => r.whopDisputeId).join(","));

    const unset = loadWithStore("src/lib/server/payment-disputes.ts", { rows, environment: null });
    const none = await unset.mod.listDisputesForPaymentLocal("pay_collide");
    check("an unresolvable environment returns nothing and issues no dispute query",
      none.length === 0 && unset.log.wheres.length === 0);
  }

  /* --- the same provider id may now exist ONCE PER ENVIRONMENT --------
   *
   * This is what migration 0011 bought. Before it, the unique index was
   * global, so these two rows could not coexist — and the read-back serving
   * that index could not be scoped without disagreeing with its own ON
   * CONFLICT target. Now both rows exist and each environment sees only its
   * own, while idempotency WITHIN an environment is unchanged.
   */
  {
    const bothEnv = () => [
      { earningId: "e_sandbox", whopPaymentId: "pay_same", firebaseUid: "uid_a", environment: "sandbox", status: "available", frozenByDispute: false, grossAmountMinor: 1000n, platformFeeMinor: 200n, netAmountMinor: 800n, platformFeeBps: 2000, currency: "usd" },
      { earningId: "e_prod", whopPaymentId: "pay_same", firebaseUid: "uid_a", environment: "production", status: "available", frozenByDispute: false, grossAmountMinor: 5000n, platformFeeMinor: 1000n, netAmountMinor: 4000n, platformFeeBps: 2000, currency: "usd" },
    ];

    // IDEMPOTENCY WITHIN THE ENVIRONMENT: the sandbox row is found, so the
    // call reports alreadyRecorded and writes nothing.
    const sandbox = loadWithStore(EARNINGS, { rows: bothEnv(), environment: "sandbox", extra: postingStub });
    const same = await sandbox.mod.recordCreatorEarning({
      firebaseUid: "uid_a", whopPaymentId: "pay_same", grossAmountMinor: 1000n,
      currency: "usd", environment: "sandbox", paymentSettledAt: new Date(),
    });
    check("recordCreatorEarning is still idempotent WITHIN one environment",
      same.ok === true && same.alreadyRecorded === true && same.earningId === "e_sandbox",
      same.ok ? same.earningId : same.reason);

    // CROSS-ENVIRONMENT: running as production must NOT report the sandbox row
    // as already-recorded. That was the exact wrong-row answer the global index
    // used to force.
    const prod = loadWithStore(EARNINGS, { rows: bothEnv(), environment: "production", extra: postingStub });
    const cross = await prod.mod.recordCreatorEarning({
      firebaseUid: "uid_a", whopPaymentId: "pay_same", grossAmountMinor: 5000n,
      currency: "usd", environment: "production", paymentSettledAt: new Date(),
    });
    check("and in production it resolves the PRODUCTION row, never the sandbox one",
      cross.ok === true && cross.earningId === "e_prod",
      cross.ok ? cross.earningId : cross.reason);

    // A genuinely new payment in an environment that has no row for it must
    // not be short-circuited by the other environment's row.
    const fresh = loadWithStore(EARNINGS, {
      rows: [bothEnv()[1]], environment: "sandbox", extra: postingStub,
    });
    const created = await fresh.mod.recordCreatorEarning({
      firebaseUid: "uid_a", whopPaymentId: "pay_same", grossAmountMinor: 1000n,
      currency: "usd", environment: "sandbox", paymentSettledAt: new Date(),
    });
    check("a production row does NOT make a sandbox earning look already-recorded",
      created.ok === true && created.alreadyRecorded !== true,
      created.ok ? `alreadyRecorded=${created.alreadyRecorded}` : created.reason);
    check("the idempotency read-back predicate carries the environment",
      fresh.log.wheres[0]?.op === "and" &&
      fresh.log.wheres[0].parts.some((p) => p.col === "environment" && p.val === "sandbox"));
  }

  /* --- creator balance and withdrawal eligibility are environment-scoped --- */
  {
    const mixed = () => [
      { earningId: "e_s", whopPaymentId: "pay_s", firebaseUid: "uid_a", environment: "sandbox", status: "available", frozenByDispute: false, netAmountMinor: 800n, currency: "usd", holdUntil: new Date(0), createdAt: new Date(1) },
      { earningId: "e_p", whopPaymentId: "pay_p", firebaseUid: "uid_a", environment: "production", status: "available", frozenByDispute: false, netAmountMinor: 4000n, currency: "usd", holdUntil: new Date(0), createdAt: new Date(2) },
    ];

    const sb = loadWithStore(EARNINGS, { rows: mixed(), environment: "sandbox", extra: postingStub });
    const sbBal = await sb.mod.getCreatorBalance("uid_a");
    check("the sandbox balance EXCLUDES the production earning",
      sbBal.ok === true && sbBal.balance.availableMinor === 800n,
      sbBal.ok ? String(sbBal.balance.availableMinor) : sbBal.reason);

    const pr = loadWithStore(EARNINGS, { rows: mixed(), environment: "production", extra: postingStub });
    const prBal = await pr.mod.getCreatorBalance("uid_a");
    check("the production balance EXCLUDES the sandbox earning",
      prBal.ok === true && prBal.balance.availableMinor === 4000n,
      prBal.ok ? String(prBal.balance.availableMinor) : prBal.reason);
    check("so no cross-environment total is ever offered as withdrawable",
      sbBal.balance.availableMinor + prBal.balance.availableMinor === 4800n &&
      sbBal.balance.availableMinor !== 4800n && prBal.balance.availableMinor !== 4800n);

    const unset = loadWithStore(EARNINGS, { rows: mixed(), environment: null, extra: postingStub });
    const none = await unset.mod.getCreatorBalance("uid_a");
    check("an unresolvable environment fails CLOSED on the balance, with no query",
      none.ok === false && unset.log.wheres.length === 0);
  }

  /* --- every scoped predicate actually names the environment --- */
  {
    const { mod, log } = loadWithStore(EARNINGS, { rows: collidingEarnings(), environment: "sandbox", extra: postingStub });
    await mod.freezeForDispute("pay_collide", "dp_1");
    const carries = (c) => c?.op === "and" && c.parts.some((p) => p.op === "eq" && p.col === "environment" && p.val === "sandbox");
    check("the predicate handed to the driver names the trusted environment",
      log.wheres.length > 0 && log.wheres.every(carries));
  }
}

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
  const [{ n: beforeMigrations }] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
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
    // Not a frozen leg count: a real sandbox refund adds its own balanced pair
    // to the real ledger. `before`/`after` above already prove THIS suite
    // added no transaction; what matters here is that the journal nets to zero.
    check("REAL DB: the real journal still balances",
      entries.s === "0", `${entries.n} legs, residual ${entries.s}`);
    const [ledger] = await client`select count(*)::int as n from financial_ledger`;
    check("REAL DB: financial_ledger is still 0", ledger.n === 0);
    const afterOrders = await client`select order_id, status, paid_at from payment_orders order by created_at`;
    check("REAL DB: payment_orders is unchanged",
      JSON.stringify(afterOrders) === JSON.stringify(beforeOrders),
      afterOrders.map((o) => o.status).join(","));
    const [migrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    // The count grows as later tasks ship their own migrations, so a literal
    // here only ever goes stale. The assertion is that THIS SUITE applied
    // none, which is why it is compared to the count captured before the run.
    check("REAL DB: no schema change was applied by this suite",
      migrations.n === beforeMigrations, `${migrations.n} migrations`);
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
