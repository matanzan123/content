import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";
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
     429 { error: "rate_limited" } with `retry-after`, when over budget

   Guards, in the order they run:
     1. Request origin check (CSRF guard)
     2. Payment id shape
     3. ADMIN-ONLY via withAdminApi
     4. Rate limit, per admin — before the audit, the provider call and the
        journal, so a refused request costs nothing and posts nothing
     5. Idempotent: if fees are already in sync, returns posted: false
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
    /* RATE LIMITED PER ADMIN, and BEFORE anything else this handler does.
     *
     * Keyed on the authenticated admin rather than the IP, like the transfer,
     * withdrawal-sweep and earnings-record routes: a shared office IP would
     * otherwise let one admin's runaway loop exhaust everyone else's budget.
     *
     * FIRST, so a refused request reaches neither Whop nor the journal — this
     * endpoint posts a real accounting correction per call, and the provider
     * call it makes is not free. It also writes no audit row, which is the
     * same position the limiter holds in the comparable finance routes: the
     * audit trail records attempts that were actually admitted.
     *
     * 60/hour, matching `admin:earnings_record` — the closest analogue, since
     * both post one journal entry for one named resource and an operator
     * repairing a batch by hand legitimately makes many calls in a row. The
     * 20/hour routes are the ones that move money out of the platform. */
    const rl = await checkRateLimit(`admin:fee_reconcile:${adminCtx.uid}`, 60);
    // A REAL 429, with `retry-after`. The shared helper's response passes
    // through `withAdminApi` untouched, so the status the limiter chose is the
    // status the client sees.
    if (!rl.ok) return rateLimitResponse();

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
