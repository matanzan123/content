import "server-only";

import { getWhopEnvironment } from "../whop-payments";
import { mapDisputeToOrder } from "../whop-dispute-mapping";
import { getDisputeByProviderId, listAllDisputes } from "../payment-disputes";
import { postDisputeMovementsForPayment, type DisputePostingReport } from "./whop-dispute-posting";

/* ==========================================================================
   DISPUTE CRASH RECOVERY.

   THE HOLE THIS FILLS is the same shape as the refund one, and it is filled
   the same way — deliberately, because the pattern is proven and a second
   design would be a second thing to get wrong.

   Handling a dispute is two writes to two places:

     1. the operational row in `payment_disputes`  — "Whop says it went this way"
     2. the postings in `accounting_transactions`  — "and here is the money"

   They cannot be one database transaction: (1) is decided from provider calls
   and (2) needs another. So there is a window, and a process that dies between
   them leaves a dispute recorded as `lost` with no journal entry.

   THAT WINDOW IS CLOSED BY CONVERGENCE, NOT BY AVOIDANCE. Both steps are
   idempotent against keys that describe provider resources, so running them
   again is always safe:

     step 1 converges on  uniq_disputes_provider_dispute (provider, dspt_id)
     step 2 converges on  uniq_accounting_idempotency    whop:<event>:<ledger_activity_id>

   THE SECOND KEY IS THE LEDGER ROW, NOT THE DISPUTE. One dispute produces
   several movements over its life — a fee when it opens, a withdrawal, later
   perhaps a reversal — and each is a separate row with a separate id. Keying
   the accounting on the dispute would collapse them into one posting and lose
   money; keying on the row means a dispute that gains a movement next week
   simply posts one more transaction and nothing already written changes.

   NOTHING IS TRUSTED FROM OUR OWN DATABASE except which dispute id to ask
   about. Every amount, the currency, the company, the order and the status are
   re-fetched from Whop through `mapDisputeToOrder` — the same function the
   webhook handler calls, with the same checks.

   THIS IS NOT A WEBHOOK REPLAY. A receipt marked `processed` is a true record
   that a delivery was handled, and rewriting one to force a handler to run
   again would corrupt the only account we have of what we have acted on. This
   takes the other door into the same authoritative code.
   ========================================================================== */

export type DisputeRecoveryOutcome = {
  whopDisputeId: string;
  whopPaymentId: string | null;
  result:
    | { kind: "converged"; posting: DisputePostingReport }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; reason: string };
};

/**
 * Re-runs the full authoritative pipeline for ONE dispute.
 *
 * Safe to call at any time, on any dispute, however many times.
 */
export async function convergeDispute(
  whopDisputeId: string,
): Promise<DisputeRecoveryOutcome> {
  const environment = getWhopEnvironment();
  if (!environment) {
    return { whopDisputeId, whopPaymentId: null, result: { kind: "failed", reason: "unconfigured" } };
  }

  // STEP 1, re-run from provider truth. This also repairs the operational row
  // itself when THAT is what went missing — a crash before the row was written
  // leaves a dispute Whop knows about and we do not.
  const mapped = await mapDisputeToOrder(whopDisputeId);
  if (mapped.kind === "rejected") {
    return {
      whopDisputeId,
      whopPaymentId: null,
      result: { kind: "failed", reason: mapped.reason },
    };
  }

  // STEP 2, idempotent, and run REGARDLESS of whether step 1 changed anything.
  // A dispute already recorded as resolved says nothing about whether its
  // movements were posted — that is exactly the crash case.
  const posting = await postDisputeMovementsForPayment(mapped.paymentId, {
    orderId: mapped.orderId,
    disputeId: whopDisputeId,
    sourceWebhookId: null,
  });

  if (!posting.ok) {
    return {
      whopDisputeId,
      whopPaymentId: mapped.paymentId,
      result: { kind: "failed", reason: posting.reason ?? "posting_failed" },
    };
  }

  return {
    whopDisputeId,
    whopPaymentId: mapped.paymentId,
    result: { kind: "converged", posting },
  };
}

export type DisputeRecoveryReport = {
  configured: boolean;
  examined: number;
  outcomes: DisputeRecoveryOutcome[];
};

/**
 * Re-converges every dispute we hold, posting any movement that is missing.
 *
 * THE ONLY WRITING REPAIR for disputes, and it is narrow by construction: it
 * can only ADD a posting that the provider's own ledger says exists, and it
 * can never alter or remove one. Reconciliation proper never writes at all —
 * it reports — and the two live in separate files so that distinction cannot
 * blur through a convenient edit.
 *
 * `dryRun` defaults to TRUE. Seeing what a repair would do must not require
 * performing it, and the direction of that default is the difference between
 * an operator investigating and an operator having already acted.
 */
export async function recoverMissingDisputePostings(
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<DisputeRecoveryReport> {
  const { limit = 100, dryRun = true } = options;

  const disputes = await listAllDisputes(limit);
  const outcomes: DisputeRecoveryOutcome[] = [];

  for (const dispute of disputes) {
    if (dryRun) {
      outcomes.push({
        whopDisputeId: dispute.whopDisputeId,
        whopPaymentId: dispute.whopPaymentId,
        result: {
          kind: "skipped",
          reason: "dry run — would re-read the provider ledger and post anything missing",
        },
      });
      continue;
    }
    outcomes.push(await convergeDispute(dispute.whopDisputeId));
  }

  return { configured: true, examined: disputes.length, outcomes };
}

/** Convenience for the tests and for an operator holding one dispute id. */
export async function getLocalDispute(whopDisputeId: string) {
  return await getDisputeByProviderId(whopDisputeId);
}
