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
 *   K. The payable is summed in ONE currency, never across them
 *   L. Mixed currency is surfaced to the reconciler, not hidden
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
    /* THE REAL FUNCTION, not a stub.
     *
     * Task #17 made the position subtract the creator share already returned by
     * partial refunds, derived through the canonical fee policy. Faking it here
     * would let the position and the policy drift apart silently, so the
     * genuine implementation is loaded and used. */
    remainingCreatorNet: loadModule("src/lib/server/creator-earnings-policy.ts", {})
      .remainingCreatorNet,
  },
  /* THE REAL CURRENCY TABLE. Whether a code is supported decides whether the
   * position is refused as `unsupported_currency`, so faking the list would let
   * the test agree with itself about a currency the build cannot actually do
   * exact minor-unit arithmetic in. */
  "./money": loadModule("src/lib/server/money.ts", {}),
});

const PAST = new Date(Date.now() - 86_400_000);
const FUTURE = new Date(Date.now() + 86_400_000);

/**
 * Builds a db whose ledger sum and earning rows the test dictates.
 *
 * `ledgerByCurrency` MAKES THE CURRENCY PREDICATE REAL. When given, the fake
 * reads the currency condition out of the WHERE clause it was handed and answers
 * with that currency's total, exactly as a filtered SQL sum would. A query that
 * forgot the predicate finds no condition and gets "0" — so these assertions
 * cannot pass by accident, which a fake returning one fixed total would allow.
 */
function dbWith({
  ledgerTotal = "0",
  ledgerByCurrency = null,
  ledgerCurrencies = ["usd"],
  rows = [],
  accountRows = [{ id: "acct-1" }],
  reserved = "0",
}) {
  const log = [];
  return makeDb((state) => {
    if (state.from === schema.accountingEntries) {
      // The DISTINCT-currency probe that resolves which currency to report in.
      if (state.kind === "selectDistinct") {
        return (ledgerCurrencies ?? []).map((currency) => ({ currency }));
      }
      if (ledgerByCurrency) {
        const cond = flatten(state.where).find(
          (c) => c.col === schema.accountingEntries.currency,
        );
        return [{ total: cond ? (ledgerByCurrency[cond.value] ?? "0") : "0" }];
      }
      return [{ total: ledgerTotal }];
    }
    if (state.from === schema.creatorEarnings) {
      // The DISTINCT-currency probe reads only the currency column.
      if (state.kind === "selectDistinct") {
        return [...new Set(rows.map((r) => r.currency))].map((currency) => ({ currency }));
      }
      return rows;
    }
    if (state.from === schema.whopAccounts) return accountRows;
    // Task #15: the in-flight withdrawal reservation total.
    if (state.from === schema.creatorWithdrawals) return [{ total: reserved }];
    return [];
  }, log);
}

