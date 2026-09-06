import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { accountingTransactions } from "@/lib/db/schema";
import { getWhopEnvironment } from "../whop-payments";
import { mapRefundToOrder } from "../whop-refund-mapping";
import {
  getRefundByProviderId,
  listCompletedRefunds,
  type PaymentRefund,
} from "../payment-refunds";
import { economicKey } from "./accounts";
import { postWhopRefund } from "./whop-refund-posting";

/* ==========================================================================
   REFUND CRASH RECOVERY.

   THE HOLE THIS FILLS. Handling a refund is two writes to two places:

     1. the operational row in `payment_refunds`  — "Whop says this completed"
     2. the posting in `accounting_transactions`  — "and here is the money"

   They cannot be one database transaction, because (1) is decided from
   provider calls and (2) needs three more of them. So there is a window: a
   process that dies between them leaves a refund recorded as `completed` with
   no journal entry — money that went back to a buyer and is nowhere in the
   accounts.

   THAT WINDOW IS CLOSED BY CONVERGENCE, NOT BY AVOIDANCE. Both steps are
   idempotent against keys that describe the refund itself, so running them
   again is always safe and always converges:

     step 1 converges on  uniq_refunds_provider_refund (provider, rf_id)
     step 2 converges on  uniq_accounting_idempotency  whop:payment_refunded:rf_id

   Running this after a complete, successful handling posts nothing and reports
   `already_posted`. Running it after a crash posts exactly the transaction
   that was missing. Running it twice concurrently produces one posting,
   because the unique index decides and not this code.

   NOTHING IS TRUSTED FROM OUR OWN DATABASE except which refund id to ask
   about. Every amount, the currency, the company, the order and the status are
   re-fetched from Whop and re-verified through `mapRefundToOrder` — the same
   function the webhook handler calls, with the same ten checks. A row we
   corrupted ourselves could not make this post the wrong money; it could only
   make it ask about the wrong refund, and the mapping would then refuse the
   mismatch.

   THIS IS NOT A WEBHOOK REPLAY, and it must not become one. The delivery
   ledger is doing its job: a receipt marked `processed` is a true record that
   the delivery was handled, and rewriting one to force a handler to run again
   would corrupt the only account we have of what we have and have not acted
   on. This takes the other door into the same authoritative code, skipping
   only the parts specific to an inbound HTTP delivery.
   ========================================================================== */

export type RefundRecoveryOutcome = {
  whopRefundId: string;
  whopPaymentId: string;
  result:
    | { kind: "posted"; transactionId: string }
    | { kind: "already_posted"; transactionId: string }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; reason: string };
};

/**
 * Whether a completed refund already has its accounting.
 *
 * Looked up by the ECONOMIC KEY rather than by the resource id, because that
 * is the value the unique index is built on: if this finds nothing, an insert
 * with that key will succeed, and if it finds a row, an insert will converge.
 * Any other lookup could disagree with the constraint that actually decides.
 */
export async function refundPostingFor(whopRefundId: string) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ transactionId: accountingTransactions.transactionId })
    .from(accountingTransactions)
    .where(
      eq(
        accountingTransactions.idempotencyKey,
        economicKey("whop", "payment_refunded", whopRefundId),
      ),
    );
  return row ?? null;
}

/**
 * Re-runs the full authoritative pipeline for ONE refund.
 *
 * Safe to call at any time, on any refund, however many times.
 */
export async function convergeRefund(whopRefundId: string): Promise<RefundRecoveryOutcome> {
  const environment = getWhopEnvironment();
  const base = { whopRefundId, whopPaymentId: "" };

  if (!environment) {
    return { ...base, result: { kind: "failed", reason: "unconfigured" } };
  }

  // STEP 1, re-run from provider truth. This also repairs the operational row
  // itself when THAT is what went missing — a crash before the row was written
  // leaves a refund Whop knows about and we do not, and this writes it.
  const mapped = await mapRefundToOrder(whopRefundId);

  if (mapped.kind === "rejected") {
    return { ...base, result: { kind: "failed", reason: mapped.reason } };
  }
  if (mapped.kind !== "completed") {
    // Pending or failed at the provider. There is no accounting to recover,
    // and inventing some would be exactly the error this build refuses.
    return {
      whopRefundId,
      whopPaymentId: "",
      result: { kind: "skipped", reason: `provider reports ${mapped.kind}` },
    };
  }

  const existing = await refundPostingFor(whopRefundId);

  // STEP 2, idempotent. Run even when step 1 reported the row was already
  // complete: that says nothing about whether the posting exists.
  const posted = await postWhopRefund(mapped.refundId, {
    environment,
    orderId: mapped.orderId,
    sourceWebhookId: null,
  });

  if (!posted.ok) {
    return {
      whopRefundId,
      whopPaymentId: mapped.paymentId,
      result: { kind: "failed", reason: posted.reason },
    };
  }

  return {
    whopRefundId,
    whopPaymentId: mapped.paymentId,
    result: {
      // `alreadyPosted` from the journal is the authority on whether this call
      // wrote anything. `existing` is read first only so the two can be
      // compared in tests — a posting that existed before and reports
      // `alreadyPosted: false` would mean the idempotency key is not doing
      // its job.
      kind: posted.alreadyPosted || existing !== null ? "already_posted" : "posted",
      transactionId: posted.transactionId,
    },
  };
}

export type RefundRecoveryReport = {
  configured: boolean;
  examined: number;
  outcomes: RefundRecoveryOutcome[];
};

/**
 * Finds every completed refund with no accounting and posts the missing
 * transactions.
 *
 * THE ONLY WRITING REPAIR IN THIS BUILD, and it is narrow by construction: it
 * can only ADD a posting that the authoritative pipeline agrees is owed, and
 * it can never alter or remove one. Reconciliation proper never writes at all
 * — it reports — and the two are kept in separate files so that distinction
 * cannot blur through a convenient edit.
 *
 * `dryRun` defaults to TRUE. Seeing what a repair would do must not require
 * performing it, and the direction of that default is the difference between
 * an operator investigating and an operator having already acted.
 */
export async function recoverMissingRefundPostings(
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<RefundRecoveryReport> {
  const { limit = 100, dryRun = true } = options;
  const db = getDb();
  if (!db) return { configured: false, examined: 0, outcomes: [] };

  const completed = await listCompletedRefunds(limit);
  const outcomes: RefundRecoveryOutcome[] = [];

  for (const refund of completed) {
    const posting = await refundPostingFor(refund.whopRefundId);
    if (posting) continue;

    if (dryRun) {
      outcomes.push({
        whopRefundId: refund.whopRefundId,
        whopPaymentId: refund.whopPaymentId,
        result: { kind: "skipped", reason: "dry run — would post the missing transaction" },
      });
      continue;
    }

    outcomes.push(await convergeRefund(refund.whopRefundId));
  }

  return { configured: true, examined: completed.length, outcomes };
}

/** Convenience for the tests and for an operator holding one refund id. */
export async function getLocalRefund(whopRefundId: string): Promise<PaymentRefund | null> {
  return await getRefundByProviderId(whopRefundId);
}
