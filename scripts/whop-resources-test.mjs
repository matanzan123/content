/**
 * Tests for authoritative Whop resource ownership.
 *
 * The id-shape and outcome rules run against a stubbed client so every branch
 * is reachable — including ones a live sandbox cannot produce on demand, like
 * a payment owned by another company. The live half then proves the same code
 * against the real sandbox API, read-only.
 *
 * No payment, refund, capture or void is ever created here.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sdk = require("@whop/sdk");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
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

const OURS = "biz_ourcompany";
const SECRET_KEY = "apik_should_never_be_logged";

/** Builds the module with a stub payments client returning `payment`. */
function withPayment(payment, { companyId = OURS, throws = null, client = true } = {}) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  const mod = load("src/lib/server/whop-resources.ts", {
    WhopError: sdk.WhopError,
    describeWhopError: (e) => String(e?.message ?? "").split(SECRET_KEY).join("[redacted]"),
    getWhopCompanyId: () => companyId,
    getWhopPaymentsClient: () =>
      client
        ? {
            payments: {
              retrieve: async () => {
                if (throws) throw throws;
                return payment;
              },
            },
          }
        : null,
  });
  console.error = original;
  return { mod, logged };
}

/* ----------------- A. the resource belongs to our company ----------------- */

{
  const { mod } = withPayment({ id: "pay_abc", account_id: OURS });
  const r = await mod.verifyPaymentOwnership("pay_abc");
  check("A. a payment owned by the configured company verifies", r.kind === "verified", r.kind);
  check("A. the proven account id is returned", r.accountId === OURS);
  check("A. no payment detail rides along", Object.keys(r).sort().join(",") === "accountId,kind");
}

/* --------------------- B. the resource is someone else's ------------------ */

{
  const { mod } = withPayment({ id: "pay_abc", account_id: "biz_someoneelse" });
  const r = await mod.verifyPaymentOwnership("pay_abc");
  check("B. a payment owned by another company is rejected", r.kind === "wrong_company", r.kind);
}
{
  const { mod } = withPayment({ id: "pay_abc", account_id: null });
  const r = await mod.verifyPaymentOwnership("pay_abc");
  check("B. a payment with NO account is rejected, not waved through", r.kind === "wrong_company", r.kind);
}
{
  // Near-miss: a prefix collision must not count as a match.
  const { mod } = withPayment({ id: "pay_abc", account_id: OURS + "x" });
  check("B. ownership is an EXACT comparison", (await mod.verifyPaymentOwnership("pay_abc")).kind === "wrong_company");
}

/* ---------------------- C. the lookup itself fails ------------------------ */

{
  const notFound = new sdk.WhopError({ message: "not found", statusCode: 404 });
  const { mod } = withPayment(null, { throws: notFound });
  check("C. a 404 is resource_not_found", (await mod.verifyPaymentOwnership("pay_abc")).kind === "resource_not_found");
}
for (const status of [401, 403, 429, 500, 503]) {
  const err = new sdk.WhopError({ message: "boom", statusCode: status });
  const { mod } = withPayment(null, { throws: err });
  const r = await mod.verifyPaymentOwnership("pay_abc");
  check(`C. a ${status} is a provider_error, never a pass`, r.kind === "provider_error", r.category);
}
{
  const { mod } = withPayment(null, { throws: new Error("socket hang up") });
  const r = await mod.verifyPaymentOwnership("pay_abc");
  check("C. a network failure is a provider_error", r.kind === "provider_error", r.category);
}
{
  const { mod } = withPayment({ id: "pay_abc", account_id: OURS }, { client: false });
  check("C. no client configured means unprovable, not valid", (await mod.verifyPaymentOwnership("pay_abc")).kind === "unconfigured");
}
{
  const { mod } = withPayment({ id: "pay_abc", account_id: OURS }, { companyId: null });
  check("C. no company configured means unprovable, not valid", (await mod.verifyPaymentOwnership("pay_abc")).kind === "unconfigured");
}

/* ---------------------- D. malformed resource ids ------------------------- */

for (const bad of ["", "pay_", "nope", "PAY_abc", "pay abc", "pay_../../x", "pay_" + "a".repeat(100), null, undefined, 42, {}]) {
  const { mod } = withPayment({ id: "x", account_id: OURS });
  const r = await mod.verifyPaymentOwnership(bad);
  check(`D. id ${JSON.stringify(bad)} is refused before any API call`, r.kind === "invalid_resource_id", r.kind);
}
{
  const { mod } = withPayment({ id: "pay_abc", account_id: OURS });
  check("D. a well-formed pay_ id is accepted for lookup", mod.isPaymentId("pay_aBc123") === true);
}

/* ----- E. an absent company_id in the webhook still requires the API ------ */

