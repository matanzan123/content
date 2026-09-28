#!/usr/bin/env node
/**
 * TASK #15 — CREATOR WITHDRAWAL / EXTERNAL PAYOUT LIFECYCLE.
 *
 * A withdrawal used to be executed as an INTERNAL Whop ledger transfer
 * (`transfers.create`, Task #13), which moves money from the platform balance
 * to the creator's Whop balance. The money never left Whop. A withdrawal is
 * `payouts.create`: the creator's own balance to their own external
 * destination — a different provider resource, with `wdrl_` ids, eight
 * statuses, a mandatory saved destination, and a post-settlement reversal state
 * the transfer resource does not model.
 *
 * NO NETWORK. NO DATABASE. NO MONEY MOVES. Modules are transpiled in memory
 * with their imports stubbed; every query runs against an in-memory fake.
 *
 * Sections:
 *   A. Amount validation and bounds
 *   B. Provider status vocabulary and mapping
 *   C. The provider balance is the only cap
 *   D. Task #15 writes nothing to the ClipRewards ledger
 *   E. Request idempotency
 *   F. Payout method selection and ownership
 *   G. Provider contract: payouts.create
 *   H. Definite vs ambiguous failure
 *   I. Reconciliation is the authority
 *   J. Reversal after success
 *   K. The withdrawal state machine
 *   L. Environment isolation
 *   M. Webhook routing
 *   N. Orphan recovery and the sweep
 *   O. Leakage and vocabulary
 *   P. Cancellation
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

let passed = 0;
const failures = [];

function check(name, condition) {
  if (condition) passed += 1;
  else {
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const src = (p) => readFileSync(p, "utf8");

/**
 * Source with comments removed.
 *
 * REQUIRED FOR EVERY ABSENCE ASSERTION. These modules explain at length what
 * they deliberately do NOT do — "never parseFloat", "no transfer_id", "not
 * `paid`" — so a plain search for those strings finds the prose promising they
 * are absent and concludes they are present. Only executable text can answer
 * "does this code do X".
 */
const codeOnly = (p) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ========================================================================= */

function loadModule(path, stubs) {
  const js = ts.transpileModule(src(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const shim = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "server-only") return {};
    throw new Error(`unstubbed import: ${id}`);
  };
  new Function("require", "module", "exports", js)(shim, mod, mod.exports);
  return mod.exports;
}

const col = (table, name) => ({ __col: true, table, name });

const drizzle = {
  and: (...p) => ({ op: "and", parts: p.filter(Boolean) }),
  or: (...p) => ({ op: "or", parts: p.filter(Boolean) }),
  eq: (c, v) => ({ op: "eq", col: c, value: v }),
  isNull: (c) => ({ op: "isNull", col: c }),
  inArray: (c, values) => ({ op: "in", col: c, values }),
  asc: (c) => ({ op: "asc", col: c }),
  sql: (strings, ...values) => ({ op: "sql", strings, values }),
};
drizzle.sql.raw = (t) => ({ op: "sql", raw: t });

const T = (table, ...names) =>
  Object.fromEntries(names.map((n) => [n, col(table, n)]));

const schema = {
  accountingEntries: T("accounting_entries", "account", "counterpartyId", "counterpartyType",
    "amountMinor", "currency", "transactionId", "leg"),
  accountingTransactions: T("accounting_transactions", "transactionId", "environment",
    "idempotencyKey", "economicEvent"),
  creatorEarnings: T("creator_earnings", "earningId", "firebaseUid", "environment", "status",
    "netAmountMinor", "holdUntil", "frozenByDispute", "currency", "accountingTransactionId",
    "createdAt", "availableAt", "updatedAt"),
  creatorWithdrawals: T("creator_withdrawals", "withdrawalId", "firebaseUid", "environment",
    "status", "amountMinor", "reservedAmountMinor", "currency", "requestId", "payoutMethodId",
    "providerPayoutId", "providerStatus", "providerFailureCode", "accountingTransactionId",
    "providerSubmittedAt", "createdAt", "requestedAt"),
  creatorWithdrawalEarnings: T("creator_withdrawal_earnings", "withdrawalId", "earningId"),
  whopAccounts: T("whop_accounts", "id", "firebaseUid", "environment"),
  creatorTransfers: T("creator_transfers", "transferId", "environment", "status"),
  users: T("users", "firebaseUid"),
};

/* ---------------------------------------------------------------- A ---- */
section("A. Amount validation and bounds");

const withdrawSrc = src("src/lib/server/creator-withdrawals.ts");
const routeSrc = src("src/app/api/creator/withdraw/route.ts");
const withdrawCode = codeOnly("src/lib/server/creator-withdrawals.ts");
const routeCode = codeOnly("src/app/api/creator/withdraw/route.ts");
const payoutCode = codeOnly("src/lib/server/whop-payouts.ts");

