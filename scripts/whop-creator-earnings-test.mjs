#!/usr/bin/env node
/**
 * TASK #14 — CREATOR EARNINGS / PAYABLE.
 *
 * "What is this creator owed" used to have two answers. `creator_earnings`
 * rows were summed for the creator-facing balance; the ledger kept a
 * `creator_payable` account built from the same events; and nothing compared
 * them. A Task #13 admin transfer debited the ledger and touched no earning
 * row, so the creator kept seeing money that had already been sent and could
 * withdraw it again through Task #15.
 *
 * This suite holds the fix in place. The ledger is the monetary authority,
 * earning rows decide eligibility, and one helper computes both.
 *
 * NO NETWORK. NO DATABASE. NO MONEY MOVES. Modules are transpiled in memory
 * with their imports stubbed, and every query runs against an in-memory fake.
 *
 * Sections:
 *   A. The position helper reads the ledger, with the right sign
 *   B. Environment and counterparty scoping
 *   C. Pending is eligibility, not a ledger figure
 *   D. Inconsistent positions are reported, never shown as a balance
 *   E. The reservation takes a lock and caps against available (admin transfer)
 *   F. The earning state machine
 *   G. The transfer journal posts against the creator, not the account id
 *   H. The creator API serves the canonical position
 *   I. The canonical position is the admin transfer's cap, and only that
 *   J. Reconciliation looks where the bugs actually are
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

let passed = 0;
const failures = [];

function check(name, condition) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* =========================================================================
   Module loader — transpile TypeScript in memory, inject stubbed imports.
   ========================================================================= */

function loadModule(path, stubs) {
  const source = readFileSync(path, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  // Named `mod`, not `module`: Next's lint bans assigning to `module` even
  // in a standalone script, and the name is only a local anyway.
  const mod = { exports: {} };
  const shim = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "server-only") return {};
    throw new Error(`unstubbed import: ${id}`);
  };
  new Function("require", "module", "exports", js)(shim, mod, mod.exports);
  return mod.exports;
}

/* =========================================================================
   Fake drizzle — records what a query asked for, rather than executing SQL.

   Each condition helper returns a plain descriptor, so an assertion can look
   at the WHERE clause a module built and confirm it scoped the query the way
   it claims to. That is the only way to test "environment-scoped" without a
   database.
   ========================================================================= */

const col = (table, name) => ({ __col: true, table, name });

function flatten(clause, out = []) {
  if (!clause) return out;
  if (clause.op === "and" || clause.op === "or") {
    for (const part of clause.parts) flatten(part, out);
  } else {
    out.push(clause);
  }
  return out;
}

const drizzle = {
  and: (...parts) => ({ op: "and", parts: parts.filter(Boolean) }),
  or: (...parts) => ({ op: "or", parts: parts.filter(Boolean) }),
  eq: (c, v) => ({ op: "eq", col: c, value: v }),
  isNull: (c) => ({ op: "isNull", col: c }),
  inArray: (c, values) => ({ op: "in", col: c, values }),
  lte: (c, v) => ({ op: "lte", col: c, value: v }),
  asc: (c) => ({ op: "asc", col: c }),
  not: (c) => ({ op: "not", inner: c }),
  sql: (strings, ...values) => ({ op: "sql", strings, values }),
};
drizzle.sql.raw = (t) => ({ op: "sql", raw: t });

