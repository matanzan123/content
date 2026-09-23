import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  requestWithdrawal,
  cancelWithdrawal,
  getActiveWithdrawal,
  listWithdrawals,
  getWithdrawableBalance,
  isValidWithdrawalRequestId,
} from "@/lib/server/creator-withdrawals";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

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

  const [active, history, withdrawable] = await Promise.all([
    getActiveWithdrawal(firebaseUid),
    listWithdrawals(firebaseUid),
    getWithdrawableBalance(firebaseUid),
  ]);

  /* THE PAYOUT BALANCE COMES FROM THE PROVIDER, NOT FROM `creator_payable`.
   *
   * `/api/creator/earnings` reports what ClipRewards still OWES the creator.
   * Task #13 discharges that when it moves the money into the creator's own
   * Whop account — so by the time a withdrawal is possible, the internal figure
   * is zero and the withdrawable one is not. They answer different questions
   * and the withdraw screen needs this one.
   *
   * Null when the provider could not be read. The UI must show that as "cannot
   * tell right now", never as a zero balance. */
  return json({
    ok: true,
    active: active ? serializeWithdrawal(active) : null,
    history: history.map(serializeWithdrawal),
    withdrawable_minor: withdrawable === null ? null : withdrawable.toString(),
    currency: "usd",
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

  const rl = await checkRateLimit(`creator:withdraw:${firebaseUid}`, 5);
  if (!rl.ok) return rateLimitResponse();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  /* THE REQUEST IDENTITY. Required, and validated for shape only.
   *
   * It names ONE intended withdrawal. A browser that retries a timed-out POST
   * sends the same token and resolves to the same row instead of reserving the
   * creator's balance twice. It is opaque: it cannot influence the amount, the
   * destination, the environment or any privilege. */
  if (!isValidWithdrawalRequestId(body.request_id)) {
    return json({ error: "missing_request_id" }, 400);
  }

  /* AMOUNT VALIDATION. `Number.isInteger` is the NaN and Infinity guard as well
   * as the integer one — both are numbers, neither is an integer — and
   * `isSafeInteger` rejects a magnitude that would already have lost precision
   * as a double before `BigInt` ever saw it. The real ceiling is the creator's
   * canonical available balance, enforced server-side under a row lock; these
   * only stop a malformed request reaching that far. */
  const amountRaw = body.amount_minor;
  if (
    typeof amountRaw !== "number" ||
    !Number.isInteger(amountRaw) ||
    !Number.isSafeInteger(amountRaw) ||
    amountRaw <= 0
  ) {
    return json({ error: "invalid_amount_minor" }, 400);
  }

  // A destination the creator picked, when they were asked to pick one. Never
  // trusted here: the server proves it belongs to them against the
  // company-scoped list at execution.
  const payoutMethodId =
    typeof body.payout_method_id === "string" && body.payout_method_id.length > 0
      ? body.payout_method_id
      : undefined;

  const result = await requestWithdrawal({
    firebaseUid,
    amountMinor: BigInt(amountRaw),
    currency: "usd",
    requestId: body.request_id,
    payoutMethodId,
  });

  if (!result.ok) {
    // A conflicting replay is a conflict, not a bad request: the same token
    // already names a different intent.
    const status = result.reason === "request_conflict" ? 409 : 400;
    return json({ error: result.reason }, status);
  }
  return json({
    ok: true,
    withdrawal_id: result.withdrawalId,
    status: result.status,
    replayed: result.replayed,
  });
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
  if (!result.ok) {
    // Once a payout exists the money may already be moving, so cancellation
    // fails closed rather than telling the creator it came back.
    const status = result.reason === "cannot_cancel_after_submission" ? 409 : 400;
    return json({ error: result.reason }, status);
  }
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
    // NO `transfer_id`. It was an internal `creator_transfers` uuid — plumbing
    // a creator cannot act on, and now legacy besides: a withdrawal is a
    // `wdrl_` payout, not a transfer. Provider ids and payout method ids are
    // likewise absent.
    failure_reason: w.failureReason,
    cancel_reason: w.cancelReason,
    requested_at: w.requestedAt.toISOString(),
    paid_at: w.paidAt?.toISOString() ?? null,
    failed_at: w.failedAt?.toISOString() ?? null,
    canceled_at: w.canceledAt?.toISOString() ?? null,
    reversed_at: w.reversedAt?.toISOString() ?? null,
  };
}
