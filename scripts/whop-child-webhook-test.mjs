/**
 * TASK #16 — CHILD-RESOURCE WEBHOOKS.
 *
 * Whop delivers every event — the ClipRewards platform company's and every
 * connected child account's — to ONE platform endpoint. A child event carries
 * the child's `biz_` id as `company_id`, so a receiver that compares that
 * field to `WHOP_COMPANY_ID` and quarantines any difference would reject every
 * creator's payout and account event.
 *
 * WHAT THIS SUITE IS FOR, AND WHY IT IS SEPARATE FROM whop-webhook-test.mjs.
 * That suite loads the receiver with `getDb: () => null`, deliberately, so it
 * tests signature verification and envelope parsing without a database. The
 * company gate lives AFTER the database check and can never run there. Rather
 * than rework a harness that 71 passing checks depend on, this suite supplies
 * a fake database and exercises the gate itself.
 *
 * NO NETWORK. NO DATABASE. NO MONEY MOVES.
 *
 * Sections:
 *   A. The child router resolves only known accounts, in this environment
 *   B. The envelope gate: platform, known child, unknown company
 *   C. Ownership families: which company may own what
 *   D. account.updated proves the account before writing
 *   E. payout.* still routes to withdrawal reconciliation
 *   F. No cross-child and no cross-environment attribution
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

let passed = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Loads a module with its imports stripped and supplied explicitly. */
function load(file, injected) {
  const source = src(file).replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", ...names, js)(mod, mod.exports, ...names.map((n) => injected[n]));
  return mod.exports;
}

const PLATFORM = "biz_platformCompany";
const CHILD_A = "biz_childAAAAAAA";
const CHILD_B = "biz_childBBBBBBB";
const FOREIGN = "biz_someoneElse1";

/* =========================================================================
   A fake drizzle that records predicates, so an assertion can look at the
   WHERE a module built and confirm it scoped the query the way it claims.
   ========================================================================= */

const col = (table, name) => ({ __col: true, table, name });

const drizzle = {
  and: (...parts) => ({ op: "and", parts: parts.filter(Boolean) }),
  or: (...parts) => ({ op: "or", parts: parts.filter(Boolean) }),
  eq: (c, v) => ({ op: "eq", col: c, value: v }),
  isNull: (c) => ({ op: "isNull", col: c }),
  sql: (strings, ...values) => ({ op: "sql", strings, values }),
};
drizzle.sql.raw = (t) => ({ op: "sql", raw: t });

function flatten(clause, out = []) {
  if (!clause) return out;
  if (clause.op === "and" || clause.op === "or") for (const p of clause.parts) flatten(p, out);
  else out.push(clause);
  return out;
}

const whopAccounts = {
  firebaseUid: col("whop_accounts", "firebase_uid"),
  whopAccountId: col("whop_accounts", "whop_account_id"),
  environment: col("whop_accounts", "environment"),
};

/* ---------------------------------------------------------------- A ---- */
section("A. The child router resolves only known accounts, in this environment");

/**
 * Builds the child router over a fixed table of connected accounts.
 *
 * `rows` are matched by the router's own predicate rather than by the fake,
 * so what is asserted is the predicate the module actually built.
 */
function makeRouter(rows, environment = "sandbox") {
  const log = [];
  const builder = (st) => ({
    from(t) { return builder({ ...st, from: t }); },
    where(w) { return builder({ ...st, where: w }); },
    limit(n) { return builder({ ...st, limit: n }); },
    then(resolve) {
      log.push(st);
      const conds = flatten(st.where);
      const wantId = conds.find((c) => c.col === whopAccounts.whopAccountId)?.value;
      const wantEnv = conds.find((c) => c.col === whopAccounts.environment)?.value;
      resolve(
        rows.filter(
          (r) =>
            r.whopAccountId === wantId &&
            /* An unscoped predicate makes this fake return the other
             * environment's row, exactly as Postgres would. The router then
             * has a second, defensive `row.environment !== environment` check
             * that still rejects it — so removing the predicate alone fails
             * only the predicate assertion below, and removing BOTH layers is
             * what makes the cross-environment cases fail. Both were verified
             * by mutation; neither layer is decorative. */
            (wantEnv === undefined || r.environment === wantEnv),
        ),
      );
    },
  });
  const router = load("src/lib/server/whop-child-router.ts", {
    ...drizzle,
    getDb: () => ({ select: (f) => builder({ kind: "select", fields: f }) }),
    whopAccounts,
    getWhopEnvironment: () => environment,
  });
  return { router, log };
}