const schema = {
  accountingEntries: {
    account: col("accounting_entries", "account"),
    counterpartyId: col("accounting_entries", "counterparty_id"),
    counterpartyType: col("accounting_entries", "counterparty_type"),
    amountMinor: col("accounting_entries", "amount_minor"),
    currency: col("accounting_entries", "currency"),
    transactionId: col("accounting_entries", "transaction_id"),
  },
  accountingTransactions: {
    transactionId: col("accounting_transactions", "transaction_id"),
    environment: col("accounting_transactions", "environment"),
  },
  creatorEarnings: {
    earningId: col("creator_earnings", "earning_id"),
    firebaseUid: col("creator_earnings", "firebase_uid"),
    environment: col("creator_earnings", "environment"),
    status: col("creator_earnings", "status"),
    netAmountMinor: col("creator_earnings", "net_amount_minor"),
    holdUntil: col("creator_earnings", "hold_until"),
    frozenByDispute: col("creator_earnings", "frozen_by_dispute"),
    currency: col("creator_earnings", "currency"),
    accountingTransactionId: col("creator_earnings", "accounting_transaction_id"),
    createdAt: col("creator_earnings", "created_at"),
  },
  whopAccounts: {
    id: col("whop_accounts", "id"),
    firebaseUid: col("whop_accounts", "firebase_uid"),
    environment: col("whop_accounts", "environment"),
  },
  // Retained only so the fake answers if a query ever reaches it. The position
  // helper no longer reads this table: a withdrawal moves the creator's own
  // provider funds and is not a ClipRewards obligation.
  creatorWithdrawals: {
    withdrawalId: col("creator_withdrawals", "withdrawal_id"),
    firebaseUid: col("creator_withdrawals", "firebase_uid"),
    environment: col("creator_withdrawals", "environment"),
    status: col("creator_withdrawals", "status"),
    reservedAmountMinor: col("creator_withdrawals", "reserved_amount_minor"),
    accountingTransactionId: col("creator_withdrawals", "accounting_transaction_id"),
  },
  creatorTransfers: {
    transferId: col("creator_transfers", "transfer_id"),
    environment: col("creator_transfers", "environment"),
    status: col("creator_transfers", "status"),
    amountMinor: col("creator_transfers", "amount_minor"),
    accountingTransactionId: col("creator_transfers", "accounting_transaction_id"),
  },
  users: { firebaseUid: col("users", "firebase_uid") },
};

/**
 * A query builder that resolves to whatever the test's `respond` callback
 * returns for the shape that was built.
 */
function makeDb(respond, log = []) {
  const builder = (state) => {
    const self = {
      from(t) { return builder({ ...state, from: t }); },
      innerJoin(t, on) { return builder({ ...state, joins: [...(state.joins ?? []), { t, on }] }); },
      leftJoin(t, on) { return builder({ ...state, leftJoins: [...(state.leftJoins ?? []), { t, on }] }); },
      where(w) { return builder({ ...state, where: w }); },
      groupBy(...g) { return builder({ ...state, groupBy: g }); },
      orderBy(...o) { return builder({ ...state, orderBy: o }); },
      limit(n) { return builder({ ...state, limit: n }); },
      for(mode) { return builder({ ...state, lock: mode }); },
      then(resolve, reject) {
        log.push(state);
        try { resolve(respond(state)); } catch (err) { reject(err); }
      },
    };
    return self;
  };
  return {
    select: (fields) => builder({ kind: "select", fields }),
    selectDistinct: (fields) => builder({ kind: "selectDistinct", fields }),
    __log: log,
  };
}

/* =========================================================================
   Load the position helper against those fakes.
   ========================================================================= */

let currentDb = null;

const position = loadModule("src/lib/server/creator-position.ts", {
  "drizzle-orm": drizzle,
  "@/lib/db": { getDb: () => currentDb, schema },
  "./creator-earnings-policy": {
    canRelease: (holdUntil, frozen, now) => !frozen && now >= holdUntil,
  },
});

const PAST = new Date(Date.now() - 86_400_000);
const FUTURE = new Date(Date.now() + 86_400_000);

/** Builds a db whose ledger sum and earning rows the test dictates. */
function dbWith({ ledgerTotal = "0", rows = [], accountRows = [{ id: "acct-1" }], reserved = "0" }) {
  const log = [];
  return makeDb((state) => {
    if (state.from === schema.accountingEntries) return [{ total: ledgerTotal }];
    if (state.from === schema.creatorEarnings) return rows;
    if (state.from === schema.whopAccounts) return accountRows;
    // Task #15: the in-flight withdrawal reservation total.
    if (state.from === schema.creatorWithdrawals) return [{ total: reserved }];
    return [];
  }, log);
}

