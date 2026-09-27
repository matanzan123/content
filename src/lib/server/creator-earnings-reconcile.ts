import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { computeCreatorPosition } from "./creator-position";

/* ==========================================================================
   RECONCILIATION — does anyone's money still add up?

   WHY THIS EXISTS AT ALL. Until now nothing compared the earning rows against
   the ledger. Each side was individually plausible and they disagreed by the
   whole value of every admin transfer ever made, and no query in the codebase
   would have shown it. A double-entry ledger that is never reconciled is a
   very tidy way of being wrong.

   THIS MODULE IS READ-ONLY. It reports; it never repairs. An automatic
   corrective write against books that are already known to be inconsistent is
   how a small discrepancy becomes an unauditable one. Every finding here is
   for a human.

   EVERY QUERY IS ENVIRONMENT-SCOPED, explicitly and at the call site. Sandbox
   test money and real earnings living under the same firebase uid is not a
   hypothetical — it is the normal state of any developer's account — and a
   reconciler that mixed them would invent discrepancies that do not exist and
   hide the ones that do.
   ========================================================================== */

export type ReconciliationFinding =
  /** (A) An earning exists whose revenue-split journal never posted. */
  | {
      check: "journal_missing";
      firebaseUid: string;
      earningId: string;
      netAmountMinor: string;
    }
  /** (B) The ledger obligation and the earning rows disagree. */
  | {
      check: "payable_mismatch";
      firebaseUid: string;
      ledgerPayableMinor: string;
      earningsOutstandingMinor: string;
      deltaMinor: string;
    }
  /** (C) We owe a negative amount: more was paid out than was ever credited. */
  | { check: "negative_payable"; firebaseUid: string; payableMinor: string }
  /**
   * (C2) The creator holds money in more than one currency, so no single
   * payable figure describes what they are owed and the (B) comparison below
   * cannot be made. Reported rather than skipped silently: the position helper
   * refuses to pay out against it, and an operator needs to know why.
   */
  | { check: "mixed_currency_payable"; firebaseUid: string; currency: string | null }
  /** (D) A `creator_payable` leg keyed to something that is not a creator. */
  | {
      check: "unknown_counterparty";
      counterpartyId: string;
      entryCount: number;
      totalMinor: string;
    }
  /** (E) A transfer that moved money with no journal behind it. */
  | {
      check: "transfer_unjournalled";
      transferId: string;
      status: string;
      amountMinor: string;
    };

export type ReconciliationReport = {
  environment: "sandbox" | "production";
  checkedAt: string;
  findings: ReconciliationFinding[];
};

export type ReconciliationResult =
  | { ok: true; report: ReconciliationReport }
  /**
   * `db_unavailable` — no database.
   * `unconfigured` — the environment could not be resolved from server
   * configuration, so there is no scope to reconcile within. Named separately
   * because an operator reading "database unavailable" would go looking at the
   * wrong thing entirely.
   */
  | { ok: false; reason: "db_unavailable" | "unconfigured" };

/**
 * Runs every check for one environment.
 *
 * `environment` is a parameter rather than being read from `process.env`
 * inside, so an operator can reconcile sandbox from a production process
 * without the answer silently describing the wrong world.
 */
