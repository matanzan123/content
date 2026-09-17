import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { reconcileProviderFees } from "@/lib/server/accounting/whop-fee-reconciliation";

/* ==========================================================================
   POST /api/admin/fees/reconcile/[id]

   Compares the provider's current `listFees` for a payment against what the
   journal has already posted, and writes a `provider_fee_reconciled` delta
   entry when they differ.

   [id] — the Whop payment id (pay_…)

   Use cases:
     - Payment settled with zero fees reported → fees arrive later → call this
     - Suspected fee drift discovered during reconciliation
     - Scheduled daily pass over recent payments with `feesAreActual: false`

   Response:
     { ok: true, delta_minor: string, posted: boolean, transaction_id: string|null }
     { ok: false, error: string }

   Guards:
     1. ADMIN-ONLY via withAdminApi
     2. Request origin check (CSRF guard)
     3. Idempotent: if fees are already in sync, returns posted: false
   ========================================================================== */

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const { id: paymentId } = await params;

  if (!paymentId || !/^[a-zA-Z0-9_-]{4,128}$/.test(paymentId)) {
    return Response.json({ error: "invalid_payment_id" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return withAdminApi(async (adminCtx) => {
    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "reconcile_provider_fees",
      targetType: "user",
      targetId: paymentId,
      metadata: { paymentId },
    });

    const result = await reconcileProviderFees(paymentId);

    if (!result.ok) return { error: result.reason, detail: (result as { detail?: string }).detail };

    return {
      ok: true,
      delta_minor: result.deltaMinor.toString(),
      posted: result.posted,
      transaction_id: result.transactionId,
    };
  });
}