const earning = (over = {}) => ({
  status: "available",
  netAmountMinor: BigInt(0),
  holdUntil: PAST,
  frozenByDispute: false,
  currency: "usd",
  ...over,
});

/* ---------------------------------------------------------------- A ---- */
section("A. The position helper reads the ledger, with the right sign");

{
  // A credit is stored NEGATIVE. $100 owed is a ledger sum of -10000, and the
  // obligation is the negation. Getting this backwards would report every
  // creator as owed nothing, or owed the negative of their balance.
  const db = dbWith({ ledgerTotal: "-10000" });
  const p = await position.computeCreatorPosition("uid_1", "sandbox", db);
  check("a -10000 ledger sum is a payable of 10000", p.payableMinor === BigInt(10000));

  const db2 = dbWith({ ledgerTotal: "-10000", rows: [] });
  const p2 = await position.computeCreatorPosition("uid_1", "sandbox", db2);
  check("with nothing held, available equals payable", p2.availableMinor === BigInt(10000));

  const db3 = dbWith({ ledgerTotal: "0" });
  const p3 = await position.computeCreatorPosition("uid_1", "sandbox", db3);
  check("an empty ledger is a zero payable, not a crash", p3.payableMinor === BigInt(0));
}

/* ---------------------------------------------------------------- B ---- */
section("B. Environment and counterparty scoping");

{
  const db = dbWith({ ledgerTotal: "-500" });
  await position.computeCreatorPosition("uid_scope", "production", db);

  const ledgerQuery = db.__log.find((q) => q.from === schema.accountingEntries);
  const conds = flatten(ledgerQuery?.where);

  check("the ledger read joins transactions to reach environment",
    (ledgerQuery?.joins ?? []).some((j) => j.t === schema.accountingTransactions));

  check("the ledger read is scoped to the creator_payable account",
    conds.some((c) => c.col === schema.accountingEntries.account && c.value === "creator_payable"));

  // THE COUNTERPARTY BUG'S TEST. Transfers used to key this leg by the Whop
  // account id while earnings keyed it by firebase uid, so the two halves of a
  // balance sat under different counterparties and never met.
  check("the ledger read is keyed by the firebase uid",
    conds.some((c) => c.col === schema.accountingEntries.counterpartyId && c.value === "uid_scope"));

  check("the ledger read is scoped to the requested environment",
    conds.some((c) => c.col === schema.accountingTransactions.environment && c.value === "production"));

  const earningsQuery = db.__log.find((q) => q.from === schema.creatorEarnings);
  const eConds = flatten(earningsQuery?.where);
  check("the earnings read is scoped by uid AND environment",
    eConds.some((c) => c.col === schema.creatorEarnings.firebaseUid && c.value === "uid_scope") &&
    eConds.some((c) => c.col === schema.creatorEarnings.environment && c.value === "production"));
}

/* ---------------------------------------------------------------- C ---- */
section("C. Pending is eligibility, not a ledger figure");