const earning = (over = {}) => {
  const netAmountMinor = over.netAmountMinor ?? BigInt(0);
  return {
    status: "available",
    netAmountMinor,
    /* Task #17 fields. A gross consistent with a 20% fee and NOTHING refunded,
     * so `remainingCreatorNet` returns the full net and every assertion written
     * before Task #17 still describes the same arithmetic. */
    grossAmountMinor: (netAmountMinor * BigInt(10000)) / BigInt(8000),
    platformFeeBps: 2000,
    refundedGrossMinor: BigInt(0),
    holdUntil: PAST,
    frozenByDispute: false,
    currency: "usd",
    ...over,
  };
};

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
  const r = await position.reserveFromPosition(db, "uid_4", "sandbox", BigInt(5000), "usd");
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
  const r2 = await position.reserveFromPosition(db2, "uid_4", "sandbox", BigInt(10001), "usd");
  check("one minor unit over the balance is refused",
    r2.ok === false && r2.reason === "insufficient_available");
  check("the refusal says what was available",
    r2.availableMinor === BigInt(10000));

  const db3 = dbWith({ ledgerTotal: "-10000" });
  const r3 = await position.reserveFromPosition(db3, "uid_4", "sandbox", BigInt(10000), "usd");
  check("exactly the balance is allowed", r3.ok === true);

  // Held money is not reservable, even though it is owed.
  const db4 = dbWith({
    ledgerTotal: "-10000",
    rows: [earning({ status: "held", netAmountMinor: BigInt(10000), holdUntil: FUTURE })],
  });
  const r4 = await position.reserveFromPosition(db4, "uid_4", "sandbox", BigInt(1), "usd");
  check("money still on hold cannot be reserved", r4.ok === false);

  // An inconsistent position refuses rather than guessing.
  const db5 = dbWith({ ledgerTotal: "500" });
  const r5 = await position.reserveFromPosition(db5, "uid_4", "sandbox", BigInt(1), "usd");
  check("an inconsistent position refuses the reservation",
    r5.ok === false && r5.reason === "position_inconsistent");

  const db6 = dbWith({ ledgerTotal: "-10000", accountRows: [] });
  const r6 = await position.reserveFromPosition(db6, "uid_4", "sandbox", BigInt(1), "usd");
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
    // A DISTINCT query means one of two different things now: the creator list,
    // or the currency probe that decides which denomination the position is in.
    // Told apart by the column asked for, exactly as the real queries are.
    if (state.kind === "selectDistinct") {
      return state.fields?.currency ? [{ currency: "usd" }] : [{ firebaseUid: "uid_k" }];
    }
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
    // A DISTINCT query means one of two different things now: the creator list,
    // or the currency probe that decides which denomination the position is in.
    // Told apart by the column asked for, exactly as the real queries are.
    if (state.kind === "selectDistinct") {
      return state.fields?.currency ? [{ currency: "usd" }] : [{ firebaseUid: "uid_n" }];
    }
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


section("K. The payable is summed in ONE currency, never across them");

/* THE BUG THIS SECTION EXISTS FOR. `ledgerPayableMinor` filtered the account,
 * the creator and the environment — and not the currency. It summed every
 * `creator_payable` leg the creator had into one bigint, so 1000 EUR-cents plus
 * 1000 USD-cents came back as 2000 of nothing. That figure is the cap a transfer
 * is checked against.
 *
 * Twenty lines below it, the earning loop was already skipping rows in another
 * currency with a comment explaining that they cannot be added — while the
 * ledger figure it was subtracted from added them. The two halves of one
 * subtraction disagreed about what money is.
 *
 * `ledgerByCurrency` in the fake answers from the WHERE clause it is handed, so
 * a query that forgot the predicate reads zero and these assertions fail. They
 * cannot pass by accident. */

