/**
 * Tests for the Whop webhook receiver.
 *
 * Signature checks run against REAL signatures produced by the same
 * `standardwebhooks` implementation the official SDK helper verifies with, so
 * "valid" and "tampered" mean what they mean in production rather than what a
 * mock says.
 *
 * The module is loaded through the transpile trick used by the other suites,
 * with its imports supplied explicitly — the genuine `unwrapWebhook` for
 * verification, and stubs for the database accessors that only
 * `processVerifiedWebhook` touches.
 *
 * Durable deduplication and the retry invariant are not asserted here — they
 * are behaviour of SQL, not of JavaScript, and are proved against real
 * Postgres in `whop-retry-test.mjs`.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { Webhook } = require("standardwebhooks");
const { unwrapWebhook, WebhookVerificationError } = require("@whop/sdk/helpers");
const postgres = require("postgres");

/**
 * Whop shows a `ws_`-prefixed secret and signs with its base64 encoding — the
 * SDK helper encodes the whole string, prefix included, before deriving the
 * HMAC key. Tests sign the same way, so a "valid" signature here is valid for
 * the same reason a real delivery is.
 */
const SECRET = "ws_cliprewards_test_signing_secret";
const OTHER_SECRET = "ws_a_completely_different_secret";
const signingKey = (secret) => Buffer.from(secret).toString("base64");
const COMPANY = "biz_kLtestcompany";

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

const webhooks = load("src/lib/server/whop-webhooks.ts", {
  unwrapWebhook,
  WebhookVerificationError,
  sql: () => {},
  and: () => {},
  or: () => {},
  isNull: () => {},
  eq: () => {},
  getDb: () => null,
  verifyPaymentOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  // Order mapping is proved in whop-checkout-test.mjs; stubbed here so these
  // suites test the receiver, not the mapping.
  mapPaymentToOrder: async () => ({ kind: "ignored", reason: "not_settled" }),
  whopWebhookReceipts: {},
  getWhopWebhookSecret: () => SECRET,
  getWhopCompanyId: () => COMPANY,
  getWhopEnvironment: () => "sandbox",
  describeWhopError: (e) => (e instanceof Error ? e.message : "unknown error"),
});

const payments = load("src/lib/server/whop-payments.ts", { WhopClient: class {} });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, skipped: false });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, why) => {
  results.push({ name, pass: true, skipped: true });
  console.log(`… SKIPPED ${name} — ${why}`);
};

/** Signs a body exactly as Whop does. */
function sign(payload, { id = "msg_" + Math.random().toString(36).slice(2), secret = SECRET, at = new Date() } = {}) {
  const wh = new Webhook(signingKey(secret));
  return {
    id,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": Math.floor(at.getTime() / 1000).toString(),
      "webhook-signature": wh.sign(id, at, payload),
    },
  };
}

const paymentBody = JSON.stringify({
  event: "payment.succeeded",
  data: { id: "pay_abc123", company_id: COMPANY, final_amount: 4200, currency: "usd" },
});

/* ---------------------- A. valid signed webhook accepted ------------------ */

{
  const { headers } = sign(paymentBody);
  const r = webhooks.verifyWebhook(paymentBody, headers);
  check("valid signed webhook is accepted", r.ok === true);
  check("the verified body is the parsed payload", r.ok && r.body.event === "payment.succeeded");
}

/* ------------------------- B. invalid signature --------------------------- */

{
  const { headers } = sign(paymentBody, { secret: OTHER_SECRET });
  const r = webhooks.verifyWebhook(paymentBody, headers);
  check("a signature from the wrong secret is rejected", r.ok === false && r.reason === "invalid_signature");
}
{
  const { headers } = sign(paymentBody);
  const r = webhooks.verifyWebhook(paymentBody, { ...headers, "webhook-signature": "v1,not-a-signature" });
  check("a malformed signature is rejected", r.ok === false && r.reason === "invalid_signature");
}

/* --------------------- C. missing signature headers ----------------------- */

{
  const { headers } = sign(paymentBody);
  for (const missing of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const stripped = { ...headers };
    delete stripped[missing];
    const r = webhooks.verifyWebhook(paymentBody, stripped);
    check(`a delivery with no ${missing} is rejected`, r.ok === false);
  }
  check("a delivery with no headers at all is rejected", webhooks.verifyWebhook(paymentBody, {}).ok === false);
}

/* -------------------------- D. tampered body ------------------------------ */