{
  // $100 owed, all of it still inside its hold window.
  const db = dbWith({
    ledgerTotal: "-10000",
    rows: [earning({ status: "held", netAmountMinor: BigInt(10000), holdUntil: FUTURE })],
  });
  const p = await position.computeCreatorPosition("uid_2", "sandbox", db);
  check("money still on hold is payable but not available",
    p.payableMinor === BigInt(10000) && p.pendingMinor === BigInt(10000) && p.availableMinor === BigInt(0));

  // Same row, hold expired. No sweep job has run; it should still count.
  const db2 = dbWith({
    ledgerTotal: "-10000",
    rows: [earning({ status: "held", netAmountMinor: BigInt(10000), holdUntil: PAST })],
  });
  const p2 = await position.computeCreatorPosition("uid_2", "sandbox", db2);
  check("a held row past its window is available without a sweep",
    p2.pendingMinor === BigInt(0) && p2.availableMinor === BigInt(10000));

  // A dispute freezes it regardless of the window.
  const db3 = dbWith({
    ledgerTotal: "-10000",
    rows: [earning({ status: "available", netAmountMinor: BigInt(10000), frozenByDispute: true })],
  });
  const p3 = await position.computeCreatorPosition("uid_2", "sandbox", db3);
  check("a frozen row is pending even with its hold expired",
    p3.pendingMinor === BigInt(10000) && p3.availableMinor === BigInt(0));

  // THE ORIGINAL DEFECT, STATED AS A TEST. $100 earned, $80 already
  // transferred out by an admin. The earning row still reads `available`
  // because no transfer marks it — and that is fine, because the LEDGER is
  // what caps the balance. The old row-summing code returned 10000 here.
  const db4 = dbWith({
    ledgerTotal: "-2000",
    rows: [earning({ status: "available", netAmountMinor: BigInt(10000) })],
  });
  const p4 = await position.computeCreatorPosition("uid_2", "sandbox", db4);
  check("money already transferred is gone from available, even with the row untouched",
    p4.availableMinor === BigInt(2000));

  // NO FAKE ALLOCATION. The $100 row is still worth $100 in the audit trail.
  check("the earning row is not rewritten to match a partial transfer",
    p4.earnedMinor === BigInt(10000));

  /* NO WITHDRAWAL TERM HERE, DELIBERATELY.
   *
   * A block here briefly asserted that an in-flight withdrawal reduced
   * `available`. It was removed with the model that required it: a Task #13
   * transfer DISCHARGES `creator_payable`, so a withdrawal moves the
   * creator's own funds out of their own Whop account and is not our
   * liability. Withdrawal eligibility is the provider's withdrawable
   * balance, asserted in `whop-withdrawal-test.mjs`.
   *
   * This helper answers one question — what ClipRewards still owes — and
   * every assertion above it is unchanged. */

  const db5 = dbWith({
    ledgerTotal: "-2000",
    rows: [
      earning({ status: "available", netAmountMinor: BigInt(2000) }),
      earning({ status: "reversed", netAmountMinor: BigInt(5000) }),
    ],
  });
  const p5 = await position.computeCreatorPosition("uid_2", "sandbox", db5);
  check("a reversed row counts as reversed, not as earned",
    p5.reversedMinor === BigInt(5000) && p5.earnedMinor === BigInt(2000));
}

/* ---------------------------------------------------------------- D ---- */
section("D. Inconsistent positions are reported, never shown as a balance");

{
  // More paid out than was ever credited.
  const db = dbWith({ ledgerTotal: "500" });
  const p = await position.computeCreatorPosition("uid_3", "sandbox", db);
  check("a negative obligation is flagged", p.inconsistency === "negative_payable");
  check("a negative obligation is never served as a negative number",
    p.payableMinor === BigInt(0) && p.availableMinor === BigInt(0));

  // Rows claim more is held than the ledger says is owed at all.
  const db2 = dbWith({
    ledgerTotal: "-1000",
    rows: [earning({ status: "held", netAmountMinor: BigInt(9000), holdUntil: FUTURE })],
  });
  const p2 = await position.computeCreatorPosition("uid_3", "sandbox", db2);
  check("pending exceeding payable is flagged", p2.inconsistency === "pending_exceeds_payable");
  check("available never goes negative silently", p2.availableMinor === BigInt(0));

  const db3 = dbWith({ ledgerTotal: "-1000" });
  const p3 = await position.computeCreatorPosition("uid_3", "sandbox", db3);
  check("a sound position carries no flag", p3.inconsistency === null);
}

/* ---------------------------------------------------------------- E ---- */
section("E. The reservation takes a lock and caps against available");