{
  /* A creator owed $100 and €50, with matching earning rows in both. */
  const mixedRows = [
    earning({ netAmountMinor: BigInt(10000), currency: "usd" }),
    earning({ netAmountMinor: BigInt(5000), currency: "eur" }),
  ];
  const mixedDb = () => dbWith({
    ledgerByCurrency: { usd: "-10000", eur: "-5000" },
    ledgerCurrencies: ["usd", "eur"],
    rows: mixedRows,
  });

  /* ---- THE EXPLICIT PATH: the caller names the currency ---- */

  const usd = await position.computeCreatorPositionInCurrency("uid_cur", "sandbox", mixedDb(), "usd");
  check("a USD payable is 10000 — the EUR legs are not added to it",
    usd.payableMinor === BigInt(10000));
  check("and it reports itself as usd", usd.currency === "usd");

  const eur = await position.computeCreatorPositionInCurrency("uid_cur", "sandbox", mixedDb(), "eur");
  check("a EUR payable is 5000 — the USD legs are not added to it",
    eur.payableMinor === BigInt(5000));
  check("and it reports itself as eur", eur.currency === "eur");

  check("neither is the sum of both — no arithmetic crossed the currencies",
    usd.payableMinor + eur.payableMinor === BigInt(15000) &&
    usd.payableMinor !== BigInt(15000) && eur.payableMinor !== BigInt(15000));

  /* THE PREDICATE IS REALLY IN THE QUERY, not merely implied by the answer. */
  const probe = dbWith({
    ledgerByCurrency: { usd: "-10000" },
    ledgerCurrencies: ["usd"],
    rows: [],
  });
  await position.computeCreatorPositionInCurrency("uid_cur", "sandbox", probe, "usd");
  const sumQuery = probe.__log.find(
    (q) => q.from === schema.accountingEntries && q.kind === "select",
  );
  const sumConds = flatten(sumQuery?.where);
  check("the ledger sum filters on the entry's own currency column",
    sumConds.some((c) => c.col === schema.accountingEntries.currency && c.value === "usd"));
  check("and still filters account, counterparty and environment",
    sumConds.some((c) => c.col === schema.accountingEntries.account && c.value === "creator_payable") &&
    sumConds.some((c) => c.col === schema.accountingEntries.counterpartyId && c.value === "uid_cur") &&
    sumConds.some((c) => c.col === schema.accountingTransactions.environment && c.value === "sandbox"));

  /* ENVIRONMENT ISOLATION IS UNCHANGED, and is independent of the currency:
   * same creator, same currency, other environment. */
  const prodProbe = dbWith({ ledgerByCurrency: { usd: "-700" }, ledgerCurrencies: ["usd"], rows: [] });
  const prod = await position.computeCreatorPositionInCurrency(
    "uid_cur", "production", prodProbe, "usd",
  );
  check("a production read is still scoped to production",
    flatten(prodProbe.__log.find((q) => q.from === schema.accountingEntries && q.kind === "select")?.where)
      .some((c) => c.col === schema.accountingTransactions.environment && c.value === "production"));
  check("and currency and environment are both applied, not one instead of the other",
    prod.payableMinor === BigInt(700) &&
    flatten(prodProbe.__log.find((q) => q.from === schema.accountingEntries && q.kind === "select")?.where)
      .some((c) => c.col === schema.accountingEntries.currency && c.value === "usd"));

  /* ---- PENDING IS FILTERED TO THE SAME CURRENCY AS THE PAYABLE ---- */

  /* €50 still inside its hold window, $100 released. Available must be the USD
   * payable less the USD pending only — the EUR hold must not reduce it. */
  const heldEur = [
    earning({ netAmountMinor: BigInt(10000), currency: "usd", holdUntil: PAST }),
    earning({ netAmountMinor: BigInt(5000), currency: "eur", holdUntil: FUTURE }),
  ];
  const usdWithEurHold = await position.computeCreatorPositionInCurrency(
    "uid_cur",
    "sandbox",
    dbWith({ ledgerByCurrency: { usd: "-10000", eur: "-5000" }, ledgerCurrencies: ["usd", "eur"], rows: heldEur }),
    "usd",
  );
  check("a EUR hold does not reduce the USD available",
    usdWithEurHold.availableMinor === BigInt(10000) &&
    usdWithEurHold.pendingMinor === BigInt(0));

  const eurWithEurHold = await position.computeCreatorPositionInCurrency(
    "uid_cur",
    "sandbox",
    dbWith({ ledgerByCurrency: { usd: "-10000", eur: "-5000" }, ledgerCurrencies: ["usd", "eur"], rows: heldEur }),
    "eur",
  );
  check("while the EUR position sees its own hold",
    eurWithEurHold.pendingMinor === BigInt(5000) &&
    eurWithEurHold.availableMinor === BigInt(0));

  /* THE OLD BUG, STATED AS AN ASSERTION. Payable across both currencies (15000)
   * minus one currency's pending (5000) would have read 10000 available in a
   * currency the creator is owed only 5000 of. */
  check("the pre-fix figure — all-currency payable less one currency's pending — is gone",
    eurWithEurHold.availableMinor !== BigInt(10000));

  /* ---- THE RESOLVING PATH, for callers with no currency to offer ---- */

  const resolvedSingle = await position.computeCreatorPosition(
    "uid_cur",
    "sandbox",
    dbWith({
      ledgerByCurrency: { eur: "-5000" },
      ledgerCurrencies: ["eur"],
      rows: [earning({ netAmountMinor: BigInt(5000), currency: "eur" })],
    }),
  );
  check("a single-currency creator resolves to their own currency, not to usd",
    resolvedSingle.currency === "eur" && resolvedSingle.payableMinor === BigInt(5000));
  check("and is not flagged — one currency is not an inconsistency",
    resolvedSingle.inconsistency === null);

  const resolvedMixed = await position.computeCreatorPosition("uid_cur", "sandbox", mixedDb());
  check("a MIXED creator is flagged rather than silently reported in one currency",
    resolvedMixed.inconsistency === "mixed_currency");
  check("the figures it does return belong to exactly one currency, not the sum",
    resolvedMixed.payableMinor !== BigInt(15000) &&
    (resolvedMixed.currency === "eur" || resolvedMixed.currency === "usd"));
  check("and the pick is deterministic — alphabetically first, so two reads agree",
    resolvedMixed.currency === "eur" &&
    (await position.computeCreatorPosition("uid_cur", "sandbox", mixedDb())).currency === "eur");

  /* NO DEFAULT CURRENCY. A creator with nothing has no denomination. */
  const empty = await position.computeCreatorPosition(
    "uid_new", "sandbox", dbWith({ ledgerCurrencies: [], rows: [] }),
  );
  check("a creator with no earnings and no legs has a NULL currency, not usd",
    empty.currency === null);
  check("and a genuine, consistent zero — an empty position is not a fault",
    empty.payableMinor === BigInt(0) && empty.availableMinor === BigInt(0) &&
    empty.inconsistency === null);

  /* UNSUPPORTED FAILS CLOSED. `whop_usd` is a real Whop value — internal
   * credits, not an ISO currency — so it cannot be scaled to minor units. */
  const unsupported = await position.computeCreatorPosition(
    "uid_cur",
    "sandbox",
    dbWith({ ledgerCurrencies: ["whop_usd"], rows: [earning({ currency: "whop_usd" })] }),
  );
  check("a stored currency this build cannot scale is refused, not skipped",
    unsupported.inconsistency === "unsupported_currency" &&
    unsupported.payableMinor === BigInt(0));

  const explicitlyUnsupported = await position.computeCreatorPositionInCurrency(
    "uid_cur", "sandbox", mixedDb(), "whop_usd",
  );
  check("and a caller asking for one explicitly is refused too",
    explicitlyUnsupported.inconsistency === "unsupported_currency" &&
    explicitlyUnsupported.currency === null);

  /* A PADDED CODE IS THE SAME CURRENCY. `char(3)` pads on storage, so a leg
   * read back as "usd " must not look like a different denomination. */
  const padded = await position.computeCreatorPositionInCurrency(
    "uid_cur",
    "sandbox",
    dbWith({
      ledgerByCurrency: { usd: "-10000" },
      ledgerCurrencies: ["usd "],
      rows: [earning({ netAmountMinor: BigInt(10000), currency: "usd " })],
    }),
    "usd",
  );
  check("a padded stored code still matches its own currency",
    padded.payableMinor === BigInt(10000) && padded.earnedMinor === BigInt(10000));

  /* ---- ELIGIBILITY USES THE CURRENCY-SPECIFIC FIGURE ---- */

  /* The reservation is the admin transfer's cap. A creator owed €50 and $100
   * must not have a $100 request covered by the EUR half, nor the reverse. */
  const reserveDb = () => dbWith({
    ledgerByCurrency: { usd: "-10000", eur: "-5000" },
    ledgerCurrencies: ["usd", "eur"],
    rows: mixedRows,
  });

  const okUsd = await position.reserveFromPosition(
    reserveDb(), "uid_cur", "sandbox", BigInt(10000), "usd",
  );
  check("a USD request up to the USD payable is reserved",
    okUsd.ok === true && okUsd.position.currency === "usd");

  const overEur = await position.reserveFromPosition(
    reserveDb(), "uid_cur", "sandbox", BigInt(10000), "eur",
  );
  check("the same amount in EUR is REFUSED — the USD balance cannot cover it",
    overEur.ok === false && overEur.reason === "insufficient_available");
  check("and the refusal reports the EUR figure, not the combined one",
    overEur.ok === false && overEur.availableMinor === BigInt(5000));

  const okEur = await position.reserveFromPosition(
    reserveDb(), "uid_cur", "sandbox", BigInt(5000), "eur",
  );
  check("a EUR request within the EUR payable is reserved",
    okEur.ok === true && okEur.position.currency === "eur");

  const unsupportedReserve = await position.reserveFromPosition(
    reserveDb(), "uid_cur", "sandbox", BigInt(1), "whop_usd",
  );
  check("reserving in an unsupported currency is refused as inconsistent",
    unsupportedReserve.ok === false && unsupportedReserve.reason === "position_inconsistent");

  /* THE RESERVATION NEVER RESOLVES THE CURRENCY FOR ITSELF. It must use the one
   * it was given, or a request in one currency could be capped by another. */
  const reserveProbe = reserveDb();
  await position.reserveFromPosition(reserveProbe, "uid_cur", "sandbox", BigInt(1), "eur");
  check("the reservation's ledger sum is filtered to the currency it was GIVEN",
    flatten(reserveProbe.__log.find((q) => q.from === schema.accountingEntries && q.kind === "select")?.where)
      .some((c) => c.col === schema.accountingEntries.currency && c.value === "eur"));
  check("and it takes the row lock before reading, as it always did",
    reserveProbe.__log.some((q) => q.from === schema.whopAccounts && q.lock === "update"));

  /* ---- NO DEFAULT-TO-USD PATH REMAINS ---- */

  const posSrc = readFileSync("src/lib/server/creator-position.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no code path defaults a currency to usd",
    !/\?\?\s*"usd"/.test(posSrc) && !/\|\|\s*"usd"/.test(posSrc));
  check("the currency is no longer taken from whichever row came back first",
    !/rows\.find\(Boolean\)/.test(posSrc));
  check("the ledger sum cannot be reached without a currency",
    /async function ledgerPayableMinor\([\s\S]{0,220}currency: string,\s*\)/.test(posSrc));
  check("and it applies that currency to the entry column",
    /eq\(schema\.accountingEntries\.currency, currency\)/.test(posSrc));
  check("the resolver reads BOTH the earning rows and the payable legs",
    /selectDistinct[\s\S]{0,400}creatorEarnings[\s\S]{0,900}selectDistinct[\s\S]{0,400}accountingEntries/.test(posSrc));
}