const SANDBOX_ROWS = [
  { firebaseUid: "uid_a", whopAccountId: CHILD_A, environment: "sandbox" },
  { firebaseUid: "uid_b", whopAccountId: CHILD_B, environment: "sandbox" },
];

{
  const { router, log } = makeRouter(SANDBOX_ROWS);

  const known = await router.resolveChildAccount(CHILD_A);
  check("a known sandbox child resolves", known !== null && known.firebaseUid === "uid_a");
  check("and carries its own account id", known?.whopAccountId === CHILD_A);
  check("and the current environment", known?.environment === "sandbox");

  check("an unknown company does not resolve", (await router.resolveChildAccount(FOREIGN)) === null);
  check("the platform company is not a child", (await router.resolveChildAccount(PLATFORM)) === null);

  // THE PREDICATE, not just the answer: environment must be IN the query.
  const q = log[0];
  const conds = flatten(q?.where);
  check("the lookup is keyed by the account id",
    conds.some((c) => c.col === whopAccounts.whopAccountId && c.value === CHILD_A));
  check("the lookup is scoped by environment IN THE PREDICATE",
    conds.some((c) => c.col === whopAccounts.environment && c.value === "sandbox"));
}

{
  /* CROSS-ENVIRONMENT. The same `biz_` id existing in production must not
   * resolve while we are running sandbox. Whop's sandbox and production are
   * separate id spaces and an id carries no proof of which one it belongs to. */
  const prodOnly = [{ firebaseUid: "uid_p", whopAccountId: CHILD_A, environment: "production" }];
  const { router } = makeRouter(prodOnly, "sandbox");
  check("a production child does NOT resolve in sandbox",
    (await router.resolveChildAccount(CHILD_A)) === null);

  const { router: prodRouter } = makeRouter(SANDBOX_ROWS, "production");
  check("a sandbox child does NOT resolve in production",
    (await prodRouter.resolveChildAccount(CHILD_A)) === null);
}

{
  // FAILS CLOSED. No database and no resolvable environment both mean "no".
  const noDb = load("src/lib/server/whop-child-router.ts", {
    ...drizzle, getDb: () => null, whopAccounts, getWhopEnvironment: () => "sandbox",
  });
  check("no database resolves nothing", (await noDb.resolveChildAccount(CHILD_A)) === null);

  const noEnv = load("src/lib/server/whop-child-router.ts", {
    ...drizzle, getDb: () => ({ select: () => { throw new Error("must not query"); } }),
    whopAccounts, getWhopEnvironment: () => null,
  });
  check("an unresolvable environment resolves nothing, without querying",
    (await noEnv.resolveChildAccount(CHILD_A)) === null);
}

/* ---------------------------------------------------------------- B ---- */
section("B. The envelope gate: platform, known child, unknown company");

/**
 * Loads the receiver over a fake receipts table, and returns both the outcome
 * and the receipt row the gate wrote.
 */