{
  const db = dbWith({ ledgerTotal: "-10000" });
  const r = await position.reserveFromPosition(db, "uid_4", "sandbox", BigInt(5000));
  check("a covered amount is reserved", r.ok === true);

  // THE LOCK IS THE WHOLE POINT. Without it, two callers read the same
  // balance and both spend it — the check and the debit are not atomic.
  const lockQuery = db.__log.find((q) => q.from === schema.whopAccounts);
  check("the creator row is locked FOR UPDATE before anything is read",
    lockQuery?.lock === "update");
  check("the lock is taken before the ledger is read",
    db.__log.indexOf(lockQuery) < db.__log.findIndex((q) => q.from === schema.accountingEntries));
  check("the lock is scoped to the creator and environment",
    flatten(lockQuery?.where).some((c) => c.col === schema.whopAccounts.firebaseUid && c.value === "uid_4") &&
    flatten(lockQuery?.where).some((c) => c.col === schema.whopAccounts.environment && c.value === "sandbox"));

  const db2 = dbWith({ ledgerTotal: "-10000" });
  const r2 = await position.reserveFromPosition(db2, "uid_4", "sandbox", BigInt(10001));
  check("one minor unit over the balance is refused",
    r2.ok === false && r2.reason === "insufficient_available");
  check("the refusal says what was available",
    r2.availableMinor === BigInt(10000));

  const db3 = dbWith({ ledgerTotal: "-10000" });
  const r3 = await position.reserveFromPosition(db3, "uid_4", "sandbox", BigInt(10000));
  check("exactly the balance is allowed", r3.ok === true);

  // Held money is not reservable, even though it is owed.
  const db4 = dbWith({
    ledgerTotal: "-10000",
    rows: [earning({ status: "held", netAmountMinor: BigInt(10000), holdUntil: FUTURE })],
  });
  const r4 = await position.reserveFromPosition(db4, "uid_4", "sandbox", BigInt(1));
  check("money still on hold cannot be reserved", r4.ok === false);

  // An inconsistent position refuses rather than guessing.
  const db5 = dbWith({ ledgerTotal: "500" });
  const r5 = await position.reserveFromPosition(db5, "uid_4", "sandbox", BigInt(1));
  check("an inconsistent position refuses the reservation",
    r5.ok === false && r5.reason === "position_inconsistent");

  const db6 = dbWith({ ledgerTotal: "-10000", accountRows: [] });
  const r6 = await position.reserveFromPosition(db6, "uid_4", "sandbox", BigInt(1));
  check("a creator with no account row cannot be reserved against",
    r6.ok === false && r6.reason === "creator_not_found");
}

/* ---------------------------------------------------------------- F ---- */
section("F. The earning state machine");

{
  const src = position.earningSourceStatuses;

  // THE DOUBLE-SPEND, AS A STATE TRANSITION. Money that left must never
  // return to a spendable balance.
  check("transferred cannot go back to available", !src("available").includes("transferred"));
  check("transferred cannot go back to held", !src("held").includes("transferred"));
  check("reversed cannot go back to available", !src("available").includes("reversed"));
  check("reversed cannot go back to held", !src("held").includes("reversed"));

  /* INVERTED. These two used to assert that a transferred earning could still
     become reversed, on the reasoning that a provider can reverse a settled
     payout. The provider can — but that is a PAYOUT reversal, and `reversed`
     on an EARNING means the creator was never entitled to the money at all.
     The old assertions let one resource's word leak into another resource's
     meaning, and would have cancelled a valid earning, and the creator's
     lifetime total with it, because delivery failed.

     Asserted as the property now: `transferred` is terminal, full stop. */
  check("a transferred earning cannot be reversed — that is a payout event",
    !position.isAllowedEarningTransition("transferred", "reversed"));
  check("a transferred earning cannot be restored to available either",
    !position.isAllowedEarningTransition("transferred", "available"));
  check("nothing at all leaves transferred except itself",
    position.ALLOWED_EARNING_TRANSITIONS.transferred.length === 1 &&
    position.ALLOWED_EARNING_TRANSITIONS.transferred[0] === "transferred");
  check("a reversed earning cannot be marked paid",
    !position.isAllowedEarningTransition("reversed", "transferred"));

  check("held may become available", position.isAllowedEarningTransition("held", "available"));
  check("held may be reversed", position.isAllowedEarningTransition("held", "reversed"));
  check("available may be paid", position.isAllowedEarningTransition("available", "transferred"));
  check("available may be reversed", position.isAllowedEarningTransition("available", "reversed"));

  check("both transferred and reversed are terminal",
    position.TERMINAL_EARNING_STATUSES.has("transferred") &&
    position.TERMINAL_EARNING_STATUSES.has("reversed"));
  check("no second status set survives to disagree with that one",
    position.UNSPENDABLE_EARNING_STATUSES === undefined);

  // The guard must be a SQL clause, not an application branch: a branch is
  // evaluated against a row read moments ago, a WHERE against committed state.
  const guard = position.earningTransitionGuard("transferred");
  check("the guard is an inArray over the status column",
    guard.op === "in" && guard.col === schema.creatorEarnings.status);
  check("the transferred guard admits only available",
    guard.values.slice().sort().join(",") === "available");

  const revGuard = position.earningTransitionGuard("reversed");
  // THE NO-OP THAT MATTERS. `reverseWithdrawal` still issues this update; the
  // guard is what makes it match nothing rather than cancel a valid earning.
  check("the reversed guard does NOT admit transferred, so a payout reversal is inert",
    !revGuard.values.includes("transferred"));
  check("the reversed guard does not admit reversed, so replays are inert",
    !revGuard.values.includes("reversed"));
  check("the reversed guard still admits held and available — real reversals land",
    revGuard.values.slice().sort().join(",") === "available,held");
}