{
  // Every one of these is a number that is not an integer amount of cents.
  // `Number.isInteger` rejects NaN and Infinity as well as floats, because
  // both are numbers and neither is an integer.
  check("the route rejects non-integers, NaN and Infinity",
    /typeof amountRaw !== "number"/.test(routeSrc) &&
    /!Number\.isInteger\(amountRaw\)/.test(routeSrc));
  check("the route rejects amounts past safe-integer precision",
    /!Number\.isSafeInteger\(amountRaw\)/.test(routeSrc));
  check("the route rejects zero and negatives", /amountRaw <= 0/.test(routeSrc));
  check("currency is fixed server-side, never taken from the body",
    /currency: "usd"/.test(routeSrc) && !/body\.currency/.test(routeSrc));

  // An APPLICATION minimum: the SDK expresses none, so this is a product floor.
  check("a minimum is enforced in the service, not only the route",
    /MIN_WITHDRAWAL_MINOR = BigInt\(100\)/.test(withdrawSrc) &&
    /amountMinor < MIN_WITHDRAWAL_MINOR/.test(withdrawSrc));
  check("a maximum ceiling exists",
    /MAX_WITHDRAWAL_MINOR/.test(withdrawSrc) &&
    /amountMinor > MAX_WITHDRAWAL_MINOR/.test(withdrawSrc));
  check("the minimum is documented as ours, not claimed as Whop's",
    /APPLICATION MINIMUM, NOT A CLAIMED PROVIDER ONE/.test(withdrawSrc));

  // The client-displayed available is a convenience, never the gate.
  // The cap is the PROVIDER's withdrawable balance, not the internal payable.
  check("the provider withdrawable balance is the real cap",
    /await readWithdrawableBalance\(account\.whopAccountId, currency\)/.test(withdrawCode));
  check("no float arithmetic on money in the service",
    !/parseFloat|Number\(amount/.test(withdrawSrc));
}

/* ---------------------------------------------------------------- B ---- */
section("B. Provider status vocabulary and mapping");

/* The genuine constraint classifier, loaded rather than faked — see the note at
 * its injection sites below. It imports nothing but `server-only`. */
const dbErrors = loadModule("src/lib/server/db-errors.ts", {});

const payouts = loadModule("src/lib/server/whop-payouts.ts", {
  "@whop/sdk": { WhopError: class WhopError extends Error {} },
  "./whop-payments": { getWhopPaymentsClient: () => null },
  "./whop-transfers": { minorToProviderAmount: () => ({ ok: false }), providerAmountToMinor: () => ({ ok: false }) },
});

{
  const expected = ["requested", "in_review", "processing", "completed", "reversed",
    "canceled", "failed", "denied"];
  check("all eight provider statuses, exactly",
    JSON.stringify([...payouts.PROVIDER_PAYOUT_STATUSES].sort()) ===
    JSON.stringify([...expected].sort()));

  // `paid` and `succeeded` are not payout statuses. Code matching them was
  // reading for values the resource never emits.
  check("no invented status strings",
    !payouts.PROVIDER_PAYOUT_STATUSES.includes("paid") &&
    !payouts.PROVIDER_PAYOUT_STATUSES.includes("succeeded"));

  check("nonterminal is exactly requested/in_review/processing",
    payouts.NONTERMINAL_PAYOUT_STATUSES.has("requested") &&
    payouts.NONTERMINAL_PAYOUT_STATUSES.has("in_review") &&
    payouts.NONTERMINAL_PAYOUT_STATUSES.has("processing") &&
    payouts.NONTERMINAL_PAYOUT_STATUSES.size === 3);
  check("success is completed", payouts.SUCCESS_PAYOUT_STATUS === "completed");
  check("failure is failed/denied/canceled",
    payouts.FAILURE_PAYOUT_STATUSES.has("failed") &&
    payouts.FAILURE_PAYOUT_STATUSES.has("denied") &&
    payouts.FAILURE_PAYOUT_STATUSES.has("canceled") &&
    payouts.FAILURE_PAYOUT_STATUSES.size === 3);
  check("reversal is its own class, not a failure",
    payouts.REVERSAL_PAYOUT_STATUS === "reversed" &&
    !payouts.FAILURE_PAYOUT_STATUSES.has("reversed"));
}

/* ---------------------------------------------------------------- C ---- */
section("C. The provider balance is the only cap");

{
  /* THE MODEL CORRECTION, ASSERTED DIRECTLY.
   *
   * An earlier Task #15 capped withdrawals against `creator_payable` and
   * reserved from it. That was a double count: Task #13 DISCHARGES
   * `creator_payable` when the money reaches the creator's own Whop account,
   * so the figure reads zero exactly when a withdrawal becomes possible, and
   * debiting it again drove it negative. */
  check("the withdrawal service never calls reserveFromPosition",
    !/reserveFromPosition/.test(withdrawCode));
  check("nor imports anything from creator-position",
    !/from "\.\/creator-position"/.test(withdrawCode));
  check("the cap is the provider's withdrawable balance",
    /await readWithdrawableBalance\(account\.whopAccountId, currency\)/.test(withdrawCode));
  check("an unreadable balance fails closed, never as 'enough'",
    /if \(!balance\.ok\) return \{ ok: false, reason: "balance_unavailable" \}/.test(withdrawCode));
  check("a zero balance refuses cleanly",
    /balance\.withdrawableMinor === BigInt\(0\)/.test(withdrawCode));
  check("over-asking is refused against the provider figure",
    /amountMinor > balance\.withdrawableMinor/.test(withdrawCode));

  // RE-READ BEFORE THE PAYOUT. The request-time figure can be days old.
  check("the balance is re-read immediately before the provider call",
    /const fresh = await readWithdrawableBalance\(accountId, withdrawal\.currency\)/.test(withdrawCode));
  check("and the re-read precedes createPayout",
    withdrawCode.indexOf("const fresh = await readWithdrawableBalance") <
    withdrawCode.indexOf("await createPayout({"));
  check("the fresh figure gates execution",
    /withdrawal\.amountMinor > fresh\.withdrawableMinor/.test(withdrawCode));

  const payoutSrc2 = src("src/lib/server/whop-payouts.ts");
  check("the balance comes from the creator's own ledger account",
    /client\.ledgerAccounts\.retrieve\(\{ id: accountId \}\)/.test(payoutSrc2));
  check("and uses total_withdrawable_balance, not a raw balance",
    /treasury\.total_withdrawable_balance/.test(payoutSrc2) &&
    !/balances\[0\]\.balance/.test(payoutCode));
  check("a currency mismatch is refused rather than converted",
    /treasuryCurrency !== currency/.test(payoutSrc2));
}

/* ---------------------------------------------------------------- D ---- */
section("D. Task #15 writes nothing to the ClipRewards ledger");

{
  /* NO JOURNAL AT ALL. A withdrawal moves the creator's own funds out of their
   * own Whop account. ClipRewards is not a party to it and records no entry. */
  check("no accounting entries are written",
    !/accountingEntries/.test(withdrawCode));
  check("no accounting transaction is written",
    !/accountingTransactions/.test(withdrawCode));
  check("creator_payable is never named",
    !/creator_payable/.test(withdrawCode));
  check("payout_clearing is never named",
    !/payout_clearing/.test(withdrawCode));
  check("reverseTransaction is never called",
    !/reverseTransaction/.test(withdrawCode));
  check("no economic key is minted",
    !/economicKey/.test(withdrawCode));
  check("no restore path survives",
    !/restorePayable/.test(withdrawCode));

  // Earning rows are untouched in every direction.
  check("creator_earnings is never written",
    !/schema\.creatorEarnings/.test(withdrawCode));
  check("the junction plays no part in eligibility",
    !/creatorWithdrawalEarnings/.test(withdrawCode));
  check("no FIFO earning scan survives",
    !/runningTotal|toReserve|no_earnings_to_reserve/.test(withdrawCode));
  check("no earning transition guard is needed any more",
    !/earningTransitionGuard/.test(withdrawCode));

  // Task #13 accounting is untouched by this change.
  const transferSrc = src("src/lib/server/creator-transfers.ts");
  check("Task #13 still discharges creator_payable",
    /account: "creator_payable"/.test(transferSrc) &&
    /account: "provider_balance"/.test(transferSrc));
  check("and still keys it by the firebase uid",
    /counterpartyId: input\.firebaseUid/.test(transferSrc));

  // payout_clearing stays gated, since nothing posts to it.
  check("payout_clearing remains non-postable",
    /payout_clearing: \{[\s\S]{0,400}postable: false/.test(
      codeOnly("src/lib/server/accounting/accounts.ts")));

  // The canonical position is back to its Task #14 meaning.
  const posCode = codeOnly("src/lib/server/creator-position.ts");
  check("the position helper no longer subtracts withdrawals",
    !/creatorWithdrawals/.test(posCode));
  check("and reports no reserved term",
    !/reservedMinor/.test(posCode));
}

/* ---------------------------------------------------------------- E ---- */
section("E. Request idempotency");

{
  check("a request id is required for a real withdrawal",
    /isValidWithdrawalRequestId\(input\.requestId\)/.test(withdrawSrc) &&
    /reason: "missing_request_id"/.test(withdrawSrc));
  check("the route requires one too",
    /isValidWithdrawalRequestId\(body\.request_id\)/.test(routeSrc));
  check("its shape is bounded",
    /\^\[A-Za-z0-9_-\]\{8,128\}\$/.test(withdrawSrc));

  const valid = loadModule("src/lib/server/creator-withdrawals.ts", {
    "drizzle-orm": drizzle,
    "@/lib/db": { getDb: () => null, schema },
    "./creator-earnings-policy": { canRelease: () => true },
    "./whop-payout-status": { fetchPayoutStatus: async () => null },
    "./connected-accounts": { getConnectedAccount: async () => null },
    "./whop-payments": { getWhopEnvironment: () => "sandbox" },
    "./notification-triggers": { notifyWithdrawalProcessing: async () => {} },
    "./creator-position": { reserveFromPosition: async () => ({ ok: true }), earningTransitionGuard: () => ({ op: "in" }) },
    "./accounting/journal": { reverseTransaction: async () => ({ ok: true }) },
    "./accounting/accounts": { economicKey: (a, b, c) => `${a}:${b}:${c}` },
    "./whop-payouts": payouts,
    // THE REAL HELPER, not a stub. Task #29 found both unique-violation
    // branches in requestWithdrawal unreachable: they matched on the error
    // MESSAGE, which drizzle renders as the SQL, while the constraint name
    // sits in `cause`. A stub here would let this suite pass whatever the
    // helper did, which is how the original defect survived 234 checks.
    "./db-errors": dbErrors,
  });

  check("a too-short token is refused", valid.isValidWithdrawalRequestId("abc") === false);
  check("a 8-char token is accepted", valid.isValidWithdrawalRequestId("abcd1234") === true);
  check("a uuid is accepted",
    valid.isValidWithdrawalRequestId("f47ac10b-58cc-4372-a567-0e02b2c3d479") === true);
  check("punctuation is refused", valid.isValidWithdrawalRequestId("abcd 1234!") === false);
  check("a non-string is refused", valid.isValidWithdrawalRequestId(12345678) === false);

  // SAME TOKEN, DIFFERENT INTENT. Two different withdrawals cannot share one
  // identity, and guessing which the creator meant would move the wrong sum.
  check("a replay with a different amount is a conflict, not a second payment",
    /if \(!sameIntent\) return \{ ok: false, reason: "request_conflict" \}/.test(withdrawSrc));
  check("the conflict compares amount, currency AND destination",
    /existing\.amountMinor === amountMinor/.test(withdrawSrc) &&
    /existing\.currency === currency/.test(withdrawSrc) &&
    /existing\.payoutMethodId === input\.payoutMethodId/.test(withdrawSrc));
  check("a matching replay returns the SAME withdrawal, reserving nothing again",
    /withdrawalId: existing\.withdrawalId/.test(withdrawSrc));
  check("the route answers a conflict with 409",
    /request_conflict" \? 409/.test(routeSrc));

  // The lookup happens BEFORE the lock, so a replay costs no contention.
  // A replay must cost neither a provider round-trip nor a new row.
  check("the replay check precedes the balance read",
    withdrawCode.indexOf("findWithdrawalByRequestId") <
    withdrawCode.indexOf("await readWithdrawableBalance"));

  // The UI must not mint a new token for a retry of the same intent.
  const cardSrc = src("src/components/dashboard/CreatorWithdrawCard.tsx");
  check("the UI holds one token per intent in a ref",
    /requestIdRef = useRef<string \| null>\(null\)/.test(cardSrc));
  check("the UI reuses it rather than regenerating",
    /if \(!requestIdRef\.current\) requestIdRef\.current = newRequestId\(\)/.test(cardSrc));
  check("the token is retired only after the server accepts",
    /requestIdRef\.current = null;[\s\S]{0,40}await load\(\)/.test(cardSrc));
  check("and NOT cleared in the finally, so a failed send stays the same intent",
    !/finally[\s\S]{0,200}requestIdRef\.current = null/.test(cardSrc));
}

/* ---------------------------------------------------------------- F ---- */
section("F. Payout method selection and ownership");

{
  const m = (id, over = {}) => ({
    payoutMethodId: id, companyId: "biz_me", currency: "usd",
    isDefault: false, category: "next_day_bank", ...over,
  });

  check("zero eligible sends the creator to set one up",
    payouts.selectPayoutMethod([]).reason === "payout_destination_required");
  check("exactly one is used",
    payouts.selectPayoutMethod([m("potk_1")]).method.payoutMethodId === "potk_1");

  // NEVER methods[0]: list ordering is undocumented and carries no key.
  const two = [m("potk_1"), m("potk_2")];
  check("several with no default is an ambiguity the creator resolves",
    payouts.selectPayoutMethod(two).reason === "payout_method_selection_required");
  check("several with exactly one default uses the default",
    payouts.selectPayoutMethod([m("potk_1"), m("potk_2", { isDefault: true })])
      .method.payoutMethodId === "potk_2");
  check("several defaults is still an ambiguity, not a guess",
    payouts.selectPayoutMethod([m("potk_1", { isDefault: true }), m("potk_2", { isDefault: true })])
      .reason === "payout_method_selection_required");

  // A browser-supplied potk_ is validated by MEMBERSHIP in the company-scoped
  // eligible list, never trusted on its own.
  check("a supplied id present in the eligible list is accepted",
    payouts.selectPayoutMethod(two, "potk_2").method.payoutMethodId === "potk_2");
  check("a supplied id NOT in the list is rejected",
    payouts.selectPayoutMethod(two, "potk_someone_else").reason === "payout_method_not_owned");
  check("a supplied id is rejected even when the list is empty",
    payouts.selectPayoutMethod([], "potk_x").reason === "payout_method_not_owned");

  const payoutSrc = src("src/lib/server/whop-payouts.ts");
  check("the list request is company-scoped at the provider",
    /company_id: companyId/.test(payoutSrc));
  check("ownership is asserted again on our side",
    /owner !== companyId/.test(payoutSrc));
  check("unconfigured destinations are excluded",
    /if \(!item\.destination\) continue/.test(payoutSrc));
  check("non-USD destinations are excluded",
    /item\.currency\.toLowerCase\(\) !== currency/.test(payoutSrc));
  check("the list is bounded", /MAX_PAYOUT_METHODS/.test(payoutSrc));
}

/* ---------------------------------------------------------------- G ---- */
section("G. Provider contract: payouts.create");

{
  const payoutSrc = src("src/lib/server/whop-payouts.ts");

  // THE WHOLE POINT OF TASK #15. A withdrawal is not a transfer.
  check("the withdrawal service does NOT call the transfer primitive",
    !/initiateCreatorTransfer/.test(withdrawCode));
  check("nor imports it", !/from "\.\/creator-transfers"/.test(withdrawSrc));
  check("the withdrawal service calls createPayout",
    /await createPayout\(\{/.test(withdrawSrc));
  check("the provider boundary calls payouts.create",
    /client\.payouts\.create\(body, \{/.test(payoutSrc));

  check("the source is the creator's own account, resolved server-side",
    /account_id: input\.accountId/.test(payoutSrc) &&
    /getConnectedAccount\(withdrawal\.firebaseUid, environment\)/.test(withdrawSrc));
  check("no account_id is ever taken from a request body",
    !/body\.account_id|body\.accountId/.test(routeSrc) &&
    !/body\.account_id|body\.accountId/.test(withdrawSrc));
  check("no environment is ever taken from a request body",
    !/body\.environment/.test(routeSrc) && !/body\.environment/.test(withdrawSrc));
  check("no provider id is ever taken from a request body",
    !/body\.provider_payout_id/.test(routeSrc));

  check("the destination is a proven potk_", /payout_method_id: input\.payoutMethodId/.test(payoutSrc));

  // AMOUNT CONVERSION IS NOT DUPLICATED. The hardened Task #13 primitive is
  // imported — the one added after a bug that would have moved 100x the sum.
  check("major-unit conversion reuses the transfer primitive",
    /minorToProviderAmount/.test(payoutSrc) &&
    /from "\.\/whop-transfers"/.test(payoutSrc));
  check("the converted value is what is sent, not the minor amount",
    /amount: converted\.amount/.test(payoutSrc));
  /* PAYOUT AMOUNTS ARRIVE AS DECIMAL STRINGS, not numbers as transfers do.
   * Feeding a string to the number-only converter made every successful payout
   * unreadable — and an unreadable 2xx is treated as ambiguous, so a payout
   * that HAD been created would have been recorded as an unknown outcome. */
  check("string amounts are normalised then delegated to the hardened parser",
    /decimalStringToMinor\(p\.amount\)/.test(payoutSrc) &&
    /providerAmountToMinor\(asNumber\)/.test(payoutSrc) &&
    !/parseFloat/.test(payoutCode));
  check("the sub-cent and magnitude rules are not restated here",
    !/toFixed|MAX_TRANSFERABLE/.test(payoutCode));

  // IDEMPOTENCY IS A HEADER, PER REQUEST.
  check("the idempotency key is passed per request",
    /idempotencyKey: input\.idempotencyKey/.test(payoutSrc));
  check("it is derived from the withdrawal id, stable across retries",
    /idempotencyKey: `wdr:\$\{withdrawalId\}`/.test(withdrawSrc));
  check("no client-level idempotency key is set",
    !/new WhopClient\([\s\S]{0,200}idempotencyKey/.test(src("src/lib/server/whop-payments.ts")));

  // Provider-safe defaults: none of these is chosen on the creator's behalf.
  check("platform_covers_fees is not set", !/platform_covers_fees/.test(
    payoutSrc.slice(payoutSrc.indexOf("const body: Whop.CreatePayoutsRequest"),
                    payoutSrc.indexOf("client.payouts.create"))));
  check("acknowledge_bank_warning is not set",
    !/acknowledge_bank_warning:/.test(payoutSrc));
  check("speed instant is not forced", !/speed: "instant"/.test(payoutCode));

  // Metadata is durable storage at the provider: webhook bodies are retained.
  check("metadata carries only the withdrawal id",
    /metadata: \{ withdrawal_id: input\.withdrawalId \}/.test(payoutSrc));
  check("no uid or email reaches metadata",
    !/metadata[\s\S]{0,120}(firebaseUid|email)/.test(payoutCode));

  check("the provider payout id and status are persisted",
    /providerPayoutId: payout\.providerPayoutId/.test(withdrawSrc) &&
    /providerStatus: payout\.status/.test(withdrawSrc));
}

/* ---------------------------------------------------------------- H ---- */
section("H. Definite vs ambiguous failure");

{
  const payoutSrc = src("src/lib/server/whop-payouts.ts");

  // DEFINITE: the provider says it did nothing, so compensation is safe.
  check("403 is DEFINITE — the expected write-authorization answer",
    /status === 403[\s\S]{0,140}outcome: "definite"[\s\S]{0,60}payout_permission_denied/.test(payoutSrc));
  check("404 is definite", /status === 404[\s\S]{0,120}"definite"/.test(payoutSrc));
  check("402 is definite", /status === 402[\s\S]{0,120}"definite"/.test(payoutSrc));
  /* 409 IS AMBIGUOUS. The SDK declares ConflictError on payouts.create and
   * never says what produces one; error.type/code are open strings with no
   * catalog. One plausible 409 is an idempotency conflict, which means the
   * payout EXISTS — so treating it as a refusal would mark a withdrawal failed
   * while the creator's money was on its way. */
  check("409 is AMBIGUOUS, not definite",
    /status === 409[\s\S]{0,200}"ambiguous"[\s\S]{0,60}provider_conflict/.test(payoutSrc));
  check("no definite reason claims a conflict",
    !/payout_conflict/.test(payoutCode));
  check("400/422 are definite", /status === 400 \|\| status === 422/.test(payoutSrc));

  // AMBIGUOUS: the payout may exist.
  check("429 is AMBIGUOUS, not a failure",
    /status === 429[\s\S]{0,120}"ambiguous"/.test(payoutSrc));
  check("5xx is ambiguous", /status >= 500[\s\S]{0,120}"ambiguous"/.test(payoutSrc));
  check("no response at all is ambiguous",
    /status === null[\s\S]{0,200}"ambiguous"/.test(payoutSrc));
  check("an unreadable 2xx body is ambiguous, not success",
    /if \(!payout\) \{[\s\S]{0,260}"ambiguous"/.test(payoutSrc));

  // THE CONSEQUENCE, in the lifecycle.
  /* A DEFINITE FAILURE RESTORES NOTHING, because nothing was ever posted. The
   * money never left the creator's Whop balance, so it is still theirs and
   * still withdrawable — the next attempt simply sees it. */
  check("a definite failure ends terminal",
    /if \(result\.outcome === "ambiguous"\)[\s\S]{0,700}"failed", \{/.test(withdrawCode));
  check("and restores nothing internally",
    !/restorePayable|reverseTransaction/.test(withdrawCode));
  check("an AMBIGUOUS outcome does NOT restore the ledger",
    !/ambiguous"\)[\s\S]{0,320}restorePayable/.test(withdrawSrc));
  check("an ambiguous outcome stays non-terminal and recoverable",
    /ambiguous"\)[\s\S]{0,200}"provider_pending"/.test(withdrawCode));
  check("no path maps an ambiguous outcome to failed",
    !/ambiguous"\)[\s\S]{0,200}"failed"/.test(withdrawCode));
  check("an ambiguous outcome is reported as its own reason",
    /return \{ ok: false, reason: "payout_ambiguous" \}/.test(withdrawCode));
  check("the key is never regenerated for a retry",
    (withdrawSrc.match(/idempotencyKey: `wdr:/g) ?? []).length === 1);
  check("the admin route answers 202 for an ambiguous outcome",
    /payout_ambiguous"[\s\S]{0,120}202/.test(src("src/app/api/admin/withdrawals/[id]/route.ts")));
}

/* ---------------------------------------------------------------- I ---- */
section("I. Reconciliation is the authority");

{
  const payoutSrc = src("src/lib/server/whop-payouts.ts");

  check("reconciliation reads the provider",
    /await retrievePayout\(withdrawal\.providerPayoutId, account\.whopAccountId\)/.test(withdrawSrc));
  check("the retrieve is scoped by account_id — an ownership proof",
    /client\.payouts\.retrieve\(\{[\s\S]{0,140}account_id: accountId/.test(payoutSrc));
  check("an unreadable answer leaves the row untouched",
    /if \(!result\.ok\) \{[\s\S]{0,200}return \{ ok: false, reason: result\.reason \}/.test(withdrawSrc));

  const wd = loadModule("src/lib/server/creator-withdrawals.ts", {
    "drizzle-orm": drizzle,
    "@/lib/db": { getDb: () => null, schema },
    "./creator-earnings-policy": { canRelease: () => true },
    "./whop-payout-status": { fetchPayoutStatus: async () => null },
    "./connected-accounts": { getConnectedAccount: async () => null },
    "./whop-payments": { getWhopEnvironment: () => "sandbox" },
    "./notification-triggers": { notifyWithdrawalProcessing: async () => {} },
    "./creator-position": { reserveFromPosition: async () => ({ ok: true }), earningTransitionGuard: () => ({ op: "in" }) },
    "./accounting/journal": { reverseTransaction: async () => ({ ok: true }) },
    "./accounting/accounts": { economicKey: (a, b, c) => `${a}:${b}:${c}` },
    "./whop-payouts": payouts,
    // THE REAL HELPER, not a stub. Task #29 found both unique-violation
    // branches in requestWithdrawal unreachable: they matched on the error
    // MESSAGE, which drizzle renders as the SQL, while the constraint name
    // sits in `cause`. A stub here would let this suite pass whatever the
    // helper did, which is how the original defect survived 234 checks.
    "./db-errors": dbErrors,
  });

  check("requested maps to provider_pending", wd.mapProviderStatus("requested") === "provider_pending");
  check("in_review maps to provider_pending", wd.mapProviderStatus("in_review") === "provider_pending");
  check("processing maps to provider_pending", wd.mapProviderStatus("processing") === "provider_pending");
  check("completed maps to paid", wd.mapProviderStatus("completed") === "paid");
  check("failed maps to failed", wd.mapProviderStatus("failed") === "failed");
  check("denied maps to failed", wd.mapProviderStatus("denied") === "failed");
  check("canceled maps to canceled, not failed", wd.mapProviderStatus("canceled") === "canceled");
  check("reversed maps to reversed", wd.mapProviderStatus("reversed") === "reversed");

  check("a terminal withdrawal reconciles to no change",
    /TERMINAL_WITHDRAWAL_STATUSES\.has\(withdrawal\.status\)[\s\S]{0,160}changed: false/.test(withdrawSrc));
  check("paid is NOT terminal — a settled payout can still reverse",
    !wd.TERMINAL_WITHDRAWAL_STATUSES.has("paid"));
  check("failed, canceled and reversed are terminal",
    wd.TERMINAL_WITHDRAWAL_STATUSES.has("failed") &&
    wd.TERMINAL_WITHDRAWAL_STATUSES.has("canceled") &&
    wd.TERMINAL_WITHDRAWAL_STATUSES.has("reversed"));

  check("a sweep can find withdrawals awaiting the provider",
    /getWithdrawalsAwaitingProvider/.test(withdrawSrc));
}

/* ---------------------------------------------------------------- J ---- */
section("J. Reversal after success");

{
  /* A REVERSAL RESTORES NOTHING OF OURS. The provider put the funds back in
   * the creator's own Whop balance, which is the only place they ever were.
   * The next balance read sees them, and a fresh withdrawal can spend them. */
  check("a reversal moves the withdrawal to reversed",
    /REVERSAL_PAYOUT_STATUS[\s\S]{0,1600}"reversed", extra\)/.test(withdrawSrc));
  check("and credits no creator_payable",
    !/creator_payable/.test(withdrawCode));
  check("and posts no reversal journal",
    !/reverseTransaction/.test(withdrawCode));

  /* THE CONFLATION TASK #14 REMOVED, ASSERTED HERE. `reversed` on an EARNING
   * means the creator was never entitled to the money. A payout reversal means
   * delivery failed. Writing the former would cancel a valid earning and drop
   * it out of the creator's lifetime total. */
  check("no earning row is marked reversed anywhere in the withdrawal lifecycle",
    !/creatorEarnings[\s\S]{0,200}status: "reversed"/.test(withdrawCode));
  check("no earning row is marked transferred either",
    !/status: "transferred"/.test(withdrawCode));
  check("the only earning status the lifecycle writes is the available promotion",
    (withdrawSrc.match(/schema\.creatorEarnings\)\s*\n?\s*\.set\(/g) ?? []).length <= 1);
  check("the reversal path documents where the money actually went",
    /THE FUNDS ARE BACK IN THE CREATOR'S WHOP BALANCE/.test(withdrawSrc));

  // A fresh attempt after a reversal is a NEW logical withdrawal.
  check("no consumption marker survives anywhere",
    !/accountingTransactionId/.test(withdrawCode));
  check("reversed is terminal for that one attempt",
    /reversed: \["reversed"\]/.test(withdrawCode));
  check("the status write is SQL-guarded, so a redelivery matches nothing",
    /inArray\(\s*schema\.creatorWithdrawals\.status,/.test(withdrawSrc));
}

/* ---------------------------------------------------------------- K ---- */
section("K. The withdrawal state machine");

{
  const wd = loadModule("src/lib/server/creator-withdrawals.ts", {
    "drizzle-orm": drizzle,
    "@/lib/db": { getDb: () => null, schema },
    "./creator-earnings-policy": { canRelease: () => true },
    "./whop-payout-status": { fetchPayoutStatus: async () => null },
    "./connected-accounts": { getConnectedAccount: async () => null },
    "./whop-payments": { getWhopEnvironment: () => "sandbox" },
    "./notification-triggers": { notifyWithdrawalProcessing: async () => {} },
    "./creator-position": { reserveFromPosition: async () => ({ ok: true }), earningTransitionGuard: () => ({ op: "in" }) },
    "./accounting/journal": { reverseTransaction: async () => ({ ok: true }) },
    "./accounting/accounts": { economicKey: (a, b, c) => `${a}:${b}:${c}` },
    "./whop-payouts": payouts,
    // THE REAL HELPER, not a stub. Task #29 found both unique-violation
    // branches in requestWithdrawal unreachable: they matched on the error
    // MESSAGE, which drizzle renders as the SQL, while the constraint name
    // sits in `cause`. A stub here would let this suite pass whatever the
    // helper did, which is how the original defect survived 234 checks.
    "./db-errors": dbErrors,
  });
  const allowed = wd.isAllowedWithdrawalTransition;

  check("requested may become eligible", allowed("requested", "eligible"));
  check("eligible may become processing", allowed("eligible", "processing"));
  check("processing may become provider_pending", allowed("processing", "provider_pending"));
  check("processing may become paid directly — a fast provider answers completed",
    allowed("processing", "paid"));
  check("provider_pending may become paid", allowed("provider_pending", "paid"));
  check("paid may become reversed — the only exit from success",
    allowed("paid", "reversed"));

  // TERMINAL STATES DO NOT RESURRECT.
  check("failed cannot become paid", !allowed("failed", "paid"));
  check("failed cannot become anything else", !allowed("failed", "provider_pending"));
  check("canceled cannot become paid", !allowed("canceled", "paid"));
  check("reversed cannot become paid", !allowed("reversed", "paid"));
  check("paid cannot go back to provider_pending", !allowed("paid", "provider_pending"));
  check("paid cannot become failed — the money arrived", !allowed("paid", "failed"));

  // REPLAY IS HARMLESS.
  check("paid to paid is permitted, so a redelivery is inert", allowed("paid", "paid"));
  check("reversed to reversed is permitted", allowed("reversed", "reversed"));

  // THE GUARD IS SQL, and self-transitions are excluded from it so a repeat
  // update matches nothing rather than rewriting timestamps.
  check("the guard excludes the target itself",
    !wd.withdrawalSourceStatuses("paid").includes("paid"));
  check("the paid guard admits only processing and provider_pending",
    wd.withdrawalSourceStatuses("paid").sort().join(",") === "processing,provider_pending");
  check("the reversed guard admits only paid and provider_pending",
    wd.withdrawalSourceStatuses("reversed").sort().join(",") === "paid,provider_pending");
  check("the guard is built into the WHERE, not checked in JS first",
    /\.where\([\s\S]{0,400}inArray\(\s*schema\.creatorWithdrawals\.status,\s*\n?\s*sources/.test(withdrawSrc));
  check("the status update is environment-scoped too",
    /setWithdrawalStatus[\s\S]{0,1400}eq\(schema\.creatorWithdrawals\.environment, environment\)/.test(withdrawSrc));
  check("a guard that matched nothing returns false rather than throwing",
    /return updated\.length > 0;/.test(withdrawSrc));
}

/* ---------------------------------------------------------------- L ---- */
section("L. Environment isolation");

{
  // Every lookup. The audit found nine unscoped; none may remain.
  const fns = [
    "loadWithdrawal", "findWithdrawalByRequestId", "findWithdrawalByProviderPayoutId",
    "getActiveWithdrawal", "listWithdrawals", "getWithdrawalsAwaitingProvider",
  ];
  for (const fn of fns) {
    const i = withdrawSrc.indexOf(`function ${fn}`);
    const body = withdrawSrc.slice(i, i + 1400);
    check(`${fn} is environment-scoped`,
      i > 0 && /eq\(schema\.creatorWithdrawals\.environment, environment\)/.test(body));
  }

  check("getWithdrawal resolves the environment before reading",
    /getWithdrawal\([\s\S]{0,300}getWhopEnvironment\(\)/.test(withdrawSrc));
  check("the environment always comes from the trusted helper",
    (withdrawSrc.match(/getWhopEnvironment\(\)/g) ?? []).length >= 6);
  check("no environment is read from a payload or parameter",
    !/environment = (body|data|payload|input\.environment)/.test(withdrawSrc));
  check("every read fails closed when the environment is unresolvable",
    (withdrawSrc.match(/if \(!environment\) return/g) ?? []).length >= 6);

  // The provider id index must be per environment, not global.
  const mig = src("drizzle/0012_withdrawal_payout_lifecycle.sql");
  check("provider payout id uniqueness is per environment",
    /uniq_withdrawal_provider_payout_env[\s\S]{0,140}"provider_payout_id","environment"/.test(mig));
  check("request id uniqueness is per creator per environment",
    /uniq_withdrawal_request_creator_env[\s\S]{0,160}"firebase_uid","environment","request_id"/.test(mig));
}

/* ---------------------------------------------------------------- M ---- */
section("M. Webhook routing");

{
  const hooks = src("src/lib/server/whop-webhooks.ts");
  /* ANCHORED ON THE DECLARATION, not on the name.
   *
   * `indexOf("handleWhopPayoutUpdated")` found whichever mention came first in
   * the file, so the moment a comment elsewhere referred to the handler by name
   * this slice silently captured the wrong region and every assertion below
   * became vacuous — which is exactly what happened when Task #27 documented the
   * transfer families in SUPPORTED_EVENTS. The declaration is unique. */
  const declAt = hooks.indexOf("export async function handleWhopPayoutUpdated");
  check("the payout handler declaration was located", declAt > 0, String(declAt));
  const handler = hooks.slice(declAt);
  const body = handler.slice(0, handler.indexOf("\n/**", 100));

  /* THE BUG THIS FIXES. `payout.*` events carry `wdrl_` ids — the PAYOUTS
   * resource. They were handed to the transfer reconciler, which resolves ids
   * against creator_transfers.provider_transfer_id. The two id spaces never
   * intersect, so every payout delivery fell through and the withdrawal
   * lifecycle received nothing. */
  /* THE LOOKUP MUST BE CALLED, not merely named. Comparing positions of the two
   * NAMES was satisfied by a mutant that replaced the call with `null as
   * { withdrawalId: string } | null` — the name survived in a type annotation and
   * the withdrawal branch became unreachable while this check still passed. */
  check("payout events route to withdrawals FIRST",
    /const withdrawal = await findWithdrawalByProviderPayoutId\(payoutId\);/.test(body) &&
    body.indexOf("await findWithdrawalByProviderPayoutId") <
    body.indexOf("await refreshTransferFromProvider"));
  check("a matched withdrawal is reconciled against the provider",
    /await reconcileWithdrawal\(withdrawal\.withdrawalId\)/.test(body));
  check("Task #13 transfer handling is preserved as the fallback",
    /await refreshTransferFromProvider\(payoutId\)/.test(body));

  // The payload is a trigger, never a source of money truth.
  check("the handler reads no status from the payload",
    !/data, "status"|data\.status/.test(body));
  check("the handler writes no money state itself",
    !/\.insert\(|\.update\(|accountingEntries|reverseTransaction/.test(body));
  check("an unrecognised id is acknowledged, never forced into a mapping",
    /business_mapping_not_implemented/.test(body));
  check("a failed reconcile keeps the delivery retryable",
    /kind: "failed", category: "payout_reconcile_failed"/.test(body));

  check("signature verification is still required",
    /unwrapWebhook|WebhookVerificationError/.test(hooks));
  check("replay protection is still required", /whopWebhookReceipts/.test(hooks));
}

/* ---------------------------------------------------------------- N ---- */
section("N. Orphan recovery and the sweep");

{
  const payoutSrc3 = src("src/lib/server/whop-payouts.ts");

  /* THE STATE WITH NO WAY OUT, BEFORE THIS EXISTED. `payouts.create` can reach
   * Whop, create the payout, and lose its response. The row then has no
   * provider id — and `payouts.retrieve` needs exactly that id. */
  check("recovery exists", /export async function recoverOrphanedWithdrawal/.test(withdrawCode));
  check("it refuses rows that already have an id",
    /already_has_payout/.test(withdrawCode));
  check("it refuses rows that never reached the provider call",
    /not_recoverable/.test(withdrawCode));
  check("it requires a submitted-at lower bound",
    /if \(!withdrawal\.providerSubmittedAt\) return \{ ok: false, reason: "not_recoverable" \}/.test(withdrawCode));
  check("provider_submitted_at is written BEFORE the provider call",
    withdrawCode.indexOf("providerSubmittedAt: new Date()") <
    withdrawCode.indexOf("await createPayout({"));

  // THE SEARCH is scoped to the creator's own account and matched on our id.
  check("the search lists payouts for the creator's account only",
    /account_id: input\.accountId/.test(payoutSrc3) &&
    /client\.payouts\.list\(\{/.test(payoutSrc3));
  check("it is bounded by a created_after window",
    /created_after: input\.createdAfter\.toISOString\(\)/.test(payoutSrc3));
  check("it is bounded in size", /ORPHAN_SCAN_LIMIT/.test(payoutSrc3));
  check("matching is on our own withdrawal_id metadata, exactly",
    /meta\.withdrawal_id !== input\.withdrawalId/.test(payoutSrc3));
  check("amount is verified too, not metadata alone",
    /payout\.amountMinor !== input\.amountMinor/.test(payoutSrc3));
  check("currency is verified too",
    /payout\.currency !== input\.currency/.test(payoutSrc3));

  // THE THREE OUTCOMES.
  check("exactly one match is adopted",
    /matches\.length > 1/.test(payoutSrc3) && /found: true, payout: matches\[0\]/.test(payoutSrc3));
  check("multiple matches fail closed, nothing adopted",
    /return \{ ok: false, reason: "ambiguous_matches" \}/.test(payoutSrc3));
  check("zero matches returns found:false, leaving the row untouched",
    /return \{ ok: true, found: false \}/.test(payoutSrc3));

  /* THE CRITICAL NEGATIVE. An empty search is NOT permission to pay again: the
   * provider may be eventually consistent, and the installed SDK nowhere
   * guarantees that reusing an Idempotency-Key replays the original. */
  const recoverBody = withdrawCode.slice(
    withdrawCode.indexOf("export async function recoverOrphanedWithdrawal"),
    withdrawCode.indexOf("export async function sweepPendingWithdrawals"),
  );
  check("recovery never calls createPayout",
    !/createPayout/.test(recoverBody));
  check("an empty result does not retry the payout",
    /if \(!search\.found\) \{[\s\S]{0,200}return \{ ok: true, adopted: false \}/.test(recoverBody));
  check("adoption is guarded so two recoveries cannot adopt different payouts",
    /isNull\(schema\.creatorWithdrawals\.providerPayoutId\)/.test(recoverBody));
  check("an adopted id is then resolved by provider retrieve",
    /await reconcileWithdrawal\(withdrawalId\)/.test(recoverBody));

  // THE SWEEP, and its caller.
  check("a sweep exists", /export async function sweepPendingWithdrawals/.test(withdrawCode));
  check("it is bounded", /limit = 25/.test(withdrawCode));
  const sweepBody = withdrawCode.slice(withdrawCode.indexOf("export async function sweepPendingWithdrawals"));
  check("rows with an id are reconciled",
    /if \(row\.providerPayoutId\) \{[\s\S]{0,200}reconcileWithdrawal/.test(sweepBody));
  check("rows without one go to recovery",
    /recoverOrphanedWithdrawal\(withdrawalId\)/.test(sweepBody));
  check("the sweep never creates a payout", !/createPayout/.test(sweepBody));

  const sweepRoute = src("src/app/api/admin/withdrawals/reconcile/route.ts");
  check("the sweep has a real caller",
    /await sweepPendingWithdrawals\(limit\)/.test(sweepRoute));
  check("the caller is admin-gated", /withAdminApi/.test(sweepRoute));
  check("origin-checked and rate-limited",
    /checkRequestOrigin/.test(sweepRoute) && /checkRateLimit/.test(sweepRoute));
  check("the batch is capped server-side", /Math\.min\(requested, MAX_BATCH\)/.test(sweepRoute));
  check("it returns counts only, no ids",
    !/withdrawal_id|provider_payout_id/.test(codeOnly("src/app/api/admin/withdrawals/reconcile/route.ts")));
}

/* ---------------------------------------------------------------- O ---- */
section("O. Leakage and vocabulary");

{
  check("readiness is ENFORCED, unlike the Task #13 transfer",
    /if \(!readiness\?\.ok \|\| !readiness\.status\.canReceivePayout\) \{[\s\S]{0,260}payout_not_ready/.test(withdrawSrc));
  check("a not-ready withdrawal keeps its reservation",
    /The reservation is deliberately preserved/.test(withdrawSrc));

  // The creator-facing view.
  check("the view carries no transfer_id", !/transferId/.test(
    withdrawSrc.slice(withdrawSrc.indexOf("function toView"))));
  check("the view carries no provider payout id", !/providerPayoutId/.test(
    withdrawSrc.slice(withdrawSrc.indexOf("function toView"))));
  check("the view carries no payout method id", !/payoutMethodId/.test(
    withdrawSrc.slice(withdrawSrc.indexOf("function toView"))));
  check("the view carries no provider failure code", !/providerFailureCode/.test(
    withdrawSrc.slice(withdrawSrc.indexOf("function toView"))));
  check("the creator route no longer serialises transfer_id",
    !/transfer_id/.test(routeCode));
  check("the creator route exposes a reversed timestamp", /reversed_at/.test(routeSrc));
  check("the creator route only ever reads its own session uid",
    /gate\.context\.uid as string/.test(routeSrc) && !/body\.firebase_uid/.test(routeSrc));
  check("the admin route does not return the provider payout id",
    !/provider_payout_id/.test(codeOnly("src/app/api/admin/withdrawals/[id]/route.ts")));

  // No raw provider prose anywhere.
  const payoutSrc = src("src/lib/server/whop-payouts.ts");
  check("the provider boundary never reads error.message",
    !/error\.message|e\.message/.test(payoutSrc));
  check("nor rawResponse or cause", !/rawResponse|\.cause/.test(payoutSrc));
  check("the failure message is deliberately not captured",
    /never the message/.test(payoutSrc));
  check("only the failure CODE is stored",
    /providerFailureCode: failureCode/.test(withdrawSrc));
  check("the quote token is never persisted",
    !/quoteToken:[\s\S]{0,60}(insert|set\()/.test(withdrawSrc) &&
    /NEVER PERSISTED/.test(payoutSrc));

  // Notification vocabulary is the provider's, and nothing financial rides on it.
  const notifCode = codeOnly("src/lib/server/notification-triggers.ts");
  const block = notifCode.slice(notifCode.indexOf('eventType === "payout.updated"'));
  const slice = block.slice(0, 900);
  check("notifications no longer match paid or succeeded",
    !/"paid"/.test(slice) && !/"succeeded"/.test(slice));
  check("notifications match the real completed status", /=== "completed"/.test(slice));
  check("notifications match the real reversed status", /=== "reversed"/.test(slice));
  check("the notification path changes no money state",
    !/reverseTransaction|accountingEntries|creator_payable/.test(slice));
}

/* ---------------------------------------------------------------- P ---- */
section("P. Cancellation");

{
  check("cancellation before a payout exists is allowed",
    /const cancellable: WithdrawalStatus\[\] = \["requested", "eligible"\]/.test(withdrawSrc));
  /* CANCELLING IS PURELY A STATUS CHANGE. Nothing was reserved, nothing was
   * posted, and no earning was linked — the money never left the creator's
   * Whop balance, so it is withdrawable again the moment the provider is next
   * read. */
  check("cancelling releases nothing, because nothing was held",
    /NOTHING TO RELEASE AND NOTHING TO REVERSE/.test(withdrawSrc));
  check("and deletes no junction rows",
    !/releaseReservation/.test(withdrawCode));

  /* AFTER SUBMISSION IT FAILS CLOSED. The provider allows cancelling only while
   * `in_review`; a local cancellation of a payout in flight would tell the
   * creator their money is back while it is still moving. */
  check("cancellation after a payout exists fails closed",
    /if \(withdrawal\.providerPayoutId\) \{[\s\S]{0,120}cannot_cancel_after_submission/.test(withdrawSrc));
  check("the route answers 409 for that",
    /cannot_cancel_after_submission" \? 409/.test(routeSrc));
  check("no provider cancel is attempted",
    !/payouts\.cancel|cancelPayout/.test(withdrawCode));

  check("the service deletes nothing at all",
    !/\.delete\(/.test(withdrawCode));
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