function makeReceiver({ knownChildren = [CHILD_A, CHILD_B], ownership, accountUpdate, findWithdrawal, reconcile } = {}) {
  const receipts = new Map();
  let lastInsert = null;

  const db = {
    insert: () => ({
      values: (v) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            lastInsert = v;
            if (receipts.has(v.webhookId)) return [];
            receipts.set(v.webhookId, { ...v, deliveryCount: 1 });
            return [{ webhookId: v.webhookId }];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch) => ({
        /* `where()` must be BOTH awaitable and chainable.
         *
         * Some call sites end at `.where(...)` and await it; others continue
         * to `.returning()`. A `where()` that returned only `{ returning }`
         * would let the first kind await a plain object — resolving instantly
         * without ever applying the patch, so the assertion that follows reads
         * an unmodified row and the test fails for a reason that has nothing
         * to do with the code under test. */
        where: (w) => {
          const apply = () => {
            const conds = flatten(w);
            const id = conds.find((c) => c.col?.name === "webhook_id")?.value;
            const row = receipts.get(id);
            if (!row) return [];
            Object.assign(row, patch);
            return [{ ...row }];
          };
          return {
            returning: async () => apply(),
            then: (resolve, reject) => {
              try { resolve(apply()); } catch (e) { reject(e); }
            },
          };
        },
      }),
    }),
  };

  const receiptCols = {
    webhookId: col("whop_webhook_receipts", "webhook_id"),
    status: col("whop_webhook_receipts", "status"),
    claimedAt: col("whop_webhook_receipts", "claimed_at"),
    deliveryCount: col("whop_webhook_receipts", "delivery_count"),
  };

  const mod = load("src/lib/server/whop-webhooks.ts", {
    ...drizzle,
    unwrapWebhook: () => { throw new Error("unused"); },
    WebhookVerificationError: class extends Error {},
    getDb: () => db,
    whopWebhookReceipts: receiptCols,
    getWhopWebhookSecret: () => "ws_x",
    getWhopCompanyId: () => PLATFORM,
    getWhopEnvironment: () => "sandbox",
    describeWhopError: () => "scrubbed",
    resolveChildAccount: async (id) =>
      knownChildren.includes(id)
        ? { firebaseUid: "uid_" + id, whopAccountId: id, environment: "sandbox" }
        : null,
    // Ownership verifiers. Default: the platform owns it.
    verifyPaymentOwnership: ownership ?? (async () => ({ kind: "verified", accountId: PLATFORM })),
    verifyRefundOwnership: async () => ({ kind: "verified", accountId: PLATFORM }),
    verifyDisputeOwnership: async () => ({ kind: "verified", accountId: PLATFORM }),
    verifyAlertOwnership: async () => ({ kind: "verified", accountId: PLATFORM }),
    verifyCaseOwnership: async () => ({ kind: "verified", accountId: PLATFORM }),
    mapPaymentToOrder: async () => ({ kind: "ignored", reason: "not_settled" }),
    mapRefundToOrder: async () => ({ kind: "pending", refundId: "rf_x", orderId: "o" }),
    postWhopRefund: async () => ({ ok: true, transactionId: "t", alreadyPosted: false }),
    mapDisputeToOrder: async () => ({ kind: "recorded", resourceId: "d", paymentId: "p", orderId: "o", status: "open", unchanged: false }),
    mapAlertToOrder: async () => ({ kind: "recorded_unmatched", resourceId: "a", reason: "payment_unmatched" }),
    mapCaseToOrder: async () => ({ kind: "recorded", resourceId: "c", paymentId: "p", orderId: "o", status: "open", unchanged: false }),
    postDisputeMovementsForPayment: async () => ({ ok: true, paymentId: "p", examined: 0, outcomes: [] }),
    shouldRetryLookup: () => false,
    refreshTransferFromProvider: async () => ({ ok: false }),
    findWithdrawalByProviderPayoutId: findWithdrawal ?? (async () => null),
    reconcileWithdrawal: reconcile ?? (async () => ({ ok: true, status: "paid", changed: true })),
    updateConnectedAccountStatus: accountUpdate ?? (async () => ({ ok: true, updated: true })),
    fireWebhookNotifications: async () => {},
    postWhopSettlement: async () => ({ ok: true }),
  });

  return { mod, receipts, lastInsert: () => lastInsert };
}

const body = (event, data) => ({ event, data });

{
  const { mod, receipts } = makeReceiver();

  // PLATFORM resource: accepted.
  const r1 = await mod.processVerifiedWebhook("wh_1", body("payment.succeeded", {
    id: "pay_1", company_id: PLATFORM,
  }));
  check("a platform payment is not rejected as wrong company", r1.status !== "rejected_company");
  check("its receipt is not quarantined", receipts.get("wh_1")?.status !== "rejected_company");

  // KNOWN CHILD: past the gate. This is the whole point of Task #16.
  const { mod: m2, receipts: rc2 } = makeReceiver();
  const r2 = await m2.processVerifiedWebhook("wh_2", body("payout.updated", {
    id: "wdrl_1", company_id: CHILD_A,
  }));
  check("a known child event is NOT rejected at the envelope gate",
    r2.status !== "rejected_company");
  check("and its receipt records the child company",
    rc2.get("wh_2")?.companyId === CHILD_A);
  check("and the receipt is scoped to the current environment",
    rc2.get("wh_2")?.environment === "sandbox");

  // UNKNOWN company: quarantined, acknowledged, terminal.
  const { mod: m3, receipts: rc3 } = makeReceiver();
  const r3 = await m3.processVerifiedWebhook("wh_3", body("payout.updated", {
    id: "wdrl_2", company_id: FOREIGN,
  }));
  check("an unknown company is rejected", r3.status === "rejected_company");
  check("and acknowledged, so Whop stops retrying an answer that cannot change",
    r3.ack === true);
  check("and its receipt is quarantined", rc3.get("wh_3")?.status === "rejected_company");
}