/* ---------------------------------------------------------------- G ---- */
section("G. The transfer journal posts against the creator, not the account id");

{
  const src = readFileSync("src/lib/server/creator-transfers.ts", "utf8");
  const journal = src.slice(src.indexOf("async function writePayoutJournal"));

  // THE COUNTERPARTY FIX. `postRevenueSplit` credits creator_payable keyed by
  // firebaseUid; debiting it by `biz_...` opened a second counterparty and the
  // obligation never went down no matter how much was paid out.
  const leg1 = journal.slice(journal.indexOf('account: "creator_payable"'));
  check("the creator_payable leg is keyed by the firebase uid",
    /counterpartyId: input\.firebaseUid/.test(leg1.slice(0, 1200)));
  check("the creator_payable leg is NOT keyed by the whop account id",
    !/account: "creator_payable"[\s\S]{0,1200}counterpartyId: input\.whopAccountId/.test(journal));

  // The Whop account id is still the provider destination — it just is not
  // an accounting identity.
  check("the whop account id remains the provider destination",
    /destinationId: whopAccountId/.test(src));

  // THE CAP, AND ITS ATOMICITY. The reservation must happen inside the same
  // transaction as the posting, before any entry is written.
  check("the journal reserves against the position before posting",
    journal.indexOf("await reserveFromPosition(") > -1 &&
    journal.indexOf("await reserveFromPosition(") < journal.indexOf("accountingEntries"));
  check("the reservation happens inside the posting transaction",
    journal.indexOf("await db.transaction") < journal.indexOf("await reserveFromPosition("));
  check("a refusal aborts rather than posting a partial journal",
    /throw new PayoutRefusal/.test(journal));
  check("an uncovered transfer fails the transfer closed",
    /failureReason: written\.reason/.test(src));
  check("the provider is never called when the journal is refused",
    src.indexOf("if (!written.ok)") < src.indexOf("createLedgerTransfer({"));
}

/* ---------------------------------------------------------------- H ---- */
section("H. The creator API serves the canonical position");

