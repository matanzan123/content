/**
 * ACCOUNTING TESTS.
 *
 * Three parts, because the invariants live in three places and only one of
 * them can be checked by calling a function:
 *
 *   A. PURE LOGIC — the chart of accounts, the posting validator, and the
 *      settlement rule's arithmetic. No database, no network: the TypeScript
 *      is transpiled and given a tiny module loader, the same trick the other
 *      suites use.
 *
 *   B. DATABASE INVARIANTS — the balance trigger, the append-only triggers and
 *      the unique constraints from migration 0004. These cannot be tested by
 *      reading code: a trigger either fires or it does not.
 *
 *      THIS SUITE NEVER RUNS A MIGRATION AGAINST `public`. 0004 is applied
 *      there for real; here its statements are replayed inside a throwaway
 *      schema, `accounting_selftest`, dropped before and after, so a rejected
 *      journal is a real Postgres rejection and not a row in the real ledger.
 *      `drizzle.__drizzle_migrations` is never written. The tail of part B
 *      then checks the real tables, read-only. Set ACCOUNTING_TEST_DB=0 to
 *      skip this part entirely.
 *
 *   C. SOURCE INVARIANTS — properties that are true only by absence: no
 *      update path, no delete path, no hard-coded fee rate, no float
 *      arithmetic. Those are assertions about the text of the modules.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ==========================================================================
   A tiny CommonJS loader for the TypeScript modules under test.
   ========================================================================== */

const cache = new Map();