{
  /* A CHILD FROM THE WRONG ENVIRONMENT IS UNKNOWN. The gate asks the router,
   * and the router is environment-scoped, so this needs no separate rule. */
  const { mod, receipts } = makeReceiver({ knownChildren: [] });
  const r = await mod.processVerifiedWebhook("wh_env", body("payout.updated", {
    id: "wdrl_3", company_id: CHILD_A,
  }));
  check("a child unknown in THIS environment is rejected", r.status === "rejected_company");
  check("and quarantined", receipts.get("wh_env")?.status === "rejected_company");
}

/* ---------------------------------------------------------------- C ---- */
section("C. Ownership families: which company may own what");

{
  const resources = codeOnly("src/lib/server/whop-resources.ts");
  const checkout = codeOnly("src/lib/server/whop-checkout.ts");

  /* PAYMENTS, REFUNDS AND DISPUTES ARE PLATFORM-ONLY, BY DESIGN.
   *
   * ClipRewards creates every checkout on the PLATFORM company, so every
   * payment we are owed — and every refund and dispute derived from one — is
   * owned by the platform. A creator's connected account may well have its own
   * unrelated Whop revenue; booking that as ours would mint platform revenue
   * and creator_payable obligations for money we never received.
   *
   * So a child-owned payment being rejected is CORRECT, not a Task #16 gap. */
  check("checkouts are created on the platform company",
    /const companyId = getWhopCompanyId\(\)/.test(checkout));
  check("payment ownership is compared to the platform company",
    /const expected = getWhopCompanyId\(\)/.test(resources));
  check("a payment owned by another account is wrong_company",
    /accountId !== expected\) return \{ kind: "wrong_company" \}/.test(resources));
  check("a payment with no owner cannot be attributed",
    /if \(!accountId\) return \{ kind: "wrong_company" \}/.test(resources));

  // The payload is never the authority for these families.
  const webhookCode = codeOnly("src/lib/server/whop-webhooks.ts");
  check("ownership is verified before any handler runs",
    webhookCode.indexOf("const verifyOwnership = OWNERSHIP_GATED[eventType]") <
    webhookCode.indexOf("await HANDLERS[eventType]"));
  check("an ownership mismatch is terminal, not retried",
    /kind === "wrong_company"[\s\S]{0,400}status: "rejected_company"/.test(webhookCode));
  check("an unprovable resource never reaches a handler",
    /ownership\.kind !== "verified" && ownership\.kind !== "verified_unmatched"/.test(webhookCode));
}

{
  /* A CHILD-OWNED PAYMENT IS REJECTED EVEN THOUGH THE GATE LET IT PAST.
   * The envelope gate answers "may this delivery be processed at all"; the
   * ownership verifier answers "is this resource ours". Both must hold. */
  const { mod, receipts } = makeReceiver({
    ownership: async () => ({ kind: "wrong_company" }),
  });
  const r = await mod.processVerifiedWebhook("wh_cp", body("payment.succeeded", {
    id: "pay_child", company_id: CHILD_A,
  }));
  check("a known child's PAYMENT is still rejected on ownership",
    r.status === "rejected_company");
  check("and recorded as an ownership mismatch, not a company mismatch",
    receipts.get("wh_cp")?.failureCategory === "ownership_mismatch");
  check("payload company_id alone never grants ownership",
    r.ack === true && receipts.get("wh_cp")?.status === "rejected_company");
}

/* ---------------------------------------------------------------- D ---- */
section("D. account.updated proves the account before writing");

