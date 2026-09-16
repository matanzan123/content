import "server-only";

import { and, eq, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  computeEarningsBreakdown,
  computeHoldUntil,
  computeBalance,
  type CreatorBalance,
  type EarningStatus,
} from "./creator-earnings-policy";
import { postRevenueSplit, postRevenueSplitReversal } from "./accounting/revenue-split-posting";
import { computeRefundSplitReversal } from "./creator-earnings-policy";

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
  orderId?: string;
  grossAmountMinor: bigint;
  currency: "usd";
  environment: "sandbox" | "production";
  paymentSettledAt: Date;
  description?: string;
};

export type RecordEarningResult =
  | { ok: true; earningId: string; alreadyRecorded: boolean }
  | { ok: false; reason: "db_unavailable" | "journal_refused" | "db_error" };

export type GetBalanceResult =
  | { ok: true; balance: CreatorBalance }
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

  const breakdown = computeEarningsBreakdown(
    input.grossAmountMinor,
    input.currency,
  );
  const holdUntil = computeHoldUntil(input.paymentSettledAt);

  // Idempotency check: return early if already recorded
  const [existing] = await db
    .select({ earningId: schema.creatorEarnings.earningId })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        eq(schema.creatorEarnings.firebaseUid, input.firebaseUid),
      ),
    )
    .limit(1);

  if (existing) return { ok: true, earningId: existing.earningId, alreadyRecorded: true };

  // Write the earning row
  let earningId: string;
  try {
    const [inserted] = await db
      .insert(schema.creatorEarnings)
      .values({
        firebaseUid: input.firebaseUid,
        environment: input.environment,
        whopPaymentId: input.whopPaymentId,
        orderId: input.orderId ?? null,
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
    // Unique constraint race (concurrent insert)
    const isConflict = err instanceof Error && err.message.includes("uniq_creator_earnings_payment_creator");
    if (isConflict) {
      const [row] = await db
        .select({ earningId: schema.creatorEarnings.earningId })
        .from(schema.creatorEarnings)
        .where(
          and(
            eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
            eq(schema.creatorEarnings.firebaseUid, input.firebaseUid),
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
 * Returns the creator's current balance across all states.
 *
 * Available is computed dynamically from hold_until — a sweep job does not
 * need to have run for this to be current.
 */
export async function getCreatorBalance(firebaseUid: string): Promise<GetBalanceResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const rows = await db
    .select({
      status: schema.creatorEarnings.status,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      holdUntil: schema.creatorEarnings.holdUntil,
      frozenByDispute: schema.creatorEarnings.frozenByDispute,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(eq(schema.creatorEarnings.firebaseUid, firebaseUid));

  const balance = computeBalance(
    rows.map((r) => ({
      status: r.status as EarningStatus,
      netAmountMinor: r.netAmountMinor,
      holdUntil: r.holdUntil,
      frozenByDispute: r.frozenByDispute,
      currency: r.currency,
    })),
  );

  return { ok: true, balance };
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
  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        frozenByDispute: false,
        frozenByDisputeId: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.creatorEarnings.whopPaymentId, whopPaymentId));
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

  const rows = await db
    .select({
      firebaseUid: schema.creatorEarnings.firebaseUid,
      grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
      platformFeeMinor: schema.creatorEarnings.platformFeeMinor,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      platformFeeBps: schema.creatorEarnings.platformFeeBps,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        or(
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.status, "available"),
        ),
      ),
    );

  for (const row of rows) {
    const percentageFeeMinor = (row.grossAmountMinor * BigInt(row.platformFeeBps)) / BigInt(10_000);
    const reversal = computeRefundSplitReversal(
      { grossAmountMinor: row.grossAmountMinor, netAmountMinor: row.netAmountMinor, percentageFeeMinor },
      row.grossAmountMinor, // full reversal
    );
    await postRevenueSplitReversal({
      refundOrDisputeId: input.whopDisputeId,
      creatorFirebaseUid: row.firebaseUid,
      reversal,
      currency: row.currency,
      environment: input.environment,
      description: `Revenue split reversal — dispute lost ${input.whopDisputeId}`,
    });
  }

  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        status: "reversed",
        frozenByDispute: false,
        reversedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
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

  const rows = await db
    .select({
      firebaseUid: schema.creatorEarnings.firebaseUid,
      grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
      platformFeeMinor: schema.creatorEarnings.platformFeeMinor,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      platformFeeBps: schema.creatorEarnings.platformFeeBps,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
        or(
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.status, "available"),
        ),
      ),
    );

  for (const row of rows) {
    // Derive processing fee from stored columns (historically correct even if
    // env vars change later: platformFeeMinor = percentageFee + processingFee).
    const percentageFeeMinor = (row.grossAmountMinor * BigInt(row.platformFeeBps)) / BigInt(10_000);
    const reversal = computeRefundSplitReversal(
      { grossAmountMinor: row.grossAmountMinor, netAmountMinor: row.netAmountMinor, percentageFeeMinor },
      input.refundAmountMinor,
    );
    await postRevenueSplitReversal({
      refundOrDisputeId: input.refundId,
      creatorFirebaseUid: row.firebaseUid,
      reversal,
      currency: input.currency,
      environment: input.environment,
      description: `Revenue split reversal — refund ${input.refundId}`,
    });
  }

  try {
    await db
      .update(schema.creatorEarnings)
      .set({
        status: "reversed",
        reversedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.creatorEarnings.whopPaymentId, input.whopPaymentId),
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
