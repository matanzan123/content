import "server-only";

import { getDb } from "@/lib/db";
import { describeWhopError } from "../whop-payments";
import {
  FEE_DRIFT_MAX_PAGE,
  selectFeeDriftCandidates,
} from "./reconcile";
import {
  inspectProviderFeeDrift,
  reconcileProviderFees,
} from "./whop-fee-reconciliation";

/* ==========================================================================
   PROVIDER FEE REPAIR — server only.

   The batch counterpart of `reconcileProviderFees`, which corrects one payment.
   This walks a bounded page of recent settlements and corrects the ones whose
   provider fee total no longer matches the journal.

   IT IS A REPAIR, AND REPAIRS LIVE IN THEIR OWN FILES HERE. `reconcile.ts`
   reports and never writes; this writes, and only ever by ADDING a correction
   the provider itself proves is owed. The separation is the same one
   `refund-recovery.ts` keeps from `reconcile.ts`, and it is a file boundary
   rather than a comment so a convenient edit cannot blur it.

   `dryRun` DEFAULTS TO TRUE. Seeing what a repair would do must not require
   performing it, and the direction of that default is the difference between an
   operator investigating and an operator having already acted.

   ONE PROVIDER CALL PER CANDIDATE, IN EITHER MODE. That is a design
   constraint, not an accident:

     dry run  → `inspectProviderFeeDrift`  reads, reports, posts nothing
     live run → `reconcileProviderFees`    reads, and posts if it must

   A live run does NOT inspect first and then reconcile. Both of those fetch
   `listFees`, so doing them in sequence would double every provider call in the
   batch and — worse — decide from one read and act on another, leaving a window
   where the fee total changed between the two.

   WHAT IT NEVER TOUCHES: `creator_payable`, creator earnings, and
   `platform_revenue`. Provider fees are a platform EXPENSE (Task #18); the
   ClipRewards fee charged against creator economics is Task #17 and is posted
   nowhere near here.
   ========================================================================== */

export type FeeRepairOutcome = {
  paymentId: string;
  transactionId: string;
  result:
    /** A correction was posted. */
    | { kind: "posted"; transactionId: string; deltaMinor: string }
    /** The provider and the journal already agree. Nothing to do. */
    | { kind: "in_sync" }
    /** Dry run: a real drift, deliberately left uncorrected. */
    | { kind: "would_post"; deltaMinor: string; postedMinor: string; actualMinor: string }
    /** The correction was already recorded by a concurrent pass. */
    | { kind: "already_posted" }
    /** The settlement names no payment, so the provider cannot be asked. */
    | { kind: "skipped"; reason: string }
    /** The provider could not be reached or its answer was unusable. */
    | { kind: "failed"; reason: string; detail?: string };
};

export type FeeRepairReport = {
  configured: boolean;
  examined: number;
  outcomes: FeeRepairOutcome[];
};

/**
 * Corrects provider-fee drift across a bounded page of recent settlements.
 *
 * `limit` is clamped by `selectFeeDriftCandidates` to `FEE_DRIFT_MAX_PAGE`, so
 * there is ONE maximum in the codebase rather than a second one here that could
 * drift from it.
 *
 * FAILURE IS PER CANDIDATE. A provider outage on one payment produces a
 * `failed` outcome for that payment and the batch continues — one unreachable
 * payment must not make the rest of the page invisible, which is exactly how a
 * batch repair comes to look like "nothing needed fixing".
 */
export async function recoverProviderFeeDrift(
  options: { limit?: number; offset?: number; dryRun?: boolean } = {},
): Promise<FeeRepairReport> {
  const { limit = FEE_DRIFT_MAX_PAGE, offset = 0, dryRun = true } = options;

  const db = getDb();
  if (!db) return { configured: false, examined: 0, outcomes: [] };

  // The SAME selection the read-only drift scan uses: bounded, ordered,
  // environment-scoped. No second copy of the predicate.
  const page = await selectFeeDriftCandidates(limit, offset);
  if (!page.configured) return { configured: false, examined: 0, outcomes: [] };

  const outcomes: FeeRepairOutcome[] = [];

  for (const candidate of page.candidates) {
    const base = { paymentId: candidate.paymentId, transactionId: candidate.transactionId };

    if (!candidate.paymentId) {
      outcomes.push({ ...base, result: { kind: "skipped", reason: "missing_payment_id" } });
      continue;
    }

    if (dryRun) {
      let inspection;
      try {
        inspection = await inspectProviderFeeDrift(candidate.paymentId);
      } catch (error) {
        outcomes.push({
          ...base,
          result: { kind: "failed", reason: "inspection_threw", detail: describeWhopError(error) },
        });
        continue;
      }

      if (!inspection.ok) {
        outcomes.push({
          ...base,
          result: { kind: "failed", reason: inspection.reason, detail: inspection.detail },
        });
        continue;
      }

      if (inspection.deltaMinor === BigInt(0)) {
        outcomes.push({ ...base, result: { kind: "in_sync" } });
        continue;
      }

      outcomes.push({
        ...base,
        result: {
          kind: "would_post",
          // Minor units as STRINGS: these are bigints, and this report is
          // serialised to JSON where a number would lose precision.
          deltaMinor: inspection.deltaMinor.toString(),
          postedMinor: inspection.postedMinor.toString(),
          actualMinor: inspection.actualMinor.toString(),
        },
      });
      continue;
    }

    /* LIVE. One call, straight to the corrector.
     *
     * `reconcileProviderFees` performs its own single authoritative read and
     * posts only if the provider disagrees with the journal — so a zero delta
     * is a no-op here without this function having to check first, and a
     * genuine delta posts under the correction-index key that lets later
     * divergences post too. */
    let corrected;
    try {
      corrected = await reconcileProviderFees(candidate.paymentId);
    } catch (error) {
      outcomes.push({
        ...base,
        result: { kind: "failed", reason: "reconcile_threw", detail: describeWhopError(error) },
      });
      continue;
    }

    if (!corrected.ok) {
      // A concurrent pass having already recorded this correction is not a
      // fault; it is the idempotency working.
      outcomes.push({
        ...base,
        result:
          corrected.reason === "already_reconciled"
            ? { kind: "already_posted" }
            : { kind: "failed", reason: corrected.reason, detail: corrected.detail },
      });
      continue;
    }

    if (!corrected.posted) {
      outcomes.push({ ...base, result: { kind: "in_sync" } });
      continue;
    }

    outcomes.push({
      ...base,
      result: {
        kind: "posted",
        transactionId: corrected.transactionId ?? "",
        deltaMinor: corrected.deltaMinor.toString(),
      },
    });
  }

  return { configured: true, examined: page.candidates.length, outcomes };
}