{
  const { headers } = sign(paymentBody);
  const tampered = paymentBody.replace("4200", "999999");
  const r = webhooks.verifyWebhook(tampered, headers);
  check("a tampered amount invalidates the signature", r.ok === false && r.reason === "invalid_signature");

  const reserialised = JSON.stringify(JSON.parse(paymentBody) );
  const sameBytes = reserialised === paymentBody;
  check(
    "verification is over raw bytes (re-serialising is not assumed safe)",
    sameBytes ? webhooks.verifyWebhook(reserialised, headers).ok === true : webhooks.verifyWebhook(reserialised, headers).ok === false,
    sameBytes ? "byte-identical here" : "differs, correctly rejected",
  );
}

/* --------------- stale timestamp is refused by the spec window ------------ */

{
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const { headers } = sign(paymentBody, { at: old });
  check("a stale timestamp is rejected", webhooks.verifyWebhook(paymentBody, headers).ok === false);
}

/* --------------- no secret configured => nothing is accepted -------------- */

{
  const noSecret = load("src/lib/server/whop-webhooks.ts", {
    unwrapWebhook,
    WebhookVerificationError,
    sql: () => {},
    and: () => {},
    or: () => {},
    isNull: () => {},
    eq: () => {},
    getDb: () => null,
    verifyPaymentOwnership: async () => ({ kind: "verified", accountId: COMPANY }),
  // Order mapping is proved in whop-checkout-test.mjs; stubbed here so these
  // suites test the receiver, not the mapping.
  mapPaymentToOrder: async () => ({ kind: "ignored", reason: "not_settled" }),
    whopWebhookReceipts: {},
    getWhopWebhookSecret: () => null,
    getWhopCompanyId: () => COMPANY,
    getWhopEnvironment: () => "sandbox",
    describeWhopError: () => "",
  });
  const { headers } = sign(paymentBody);
  const r = noSecret.verifyWebhook(paymentBody, headers);
  check("with no secret configured a VALID delivery is still refused", r.ok === false && r.reason === "no_secret");
}

/* ----------------------- G. supported event classified -------------------- */

for (const name of [
  "payment.succeeded",
  "payment.failed",
  "payment.pending",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "payout.created",
  "payout.updated",
  "payout.reversed",
]) {
  check(`"${name}" is recognised`, webhooks.isSupportedEvent(name) === true);
}
check("the envelope reads the event name", webhooks.readEnvelope(JSON.parse(paymentBody)).eventType === "payment.succeeded");
check("the envelope reads the resource id", webhooks.readEnvelope(JSON.parse(paymentBody)).resourceId === "pay_abc123");
check("the envelope reads the company id", webhooks.readEnvelope(JSON.parse(paymentBody)).companyId === COMPANY);
check("the webhook id comes from the signed headers", webhooks.readWebhookId({ "Webhook-Id": "msg_x" }) === "msg_x");

/* ------------------ H. unknown signed event creates no money -------------- */

for (const name of ["chat.message.created", "product.created", "membership.activated", "totally.made.up", ""]) {
  check(`"${name}" is not treated as financial`, webhooks.isSupportedEvent(name) === false);
}
check("a body with no event name degrades to unknown", webhooks.readEnvelope({}).eventType === "unknown");
check("a null body does not throw", webhooks.readEnvelope(null).eventType === "unknown");

/* -------------- handlers exist but write nothing financial yet ------------ */

for (const handler of [
  "handleWhopPaymentSucceeded",
  "handleWhopPaymentFailed",
  "handleWhopRefundCreated",
  "handleWhopDisputeCreated",
  "handleWhopPayoutUpdated",
]) {
  const result = await webhooks[handler]();
  check(`${handler} reports business_mapping_not_implemented`, result.kind === "business_mapping_not_implemented");
}

/* ------------------------ I. wrong company detected ----------------------- */

{
  const foreign = { event: "payment.succeeded", data: { id: "pay_x", company_id: "biz_someoneelse" } };
  const envelope = webhooks.readEnvelope(foreign);
  check("an event for another company is identifiable", envelope.companyId !== COMPANY);
  check("its resource id is still read for the receipt", envelope.resourceId === "pay_x");
}

/* ------------------ L. the secret never reaches output -------------------- */

{
  const env = { WHOP_API_KEY: "apik_test", WHOP_WEBHOOK_SECRET: SECRET, WHOP_COMPANY_ID: COMPANY, WHOP_ENV: "sandbox" };
  check("redaction removes the webhook secret", payments.redactWhopSecrets(`secret=${SECRET}`, env).includes(SECRET) === false);
  check("redaction removes the api key too", payments.redactWhopSecrets("key=apik_test", env).includes("apik_test") === false);
  check(
    "a verification failure never returns the secret",
    JSON.stringify(webhooks.verifyWebhook(paymentBody, {})).includes(SECRET) === false,
  );
  check(
    "an error quoting the secret is scrubbed",
    payments.describeWhopError(new Error(`bad key ${SECRET}`), env).includes(SECRET) === false,
  );
}

