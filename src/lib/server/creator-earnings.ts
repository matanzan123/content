import "server-only";

import { and, eq, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  computeEarningsBreakdown,
  computeHoldUntil,
} from "./creator-earnings-policy";
import { postRevenueSplit, postRevenueSplitReversal } from "./accounting/revenue-split-posting";
import { readSettlementAllocation } from "./accounting/settlement-allocation";
import { getWhopEnvironment } from "./whop-payments";
import { violatesConstraint } from "./db-errors";
import {
  capRefundedGross,
  computeCumulativeRefundDelta,
  isFullyRefunded,
} from "./creator-earnings-policy";
import { computeCreatorPosition, type CreatorPosition } from "./creator-position";

/* ==========================================================================
   CREATOR EARNINGS — DB operations and the main recording flow.

   THIS IS THE AUTHORITATIVE SOURCE for what a creator is owed. Do NOT compute
   creator balances from payment totals, webhook counts, or any UI sum.

   THE RECORDING FLOW (one brand payment → one creator share):
     1. Compute breakdown (gross → fee → net) using policy module
     2. Write `creator_earnings` row (status: `held`)
     3. Write accounting journal entry (`revenue_split`)
     4. Link accounting transaction id back to the row

   IDEMPOTENCY: a unique index on (whop_payment_id, firebase_uid) means a
   repeated call for the same payment + creator is a no-op (returns the
   existing row). The journal has its own idempotency key.

   DISPUTE IMPACT:
     - `freezeForDispute(paymentId, disputeId)` marks all `held`/`available`
       earnings for that payment as frozen. Called by the dispute.opened handler.
     - `unfreezeFromDispute(paymentId)` clears the freeze. Called on win.
     - `reverseForDispute(paymentId)` reverses all earnings. Called on loss.

   REFUND IMPACT:
     - `reverseForRefund(paymentId)` reverses all `held`/`available` earnings.
       A `transferred` earning is NOT reversed here — the transfer happened
       and the platform absorbs the loss.

   HOLD SWEEP:
     - `releaseHeldEarnings()` promotes all `held` rows past their hold_until
       that are not frozen. Safe to call repeatedly (idempotent).
   ========================================================================== */

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

export type RecordEarningInput = {
  firebaseUid: string;
  whopPaymentId: string;
  /**
   * ASSERTION ONLY. Compared against the order the settlement was posted
   * against; never used to find or choose one.
   */
  orderId?: string;
  /**
   * ASSERTION ONLY, and named so. The gross comes from the settlement's own
   * suspense credit — see `readSettlementAllocation`. When supplied this is
   * compared against that figure and a mismatch is refused, which is how a
   * caller working from a stale number finds out instead of silently allocating
   * it. It is NOT the accounting source of truth and cannot become one.
   */
  expectedGrossAmountMinor?: bigint;
  /** ASSERTION ONLY. The currency comes from the settlement transaction. */
  expectedCurrency?: string;
  environment: "sandbox" | "production";
  paymentSettledAt: Date;
  description?: string;
};

export type RecordEarningResult =
  | { ok: true; earningId: string; alreadyRecorded: boolean }
  | {
      ok: false;
      reason:
        | "db_unavailable"
        | "journal_refused"
        | "db_error"
        /** Nothing settled for this payment in this environment. */
        | "settlement_not_found"
        /** Two settlements name this payment; which one is right is unknowable. */
        | "ambiguous_settlement"
        /** The settlement's currency is not one we can do exact minor units in. */
        | "unsupported_currency"
        /** A settlement leg's currency disagrees with its own header. */
        | "currency_mismatch"
        /** No suspense credit to allocate. */
        | "suspense_unreadable"
        /** This settlement's suspense has already been moved by a split. */
        | "already_allocated"
        /** The caller's gross does not match the settlement's suspense credit. */
        | "gross_mismatch"
        /** The caller's currency does not match the settlement's. */
        | "currency_assertion_failed"
        /** The caller named an order the settlement was not posted against. */
        | "order_mismatch";
      detail?: string;
    };

export type GetBalanceResult =
  | { ok: true; balance: CreatorPosition }
  | { ok: false; reason: "db_unavailable" };

