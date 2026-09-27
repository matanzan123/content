import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { sweepPendingWithdrawals } from "@/lib/server/creator-withdrawals";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

/* ==========================================================================
   POST /api/admin/withdrawals/reconcile

   Asks the provider what happened to every withdrawal it has not finished
   with, and applies the answers.

   WHY THIS ROUTE EXISTS. Every other way into the withdrawal lifecycle is
   triggered by something arriving — an admin clicking execute, a `payout.*`
   webhook. A withdrawal whose `payouts.create` response was lost to a timeout
   produces neither: there is no id for a webhook to name, and no operator
   knows to look at it. Without a sweep, the rows that most need attention are
   exactly the ones nothing would ever examine.

   This is a callable route rather than a scheduled job because the project has
   no scheduler. An operator, or an external cron hitting this endpoint, is
   enough for Task #15.

   READ-ONLY AT THE PROVIDER. It calls `payouts.retrieve` and `payouts.list`.
   It never creates a payout — not even when a search for an orphaned one comes
   back empty, because an empty answer is not proof that no payout exists.

   Bounded per call and environment-scoped, so it cannot become an unbounded
   provider scan that rate-limits itself into the ambiguity it exists to clear.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH = 50;

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json(
      { error: "forbidden" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  return withAdminApi(async (adminCtx) => {
    const rl = await checkRateLimit(`admin:withdrawal_sweep:${adminCtx.uid}`, 20);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSeconds);

    const requested = typeof body?.limit === "number" ? body.limit : 25;
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_BATCH) : 25;

    // `targetType` is constrained to the audit log's existing vocabulary. A
    // sweep has no single target, so it is recorded against the admin who ran
    // it — widening the audit enum for one route would be a schema change this
    // task does not need.
    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "sweep_withdrawals",
      targetType: "user",
      targetId: adminCtx.uid,
      metadata: { limit },
    });

    const result = await sweepPendingWithdrawals(limit);

    // Counts only. No withdrawal ids, no provider ids, no creator identities —
    // an operator needs to know whether the sweep moved anything, and the
    // individual rows are inspectable through the per-withdrawal route.
    return {
      ok: true,
      scanned: result.scanned,
      reconciled: result.reconciled,
      adopted: result.adopted,
      unresolved: result.unresolved,
    };
  });
}
