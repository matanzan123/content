/**
 * Proves the webhook retry invariant against the REAL migrated table, driving
 * the REAL `processVerifiedWebhook` — not a re-implementation of its SQL.
 *
 * The module is transpiled and given genuine dependencies: a live Drizzle
 * client on Neon, the real schema, the real drizzle-orm operators. So what is
 * exercised here is the shipped acquisition path against real Postgres row
 * locking, which is the only way this invariant can be honestly demonstrated.
 *
 * ROWS: the test writes receipts under ids prefixed `test_retry_`, and deletes
 * every one of them at the end. The final check asserts the table is back to
 * the count it started at, so nothing is seeded and no fabricated delivery
 * history survives the run. No financial row is written at any point.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");
const drizzleOrm = require("drizzle-orm");
const pgCore = require("drizzle-orm/pg-core");
const { drizzle } = require("drizzle-orm/postgres-js");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
if (!process.env.DATABASE_URL) {
  console.log("no DATABASE_URL — cannot prove against the real table");
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function load(file, injected) {
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", ...names, js)(mod, mod.exports, ...names.map((n) => injected[n]));
  return mod.exports;
}

/* The real schema, then the real receiver bound to a real database. */
const schema = load("src/lib/db/schema.ts", { sql: drizzleOrm.sql, ...pgCore });