/* -------------------------------------------------------------------------
   Record a new earning
   ------------------------------------------------------------------------- */

/**
 * Records one creator's share from a settled brand payment.
 *
 * Idempotent: a second call for the same payment + creator returns
 * `{ ok: true, alreadyRecorded: true }` without writing again.
 *
 * ADMIN USE ONLY in this build. The trigger will be a campaign settlement
 * job or an admin action — not a creator-facing call.
 */
export async function recordCreatorEarning(
  input: RecordEarningInput,
): Promise<RecordEarningResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };


  const holdUntil = computeHoldUntil(input.paymentSettledAt);

  // IDEMPOTENCY CHECK, SCOPED TO THE ENVIRONMENT THIS ROW WILL BE WRITTEN IN.
  //
  // The predicate matches `uniq_creator_earnings_payment_creator` exactly —
  // (whop_payment_id, firebase_uid, environment) after migration 0011. Before
  // that migration the index omitted environment, so scoping this read would
  // have made it miss a cross-environment row, the INSERT would then hit the
  // unique violation, and the catch below would report `db_error` instead of
  // `alreadyRecorded`. Index and read-back have to agree.
  //
  // `input.environment` and NOT getWhopEnvironment(): it must be the same value
  // the INSERT writes, or the check and the write would disagree about which
  // row they mean. It is typed to the enum and its only caller supplies
  // `resolvePlatformConfig().config.environment`, never a request body.
  const [existing] = await db
    .select({ earningId: schema.creatorEarnings.earningId })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        eq(schema.creatorEarnings.firebaseUid, input.firebaseUid),
        eq(schema.creatorEarnings.environment, input.environment),
      ),
    )
    .limit(1);

  if (existing) return { ok: true, earningId: existing.earningId, alreadyRecorded: true };

  /* ORDER MATTERS, AND THIS IS WHY THE SETTLEMENT IS READ HERE AND NOT EARLIER.
   *
   * The idempotency check above answers a repeated call for an earning that
   * already exists, and it must keep answering it without consulting the
   * settlement. Reading the settlement first would make a re-record fail as
   * `already_allocated` — its own revenue split, correctly found — turning an
   * idempotent no-op into an error the caller cannot act on.
   *
   * So: existing row wins, and only a genuinely NEW earning asks what may be
   * allocated. `already_allocated` then means what it says — some OTHER
   * creator's split has already moved this settlement's suspense. */
  /* THE AUTHORITATIVE AMOUNT AND CURRENCY, FROM THE POSTED SETTLEMENT.
   *
   * Not from the request. The suspense credit the settlement created IS what
   * may be allocated — economically `total - tax`, because the settlement
   * already put the tax on `tax_payable`. Reading it back means no caller can
   * allocate a number the books do not agree with, and there is no tax
   * arithmetic here to keep in step with the tax rules.
   *
   * Every refusal it can return is a state in which no honest allocation
   * exists, so they are passed straight through rather than collapsed. */
  const settlement = await readSettlementAllocation(input.whopPaymentId, input.environment);
  if (!settlement.ok) {
    return { ok: false, reason: settlement.reason, detail: settlement.detail };
  }
  const { allocatableMinor, currency, orderId: settledOrderId } = settlement.allocation;

  /* THE REQUEST'S FIGURES ARE ASSERTIONS, checked against the settlement and
   * then discarded. A mismatch is refused by name so a caller working from a
   * stale or hand-typed number is told which of the two disagreed, rather than
   * having its number quietly ignored — or, as before, quietly used. */
  if (
    input.expectedGrossAmountMinor !== undefined &&
    input.expectedGrossAmountMinor !== allocatableMinor
  ) {
    return {
      ok: false,
      reason: "gross_mismatch",
      detail: `requested ${input.expectedGrossAmountMinor.toString()}, settlement ${allocatableMinor.toString()}`,
    };
  }

  if (input.expectedCurrency !== undefined) {
    const asserted = input.expectedCurrency.trim().toLowerCase();
    if (asserted !== currency) {
      return {
        ok: false,
        reason: "currency_assertion_failed",
        detail: `requested ${asserted}, settlement ${currency}`,
      };
    }
  }

  /* THE ORDER, when the caller names one. A request pointing at a different
   * order than the settlement was posted against is describing a different
   * economic event, and allocating it would attribute one payment's money to
   * another campaign. Only checked when the settlement itself recorded an
   * order — an older settlement without one has nothing to contradict. */
  if (input.orderId !== undefined && settledOrderId !== null && input.orderId !== settledOrderId) {
    return {
      ok: false,
      reason: "order_mismatch",
      detail: `requested ${input.orderId}, settlement ${settledOrderId}`,
    };
  }

  /* THE FEE FORMULA IS UNTOUCHED — Task #17 policy, applied to an authoritative
   * gross instead of a supplied one. The split of that gross into platform fee
   * and creator net is not this change's business. */
  const breakdown = computeEarningsBreakdown(allocatableMinor, currency);

  // Write the earning row
  let earningId: string;
  try {
    const [inserted] = await db
      .insert(schema.creatorEarnings)
      .values({
        firebaseUid: input.firebaseUid,
        environment: input.environment,
        whopPaymentId: input.whopPaymentId,
        // The SETTLEMENT's order, not the request's. They are proven equal above
        // when the caller named one, and the settlement is the authority when it
        // did not.
        orderId: settledOrderId ?? input.orderId ?? null,
        grossAmountMinor: breakdown.grossAmountMinor,
        platformFeeMinor: breakdown.platformFeeMinor,
        netAmountMinor: breakdown.netAmountMinor,
        currency: breakdown.currency,
        platformFeeBps: breakdown.platformFeeBps,
        status: "held",
        holdUntil,
        frozenByDispute: false,
        paymentSettledAt: input.paymentSettledAt,
        description: input.description ?? null,
      })
      .returning({ earningId: schema.creatorEarnings.earningId });
    earningId = inserted.earningId;
  } catch (err) {
    /* Unique constraint race (concurrent insert).
     *
     * READ FROM THE CAUSE, not from this error's message: drizzle's own message
     * is the rendered SQL, so `err.message.includes(...)` was never true and this
     * race could not resolve to the earning that already existed — a concurrent
     * duplicate reported a storage failure instead of the idempotent answer. */
    const isConflict = violatesConstraint(err, "uniq_creator_earnings_payment_creator");
    if (isConflict) {
      const [row] = await db
        .select({ earningId: schema.creatorEarnings.earningId })
        .from(schema.creatorEarnings)
        .where(
          and(
            eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
            eq(schema.creatorEarnings.firebaseUid, input.firebaseUid),
            eq(schema.creatorEarnings.environment, input.environment),
          ),
        )
        .limit(1);
      if (row) return { ok: true, earningId: row.earningId, alreadyRecorded: true };
    }
    return { ok: false, reason: "db_error" };
  }

  // Write the revenue split journal entry
  const journalResult = await postRevenueSplit({
    paymentId: input.whopPaymentId,
    creatorFirebaseUid: input.firebaseUid,
    breakdown,
    description: input.description ?? `Creator payout share — ${input.whopPaymentId}`,
    environment: input.environment,
  });

  if (!journalResult.ok && journalResult.reason !== "already_posted") {
    // The earning row is written but the journal failed. This is observable
    // (accountingTransactionId stays null) and must be investigated. We do
    // not delete the earning row — that would create a silent gap.
    return { ok: false, reason: "journal_refused" };
  }

  if (journalResult.ok) {
    await db
      .update(schema.creatorEarnings)
      .set({ accountingTransactionId: journalResult.transactionId, updatedAt: new Date() })
      .where(eq(schema.creatorEarnings.earningId, earningId));
  }

  return { ok: true, earningId, alreadyRecorded: false };
}