{
  const balanceSrc = readFileSync("src/lib/server/creator-earnings.ts", "utf8");
  const fn = balanceSrc.slice(balanceSrc.indexOf("export async function getCreatorBalance"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // ONE SOURCE, NOT TWO. The old body summed earning rows itself, which is
  // exactly the number a transfer does not move.
  check("getCreatorBalance delegates to the canonical helper",
    /computeCreatorPosition\(firebaseUid, environment, db\)/.test(body));
  check("getCreatorBalance no longer sums earning rows itself",
    !/computeBalance|reduce\(/.test(body));
  check("nothing else in the module recomputes a balance",
    !/computeBalance/.test(balanceSrc));
  check("the balance is still environment-scoped",
    /getWhopEnvironment\(\)/.test(body));

  const route = readFileSync("src/app/api/creator/earnings/route.ts", "utf8");
  check("the route exposes the ledger obligation",
    /payable_minor: balance\.payableMinor/.test(route));
  check("an inconsistent position is refused, not served as a balance",
    /balance\.inconsistency/.test(route) && /balance_unavailable/.test(route));
  check("the route still requires an eligible creator",
    /requireWhopEligible/.test(route));
}

/* ---------------------------------------------------------------- I ---- */
section("I. The canonical position is the ADMIN TRANSFER's cap, and only that");

{
  const transferSrc = readFileSync("src/lib/server/creator-transfers.ts", "utf8");
  const withdrawCode = readFileSync("src/lib/server/creator-withdrawals.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /* RE-BASELINED. THIS SECTION USED TO COVER TWO CALLERS; NOW IT COVERS ONE.
   *
   * It asserted that the creator withdrawal path shared this helper and its
   * lock with the admin transfer, because an early Task #15 capped withdrawals
   * against `creator_payable` and reserved from it.
   *
   * That was a double count. A Task #13 transfer DISCHARGES `creator_payable`
   * — it moves the money into the creator's own Whop account, after which
   * ClipRewards owes them nothing. A Task #15 withdrawal then moves THEIR
   * funds out of THEIR account and is not our liability at all. Capping it
   * against this figure asked the wrong question twice over: the number is
   * zero exactly when a withdrawal becomes possible, and debiting it a second
   * time drove it negative.
   *
   * So the assertions are inverted rather than dropped. What must hold now is
   * that the admin transfer still uses the lock and the canonical cap, and
   * that the withdrawal path stays entirely out of this helper. Withdrawal
   * eligibility is covered against the provider balance in
   * `whop-withdrawal-test.mjs`.
   */
  check("the admin transfer still reserves against the canonical position",
    /await reserveFromPosition\(/.test(transferSrc));
  check("and does so inside a transaction, under the creator lock",
    /await db\.transaction/.test(transferSrc) &&
    transferSrc.indexOf("await db.transaction") < transferSrc.indexOf("await reserveFromPosition("));
  // Comment-stripped: the leg carries a long explanation between the account
  // name and the counterparty, which would push them out of any sane window.
  const transferCode = transferSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check("the transfer journal still debits creator_payable by firebase uid",
    /account: "creator_payable"[\s\S]{0,200}counterpartyId: input\.firebaseUid/.test(transferCode));

  // THE BOUNDARY. Task #15 must not appear in this helper's callers at all.
  check("the withdrawal path does not use the canonical position",
    !/reserveFromPosition/.test(withdrawCode));
  check("nor imports creator-position",
    !/from "\.\/creator-position"/.test(withdrawCode));
  check("nor names creator_payable anywhere",
    !/creator_payable/.test(withdrawCode));
  check("nor posts any accounting entry",
    !/accountingEntries|accountingTransactions|reverseTransaction/.test(withdrawCode));

  // And the helper itself no longer knows withdrawals exist.
  const posCode = readFileSync("src/lib/server/creator-position.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check("the position helper reads no withdrawal table",
    !/creatorWithdrawals/.test(posCode));
  check("and reports no reserved term",
    !/reservedMinor/.test(posCode));
}

/* ---------------------------------------------------------------- J ---- */
section("J. Reconciliation looks where the bugs actually are");

{
  const recon = loadModule("src/lib/server/creator-earnings-reconcile.ts", {
    "drizzle-orm": drizzle,
    "@/lib/db": { getDb: () => currentDb, schema },
    "./creator-position": position,
  });

  // (A) A journal that never posted leaves the row with a null transaction id
  // on purpose, so the earning is not lost. That is only safe if something
  // looks — a null here means the canonical payable under-reports the creator.
  currentDb = makeDb((state) => {
    if (state.from === schema.creatorEarnings && state.kind === "select") {
      return [{ firebaseUid: "uid_j", earningId: "e1", netAmountMinor: BigInt(2500) }];
    }
    return [];
  });
  let out = await recon.reconcileCreatorEarnings("sandbox");
  check("an unjournalled earning is reported",
    out.ok && out.report.findings.some((f) => f.check === "journal_missing" && f.earningId === "e1"));

  const nullQuery = currentDb.__log.find((q) =>
    flatten(q.where).some((c) => c.op === "isNull" && c.col === schema.creatorEarnings.accountingTransactionId));
  check("the journal check actually queries for a null transaction id", Boolean(nullQuery));
  check("the journal check is environment-scoped",
    flatten(nullQuery?.where).some((c) => c.col === schema.creatorEarnings.environment && c.value === "sandbox"));

  // (B) The ledger and the rows must agree. $100 earned, nothing transferred,
  // but the ledger only owes $20 — money left without the rows settling.
  currentDb = makeDb((state) => {
    if (state.kind === "selectDistinct") return [{ firebaseUid: "uid_k" }];
    if (state.from === schema.accountingEntries) return [{ total: "-2000" }];
    if (state.from === schema.creatorEarnings) {
      return [earning({ status: "available", netAmountMinor: BigInt(10000) })];
    }
    return [];
  });
  out = await recon.reconcileCreatorEarnings("sandbox");
  const mismatch = out.ok && out.report.findings.find((f) => f.check === "payable_mismatch");
  check("a ledger that disagrees with the rows is reported", Boolean(mismatch));
  check("the mismatch reports the signed size of the gap",
    mismatch && mismatch.deltaMinor === "-8000");

  // (C) A negative obligation.
  currentDb = makeDb((state) => {
    if (state.kind === "selectDistinct") return [{ firebaseUid: "uid_n" }];
    if (state.from === schema.accountingEntries) return [{ total: "500" }];
    return [];
  });
  out = await recon.reconcileCreatorEarnings("sandbox");
  check("a negative obligation is reported",
    out.ok && out.report.findings.some((f) => f.check === "negative_payable"));

  // (D) THE COUNTERPARTY BUG'S OWN DETECTOR: a creator_payable leg keyed to
  // something that is not a creator — a `biz_...` id from before the fix.
  currentDb = makeDb((state) => {
    if (state.leftJoins?.length) {
      return [{ counterpartyId: "biz_legacy", entryCount: 3, totalMinor: "9000" }];
    }
    return [];
  });
  out = await recon.reconcileCreatorEarnings("sandbox");
  const stray = out.ok && out.report.findings.find((f) => f.check === "unknown_counterparty");
  check("a payable leg keyed to a non-creator is reported",
    stray && stray.counterpartyId === "biz_legacy");

  // (E) Money that moved with no journal behind it should be impossible,
  // which is exactly why it is checked.
  currentDb = makeDb((state) => {
    if (state.from === schema.creatorTransfers) {
      return [{ transferId: "t1", status: "completed", amountMinor: BigInt(4000) }];
    }
    return [];
  });
  out = await recon.reconcileCreatorEarnings("sandbox");
  check("a settled transfer with no journal is reported",
    out.ok && out.report.findings.some((f) => f.check === "transfer_unjournalled"));

  // A clean set of books produces nothing at all.
  currentDb = makeDb(() => []);
  out = await recon.reconcileCreatorEarnings("sandbox");
  check("clean books produce no findings", out.ok && out.report.findings.length === 0);
  check("the report names the environment it describes",
    out.ok && out.report.environment === "sandbox");

  // READ-ONLY. A reconciler that repairs inconsistent books automatically is
  // how a small discrepancy becomes an unauditable one.
  const reconSrc = readFileSync("src/lib/server/creator-earnings-reconcile.ts", "utf8");
  check("the reconciler never writes",
    !/\.insert\(|\.update\(|\.delete\(|db\.transaction/.test(reconSrc));
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
