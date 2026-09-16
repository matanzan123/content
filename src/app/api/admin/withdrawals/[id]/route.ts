import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import {
  processWithdrawal,
  cancelWithdrawal,
  getWithdrawal,
} from "@/lib/server/creator-withdrawals";

/* ==========================================================================
   /api/admin/withdrawals/[id]

   GET    — view withdrawal detail
   POST   — process (trigger Whop transfer). Body: { action: "process" }
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
        transfer_id: withdrawal.transferId,
        failure_reason: withdrawal.failureReason,
        cancel_reason: withdrawal.cancelReason,
        requested_at: withdrawal.requestedAt.toISOString(),
        paid_at: withdrawal.paidAt?.toISOString() ?? null,
        failed_at: withdrawal.failedAt?.toISOString() ?? null,
        canceled_at: withdrawal.canceledAt?.toISOString() ?? null,
      },
    };
  });
}

export async function POST(request: Request, { params }: Params) {
  if (!checkRequestOrigin(request.headers).ok)
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  return withAdminApi(async (adminCtx) => {
    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "process_withdrawal",
      targetType: "user",
      targetId: id,
      metadata: { withdrawalId: id },
    });

    const result = await processWithdrawal(id, adminCtx.uid);
    if (!result.ok) return { error: result.reason };
    return { ok: true, transfer_id: result.transferId };
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
