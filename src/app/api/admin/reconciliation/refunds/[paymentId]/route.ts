import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { reconcileRefundsAgainstProvider } from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   GET /api/admin/reconciliation/refunds/[paymentId]

   Provider-backed refund check for ONE payment.

   Compares our local `payment_refunds` rows and their journal entries against
   Whop's refund list for this payment. Costs ≤ 3 provider API calls.

   [paymentId] — the Whop payment id (pay_…)

   Response:
     { findings: RefundDiscrepancy[] }
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
    const findings = await reconcileRefundsAgainstProvider(paymentId);
    return { findings };
  });
}
