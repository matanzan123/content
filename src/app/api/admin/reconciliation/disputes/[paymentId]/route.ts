import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { reconcileDisputesAgainstProvider } from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   GET /api/admin/reconciliation/disputes/[paymentId]

   Provider-backed dispute check for ONE payment.

   Two independent questions:
     1. Does Whop agree with our dispute rows?     (disputes.list)
     2. Is every dispute movement accounted for?   (financialActivity.list)

   Costs ≤ 2 provider API calls.

   [paymentId] — the Whop payment id (pay_…)

   Response:
     { findings: DisputeDiscrepancy[] }
   ========================================================================== */

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const { paymentId } = await params;
  if (!paymentId || !/^[a-zA-Z0-9_-]{4,128}$/.test(paymentId)) {
    return Response.json(
      { error: "invalid_payment_id" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  return withAdminApi(async () => {
    const findings = await reconcileDisputesAgainstProvider(paymentId);
    return { findings };
  });
}