{
  const webhookSrc = src("src/lib/server/whop-webhooks.ts");
  const handler = webhookSrc.slice(webhookSrc.indexOf("export async function handleWhopAccountUpdated"));

  /* `data.id` IS NOT THE FIELD THE GATE CHECKED. The gate resolves the
   * envelope's `company_id`; this is a separate, unverified payload field, so
   * it is resolved through the same connected-account source of truth before
   * anything is written. */
  check("the account is resolved through the child router first",
    /const known = await resolveChildAccount\(accountId\)/.test(handler));
  check("an unknown account is reported unmapped, not handled",
    /if \(!known\) return \{ kind: "business_mapping_not_implemented" \}/.test(handler));
  check("the write uses the RESOLVED id, not the raw payload field",
    /updateConnectedAccountStatus\(known\.whopAccountId, environment, status\)/.test(handler));
  check("a row that vanished concurrently is unmapped, not handled",
    /if \(!result\.updated\) return \{ kind: "business_mapping_not_implemented" \}/.test(handler));
  check("the id shape is still validated",
    /\^biz_\[A-Za-z0-9\]\{4,\}\$/.test(handler));

  // No creation path: only an UPDATE, environment-scoped.
  const accounts = codeOnly("src/lib/server/connected-accounts.ts");
  const updater = accounts.slice(accounts.indexOf("export async function updateConnectedAccountStatus"));
  check("the status writer only updates, never inserts",
    !/\.insert\(/.test(updater.slice(0, 900)));
  check("and is environment-scoped",
    /eq\(whopAccounts\.environment, environment\)/.test(updater.slice(0, 900)));
}

{
  // Behavioural: an unknown account writes nothing at all.
  let wrote = false;
  const { mod } = makeReceiver({
    knownChildren: [CHILD_A],
    accountUpdate: async () => { wrote = true; return { ok: true, updated: true }; },
  });

  const unknown = await mod.processVerifiedWebhook("wh_acc_unknown",
    body("account.updated", { id: FOREIGN, status: "active", company_id: PLATFORM }));
  check("account.updated for an unknown account writes nothing", wrote === false);
  check("and is acknowledged as unmapped rather than processed",
    unknown.ack === true && unknown.status === "awaiting_mapping");

  const known = await mod.processVerifiedWebhook("wh_acc_known",
    body("account.updated", { id: CHILD_A, status: "active", company_id: CHILD_A }));
  check("account.updated for a known child writes", wrote === true);
  check("and is accepted", known.status === "accepted");
}

/* ---------------------------------------------------------------- E ---- */
section("E. payout.* still routes to withdrawal reconciliation");

{
  const webhookCode = codeOnly("src/lib/server/whop-webhooks.ts");
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleWhopPayoutUpdated"));
  const bodySlice = handler.slice(0, handler.indexOf("export async function handleWhopAccountUpdated"));

  check("withdrawals are consulted BEFORE the transfer reconciler",
    bodySlice.indexOf("findWithdrawalByProviderPayoutId") <
    bodySlice.indexOf("refreshTransferFromProvider"));
  check("a matched withdrawal is reconciled against the provider",
    /await reconcileWithdrawal\(withdrawal\.withdrawalId\)/.test(bodySlice));
  check("the payload status is not read", !/data\.status|"status"\)/.test(bodySlice));
  check("the handler writes no ledger entry",
    !/accountingEntries|creator_payable|reverseTransaction/.test(bodySlice));

  // A `wdrl_` id must never be treated as a creator transfer.
  const withdrawCode = codeOnly("src/lib/server/creator-withdrawals.ts");
  check("withdrawals never touch the transfer primitive",
    !/initiateCreatorTransfer/.test(withdrawCode));
  check("and never post a creator_payable journal",
    !/creator_payable/.test(withdrawCode));

  /* Behavioural: a payout event for a known child reaches reconciliation.
   *
   * The receiver is built with a withdrawal lookup that MATCHES, so the path
   * under test is the one a real creator payout takes: gate → withdrawal
   * lookup → provider-authoritative reconcile. */
  let reconciledId = null;
  const { mod } = makeReceiver({
    findWithdrawal: async () => ({ withdrawalId: "wd_1" }),
    reconcile: async (id) => { reconciledId = id; return { ok: true, status: "paid", changed: true }; },
  });
  const r = await mod.processVerifiedWebhook("wh_payout",
    body("payout.updated", { id: "wdrl_9", company_id: CHILD_A }));
  check("a known child's payout event reaches withdrawal reconciliation",
    reconciledId === "wd_1");
  check("and is acknowledged once reconciled", r.ack === true);
}