section("L. Mixed currency is surfaced to the reconciler, not hidden");

{
  const recon = loadModule("src/lib/server/creator-earnings-reconcile.ts", {
    "drizzle-orm": drizzle,
    "@/lib/db": { getDb: () => currentDb, schema },
    "./creator-position": position,
  });

  /* A creator with legs in two currencies. The (B) payable-vs-rows comparison
   * cannot be made — neither side describes the whole position — so reporting
   * a `payable_mismatch` would send an operator chasing an accounting fault
   * when the real problem is the denomination. */
  currentDb = makeDb((state) => {
    if (state.kind === "selectDistinct") {
      if (state.fields?.currency) {
        return state.from === schema.accountingEntries
          ? [{ currency: "usd" }, { currency: "eur" }]
          : [{ currency: "usd" }, { currency: "eur" }];
      }
      return [{ firebaseUid: "uid_mixed" }];
    }
    if (state.from === schema.accountingEntries) return [{ total: "-10000" }];
    if (state.from === schema.creatorEarnings) {
      return [
        earning({ netAmountMinor: BigInt(10000), currency: "usd" }),
        earning({ netAmountMinor: BigInt(5000), currency: "eur" }),
      ];
    }
    return [];
  });

  const out = await recon.reconcileCreatorEarnings("sandbox");
  check("a mixed-currency creator is reported as such",
    out.ok && out.report.findings.some((f) => f.check === "mixed_currency_payable" &&
      f.firebaseUid === "uid_mixed"));
  check("and NOT as a payable mismatch, which would be the wrong diagnosis",
    out.ok && !out.report.findings.some((f) => f.check === "payable_mismatch"));

  /* THE CREATOR-FACING API ALREADY REFUSES ON ANY INCONSISTENCY, so mixed
   * currency needs no route change to stop being served as a balance. */
  const routeSrc = readFileSync("src/app/api/creator/earnings/route.ts", "utf8");
  check("the creator balance route refuses to serve an inconsistent position",
    /if \(balance\.inconsistency\)/.test(routeSrc) &&
    /balance_unavailable/.test(routeSrc));
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