/* -------------------------------------------------------------------------
   Balance query
   ------------------------------------------------------------------------- */

/**
 * Returns the creator's current position across all states.
 *
 * THIS NO LONGER COMPUTES ANYTHING. It delegates to `computeCreatorPosition`,
 * and that delegation is the fix, not an indirection.
 *
 * It used to sum `creator_earnings` rows on its own while the ledger kept a
 * `creator_payable` balance built from the same events. Two sources, one
 * question, and nothing reconciling them — so a Task #13 admin transfer, which
 * debits the ledger and touches no earning row, left this function still
 * reporting the full balance. The creator saw money that had already been sent,
 * and could withdraw it a second time through Task #15.
 *
 * The name and shape are kept so callers do not change, but there is now
 * exactly one implementation of "what is this creator owed". See
 * `creator-position.ts` for why the ledger is the authority.
 */
export async function getCreatorBalance(firebaseUid: string): Promise<GetBalanceResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  // ENVIRONMENT-SCOPED. One creator has rows in both environments under the
  // same uid, so an unscoped read would report sandbox test money alongside
  // real earnings. The number a creator sees, and the number a withdrawal is
  // checked against, must describe one environment.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "db_unavailable" };

  const position = await computeCreatorPosition(firebaseUid, environment, db);
  return { ok: true, balance: position };
}