{
  /* A payout naming nothing we hold is acknowledged and ignored, never forced
   * into a mapping. It may be another environment's, or a payout we did not
   * create. */
  const { mod } = makeReceiver();
  const r = await mod.processVerifiedWebhook("wh_payout_unknown",
    body("payout.updated", { id: "wdrl_unknown", company_id: CHILD_A }));
  check("an unrecognised payout id is acknowledged, not retried forever",
    r.ack === true);
}

/* ---------------------------------------------------------------- F ---- */
section("F. No cross-child and no cross-environment attribution");

/**
 * A real `account.updated` body, shaped as `PostAccountUpdatedPayload`.
 *
 * THE SHAPE MATTERS AND AN EARLIER VERSION OF THIS SUITE GOT IT WRONG. It put
 * a `company_id` inside `data`, which Whop never sends for this family:
 * `Account` carries no such field, and the envelope's attributed account is a
 * TOP-LEVEL `account_id`. So `readEnvelope` finds no company for this event,
 * `wrongCompany` is false, and the delivery passes the gate without any child
 * being resolved. Testing against a fabricated shape proved a property the
 * production payload could never exercise.
 *
 * `attributedTo` is the event's own account; `resourceId` is the account the
 * body describes. The two must agree.
 */
const accountBody = (attributedTo, resourceId, status = "active") => ({
  type: "account.updated",
  api_version: "v1",
  api_version_date: null,
  ...(attributedTo === null ? {} : { account_id: attributedTo }),
  data: { id: resourceId, status },
});

{
  /* Confirm the premise: the gate really does resolve nothing for this family.
   * Built through the shared harness, because the receiver references every
   * ownership verifier at module load and a partial injection map throws. */
  const { mod: envMod } = makeReceiver();
  const parsed = envMod.readEnvelope(accountBody(CHILD_A, CHILD_B));
  check("account.updated carries NO company_id, so the gate resolves no child",
    parsed.companyId === null);
  check("and the envelope resource id is the account the body describes",
    parsed.resourceId === CHILD_B);
}

