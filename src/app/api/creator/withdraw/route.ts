import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  requestWithdrawal,
  cancelWithdrawal,
  getActiveWithdrawal,
  listWithdrawals,
} from "@/lib/server/creator-withdrawals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/* -------------------------------------------------------------------------
   GET /api/creator/withdraw — active withdrawal + history
   ------------------------------------------------------------------------- */
export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const [active, history] = await Promise.all([
    getActiveWithdrawal(firebaseUid),
    listWithdrawals(firebaseUid),
  ]);

  return json({
    ok: true,
    active: active ? serializeWithdrawal(active) : null,
    history: history.map(serializeWithdrawal),
  });
}

/* -------------------------------------------------------------------------
   POST /api/creator/withdraw — request a new withdrawal
   ------------------------------------------------------------------------- */
export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const amountRaw = body.amount_minor;
  if (typeof amountRaw !== "number" || !Number.isInteger(amountRaw) || amountRaw <= 0) {
    return json({ error: "invalid_amount_minor" }, 400);
  }

  const result = await requestWithdrawal({
    firebaseUid,
    amountMinor: BigInt(amountRaw),
    currency: "usd",
  });

  if (!result.ok) return json({ error: result.reason }, 400);
  return json({ ok: true, withdrawal_id: result.withdrawalId, status: result.status });
}

/* -------------------------------------------------------------------------
   DELETE /api/creator/withdraw — cancel the active withdrawal
   ------------------------------------------------------------------------- */
export async function DELETE(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const active = await getActiveWithdrawal(firebaseUid);
  if (!active) return json({ error: "no_active_withdrawal" }, 404);

  const result = await cancelWithdrawal(active.withdrawalId, "creator_canceled");
  if (!result.ok) return json({ error: result.reason }, 400);
  return json({ ok: true });
}

/* -------------------------------------------------------------------------
   Helper
   ------------------------------------------------------------------------- */
function serializeWithdrawal(w: Awaited<ReturnType<typeof getActiveWithdrawal>>) {
  if (!w) return null;
  return {
    withdrawal_id: w.withdrawalId,
    amount_minor: w.amountMinor.toString(),
    reserved_amount_minor: w.reservedAmountMinor.toString(),
    currency: w.currency,
    status: w.status,
    transfer_id: w.transferId,
    failure_reason: w.failureReason,
    cancel_reason: w.cancelReason,
    requested_at: w.requestedAt.toISOString(),
    paid_at: w.paidAt?.toISOString() ?? null,
    failed_at: w.failedAt?.toISOString() ?? null,
    canceled_at: w.canceledAt?.toISOString() ?? null,
  };
}