/* -------------------------------------------------------------------------
   Dispute lifecycle
   ------------------------------------------------------------------------- */

/** Freeze all non-reversed earnings for a payment when a dispute opens. */
export async function freezeForDispute(
  whopPaymentId: string,
  whopDisputeId: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  // Environment-scoped: a `whop_payment_id` can legitimately exist in both
  // environments (the unique index is per payment+creator, not per environment),
  // so an unscoped match could freeze or reverse ANOTHER environment's earning.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false };
  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        frozenByDispute: true,
        frozenByDisputeId: whopDisputeId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.creatorEarnings.whopPaymentId, whopPaymentId),
          eq(schema.creatorEarnings.environment, environment),
          // Only freeze non-reversed rows
          sql`${schema.creatorEarnings.status} != 'reversed'`,
        ),
      );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Clear dispute freeze when the dispute is won. */
export async function unfreezeFromDispute(
  whopPaymentId: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  // Environment-scoped: a `whop_payment_id` can legitimately exist in both
  // environments (the unique index is per payment+creator, not per environment),
  // so an unscoped match could freeze or reverse ANOTHER environment's earning.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false };
  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        frozenByDispute: false,
        frozenByDisputeId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.creatorEarnings.whopPaymentId, whopPaymentId),
          eq(schema.creatorEarnings.environment, environment),
        ),
      );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export type DisputeReverseInput = {
  whopPaymentId: string;
  /** The dispute id — the idempotency anchor for the reversal journal. */
  whopDisputeId: string;
  environment: "sandbox" | "production";
};

/** Reverse all non-transferred earnings when a dispute is lost. */
export async function reverseForDispute(
  input: DisputeReverseInput,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  // Environment-scoped: a `whop_payment_id` can legitimately exist in both
  // environments (the unique index is per payment+creator, not per environment),
  // so an unscoped match could freeze or reverse ANOTHER environment's earning.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false };

  const rows = await db
    .select({
      firebaseUid: schema.creatorEarnings.firebaseUid,
      grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
      platformFeeMinor: schema.creatorEarnings.platformFeeMinor,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      platformFeeBps: schema.creatorEarnings.platformFeeBps,
      refundedGrossMinor: schema.creatorEarnings.refundedGrossMinor,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        eq(schema.creatorEarnings.environment, environment),
        or(
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.status, "available"),
        ),
      ),
    );

  for (const row of rows) {
    const economics = {
      grossAmountMinor: row.grossAmountMinor,
      netAmountMinor: row.netAmountMinor,
      platformFeeBps: row.platformFeeBps,
    };

    /* A LOST DISPUTE UNWINDS WHATEVER IS LEFT, NOT THE WHOLE EARNING.
     *
     * This used to post a full reversal unconditionally. After Task #17 an
     * earning may already be PARTLY refunded, and returning the full net on top
     * of a refund that had already returned part of it would claw back more than
     * was ever created — a $100 earning refunded $30 and then disputed would
     * have returned $80 of creator share against $56 outstanding.
     *
     * Taking the cumulative delta to full gross returns exactly the remainder,
     * and is identical to the old behaviour on the untouched earning that was
     * previously the only case. */
    const reversal = computeCumulativeRefundDelta(
      economics,
      row.refundedGrossMinor,
      row.grossAmountMinor,
    );

    // Nothing left to unwind: already fully refunded. The status update below
    // still runs, so the row reaches `reversed` either way.
    if (reversal.totalToReturn > BigInt(0) || reversal.platformAbsorbedMinor !== BigInt(0)) {
      await postRevenueSplitReversal({
        refundOrDisputeId: input.whopDisputeId,
        creatorFirebaseUid: row.firebaseUid,
        reversal,
        currency: row.currency,
        // THE TRUSTED ENVIRONMENT, the same one the rows were read under.
        // `input.environment` was a second, caller-supplied authority: the rows
        // were selected under one environment and the journal posted under
        // another, so a disagreement would file the reversal in the wrong
        // environment's books.
        environment,
        description: `Revenue split reversal — dispute lost ${input.whopDisputeId}`,
      });
    }
  }

  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        status: "reversed",
        frozenByDispute: false,
        reversedAt: new Date(),
        updatedAt: new Date(),
        // FULLY UNWOUND, RECORDED AS SUCH. Without this a refund arriving after
        // a lost dispute would compute a delta against a stale cumulative
        // figure and reverse the same money twice.
        refundedGrossMinor: sql`${schema.creatorEarnings.grossAmountMinor}`,
      })
      .where(
        and(
          eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        eq(schema.creatorEarnings.environment, environment),
          // A transferred earning is NOT reversed here — the platform absorbs.
          or(
            eq(schema.creatorEarnings.status, "held"),
            eq(schema.creatorEarnings.status, "available"),
          ),
        ),
      );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/* -------------------------------------------------------------------------
   Refund
   ------------------------------------------------------------------------- */