export async function reconcileCreatorEarnings(
  environment: "sandbox" | "production",
  options: { firebaseUid?: string } = {},
): Promise<ReconciliationResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const findings: ReconciliationFinding[] = [];

  /* --- (A) Earnings whose journal never posted ---------------------------
     `recordCreatorEarning` deliberately KEEPS the earning row when the
     revenue-split posting is refused, leaving `accounting_transaction_id`
     null rather than discarding a real economic fact. That choice is only
     safe if something eventually looks. This is that something: a null here
     means the creator is owed money the ledger has never heard of, so the
     canonical payable under-reports them.                                 */
  const unjournalled = await db
    .select({
      firebaseUid: schema.creatorEarnings.firebaseUid,
      earningId: schema.creatorEarnings.earningId,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.environment, environment),
        isNull(schema.creatorEarnings.accountingTransactionId),
        // A reversed earning that never posted is consistent, not broken.
        sql`${schema.creatorEarnings.status} <> 'reversed'`,
        options.firebaseUid
          ? eq(schema.creatorEarnings.firebaseUid, options.firebaseUid)
          : undefined,
      ),
    );

  for (const row of unjournalled) {
    findings.push({
      check: "journal_missing",
      firebaseUid: row.firebaseUid,
      earningId: row.earningId,
      netAmountMinor: row.netAmountMinor.toString(),
    });
  }

  /* --- (B) and (C) Per-creator position checks ---------------------------
     The ledger obligation should equal what the earning rows still say is
     outstanding: everything earned that has been neither transferred nor
     reversed. A gap in either direction is a real discrepancy, and the sign
     says which way: a ledger LOWER than the rows is the classic symptom of
     money paid out without the rows being settled.

     PARTIAL REFUNDS ARE ALREADY ACCOUNTED FOR. `earnedMinor` and
     `transferredMinor` come from `computeCreatorPosition`, which reports the
     REMAINING creator share of each earning rather than its original net — so a
     partly refunded earning contributes only what is still owed, exactly as the
     ledger does. Comparing original nets here would flag every partial refund
     as a discrepancy forever.                                              */
  const creators = options.firebaseUid
    ? [{ firebaseUid: options.firebaseUid }]
    : await db
        .selectDistinct({ firebaseUid: schema.creatorEarnings.firebaseUid })
        .from(schema.creatorEarnings)
        .where(eq(schema.creatorEarnings.environment, environment));

  for (const { firebaseUid } of creators) {
    const position = await computeCreatorPosition(firebaseUid, environment, db);

    // `computeCreatorPosition` floors a negative payable at zero for display,
    // so the raw figure is recovered from the flag it sets rather than from
    // the clamped number.
    if (position.inconsistency === "negative_payable") {
      findings.push({
        check: "negative_payable",
        firebaseUid,
        payableMinor: position.payableMinor.toString(),
      });
      continue;
    }

    /* MIXED OR UNREADABLE CURRENCY: the (B) comparison below subtracts a
     * ledger figure from a rows figure, and neither describes the whole
     * position when more than one currency is in play. Reporting it and moving
     * on beats emitting a `payable_mismatch` that an operator would chase as an
     * accounting fault when the real problem is the denomination. */
    if (
      position.inconsistency === "mixed_currency" ||
      position.inconsistency === "unsupported_currency"
    ) {
      findings.push({
        check: "mixed_currency_payable",
        firebaseUid,
        currency: position.currency,
      });
      continue;
    }

    const outstanding = position.earnedMinor - position.transferredMinor;
    const delta = position.payableMinor - outstanding;
    if (delta !== BigInt(0)) {
      findings.push({
        check: "payable_mismatch",
        firebaseUid,
        ledgerPayableMinor: position.payableMinor.toString(),
        earningsOutstandingMinor: outstanding.toString(),
        deltaMinor: delta.toString(),
      });
    }
  }

  /* --- (D) `creator_payable` legs keyed to a non-creator ------------------
     THIS IS THE COUNTERPARTY BUG'S OWN DETECTOR. Transfers used to debit
     `creator_payable` keyed by the Whop account id (`biz_...`) while earnings
     credited it by firebase uid, so the two halves of one creator's balance
     sat under different keys and no single query could see both. Any leg
     whose counterparty is not a known creator uid is that bug, a legacy row
     from before the fix, or a new one — all three need a human.            */
  const strayLegs = await db
    .select({
      counterpartyId: schema.accountingEntries.counterpartyId,
      entryCount: sql<number>`count(*)::int`,
      totalMinor: sql<string>`sum(${schema.accountingEntries.amountMinor})::text`,
    })
    .from(schema.accountingEntries)
    .innerJoin(
      schema.accountingTransactions,
      eq(schema.accountingEntries.transactionId, schema.accountingTransactions.transactionId),
    )
    .leftJoin(
      schema.users,
      eq(schema.accountingEntries.counterpartyId, schema.users.firebaseUid),
    )
    .where(
      and(
        eq(schema.accountingEntries.account, "creator_payable"),
        eq(schema.accountingTransactions.environment, environment),
        isNull(schema.users.firebaseUid),
      ),
    )
    .groupBy(schema.accountingEntries.counterpartyId);

  for (const row of strayLegs) {
    findings.push({
      check: "unknown_counterparty",
      counterpartyId: row.counterpartyId ?? "(null)",
      entryCount: row.entryCount,
      totalMinor: row.totalMinor ?? "0",
    });
  }

  /* --- (E) Money that moved with no journal behind it ---------------------
     The transfer path posts the journal BEFORE calling the provider and
     refuses to call at all if the posting fails, so a settled transfer with
     no `accounting_transaction_id` should be impossible. That is exactly why
     it is worth checking: if it ever appears, the invariant the whole payout
     design rests on has been broken somewhere.                             */
  const unjournalledTransfers = await db
    .select({
      transferId: schema.creatorTransfers.transferId,
      status: schema.creatorTransfers.status,
      amountMinor: schema.creatorTransfers.amountMinor,
    })
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.environment, environment),
        isNull(schema.creatorTransfers.accountingTransactionId),
        // Only states in which money actually left. A `pending` or `failed`
        // row with no journal is the correct, expected shape.
        sql`${schema.creatorTransfers.status} in ('submitted', 'completed')`,
      ),
    );

  for (const row of unjournalledTransfers) {
    findings.push({
      check: "transfer_unjournalled",
      transferId: row.transferId,
      status: row.status,
      amountMinor: row.amountMinor.toString(),
    });
  }

  return {
    ok: true,
    report: { environment, checkedAt: new Date().toISOString(), findings },
  };
}
