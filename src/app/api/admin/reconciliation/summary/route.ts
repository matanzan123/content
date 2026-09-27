import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  reconcileInternal,
  reconcileRefundsInternal,
  reconcileDisputesInternal,
  reconcileFeeDrift,
  reconcileAllocationInternal,
} from "@/lib/server/accounting/reconcile";
import { reconcileCreatorEarnings } from "@/lib/server/creator-earnings-reconcile";
import { getWhopEnvironment } from "@/lib/server/whop-payments";

/* ==========================================================================
   GET /api/admin/reconciliation/summary

   Runs ALL local-only reconciliation checks (no provider network calls) and
   returns a combined report.

   These checks are cheap: no API calls, pure database arithmetic.
   Safe to run on a schedule; the fee drift scan is included here.

   Response:
     {
       payments: ReconciliationReport,
       refunds:  RefundReconciliationReport,
       disputes: DisputeReconciliationReport,
       fee_drift: FeeDriftReport,
     }
   ========================================================================== */

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  return withAdminApi(async () => {
    /* THE EARNINGS RECONCILER IS INCLUDED HERE, and until now it was not.
     *
     * `reconcileCreatorEarnings` was fully implemented and wired to nothing: no
     * route called it, so the entire creator-earnings and revenue-split
     * dimension — unjournalled earnings, ledger-versus-rows payable mismatches,
     * negative payables, mixed-currency positions, transfers with no journal —
     * could not be run by anyone. A detector nobody can reach detects nothing.
     *
     * It takes the environment as a parameter, so the route resolves it from
     * server configuration below and passes it in — never from the request. */
    /* THE ENVIRONMENT COMES FROM SERVER CONFIGURATION. No query string, no body,
     * no header. Fails closed: unresolvable means this dimension is reported as
     * unconfigured rather than reconciled across the boundary. */
    const environment = getWhopEnvironment();

    const [payments, refunds, disputes, feeDrift, allocation, earnings] = await Promise.all([
      reconcileInternal(),
      reconcileRefundsInternal(),
      reconcileDisputesInternal(),
      reconcileFeeDrift(),
      reconcileAllocationInternal(),
      environment ? reconcileCreatorEarnings(environment) : Promise.resolve({ ok: false as const, reason: "unconfigured" as const }),
    ]);

    return {
      payments,
      refunds,
      disputes,
      /* THE ALLOCATION AND REVERSAL CHAIN — the Task #17/#18/#19 invariants that
       * had no detector: a double allocation, a split moving more than its
       * settlement made allocatable, suspense left stranded by a reversal, or a
       * refund_absorbed_cost leg somewhere it does not belong. */
      allocation,
      creator_earnings: earnings.ok
        ? { configured: true, environment: earnings.report.environment,
            checked_at: earnings.report.checkedAt, findings: earnings.report.findings }
        : { configured: false, reason: earnings.reason },
      fee_drift: {
        configured: feeDrift.configured,
        settlements_scanned: feeDrift.settlementsScanned,
        drift_candidates: feeDrift.driftCandidates.map((c) => ({
          payment_id: c.paymentId,
          transaction_id: c.transactionId,
          gross_minor: c.grossMinor.toString(),
          currency: c.currency,
          // The drift itself. Minor units as STRINGS: these are bigints, and a
          // JSON number would silently lose precision on a large total.
          posted_fee_minor: c.postedFeeMinor.toString(),
          actual_fee_minor: c.actualFeeMinor.toString(),
          delta_minor: c.deltaMinor.toString(),
          /* TAX PRINCIPAL, reported alongside the fee drift and separately from
           * it. A finding may carry a zero fee delta and a non-zero tax delta:
           * Whop remits sales tax when it files, long after settlement. */
          tax_remittance_posted_minor: c.taxRemittancePostedMinor.toString(),
          tax_remittance_actual_minor: c.taxRemittanceActualMinor.toString(),
          tax_remittance_delta_minor: c.taxRemittanceDeltaMinor.toString(),
          // A hint about why this drifted, not a cause. Null for settlements
          // predating the flag.
          fees_were_actual_at_settlement: c.feesWereActualAtSettlement,
        })),
        /* CANDIDATES THE PROVIDER COULD NOT BE ASKED ABOUT, surfaced rather
         * than omitted. A provider outage must not read to an operator as
         * "no drift found". */
        unresolved: feeDrift.unresolved.map((u) => ({
          payment_id: u.paymentId,
          transaction_id: u.transactionId,
          reason: u.reason,
          detail: u.detail ?? null,
        })),
      },
    };
  });
}
