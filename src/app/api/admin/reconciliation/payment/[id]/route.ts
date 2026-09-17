import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  reconcilePaymentAgainstProvider,
  reconcileOrderLifecycle,
} from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   GET /api/admin/reconciliation/payment/[id]

   Provider-backed check for ONE payment.

   Runs two independent checks:
     1. `reconcilePaymentAgainstProvider`  — amounts, currency, net vs fees
     2. `reconcileOrderLifecycle`          — order status vs Whop status

   Each costs ≤ 2 provider API calls. Not suitable for bulk scheduling.

   [id] — the Whop payment id (pay_…) or order id (ord_…)

   Response:
     { payment_findings: Discrepancy[], lifecycle_findings: Discrepancy[] }
   ========================================================================== */

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const { id } = await params;
  if (!id || !/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    return Response.json(
      { error: "invalid_id" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  return withAdminApi(async () => {
    const [paymentFindings, lifecycleFindings] = await Promise.all([
      reconcilePaymentAgainstProvider(id),
      reconcileOrderLifecycle(id),
    ]);

    return {
      payment_findings: paymentFindings,
      lifecycle_findings: lifecycleFindings,
    };
  });
}
