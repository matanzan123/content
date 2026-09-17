import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  reconcileInternal,
  reconcileRefundsInternal,
  reconcileDisputesInternal,
  reconcileFeeDrift,
} from "@/lib/server/accounting/reconcile";

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
    const [payments, refunds, disputes, feeDrift] = await Promise.all([
      reconcileInternal(),
      reconcileRefundsInternal(),
      reconcileDisputesInternal(),
      reconcileFeeDrift(),
    ]);

    return {
      payments,
      refunds,
      disputes,
      fee_drift: {
        configured: feeDrift.configured,
        settlements_scanned: feeDrift.settlementsScanned,
        drift_candidates: feeDrift.driftCandidates.map((c) => ({
          payment_id: c.paymentId,
          transaction_id: c.transactionId,
          gross_minor: c.grossMinor.toString(),
          currency: c.currency,
        })),
      },
    };
  });
}