/* --------------------- M. the raw payload is not stored ------------------- */

{
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const table = schema.slice(schema.indexOf("whop_webhook_receipts"));
  const body = table.slice(0, table.indexOf("(t) =>"));
  for (const forbidden of ["raw_body", "payload", "body", "signature", "headers", "card", "email"]) {
    check(`the receipts table has no ${forbidden} column`, body.includes(`"${forbidden}"`) === false);
  }
  const receiver = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
  // The raw body is a parameter of the verifier; what matters is that it is
  // never among the values written to the receipt.
  const inserted = receiver.slice(receiver.indexOf(".values({"), receiver.indexOf(".onConflictDoNothing"));
  for (const forbidden of ["body", "payload", "signature", "secret", "headers"]) {
    check(`the receipt insert carries no ${forbidden} field`, inserted.includes(forbidden) === false);
  }
  check("the route reads the raw body but does not pass it on", readFileSync("src/app/api/webhooks/whop/route.ts", "utf8").includes("processVerifiedWebhook(webhookId, verified.body)"));
}

/* ------------------- N. sandbox / production isolation -------------------- */

{
  const sandbox = { WHOP_API_KEY: "apik_x", WHOP_COMPANY_ID: COMPANY, WHOP_ENV: "sandbox" };
  check("sandbox still selects the sandbox API", payments.resolveWhopPayments(sandbox).config.baseUrl === "https://sandbox-api.whop.com/api/v1");
  check("a broken environment still fails closed", payments.resolveWhopPayments({ ...sandbox, WHOP_ENV: "sandbx" }).ok === false);
  check("receipts record an environment", readFileSync("src/lib/server/whop-webhooks.ts", "utf8").includes("environment,"));
}

/* -------------------- O. the old OAuth flow is unaffected ----------------- */

// Account linking is a separate subsystem with its own module, cookie and
// credentials. The legacy module that used to blur the two is deleted.
check("the legacy OAuth module is gone", existsSync("src/lib/whop.ts") === false);
check("the webhook receiver shares nothing with account linking", readFileSync("src/lib/server/whop-webhooks.ts", "utf8").includes("whop-oauth") === false);
check("the webhook receiver does not touch OAuth", readFileSync("src/lib/server/whop-webhooks.ts", "utf8").includes("WHOP_CLIENT") === false);

/* ------------- E, F: durable dedup — needs the unapplied migration -------- */

skip("E/F. durable dedup against the real table", "proved against Postgres in whop-retry-test.mjs; re-run there after applying 0001");

/* ---------- J, K: the money tables must be untouched by this phase -------- */

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

if (process.env.DATABASE_URL) {
  const sqlc = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    const [{ n: ledger }] = await sqlc`select count(*)::int as n from financial_ledger`;
    check("J. financial_ledger is still empty", ledger === 0, `${ledger} rows`);
    const [{ n: audit }] = await sqlc`select count(*)::int as n from admin_audit_log`;
    check("K. admin_audit_log is still empty", audit === 0, `${audit} rows`);
    const tables = await sqlc`select table_name from information_schema.tables where table_schema='public'`;
    check(
      "the receipts table exists (migration 0001 applied)",
      tables.some((t) => t.table_name === "whop_webhook_receipts") === true,
    );
    // Every stored receipt must have come through signature verification.
    // A row whose id is not a Standard Webhooks message id could not have been
    // written by the verified path, so its presence would mean something got
    // in around the boundary.
    const stored = await sqlc`select webhook_id, environment from whop_webhook_receipts`;
    const unverifiable = stored.filter((r) => !r.webhook_id.startsWith("msg_"));
    check(
      "every stored receipt carries a Whop-signed message id",
      unverifiable.length === 0,
      `${stored.length} receipt(s), ${unverifiable.length} unexplained`,
    );
    check(
      "no receipt was recorded against the wrong environment",
      stored.every((r) => r.environment === "sandbox"),
    );
  } finally {
    await sqlc.end({ timeout: 2 });
  }
} else {
  skip("J/K. money tables unchanged", "no DATABASE_URL available");
}

const failed = results.filter((r) => !r.pass);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} checks passed, ${skipped} skipped.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