export type RefundReverseInput = {
  whopPaymentId: string;
  /** The refund id — the idempotency anchor for the reversal journal. */
  refundId: string;
  /** How much the customer was refunded (may be partial). */
  refundAmountMinor: bigint;
  currency: string;
  environment: "sandbox" | "production";
};

/**
 * Reverse non-transferred earnings when a payment is refunded.
 *
 * For a partial refund, each earning's reversal is pro-rated against that
 * earning's own gross amount. For a full refund (refundAmountMinor >= gross),
 * the earning is fully reversed.
 *
 * The accounting journal (`revenue_split_reversed`) is posted BEFORE the DB
 * status update. If the DB update fails, the journal stays (which is correct —
 * the money was returned and the entry must remain). The status inconsistency
 * will surface in reconciliation.
 */
export async function reverseForRefund(
  input: RefundReverseInput,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  // Environment-scoped: a `whop_payment_id` can legitimately exist in both
  // environments (the unique index is per payment+creator, not per environment),
  // so an unscoped match could freeze or reverse ANOTHER environment's earning.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false };

  const rows = await db
    .select({
      earningId: schema.creatorEarnings.earningId,
      firebaseUid: schema.creatorEarnings.firebaseUid,
      grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
      platformFeeMinor: schema.creatorEarnings.platformFeeMinor,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      platformFeeBps: schema.creatorEarnings.platformFeeBps,
      refundedGrossMinor: schema.creatorEarnings.refundedGrossMinor,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        eq(schema.creatorEarnings.environment, environment),
        /* A PARTIALLY REFUNDED EARNING IS STILL FOUND, and that is the fix.
         *
         * This filter used to be `status IN (held, available)`, and the first
         * partial refund set the row to `reversed` — so the second and third
         * refunds of the same payment matched nothing and reversed NOTHING.
         * ClipRewards kept fee revenue and the creator kept payable on a
         * payment the brand had been refunded in full.
         *
         * `reversed` is excluded because it means fully unwound; there is
         * genuinely nothing left. `transferred` is excluded because the
         * platform deliberately absorbs a refund on money already sent — that
         * rule is unchanged. Everything else remains eligible however many
         * times it has already been partly refunded. */
        or(
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.status, "available"),
        ),
      ),
    );

  for (const row of rows) {
    const economics = {
      grossAmountMinor: row.grossAmountMinor,
      netAmountMinor: row.netAmountMinor,
      platformFeeBps: row.platformFeeBps,
    };

    /* CAPPED, then posted as a DELTA between cumulative targets.
     *
     * The cap means no sequence of provider refunds can return more than this
     * earning created. The delta means the postings telescope: any split of
     * partial refunds totals exactly what one refund of the sum would, where
     * flooring each refund on its own would lose a fraction every time. */
    const previousRefundedGross = row.refundedGrossMinor;
    const newRefundedGross = capRefundedGross(
      economics,
      previousRefundedGross,
      input.refundAmountMinor,
    );

    // Already fully unwound, or a replay that adds nothing. Post no journal and
    // leave the row alone rather than writing a zero-amount transaction.
    if (newRefundedGross <= previousRefundedGross) continue;

    const reversal = computeCumulativeRefundDelta(
      economics,
      previousRefundedGross,
      newRefundedGross,
    );

    /* THE JOURNAL FIRST, then the row.
     *
     * Its economic key is the refund id, so a redelivery of the SAME refund is
     * refused by the ledger's unique constraint and cannot double-reverse. The
     * cumulative column is advanced only after the posting is accepted, so a
     * crash between them leaves the row understated — recoverable, and visible
     * to reconciliation — rather than silently swallowing a reversal. */
    const posted = await postRevenueSplitReversal({
      refundOrDisputeId: input.refundId,
      creatorFirebaseUid: row.firebaseUid,
      reversal,
      currency: row.currency,
      environment,
      description: `Revenue split reversal — refund ${input.refundId}`,
    });

    /* A REPLAY MUST NOT ADVANCE THE COLUMN, and getting this wrong was a real
     * double-count.
     *
     * `already_posted` means the ledger already holds a reversal under this
     * refund id, so `previousRefundedGross` has ALREADY absorbed this refund.
     * Adding it again moves the cumulative figure past what was actually
     * refunded — and a later genuine refund would then compute its delta from
     * an inflated base and under-reverse. The journal is refused correctly by
     * its unique economic key either way; it is the column that must not move.
     *
     * THE CRASH WINDOW THIS LEAVES, stated honestly: if the process dies
     * between a successful posting and this update, the column stays behind and
     * a retry sees `already_posted` and skips it. The figure is then understated
     * and reconciliation reports it, which is the trade the module header
     * already describes for the journal-before-row ordering. The alternative —
     * advancing on a replay — double-counts on every ordinary webhook
     * redelivery, which is routine rather than exceptional. Total exposure stays
     * bounded either way, because no cumulative target can exceed the amounts
     * the earning created. */
    if (!posted.ok) continue;

    const fullyRefunded = isFullyRefunded(economics, newRefundedGross);

    /* PARTIAL REFUNDS DO NOT REVERSE THE EARNING.
     *
     * Only a cumulative refund reaching the earning's whole gross may. The
     * status guard stays in SQL so a row that reached a terminal state between
     * the read and this write is not walked back. */
    await db
      .update(schema.creatorEarnings)
      .set({
        refundedGrossMinor: newRefundedGross,
        updatedAt: new Date(),
        ...(fullyRefunded ? { status: "reversed" as const, reversedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(schema.creatorEarnings.earningId, row.earningId),
          eq(schema.creatorEarnings.environment, environment),
          // Not already advanced past this point by a concurrent delivery.
          eq(schema.creatorEarnings.refundedGrossMinor, previousRefundedGross),
          or(
            eq(schema.creatorEarnings.status, "held"),
            eq(schema.creatorEarnings.status, "available"),
          ),
        ),
      );
  }

  return { ok: true };
}


/* -------------------------------------------------------------------------
   Hold sweep
   ------------------------------------------------------------------------- */

/**
 * Promotes all `held` earnings past their hold_until that are not frozen.
 *
 * Safe to call repeatedly. Intended for a cron or background job;
 * the balance query also computes available dynamically, so this sweep
 * is an optimization (correct DB status) rather than a requirement.
 */
export async function releaseHeldEarnings(): Promise<{ released: number }> {
  const db = getDb();
  if (!db) return { released: 0 };
  const now = new Date();
  try {
    const result = await db
      .update(schema.creatorEarnings)
      .set({ status: "available", availableAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.frozenByDispute, false),
          lte(schema.creatorEarnings.holdUntil, now),
        ),
      )
      .returning({ earningId: schema.creatorEarnings.earningId });
    return { released: result.length };
  } catch {
    return { released: 0 };
  }
}
