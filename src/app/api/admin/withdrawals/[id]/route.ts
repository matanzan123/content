import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import {
  executeWithdrawal,
  cancelWithdrawal,
  getWithdrawal,
  reconcileWithdrawal,
} from "@/lib/server/creator-withdrawals";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

/* ==========================================================================
   /api/admin/withdrawals/[id]

   GET    — view withdrawal detail
   POST   — execute the external payout, or reconcile it against the provider.
            Body: { action: "process" | "reconcile" }

            "process" creates a Whop PAYOUT (`payouts.create`) from the
            creator's own balance to their own external destination. It is NOT
            the Task #13 internal ledger transfer, which never leaves Whop.
   DELETE — cancel (before processing). Body: { reason?: string }

   All actions require the Firebase `admin` custom claim.
   ========================================================================== */

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!checkRequestOrigin(request.headers).ok)
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  return withAdminApi(async () => {
    const withdrawal = await getWithdrawal(id);
    if (!withdrawal) return { error: "not_found" };
    return {
      ok: true,
      withdrawal: {
        withdrawal_id: withdrawal.withdrawalId,
        amount_minor: withdrawal.amountMinor.toString(),
        reserved_amount_minor: withdrawal.reservedAmountMinor.toString(),
        currency: withdrawal.currency,
        status: withdrawal.status,
        failure_reason: withdrawal.failureReason,
        cancel_reason: withdrawal.cancelReason,
        requested_at: withdrawal.requestedAt.toISOString(),
        paid_at: withdrawal.paidAt?.toISOString() ?? null,
        failed_at: withdrawal.failedAt?.toISOString() ?? null,
        canceled_at: withdrawal.canceledAt?.toISOString() ?? null,
        reversed_at: withdrawal.reversedAt?.toISOString() ?? null,
      },
    };
  });
}

export async function POST(request: Request, { params }: Params) {
  if (!checkRequestOrigin(request.headers).ok)
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  // A body is optional: no body means the default "process" action.
  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  return withAdminApi(async (adminCtx) => {
    const rl = await checkRateLimit(`admin:withdrawal:${adminCtx.uid}`, 30);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSeconds);

    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "process_withdrawal",
      targetType: "user",
      targetId: id,
      metadata: { withdrawalId: id },
    });

    // Reconciliation is a read against the provider that then applies its
    // truth; it moves no new money and is how a stuck or ambiguous withdrawal
    // is resolved without paying again.
    const action = typeof body?.action === "string" ? body.action : "process";
    if (action === "reconcile") {
      const reconciled = await reconcileWithdrawal(id);
      if (!reconciled.ok) return { error: reconciled.reason };
      return { ok: true, status: reconciled.status, changed: reconciled.changed };
    }

    const result = await executeWithdrawal(id, adminCtx.uid);
    if (!result.ok) {
      // An ambiguous provider outcome is NOT a failure: the payout may exist,
      // the journal stands, and the withdrawal is recoverable by reconciling.
      // 202 says "accepted, outcome unknown" rather than claiming either.
      if (result.reason === "payout_ambiguous") {
        return { error: "payout_ambiguous", status: 202 };
      }
      return { error: result.reason };
    }
    // The provider payout id is deliberately NOT returned. Operators reconcile
    // by withdrawal id; the provider id is plumbing.
    return { ok: true, status: result.status };
  });
}

export async function DELETE(request: Request, { params }: Params) {
  if (!checkRequestOrigin(request.headers).ok)
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  let body: { reason?: string } = {};
  try { body = (await request.json()) as { reason?: string }; } catch { /* no body ok */ }

  return withAdminApi(async (adminCtx) => {
    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "cancel_withdrawal",
      targetType: "user",
      targetId: id,
      metadata: { withdrawalId: id, reason: body.reason ?? "admin_canceled" },
    });

    const result = await cancelWithdrawal(id, body.reason ?? "admin_canceled");
    if (!result.ok) return { error: result.reason };
    return { ok: true };
  });
}