{
  const source = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
  const gated = source.slice(source.indexOf("OWNERSHIP_GATED"), source.indexOf("const HANDLERS"));
  check("E. payment events are ownership-gated", ["payment.succeeded", "payment.failed", "payment.pending"].every((e) => gated.includes(e)));
  const boundary = source.slice(source.indexOf("if (OWNERSHIP_GATED"), source.indexOf("await HANDLERS[eventType]()"));
  check("E. the gate calls the authoritative lookup", boundary.includes("verifyPaymentOwnership(resourceId)"));
  check("E. anything other than verified stops the dispatch", boundary.includes('ownership.kind !== "verified"'));
  check("E. the payload company_id alone can never satisfy the gate", boundary.includes("companyId") === false);
  check("E. a wrong company is quarantined terminally", boundary.includes('status: "rejected_company"') && boundary.includes("ownership_mismatch"));
  check("E. an unprovable payment is left retryable, not acknowledged", boundary.includes('status: "failed"') && boundary.includes('ack: false'));
}

/* -------- F. a verified payment still stops at awaiting_mapping ----------- */

{
  const source = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
  const handlers = source.slice(source.indexOf("export async function handleWhopPaymentSucceeded"), source.indexOf("const OWNERSHIP_GATED"));
  check("F. no handler writes to a database", handlers.includes("db.") === false && handlers.includes("insert(") === false);
  check("F. every handler still reports business_mapping_not_implemented", (handlers.match(/business_mapping_not_implemented/g) ?? []).length >= 5);
  check("F. a verified payment therefore ends at awaiting_mapping", source.includes('result.kind === "handled" ? "processed" : "awaiting_mapping"'));
}

/* ------- J. no secret or raw payment response leaks to log or result ------ */

{
  const err = new sdk.WhopError({ message: `failed using ${SECRET_KEY}`, statusCode: 500 });
  const { mod, logged } = withPayment(null, { throws: err });
  const original = console.error;
  const captured = [];
  console.error = (...args) => captured.push(args.join(" "));
  const r = await mod.verifyPaymentOwnership("pay_abc");
  console.error = original;
  const all = captured.join("\n") + logged.join("\n");
  check("J. the API key never reaches the log", all.includes(SECRET_KEY) === false, all.length + " chars logged");
  check("J. the result never carries the key", JSON.stringify(r).includes(SECRET_KEY) === false);
  check("J. the failure category is a label, not a message", /^http_\d+$/.test(r.category), r.category);
}
{
  const fat = {
    id: "pay_abc",
    account_id: OURS,
    amount_after_fees: 4200,
    billing_address: { line1: "1 Somewhere St", postal_code: "12345" },
    user: { email: "buyer@example.com", name: "A Buyer" },
    payment_method: { type: "card", last4: "4242" },
  };
  const { mod } = withPayment(fat);
  const r = await mod.verifyPaymentOwnership("pay_abc");
  const dump = JSON.stringify(r);
  check("J. the full payment response is not returned", dump.includes("4242") === false && dump.includes("buyer@example.com") === false && dump.includes("Somewhere") === false);
  check("J. only kind and accountId survive", dump === JSON.stringify({ kind: "verified", accountId: OURS }));
}

/* ------------------- LIVE: the real sandbox, read-only -------------------- */

{
  const payments = load("src/lib/server/whop-payments.ts", { WhopClient: sdk.WhopClient });
  const live = load("src/lib/server/whop-resources.ts", {
    WhopError: sdk.WhopError,
    describeWhopError: payments.describeWhopError,
    getWhopCompanyId: payments.getWhopCompanyId,
    getWhopPaymentsClient: payments.getWhopPaymentsClient,
  });

  check("LIVE. the environment is sandbox", payments.getWhopEnvironment() === "sandbox");
  check("LIVE. the lookup would use the sandbox API", payments.resolveWhopPayments().config.baseUrl === "https://sandbox-api.whop.com/api/v1");

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const [receipt] = await sql`select resource_id from whop_webhook_receipts
                               where event_type='payment.succeeded' order by received_at limit 1`;
  const [{ n: ledger }] = await sql`select count(*)::int as n from financial_ledger`;
  await sql.end({ timeout: 2 });

  if (receipt?.resource_id) {
    check("LIVE. the stored real resource id is well-formed", live.isPaymentId(receipt.resource_id), receipt.resource_id.split("_")[0] + "_");
    const r = await live.verifyPaymentOwnership(receipt.resource_id);
    // Whop's dashboard "send test event" ships a SYNTHETIC payload: the
    // sandbox company has no payments, so this id resolves to nothing. Failing
    // closed on it is the correct outcome, and is the whole point of the gate.
    check("LIVE. an unresolvable resource fails closed", r.kind !== "verified", r.kind);
    check("LIVE. it is reported as not found, not as a pass", r.kind === "resource_not_found", r.kind);
  }
  check("LIVE. financial_ledger is untouched", ledger === 0, `${ledger} rows`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