const client = postgres(process.env.DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const db = drizzle(client, { schema });

const COMPANY = process.env.WHOP_COMPANY_ID;

const webhooks = load("src/lib/server/whop-webhooks.ts", {
  and: drizzleOrm.and,
  eq: drizzleOrm.eq,
  isNull: drizzleOrm.isNull,
  or: drizzleOrm.or,
  sql: drizzleOrm.sql,
  unwrapWebhook: () => {
    throw new Error("not used here");
  },
  WebhookVerificationError: Error,
  getDb: () => db,
  whopWebhookReceipts: schema.whopWebhookReceipts,
  getWhopCompanyId: () => COMPANY,
  getWhopEnvironment: () => "sandbox",
  getWhopWebhookSecret: () => null,
  // Ownership is proved in whop-resources-test.mjs; here it is stubbed so the
  // retry/lease semantics are what is under test.
  verifyPaymentOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  // Order mapping is proved in whop-checkout-test.mjs; stubbed here so these
  // suites test the receiver, not the mapping.
  mapPaymentToOrder: async () => ({ kind: "ignored", reason: "not_settled" }),
  // The refund seam, stubbed for the same reason: refund mapping and refund
  // accounting are proved in refund-test.mjs, so what is under test here is
  // the retry and lease semantics of the receiver, not what a refund decides.
  verifyRefundOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  mapRefundToOrder: async () => ({ kind: "pending", refundId: "rf_x", orderId: "o" }),
  postWhopRefund: async () => ({ ok: true, transactionId: "t", alreadyPosted: false }),
  verifyDisputeOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  verifyAlertOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  verifyCaseOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  mapDisputeToOrder: async () => ({ kind: "recorded", resourceId: "dspt_x", paymentId: "pay_x", orderId: "o", status: "open", unchanged: false }),
  mapAlertToOrder: async () => ({ kind: "recorded_unmatched", resourceId: "dspa_x", reason: "payment_unmatched" }),
  mapCaseToOrder: async () => ({ kind: "recorded", resourceId: "reso_x", paymentId: "pay_x", orderId: "o", status: "open", unchanged: false }),
  postDisputeMovementsForPayment: async () => ({ ok: true, paymentId: "pay_x", examined: 0, outcomes: [] }),
  describeWhopError: (e) => (e instanceof Error ? e.message : "unknown error"),
});

const { processVerifiedWebhook } = webhooks;

const PREFIX = "test_retry_" + Date.now() + "_";
const ids = [];
const id = (name) => {
  const value = PREFIX + name;
  ids.push(value);
  return value;
};

const body = (event = "payment.succeeded", company = COMPANY) => ({
  event,
  data: { id: "pay_test_resource", company_id: company },
});

const row = async (webhookId) =>
  (await client`select * from whop_webhook_receipts where webhook_id = ${webhookId}`)[0];

const [{ n: startCount }] = await client`select count(*)::int as n from whop_webhook_receipts`;

try {
  /* ---------- first delivery reaches a terminal, honest state ------------- */
  {
    const w = id("first");
    const outcome = await processVerifiedWebhook(w, body());
    const r = await row(w);
    check("a first delivery is recorded", Boolean(r));
    check("a supported event ends in awaiting_mapping", outcome.ack === true && outcome.status === "awaiting_mapping", r?.status);
    check("its lease is released", r?.claimed_at === null);
    check("processed_at is set only once terminal", r?.processed_at !== null);
    check("delivery_count starts at 1", r?.delivery_count === 1);
    check("the environment is recorded as sandbox", r?.environment === "sandbox");
    // G. Both timestamps now come from Postgres, so the lifecycle cannot run
    // backwards however far this machine's clock has drifted from Neon's.
    check(
      "G. processed_at does not precede received_at",
      new Date(r.processed_at) >= new Date(r.received_at),
      `${new Date(r.received_at).toISOString()} -> ${new Date(r.processed_at).toISOString()}`,
    );
    check("H. no raw payload column exists to persist into", Object.keys(r).includes("payload") === false && Object.keys(r).includes("raw_body") === false);
  }

  /* -------- B/G. a terminal receipt never reprocesses on redelivery ------- */
  {
    const w = id("terminal");
    await processVerifiedWebhook(w, body());
    const before = await row(w);
    const again = await processVerifiedWebhook(w, body());
    const after = await row(w);
    check("B. a redelivery after terminal is answered duplicate", again.ack === true && again.status === "duplicate");
    check("G. the handler did not rerun (processed_at unchanged)", String(before.processed_at) === String(after.processed_at));
    check("F. delivery_count still incremented", after.delivery_count === 2, String(after.delivery_count));
    check("G. status is unchanged", after.status === before.status);
  }

  /* --------------- A. failed -> redelivery -> exactly one retry ----------- */
  {
    const w = id("failed");
    await processVerifiedWebhook(w, body());
    // Put the receipt in the state a thrown handler leaves behind.
    await client`update whop_webhook_receipts
                    set status='failed', failure_category='handler_exception',
                        claimed_at=null, processed_at=null
                  where webhook_id=${w}`;

    const retry = await processVerifiedWebhook(w, body());
    const r = await row(w);
    check("A. a failed receipt is reclaimed and retried", retry.ack === true && retry.status === "awaiting_mapping");
    check("A. it reaches a terminal status", r.status === "awaiting_mapping");
    check("A. failure_category is cleared", r.failure_category === null);
    check("F. the retry counted as a delivery", r.delivery_count === 2, String(r.delivery_count));

    const once = await processVerifiedWebhook(w, body());
    check("A. a further redelivery does NOT retry again", once.status === "duplicate");
  }

  /* ------------------- D. a live lease cannot be stolen ------------------- */
  {
    const w = id("live_lease");
    await client`insert into whop_webhook_receipts (webhook_id, event_type, company_id, environment, status, claimed_at)
                 values (${w}, 'payment.succeeded', ${COMPANY}, 'sandbox', 'received', now())`;
    const blocked = await processVerifiedWebhook(w, body());
    const r = await row(w);
    check("D. a delivery under a live lease is NOT acknowledged", blocked.ack === false && blocked.kind === "processing_in_flight");
    check("D. the owner keeps the receipt in received", r.status === "received");
    check("F. the blocked delivery was still counted", r.delivery_count === 2, String(r.delivery_count));
  }

  /* ----------------- E. an abandoned lease can be reclaimed --------------- */
  {
    const w = id("stale_lease");
    await client`insert into whop_webhook_receipts (webhook_id, event_type, company_id, environment, status, claimed_at)
                 values (${w}, 'payment.succeeded', ${COMPANY}, 'sandbox', 'received', now() - interval '30 minutes')`;
    const recovered = await processVerifiedWebhook(w, body());
    const r = await row(w);
    check("E. a stale lease is reclaimed, not stuck", recovered.ack === true && recovered.status === "awaiting_mapping");
    check("E. the recovered receipt reaches terminal", r.status === "awaiting_mapping");
    check("E. no receipt can sit in received forever", r.claimed_at === null);
  }

  /* ------------ C. concurrent duplicate deliveries, one owner ------------- */
  {
    const w = id("concurrent");
    const [a, b] = await Promise.all([
      processVerifiedWebhook(w, body()),
      processVerifiedWebhook(w, body()),
    ]);
    const rows = await client`select * from whop_webhook_receipts where webhook_id = ${w}`;
    check("C. concurrent deliveries create exactly ONE receipt", rows.length === 1, `${rows.length} rows`);

    const owners = [a, b].filter((o) => o.ack === true && o.status === "awaiting_mapping").length;
    const others = [a, b].filter((o) => o.status === "duplicate" || o.kind === "processing_in_flight").length;
    check("C. exactly one delivery owned the processing", owners === 1, `${owners} owner(s)`);
    check("C. the other was refused or deduplicated, never a second run", others === 1);
    check("C. the receipt is terminal exactly once", rows[0].status === "awaiting_mapping");
  }

  /* --------- a wrong-company event is quarantined, never processed -------- */
  {
    const w = id("foreign");
    const outcome = await processVerifiedWebhook(w, body("payment.succeeded", "biz_someoneelse"));
    const r = await row(w);
    check("an event for another company is quarantined", outcome.status === "rejected_company" && r.status === "rejected_company");
    check("it is terminal and never dispatched", r.processed_at !== null);
  }

  /* ------- an unknown but signed event is deterministic and harmless ------ */
  {
    const w = id("unknown");
    const outcome = await processVerifiedWebhook(w, body("chat.message.created"));
    check("an unsupported event is recorded, not processed", outcome.status === "unsupported");
    check("it does not rerun on redelivery", (await processVerifiedWebhook(w, body("chat.message.created"))).status === "duplicate");
  }

  /* ---------------- H. nothing sensitive was persisted -------------------- */
  {
    const stored = await client`select * from whop_webhook_receipts where webhook_id = any(${ids})`;
    const dump = JSON.stringify(stored);
    check("H. no raw body was stored", dump.includes("final_amount") === false && dump.includes('"event"') === false);
    check("H. no secret was stored", process.env.WHOP_API_KEY ? dump.includes(process.env.WHOP_API_KEY) === false : true);
    check("H. only the envelope fields are kept", Object.keys(stored[0]).sort().join(",") ===
      "claimed_at,company_id,delivery_count,environment,event_type,failure_category,processed_at,received_at,resource_id,status,webhook_id");
  }

  /* ---------------------- I/J. money tables untouched --------------------- */
  {
    const [{ n: ledger }] = await client`select count(*)::int as n from financial_ledger`;
    check("I. financial_ledger is still empty", ledger === 0, `${ledger} rows`);
    const [{ n: audit }] = await client`select count(*)::int as n from admin_audit_log`;
    check("J. admin_audit_log is still empty", audit === 0, `${audit} rows`);
  }

  /* ------------ the shipped acquisition path has not drifted -------------- */
  {
    const source = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
    const acquisition = source.slice(source.indexOf("const claimed = await db"), source.indexOf("if (wrongCompany) return"));
    check("the acquisition path contains no SELECT", acquisition.includes(".select(") === false);
    check("eligibility is tested inside the UPDATE", acquisition.includes("eq(whopWebhookReceipts.status, \"failed\")") && acquisition.includes("make_interval(secs =>"));
    check("G. no JS clock stamps any receipt timestamp", source.includes("new Date()") === false);
    check("G. every lifecycle timestamp uses the database clock", source.includes("const dbNow = sql"));
    check("G. the lease window is compared inside Postgres", acquisition.includes("now() - make_interval"));
    check("the ownership gate sits before dispatch", source.indexOf("verifyPaymentOwnership") < source.indexOf("await HANDLERS[eventType]("));
    check("delivery_count is incremented in SQL", acquisition.includes("deliveryCount: sql`"));
    check("an in-flight delivery is not acknowledged", acquisition.includes("kind: \"processing_in_flight\""));
  }
} finally {
  // Remove every row this run created, then prove the table is as we found it.
  await client`delete from whop_webhook_receipts where webhook_id = any(${ids})`;
  const [{ n: endCount }] = await client`select count(*)::int as n from whop_webhook_receipts`;
  check("the table is left exactly as it was found", endCount === startCount, `${startCount} -> ${endCount}`);
  await client.end({ timeout: 5 });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