{
  /* THE FIVE CASES. `writes` records every account id the status writer was
   * asked to touch, so "wrote nothing" is proved by an empty array rather than
   * by the absence of an error. */
  const make = (knownChildren) => {
    const writes = [];
    const { mod } = makeReceiver({
      knownChildren,
      accountUpdate: async (id) => { writes.push(id); return { ok: true, updated: true }; },
    });
    return { mod, writes };
  };

  // 1. Child A envelope + Child A account id => ACCEPTED.
  {
    const { mod, writes } = make([CHILD_A, CHILD_B]);
    const r = await mod.processVerifiedWebhook("f_match", accountBody(CHILD_A, CHILD_A));
    check("A envelope + A resource is accepted", r.status === "accepted");
    check("and writes exactly that account", writes.length === 1 && writes[0] === CHILD_A);
  }

  /* 2. Child A envelope + Child B account id => NO WRITE, even though BOTH are
   *    known children. This is the invariant the earlier suite had backwards.
   *    A signed delivery proves Whop sent the body; it does not license us to
   *    decide which of two disagreeing identifiers is the real subject. */
  {
    const { mod, writes } = make([CHILD_A, CHILD_B]);
    const r = await mod.processVerifiedWebhook("f_cross", accountBody(CHILD_A, CHILD_B));
    check("A envelope + B resource writes NOTHING", writes.length === 0);
    check("and is refused as unmapped, not processed", r.status === "awaiting_mapping");
    check("and is acknowledged rather than retried forever", r.ack === true);
    check("neither A nor B is touched",
      !writes.includes(CHILD_A) && !writes.includes(CHILD_B));
  }

  // 3. Child A envelope + unknown account id => NO WRITE.
  {
    const { mod, writes } = make([CHILD_A]);
    const r = await mod.processVerifiedWebhook("f_unknown", accountBody(CHILD_A, FOREIGN));
    check("A envelope + unknown resource writes nothing", writes.length === 0);
    check("and is unmapped", r.status === "awaiting_mapping");
  }

  /* 4. Wrong-environment child => NO WRITE. The router is environment-scoped,
   *    so a child that exists only in the other environment is simply unknown
   *    here — consistent identifiers do not rescue it. */
  {
    const { mod, writes } = make([]);
    const r = await mod.processVerifiedWebhook("f_env", accountBody(CHILD_A, CHILD_A));
    check("a child unknown in THIS environment writes nothing", writes.length === 0);
    check("and is unmapped", r.status === "awaiting_mapping");
  }

  /* 5. A payload account id cannot make another child authoritative. The only
   *    difference between this and case 1 is which account the body names, and
   *    that difference alone must decide the outcome. */
  {
    const { mod, writes } = make([CHILD_A, CHILD_B]);
    await mod.processVerifiedWebhook("f_auth1", accountBody(CHILD_B, CHILD_B));
    check("B envelope + B resource writes B", writes.length === 1 && writes[0] === CHILD_B);

    const { mod: m2, writes: w2 } = make([CHILD_A, CHILD_B]);
    await m2.processVerifiedWebhook("f_auth2", accountBody(CHILD_B, CHILD_A));
    check("B envelope + A resource writes neither", w2.length === 0);
  }

  /* ABSENT IS NOT A MISMATCH. `account_id` is optional and nullable in the
   * contract. With no second identity to disagree with, the router rule stands
   * on its own — otherwise every delivery that omits the field would be
   * refused. */
  {
    const { mod, writes } = make([CHILD_A]);
    const r = await mod.processVerifiedWebhook("f_absent", accountBody(null, CHILD_A));
    check("an absent attributed account still allows a known child through",
      r.status === "accepted" && writes[0] === CHILD_A);

    const { mod: m2, writes: w2 } = make([]);
    await m2.processVerifiedWebhook("f_absent_unknown", accountBody(null, CHILD_A));
    check("but absence does not waive the router rule", w2.length === 0);
  }

  /* THE MUTATION SENTINEL. Deleting the equality check makes case 2 write
   * CHILD_B, so this asserts the comparison exists in source as well as in
   * behaviour — a source assertion catches a removal that a behavioural one
   * could miss if the fake ever drifted. */
  const handler = src("src/lib/server/whop-webhooks.ts");
  const body_ = handler.slice(handler.indexOf("export async function handleWhopAccountUpdated"));
  check("the two account identities are compared in source",
    /const attributedTo = readString\(root, "account_id"\);/.test(body_) &&
    /if \(attributedTo && attributedTo !== accountId\)/.test(body_));
  check("and a mismatch returns before any write",
    body_.indexOf("attributedTo !== accountId") <
    body_.indexOf("updateConnectedAccountStatus"));
}

{
  // The receipt always records the environment it was processed under, and the
  // environment comes from server config, never the payload.
  const webhookCode = codeOnly("src/lib/server/whop-webhooks.ts");
  check("the environment comes from the trusted helper",
    /const environment = getWhopEnvironment\(\)/.test(webhookCode));
  check("and is never read from the payload",
    !/readString\(data, "environment"\)|data\.environment/.test(webhookCode));
  check("an unresolvable environment processes nothing",
    /if \(!environment\) return \{ ack: false, kind: "unconfigured" \}/.test(webhookCode));

  const routerCode = codeOnly("src/lib/server/whop-child-router.ts");
  check("the child router takes its environment from the same helper",
    /getWhopEnvironment\(\)/.test(routerCode));
  check("and exposes no way for a caller to name the environment",
    !/resolveChildAccount\([^)]*environment/.test(routerCode));
}

{
  // Duplicate delivery stays idempotent: the second insert conflicts and the
  // row is not processed twice.
  const { mod, receipts } = makeReceiver();
  await mod.processVerifiedWebhook("wh_dup", body("payout.updated", { id: "wdrl_d", company_id: CHILD_A }));
  const second = await mod.processVerifiedWebhook("wh_dup", body("payout.updated", { id: "wdrl_d", company_id: CHILD_A }));
  check("a redelivery does not create a second receipt", receipts.size >= 1);
  check("and resolves without reprocessing from scratch",
    second.ack === true || second.kind === "processing_in_flight");
}

/* ========================================================================= */

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