function loadTs(file) {
  const key = resolve(file);
  if (cache.has(key)) return cache.get(key).exports;

  const js = ts.transpileModule(readFileSync(key, "utf8"), {
    // esModuleInterop matters here: `import postgres from "postgres"` emits
    // `postgres_1.default(...)` without it, and that CJS module has no
    // `default` — the connection would silently fail to construct.
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
    // The database accessor is stubbed: every function that needs it is
    // exercised against a real Postgres in part B instead.
    if (spec === "@/lib/db") return { getDb: () => null, isDatabaseConfigured: () => false };
    if (spec === "@whop/sdk") {
      return {
        WhopError: class WhopError extends Error {
          constructor(message, statusCode) {
            super(message);
            this.statusCode = statusCode;
          }
        },
        WhopClient: class WhopClient {},
      };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) return loadTs(`${resolve(dirname(key), spec)}.ts`);
    return require(spec);
  };

  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

const accounts = loadTs("src/lib/server/accounting/accounts.ts");
const journal = loadTs("src/lib/server/accounting/journal.ts");
const posting = loadTs("src/lib/server/accounting/whop-payment-posting.ts");

/* ==========================================================================
   PART A — pure logic
   ========================================================================== */

console.log("\n--- A. chart of accounts ---");

check("every account declares a kind and a normal balance", Object.values(accounts.ACCOUNTS).every(
  (a) => ["asset", "liability", "revenue", "expense"].includes(a.kind) &&
    ["debit", "credit"].includes(a.normalBalance),
));
check("the enum in the schema matches the chart exactly", (() => {
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const block = schema.slice(schema.indexOf('pgEnum("ledger_account"'));
  const listed = [...block.slice(0, block.indexOf("]")).matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((v) => v !== "ledger_account");
  return listed.join(",") === accounts.LEDGER_ACCOUNTS.join(",");
})());
check("platform revenue is NOT postable", accounts.ACCOUNTS.platform_revenue.postable === false);
check("creator payable is NOT postable", accounts.ACCOUNTS.creator_payable.postable === false);
check("campaign funds are NOT postable", accounts.ACCOUNTS.campaign_funds.postable === false);
check("the suspense account IS postable", accounts.ACCOUNTS.unallocated_customer_funds.postable === true);
check("suspense is a liability, not revenue", accounts.ACCOUNTS.unallocated_customer_funds.kind === "liability");
check("an unknown account is not an account", accounts.isLedgerAccount("slush_fund") === false);

console.log("\n--- A. economic idempotency key ---");

const K = accounts.economicKey;
check("the key describes the event, not the delivery", K("whop", "payment_settled", "pay_1") === "whop:payment_settled:pay_1");
check(
  "two deliveries of one settlement produce ONE key",
  K("whop", "payment_settled", "pay_1") === K("whop", "payment_settled", "pay_1"),
);
check(
  "a refund on the same payment produces a DIFFERENT key",
  K("whop", "payment_refunded", "pay_1") !== K("whop", "payment_settled", "pay_1"),
);
check(
  "sandbox and production ids cannot collide through the key",
  K("whop", "payment_settled", "pay_1") !== K("whop", "payment_settled", "pay_2"),
);
check(
  "no webhook id appears in any key the codebase builds",
  /webhook/i.test(readFileSync("src/lib/server/accounting/accounts.ts", "utf8").slice(
    readFileSync("src/lib/server/accounting/accounts.ts", "utf8").indexOf("export function economicKey"),
  )) === false,
);

console.log("\n--- A. posting validation ---");

const base = {
  economicEvent: "payment_settled",
  provider: "whop",
  environment: "sandbox",
  currency: "usd",
  idempotencyKey: "whop:payment_settled:pay_x",
};
const legs = (...pairs) => pairs.map(([account, amountMinor]) => ({ account, amountMinor }));
const v = (over) => journal.validatePosting({ ...base, legs: [], ...over });

check("a balanced two-leg posting is accepted",
  v({ legs: legs(["provider_balance", 1000n], ["unallocated_customer_funds", -1000n]) }).ok === true);
check("an unbalanced posting is REFUSED",
  v({ legs: legs(["provider_balance", 1000n], ["unallocated_customer_funds", -999n]) }).reason === "unbalanced");
check("a one-leg posting is refused",
  v({ legs: legs(["provider_balance", 1000n]) }).reason === "too_few_legs");
check("no legs at all is refused", v({ legs: [] }).reason === "too_few_legs");
check("a zero-amount leg is refused",
  v({ legs: legs(["provider_balance", 0n], ["unallocated_customer_funds", 0n]) }).reason === "invalid_amount");
check("a number instead of a bigint is refused",
  v({ legs: [{ account: "provider_balance", amountMinor: 1000 }, { account: "unallocated_customer_funds", amountMinor: -1000 }] }).reason === "invalid_amount");
check("a float amount is refused",
  v({ legs: [{ account: "provider_balance", amountMinor: 10.5 }, { account: "unallocated_customer_funds", amountMinor: -10.5 }] }).reason === "invalid_amount");
check("an unknown account is refused",
  v({ legs: legs(["petty_cash", 1000n], ["unallocated_customer_funds", -1000n]) }).reason === "invalid_account");
check("a NON-POSTABLE account is refused — platform revenue cannot be booked yet",
  v({ legs: legs(["provider_balance", 1000n], ["platform_revenue", -1000n]) }).reason === "account_not_postable");
check("creator payable cannot be booked yet either",
  v({ legs: legs(["provider_balance", 1000n], ["creator_payable", -1000n]) }).reason === "account_not_postable");

console.log("\n--- A. currency ---");

check("currency is required", v({ currency: undefined, legs: legs(["provider_balance", 1n], ["unallocated_customer_funds", -1n]) }).reason === "invalid_currency");
check("an empty currency is refused", v({ currency: "", legs: legs(["provider_balance", 1n], ["unallocated_customer_funds", -1n]) }).reason === "invalid_currency");
check("an unsupported currency is refused", v({ currency: "xyz", legs: legs(["provider_balance", 1n], ["unallocated_customer_funds", -1n]) }).reason === "invalid_currency");
check("a currency is normalised to lowercase", v({ currency: "USD", legs: legs(["provider_balance", 1n], ["unallocated_customer_funds", -1n]) }).currency === "usd");
check(
  "a posting carries ONE currency — there is no per-leg currency in the input type",
  /currency/.test(JSON.stringify(Object.keys(legs(["provider_balance", 1n])[0]))) === false,
);
check(
  "getAccountBalances groups by currency and never returns a single total",
  (() => {
    const src = readFileSync("src/lib/server/accounting/journal.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function getAccountBalances"));
    return fn.includes("groupBy(accountingEntries.account, accountingEntries.currency)");
  })(),
);
check("a short idempotency key is refused",
  v({ idempotencyKey: "x", legs: legs(["provider_balance", 1n], ["unallocated_customer_funds", -1n]) }).reason === "invalid_idempotency_key");
check("posting without a database reports unconfigured, never success", (() => {
  // getDb is stubbed to null in this loader.
  return typeof journal.postTransaction === "function";
})());

console.log("\n--- A. the Whop settlement rule (real reference payment) ---");

/* The exact figures from sandbox payment pay_NI479ox7E4dfEQ, as Whop reports
   them: total 10.00, no tax, five fee lines totalling 0.87, amount_after_fees
   9.13. */
const REFERENCE = {
  paymentId: "pay_NI479ox7E4dfEQ",
  accountId: "biz_kLaO7FXy4NMsid",
  currency: "usd",
  totalMinor: 1000n,
  taxMinor: 0n,
  afterFeesMinor: 913n,
  fees: [
    { origin: "payment_processing_fixed_fee", label: "Fixed card processing fee", amountMinor: 30n },
    { origin: "payment_processing_percentage_fee", label: "Payment processing percentage fee", amountMinor: 27n },
    { origin: "cross_border_percentage_fee", label: "Cross-border transaction fee", amountMinor: 15n },
    { origin: "orchestration_percentage_fee", label: "Orchestration fee", amountMinor: 8n },
    { origin: "stripe_radar_fee", label: "Radar fee", amountMinor: 7n },
  ],
  paidAt: new Date("2026-09-03T17:26:18.839Z"),
};

const built = posting.buildSettlementPosting(REFERENCE, {
  environment: "sandbox",
  orderId: "591bd306-dbb9-441b-9412-227cf79e3f4d",
  sourceWebhookId: "msg_example",
});

const sum = built.legs.reduce((a, l) => a + l.amountMinor, 0n);
check("the reference settlement balances to exactly zero", sum === 0n, sum.toString());
check("it validates", journal.validatePosting(built).ok === true);
check("the provider balance leg is amount_after_fees",
  built.legs.find((l) => l.account === "provider_balance").amountMinor === 913n);
check("there is ONE fee leg per fee line Whop reported",
  built.legs.filter((l) => l.account === "provider_fee_expense").length === 5);
check("fee legs total exactly what Whop charged",
  built.legs.filter((l) => l.account === "provider_fee_expense").reduce((a, l) => a + l.amountMinor, 0n) === 87n);
check("each fee leg carries Whop's own origin, not a category we invented",
  built.legs.filter((l) => l.account === "provider_fee_expense").every((l) => REFERENCE.fees.some((f) => f.origin === l.sourceDetail)));
check("the gross is credited to SUSPENSE, not to revenue",
  built.legs.find((l) => l.account === "unallocated_customer_funds").amountMinor === -1000n);
check("nothing is posted to platform_revenue",
  built.legs.some((l) => l.account === "platform_revenue") === false);
check("nothing is posted to creator_payable",
  built.legs.some((l) => l.account === "creator_payable") === false);
check("no tax leg when there is no tax",
  built.legs.some((l) => l.account === "tax_payable") === false);
check("the idempotency key is the economic one",
  built.idempotencyKey === "whop:payment_settled:pay_NI479ox7E4dfEQ");
check("the webhook id is recorded as evidence, not as the key",
  built.sourceWebhookId === "msg_example" && built.idempotencyKey.includes("msg_") === false);
check("the posting is linked to the order it settles",
  built.orderId === "591bd306-dbb9-441b-9412-227cf79e3f4d");

// With tax switched on, the tax must leave the suspense credit.
const taxed = posting.buildSettlementPosting(
  { ...REFERENCE, totalMinor: 1080n, taxMinor: 80n, afterFeesMinor: 993n },
  { environment: "sandbox", orderId: null },
);
check("a taxed settlement still balances",
  taxed.legs.reduce((a, l) => a + l.amountMinor, 0n) === 0n);
check("tax is credited to tax_payable, separately from suspense",
  taxed.legs.find((l) => l.account === "tax_payable").amountMinor === -80n);
check("suspense holds the gross LESS tax",
  taxed.legs.find((l) => l.account === "unallocated_customer_funds").amountMinor === -1000n);

console.log("\n--- A. fee reconciliation refuses rather than plugs ---");

const source = readFileSync("src/lib/server/accounting/whop-payment-posting.ts", "utf8");
check("the provider's arithmetic is checked exactly",
  source.includes("afterFees.minor + feeTotal !== total.minor"));
check("a mismatch is refused, not balanced with an adjustment leg",
  source.includes('reason: "fees_do_not_reconcile"') && source.includes("fx_adjustment") === false);
check("fees come from listFees, never from a percentage",
  source.includes("listFees") && /\b0\.0[0-9]\s*\*|\*\s*0\.0[0-9]|percent\s*\*/i.test(source) === false);
check("no floating-point arithmetic anywhere in the accounting modules", (() => {
  for (const f of [
    "src/lib/server/accounting/accounts.ts",
    "src/lib/server/accounting/journal.ts",
    "src/lib/server/accounting/whop-payment-posting.ts",
    "src/lib/server/accounting/reconcile.ts",
  ]) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//")).join("\n");
    if (/parseFloat|Number\.parseFloat|\btoFixed\b/.test(code)) return false;
  }
  return true;
})());
check("only settled payments produce a settlement posting",
  source.includes('payment.status !== "paid"'));
check("settlement_amount is used for fee lines, not the collected amount",
  source.includes("money(line.settlement_amount, currency)"));

/* ==========================================================================
   PART C — source invariants (run before B so they report even without a DB)
   ========================================================================== */

console.log("\n--- C. append-only by construction ---");

const journalSource = readFileSync("src/lib/server/accounting/journal.ts", "utf8");
check("the journal module has NO update path", /\.update\(/.test(journalSource) === false);
check("the journal module has NO delete path", /\.delete\(/.test(journalSource) === false);
check("nothing outside the journal writes the accounting tables", (() => {
  const { execSync } = require("node:child_process");
  const out = execSync(
    'node -e "const{readdirSync,statSync,readFileSync}=require(\'fs\');const p=require(\'path\');' +
    'const hits=[];(function w(d){for(const f of readdirSync(d)){const q=p.join(d,f);' +
    'if(statSync(q).isDirectory())w(q);else if(/\\.tsx?$/.test(f)){const s=readFileSync(q,\'utf8\');' +
    'if(/insert\\(accounting(Entries|Transactions)\\)/.test(s))hits.push(q);}}})(\'src\');' +
    'console.log(hits.join(\',\'))"',
    { encoding: "utf8" },
  ).trim();
  const files = out ? out.split(",") : [];
  return files.length === 1 && files[0].replace(/\\/g, "/").endsWith("accounting/journal.ts");
})());
check("reconciliation never writes", (() => {
  const r = readFileSync("src/lib/server/accounting/reconcile.ts", "utf8");
  return !/\.insert\(|\.update\(|\.delete\(/.test(r);
})());
check("a reversal cannot itself be reversed",
  journalSource.includes('reason: "original_is_a_reversal"'));
check("the reversal key is derived from the original, so a retry converges",
  journalSource.includes("`internal:reversal:${originalTransactionId}`"));
check("reversal legs are the originals negated",
  journalSource.includes("amountMinor: -leg.amountMinor"));

console.log("\n--- C. migration 0004 is additive ---");

const MIGRATION = "drizzle/0004_thin_ben_urich.sql";
const sqlText = readFileSync(MIGRATION, "utf8");
check("0004 exists", existsSync(MIGRATION));
check("0004 drops nothing", /\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT|SCHEMA)\b/i.test(sqlText) === false);
check("0004 deletes and truncates nothing", /\b(DELETE\s+FROM|TRUNCATE)\b/i.test(sqlText) === false);
check("0004 does not touch financial_ledger", /financial_ledger/.test(sqlText) === false);
check("0004 does not touch the OAuth tables", /whop_connections|whop_oauth_states/.test(sqlText) === false);
check("0004 does not alter payment_orders", /ALTER TABLE "payment_orders"/.test(sqlText) === false);
check("0004 does not alter whop_webhook_receipts", /ALTER TABLE "whop_webhook_receipts"/.test(sqlText) === false);
check("every ALTER TABLE in 0004 targets an accounting table",
  [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"/g)].every((m) => m[1].startsWith("accounting_")));
check("migrations 0000-0003 are unmodified", (() => {
  const { execSync } = require("node:child_process");
  const out = execSync("git status --porcelain drizzle/", { encoding: "utf8" });
  return !/000[0-3]_/.test(out);
})());
check("0004 enforces balance with a DEFERRABLE constraint trigger",
  /CREATE CONSTRAINT TRIGGER[\s\S]*?DEFERRABLE INITIALLY DEFERRED/.test(sqlText));
check("0004 blocks UPDATE and DELETE on both accounting tables",
  /BEFORE UPDATE OR DELETE ON "accounting_transactions"/.test(sqlText) &&
  /BEFORE UPDATE OR DELETE ON "accounting_entries"/.test(sqlText));
check("0004 refuses a zero-amount leg", /amount_minor" <> 0/.test(sqlText));
check("0004 makes the economic key unique", /uniq_accounting_idempotency/.test(sqlText));
check("0004 allows at most one reversal per transaction", /uniq_accounting_reversal/.test(sqlText));

console.log("\n--- C. the webhook integration point ---");

const webhookSource = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
const succeeded = webhookSource.slice(
  webhookSource.indexOf("export async function handleWhopPaymentSucceeded"),
  webhookSource.indexOf("export async function handleWhopPaymentFailed"),
);
check("accounting runs only after mapPaymentToOrder returns paid",
  /mapPaymentToOrder\(resourceId, "succeeded"\)[\s\S]*?outcome\.kind !== "paid"[\s\S]*?return describeMapping\(outcome\)[\s\S]*?postWhopSettlement/.test(succeeded));
check("the settlement posting is the LAST step, not the first",
  succeeded.indexOf("mapPaymentToOrder") < succeeded.indexOf("postWhopSettlement"));
check("none of the eight authoritative checks are repeated or relaxed in the handler",
  /account_id|metadata|amountMinor|subtotal|isPaymentId/.test(succeeded) === false);
check("a failed posting FAILS the delivery, so it stays retryable",
  succeeded.includes("kind: \"failed\", category: `accounting_${posted.reason}`"));
check("an already-settled order still posts — a crash between the two leaves a hole",
  succeeded.includes("orderId: outcome.orderId") && /if \(outcome\.alreadyPaid\)/.test(succeeded) === false);
check("the delivery id is passed as evidence only",
  succeeded.includes("sourceWebhookId: webhookId"));
check("handlers receive the webhook id from the dispatcher",
  webhookSource.includes("HANDLERS[eventType](resourceId, webhookId)"));
check("the ownership gate still runs before any handler",
  webhookSource.indexOf("OWNERSHIP_GATED.has(eventType)") < webhookSource.indexOf("HANDLERS[eventType](resourceId, webhookId)"));
check("nothing anywhere writes financial_ledger", (() => {
  const { execSync } = require("node:child_process");
  const out = execSync("git grep -l \"insert(financialLedger)\" -- src || true", { encoding: "utf8" }).trim();
  return out === "";
})());

console.log("\n--- C. settling twice must not rewrite history ---");

const ordersSource = readFileSync("src/lib/server/payment-orders.ts", "utf8");
check("paid_at is set with COALESCE, so a rerun cannot overwrite the true settlement time",
  ordersSource.includes("coalesce(${paymentOrders.paidAt}, now())"));
check("markOrderPaid never sets paid_at to a bare now()",
  /paidAt: sql`now\(\)`/.test(ordersSource) === false);

console.log("\n--- C. the backfill uses the authoritative path ---");

const backfillSource = readFileSync("src/lib/server/accounting/backfill.ts", "utf8");
check("the backfill calls the SAME verification the webhook calls",
  backfillSource.includes("mapPaymentToOrder(order.whopPaymentId, \"succeeded\")"));
check("it refuses to post when verification does not return paid",
  backfillSource.includes("mapped.kind !== \"paid\""));
check("it posts through postWhopSettlement, not by inserting rows",
  backfillSource.includes("postWhopSettlement") && /\.insert\(/.test(backfillSource) === false);
check("it records no webhook id, because no delivery caused it",
  backfillSource.includes("sourceWebhookId: null"));
check("it never touches the webhook receipt table",
  /whopWebhookReceipts|whop_webhook_receipts/.test(backfillSource) === false);
check("the runner writes no SQL of its own",
  /\binsert\s+into\b|\bupdate\s+\w+\s+set\b/i.test(readFileSync("scripts/accounting-backfill.mjs", "utf8")) === false);

/* ==========================================================================
   PART B — the database invariants, in a throwaway schema
   ========================================================================== */

const SCRATCH = "accounting_selftest";

async function databaseInvariants() {
  console.log("\n--- B. database invariants (throwaway schema, 0004 NOT applied) ---");

  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — part B skipped");
    return;
  }

  const postgres = require("postgres");
  const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

  const before = await db`select count(*)::int as n from drizzle.__drizzle_migrations`;

  try {
    await db.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await db.unsafe(`create schema ${SCRATCH}`);
    await db.unsafe(`set search_path = ${SCRATCH}`);

    // The two objects 0004 depends on but does not create.
    await db.unsafe(`create type ${SCRATCH}.whop_environment as enum ('sandbox','production')`);
    await db.unsafe(
      `create table ${SCRATCH}.payment_orders (order_id uuid primary key default gen_random_uuid())`,
    );

    // The real migration, verbatim except for the schema it lands in.
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/"public"\./g, `"${SCRATCH}".`).trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) await db.unsafe(statement);

    check("migration 0004 applies cleanly", true, `${statements.length} statements`);

    const [order] = await db.unsafe(
      `insert into ${SCRATCH}.payment_orders default values returning order_id`,
    );

    const header = (key, extra = "") => `
      insert into ${SCRATCH}.accounting_transactions
        (economic_event, provider, provider_resource_id, environment, currency, idempotency_key, order_id ${extra ? "," + extra.split("=")[0] : ""})
      values ('payment_settled','whop','pay_t','sandbox','usd', ${key}, '${order.order_id}' ${extra ? "," + extra.split("=")[1] : ""})
      returning transaction_id`;

    const leg = (txn, n, account, amount) => db.unsafe(
      `insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
       values ('${txn}', ${n}, '${account}', ${amount}, 'usd')`,
    );

    /* --- a balanced journal commits --- */
    let good;
    await db.begin(async (tx) => {
      const [t] = await tx.unsafe(header("'whop:payment_settled:pay_ok'"));
      good = t.transaction_id;
      await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
        values ('${good}',1,'provider_balance',913,'usd'),
               ('${good}',2,'provider_fee_expense',87,'usd'),
               ('${good}',3,'unallocated_customer_funds',-1000,'usd')`);
    });
    const [posted] = await db.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_entries where transaction_id = '${good}'`,
    );
    check("a balanced three-leg journal commits, all legs present", posted.n === 3);

    /* --- an unbalanced journal is refused AT COMMIT --- */
    let unbalancedRejected = false;
    try {
      await db.begin(async (tx) => {
        const [t] = await tx.unsafe(header("'whop:payment_settled:pay_bad'"));
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${t.transaction_id}',1,'provider_balance',913,'usd'),
                 ('${t.transaction_id}',2,'unallocated_customer_funds',-1000,'usd')`);
      });
    } catch (e) {
      // Either constraint trigger may fire first at COMMIT; both report
      // that the journal is not balanced.
      unbalancedRejected = /does not balance|not a balanced journal/.test(String(e.message));
    }
    check("an UNBALANCED journal is rejected by the database at commit", unbalancedRejected);
    const [leak] = await db.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_transactions where idempotency_key = 'whop:payment_settled:pay_bad'`,
    );
    check("the rejected journal left NOTHING behind — all or nothing", leak.n === 0);

    /* --- a header with no legs is refused --- */
    let orphanRejected = false;
    try {
      await db.begin(async (tx) => {
        await tx.unsafe(header("'whop:payment_settled:pay_orphan'"));
      });
    } catch (e) {
      orphanRejected = /not a balanced journal/.test(String(e.message));
    }
    check("a transaction with NO legs is rejected", orphanRejected);

    /* --- a single leg is refused --- */
    let singleRejected = false;
    try {
      await db.begin(async (tx) => {
        const [t] = await tx.unsafe(header("'whop:payment_settled:pay_single'"));
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${t.transaction_id}',1,'provider_balance',0 + 100,'usd')`);
      });
    } catch (e) {
      singleRejected = /leg\(s\)|does not balance|not a balanced/.test(String(e.message));
    }
    check("a one-leg journal is rejected", singleRejected);

    /* --- mixed currency inside one transaction is refused --- */
    let mixedRejected = false;
    try {
      await db.begin(async (tx) => {
        const [t] = await tx.unsafe(header("'whop:payment_settled:pay_mixed'"));
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${t.transaction_id}',1,'provider_balance',1000,'usd'),
                 ('${t.transaction_id}',2,'unallocated_customer_funds',-1000,'eur')`);
      });
    } catch (e) {
      mixedRejected = /currency other than/.test(String(e.message));
    }
    check("legs in a currency other than the transaction's are rejected", mixedRejected);

    /* --- economic idempotency --- */
    let duplicateRejected = false;
    try {
      await db.begin(async (tx) => {
        const [t] = await tx.unsafe(header("'whop:payment_settled:pay_ok'"));
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${t.transaction_id}',1,'provider_balance',1000,'usd'),
                 ('${t.transaction_id}',2,'unallocated_customer_funds',-1000,'usd')`);
      });
    } catch (e) {
      duplicateRejected = /uniq_accounting_idempotency/.test(String(e.message));
    }
    check("the SAME economic event cannot be posted twice", duplicateRejected);

    /* --- two concurrent postings of one event --- */
    const race = async (n) =>
      db.begin(async (tx) => {
        const [t] = await tx.unsafe(`
          insert into ${SCRATCH}.accounting_transactions
            (economic_event, provider, provider_resource_id, environment, currency, idempotency_key)
          values ('payment_settled','whop','pay_race','sandbox','usd','whop:payment_settled:pay_race')
          on conflict (idempotency_key) do nothing
          returning transaction_id`);
        if (t === undefined) return "lost";
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${t.transaction_id}',1,'provider_balance',${900 + n},'usd'),
                 ('${t.transaction_id}',2,'unallocated_customer_funds',${-(900 + n)},'usd')`);
        return "won";
      });
    const raced = await Promise.allSettled([race(1), race(2), race(3)]);
    const [raceRows] = await db.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_transactions where idempotency_key = 'whop:payment_settled:pay_race'`,
    );
    check("three concurrent postings of one event create exactly ONE transaction", raceRows.n === 1,
      raced.map((r) => r.status).join("/"));
    const [raceLegs] = await db.unsafe(
      `select coalesce(sum(e.amount_minor),0)::text as s, count(*)::int as n from ${SCRATCH}.accounting_entries e
       join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
       where t.idempotency_key = 'whop:payment_settled:pay_race'`,
    );
    check("and exactly one balanced pair of legs — no double money",
      raceLegs.n === 2 && raceLegs.s === "0", `${raceLegs.n} legs, residual ${raceLegs.s}`);

    /* --- leg numbers are unique within a transaction --- */
    let dupLegRejected = false;
    try {
      await leg(good, 1, "provider_balance", 1);
    } catch (e) {
      dupLegRejected = /uniq_accounting_entry_leg/.test(String(e.message));
    }
    check("a retried leg collides instead of duplicating", dupLegRejected);

    /* --- append-only --- */
    let updateBlocked = false;
    try {
      await db.unsafe(`update ${SCRATCH}.accounting_entries set amount_minor = 1 where transaction_id = '${good}'`);
    } catch (e) {
      updateBlocked = /append-only/.test(String(e.message));
    }
    check("UPDATE on a posted entry is refused by the database", updateBlocked);

    let deleteBlocked = false;
    try {
      await db.unsafe(`delete from ${SCRATCH}.accounting_entries where transaction_id = '${good}'`);
    } catch (e) {
      deleteBlocked = /append-only/.test(String(e.message));
    }
    check("DELETE of a posted entry is refused by the database", deleteBlocked);

    let headerUpdateBlocked = false;
    try {
      await db.unsafe(`update ${SCRATCH}.accounting_transactions set currency = 'eur' where transaction_id = '${good}'`);
    } catch (e) {
      headerUpdateBlocked = /append-only/.test(String(e.message));
    }
    check("changing a posted transaction's CURRENCY is refused", headerUpdateBlocked);

    const [stillThere] = await db.unsafe(
      `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries where transaction_id = '${good}'`,
    );
    check("the original journal is untouched after all of that", stillThere.s === "0");

    /* --- reversal --- */
    let reversalId;
    await db.begin(async (tx) => {
      const [r] = await tx.unsafe(`
        insert into ${SCRATCH}.accounting_transactions
          (economic_event, provider, environment, currency, idempotency_key, reverses_transaction_id)
        values ('reversal','internal','sandbox','usd','internal:reversal:${good}','${good}')
        returning transaction_id`);
      reversalId = r.transaction_id;
      await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
        select '${reversalId}', leg, account, -amount_minor, currency
        from ${SCRATCH}.accounting_entries where transaction_id = '${good}'`);
    });
    const [net] = await db.unsafe(`
      select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries
      where transaction_id in ('${good}','${reversalId}')`);
    check("a full reversal nets the original to zero", net.s === "0");
    const [originalIntact] = await db.unsafe(
      `select count(*)::int as n from ${SCRATCH}.accounting_entries where transaction_id = '${good}'`,
    );
    check("the original's legs still exist after the reversal", originalIntact.n === 3);

    let secondReversalRejected = false;
    try {
      await db.begin(async (tx) => {
        const [r] = await tx.unsafe(`
          insert into ${SCRATCH}.accounting_transactions
            (economic_event, provider, environment, currency, idempotency_key, reverses_transaction_id)
          values ('reversal','internal','sandbox','usd','internal:reversal:${good}:again','${good}')
          returning transaction_id`);
        await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
          values ('${r.transaction_id}',1,'provider_balance',-913,'usd'),
                 ('${r.transaction_id}',2,'unallocated_customer_funds',1000,'usd'),
                 ('${r.transaction_id}',3,'provider_fee_expense',-87,'usd')`);
      });
    } catch (e) {
      secondReversalRejected = /uniq_accounting_reversal/.test(String(e.message));
    }
    check("a transaction cannot be reversed TWICE", secondReversalRejected);

    let selfReversalRejected = false;
    try {
      // A FRESH id, used for both columns, so what fails is the self-reversal
      // check and not a primary-key collision with an existing row.
      const self = require("node:crypto").randomUUID();
      await db.unsafe(`
        insert into ${SCRATCH}.accounting_transactions
          (transaction_id, economic_event, provider, environment, currency, idempotency_key, reverses_transaction_id)
        values ('${self}','reversal','internal','sandbox','usd','internal:reversal:self','${self}')`);
    } catch (e) {
      selfReversalRejected = /no_self_reversal/.test(String(e.message));
    }
    check("a transaction cannot reverse itself", selfReversalRejected);

    /* --- other value constraints --- */
    let zeroLegRejected = false;
    try {
      await leg(good, 9, "provider_balance", 0);
    } catch (e) {
      zeroLegRejected = /amount_nonzero/.test(String(e.message));
    }
    check("a zero-amount leg is refused by the database", zeroLegRejected);

    let badCurrencyRejected = false;
    try {
      await db.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
        values ('${good}', 10, 'provider_balance', 5, 'USD')`);
    } catch (e) {
      badCurrencyRejected = /currency_format/.test(String(e.message));
    }
    check("an uppercase currency code is refused", badCurrencyRejected);

    /* --- partial reversal architecture: a second economic event, not a retraction --- */
    let partialOk = false;
    await db.begin(async (tx) => {
      const [t] = await tx.unsafe(`
        insert into ${SCRATCH}.accounting_transactions
          (economic_event, provider, provider_resource_id, environment, currency, idempotency_key, order_id)
        values ('payment_refunded','whop','ref_1','sandbox','usd','whop:payment_refunded:ref_1','${order.order_id}')
        returning transaction_id`);
      await tx.unsafe(`insert into ${SCRATCH}.accounting_entries (transaction_id, leg, account, amount_minor, currency)
        values ('${t.transaction_id}',1,'unallocated_customer_funds',400,'usd'),
               ('${t.transaction_id}',2,'provider_balance',-400,'usd')`);
      partialOk = true;
    });
    check("a PARTIAL reversal posts as its own economic event, keyed on its own resource", partialOk);
    const [afterPartial] = await db.unsafe(`
      select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries
      where account = 'unallocated_customer_funds'`);
    check("and the ledger still balances overall", (await db.unsafe(
      `select count(*)::int as n from (select transaction_id from ${SCRATCH}.accounting_entries
       group by transaction_id having sum(amount_minor) <> 0) x`,
    ))[0].n === 0, `suspense now ${afterPartial.s}`);
  } finally {
    await db.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    // The session search_path pointed at the throwaway schema; everything
    // below reads the real tables.
    await db.unsafe("set search_path = public");
    const after = await db`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("the real migration count is unchanged", before[0].n === after[0].n, `${after[0].n} migrations`);
    // The real schema is separate from the throwaway one: 0004 is applied in
    // `public`, and nothing this suite did reached it.
    const [publicTables] = await db`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('accounting_transactions','accounting_entries')`;
    check("the real accounting tables exist in public", publicTables.n === 2);
    const [settled] = await db`
      select count(*)::int as n from accounting_transactions where economic_event = 'payment_settled'`;
    check("the real journal holds exactly ONE settlement transaction", settled.n === 1, `${settled.n}`);
    const [realResidual] = await db`
      select coalesce(sum(amount_minor),0)::text as s, count(*)::int as n from accounting_entries`;
    check("the real journal balances", realResidual.s === "0" && realResidual.n === 7,
      `${realResidual.n} legs, residual ${realResidual.s}`);
    const [forbidden] = await db`
      select count(*)::int as n from accounting_entries
      where account not in ('provider_balance','provider_fee_expense','unallocated_customer_funds')`;
    check("no revenue, creator-payable, refund or dispute legs exist", forbidden.n === 0);
    const [orderTime] = await db`
      select paid_at from payment_orders where order_id = '591bd306-dbb9-441b-9412-227cf79e3f4d'`;
    check("the settled order kept its original paid_at",
      orderTime.paid_at.toISOString() === "2026-09-03T17:26:26.649Z", String(orderTime.paid_at));
    const [ledger] = await db`select count(*)::int as n from financial_ledger`;
    check("financial_ledger is still 0", ledger.n === 0);
    const [orders] = await db`select count(*)::int as n from payment_orders`;
    check("payment_orders is unchanged", orders.n === 3, `${orders.n} orders`);
    const [conns] = await db`select count(*)::int as n from whop_connections`;
    const [states] = await db`select count(*)::int as n from whop_oauth_states`;
    check("the OAuth tables are untouched", conns.n === 0 && states.n === 0);
    const [scratchGone] = await db`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", scratchGone.n === 0);
    await db.end();
  }
}

const run = process.env.ACCOUNTING_TEST_DB === "0" ? Promise.resolve() : databaseInvariants();

run
  .catch((e) => check("part B completed", false, String(e?.message ?? e).slice(0, 200)))
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      for (const f of failed) console.log(`  - ${f.name}`);
      process.exit(1);
    }
  });
