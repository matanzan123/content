import "server-only";

import { economicKey } from "./accounts";
import { postTransaction } from "./journal";
import type { EarningsBreakdown, RefundSplitReversal } from "../creator-earnings-policy";

/* ==========================================================================
   REVENUE SPLIT POSTING — server only.

   THE SECOND JOURNAL ENTRY for a settled payment. The first (payment_settled)
   moves gross → unallocated_customer_funds. This one moves those funds out
   of suspense into their economic homes.

   PRECONDITION: a payment_settled entry must exist for `paymentId` before
   this is called. This module does not check; the caller must ensure the
   settlement posting ran first.

   THE JOURNAL:

     DR  unallocated_customer_funds  [gross]   suspense clears
     CR  platform_revenue            [fee]     ClipRewards earned this
     CR  creator_payable             [net]     owed to creator

   Sum: gross - fee - net = 0 exactly (enforced by the balance constraint).

   IDEMPOTENCY KEY: whop:revenue_split:<paymentId>:<creatorFirebaseUid>
   If the same payment is split to two creators, two postings are made with
   different keys (one per creator). A single brand payment → single creator
   payout is the base case.

   WHAT THIS MODULE DOES NOT DO:
   - Does not write `creator_earnings` rows. That is `creator-earnings.ts`.
   - Does not validate that gross matches the settled amount. That is the
     caller's responsibility — it is the caller who knows what portion to
     allocate.
   - Does not post provider fees — those are already in the payment_settled
     journal from `whop-payment-posting.ts`.
   ========================================================================== */

export type RevenueSplitPostingInput = {
  paymentId: string;
  /** Used in the idempotency key when the same payment splits to multiple creators. */
  creatorFirebaseUid: string;
  breakdown: EarningsBreakdown;
  /** The human-readable label in the journal. */
  description: string;
  environment: "sandbox" | "production";
};

export type RevenueSplitResult =
  | { ok: true; transactionId: string }
  | { ok: false; reason: "journal_refused" | "db_unavailable" | "already_posted" };

/**
 * Posts the revenue-split journal entry for one creator's share of a payment.
 *
 * Safe to retry: the idempotency key means a duplicate call returns
 * `already_posted` rather than writing a second entry.
 */
export async function postRevenueSplit(
  input: RevenueSplitPostingInput,
): Promise<RevenueSplitResult> {
  const { breakdown, paymentId, creatorFirebaseUid, environment, description } = input;

  const idempotency = economicKey(
    "whop",
    "revenue_split",
    `${paymentId}:${creatorFirebaseUid}`,
  );

  const result = await postTransaction({
    economicEvent: "revenue_split",
    provider: "whop",
    providerResourceId: paymentId,
    environment,
    currency: breakdown.currency,
    idempotencyKey: idempotency,
    description,
    legs: [
      {
        // Debit: clears suspense
        account: "unallocated_customer_funds",
        amountMinor: breakdown.grossAmountMinor,
        counterpartyType: "creator",
        counterpartyId: creatorFirebaseUid,
      },
      {
        // Credit: platform fee earned
        account: "platform_revenue",
        amountMinor: -breakdown.platformFeeMinor,
        counterpartyType: "platform",
        counterpartyId: "cliprewards",
      },
      {
        // Credit: owed to creator
        account: "creator_payable",
        amountMinor: -breakdown.netAmountMinor,
        counterpartyType: "creator",
        counterpartyId: creatorFirebaseUid,
      },
    ],
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason === "storage_error" ? "db_unavailable" : "journal_refused" };
  }

  if (result.alreadyPosted) return { ok: false, reason: "already_posted" };

  return { ok: true, transactionId: result.transactionId };
}

/* ==========================================================================
   REVENUE SPLIT REVERSAL — the unwinding journal for a refund or dispute loss.

   THE JOURNAL:
     DR  creator_payable            [creatorShareToReturn]   owed no longer
     DR  platform_revenue           [platformFeeToReturn]    percentage fee back
     CR  unallocated_customer_funds [totalToReturn]          back to suspense

   The `payment_refunded` entry (posted separately by whop-refund-posting.ts)
   then DEBITS unallocated_customer_funds and CREDITS provider_balance. The two
   postings together produce a clean net effect:

     Net: DR creator_payable, DR platform_revenue, CR provider_balance.

   PROCESSING FEE NOT REVERSED: the fixed processing fee portion stays in
   platform_revenue. Only the percentage component is returned.

   IDEMPOTENCY KEY: whop:revenue_split_reversed:<refundId>:<creatorFirebaseUid>
   ========================================================================== */

export type RevenueSplitReversalInput = {
  /** The refund or dispute resource id — unique per event, not per payment. */
  refundOrDisputeId: string;
  creatorFirebaseUid: string;
  reversal: RefundSplitReversal;
  currency: string;
  environment: "sandbox" | "production";
  description: string;
};

/**
 * Posts the revenue-split reversal journal for one creator's earning.
 *
 * Safe to retry: the idempotency key means a duplicate call returns
 * `already_posted` rather than writing a second entry.
 *
 * A zero-amount reversal (creatorShareToReturn + platformFeeToReturn = 0) is
 * silently skipped — no journal is written and `ok: true` is returned.
 */
export async function postRevenueSplitReversal(
  input: RevenueSplitReversalInput,
): Promise<RevenueSplitResult> {
  const { reversal, refundOrDisputeId, creatorFirebaseUid, currency, environment, description } = input;

  if (reversal.totalToReturn <= BigInt(0)) {
    return { ok: true, transactionId: "noop" };
  }

  const idempotency = economicKey(
    "whop",
    "revenue_split_reversed",
    `${refundOrDisputeId}:${creatorFirebaseUid}`,
  );

  const legs = [];

  if (reversal.creatorShareToReturn > BigInt(0)) {
    legs.push({
      account: "creator_payable" as const,
      amountMinor: reversal.creatorShareToReturn,
      counterpartyType: "creator" as const,
      counterpartyId: creatorFirebaseUid,
    });
  }

  if (reversal.platformFeeToReturn > BigInt(0)) {
    legs.push({
      account: "platform_revenue" as const,
      amountMinor: reversal.platformFeeToReturn,
      counterpartyType: "platform" as const,
      counterpartyId: "cliprewards",
    });
  }

  legs.push({
    account: "unallocated_customer_funds" as const,
    amountMinor: -(reversal.totalToReturn),
    counterpartyType: "customer" as const,
  });

  const result = await postTransaction({
    economicEvent: "revenue_split_reversed",
    provider: "whop",
    providerResourceId: refundOrDisputeId,
    environment,
    currency,
    idempotencyKey: idempotency,
    description,
    legs,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason === "storage_error" ? "db_unavailable" : "journal_refused" };
  }

  if (result.alreadyPosted) return { ok: false, reason: "already_posted" };

  return { ok: true, transactionId: result.transactionId };
}
