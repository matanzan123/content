import { and, eq } from "drizzle-orm";
import { withAdminApi } from "@/lib/server/admin-guard";
import { writeAudit } from "@/lib/server/admin-audit";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";
import { getWhopEnvironment } from "@/lib/server/whop-payments";
import { getPaymentOrder, isOrderId } from "@/lib/server/payment-orders";
import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json(
      { error: "forbidden" },
      { status: 403, headers: NO_STORE },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "invalid_json" },
      { status: 400, headers: NO_STORE },
    );
  }

  return withAdminApi(async (adminCtx) => {
    const rl = await checkRateLimit(
      `admin:production_e2e_release:${adminCtx.uid}`,
      5,
    );

    if (!rl.ok) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    if (getWhopEnvironment() !== "production") {
      return Response.json(
        { error: "production_only" },
        { status: 409, headers: NO_STORE },
      );
    }

    if (body.confirm !== "RELEASE_MY_PRODUCTION_E2E_100_CENTS") {
      return Response.json(
        { error: "confirmation_required" },
        { status: 400, headers: NO_STORE },
      );
    }

    const orderId =
      typeof body.order_id === "string" ? body.order_id.trim() : "";

    if (!isOrderId(orderId)) {
      return Response.json(
        { error: "invalid_order_id" },
        { status: 400, headers: NO_STORE },
      );
    }

    const order = await getPaymentOrder(orderId);

    if (!order) {
      return Response.json(
        { error: "order_not_found" },
        { status: 404, headers: NO_STORE },
      );
    }

    // This escape hatch is valid ONLY for our exact production E2E payment.
    if (
      order.environment !== "production" ||
      order.purpose !== "production_e2e_test" ||
      order.amountMinor !== BigInt(107) ||
      order.currency !== "usd" ||
      order.status !== "paid" ||
      !order.whopPaymentId
    ) {
      return Response.json(
        { error: "order_not_eligible_for_e2e_release" },
        { status: 409, headers: NO_STORE },
      );
    }

    const db = getDb();

    if (!db) {
      return Response.json(
        { error: "db_unavailable" },
        { status: 503, headers: NO_STORE },
      );
    }

    const earnings = await db
      .select({
        earningId: schema.creatorEarnings.earningId,
        firebaseUid: schema.creatorEarnings.firebaseUid,
        environment: schema.creatorEarnings.environment,
        whopPaymentId: schema.creatorEarnings.whopPaymentId,
        orderId: schema.creatorEarnings.orderId,
        grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
        platformFeeMinor: schema.creatorEarnings.platformFeeMinor,
        netAmountMinor: schema.creatorEarnings.netAmountMinor,
        platformFeeBps: schema.creatorEarnings.platformFeeBps,
        currency: schema.creatorEarnings.currency,
        status: schema.creatorEarnings.status,
        frozenByDispute: schema.creatorEarnings.frozenByDispute,
        refundedGrossMinor: schema.creatorEarnings.refundedGrossMinor,
        accountingTransactionId:
          schema.creatorEarnings.accountingTransactionId,
      })
      .from(schema.creatorEarnings)
      .where(
        and(
          eq(schema.creatorEarnings.firebaseUid, adminCtx.uid),
          eq(schema.creatorEarnings.environment, "production"),
          eq(schema.creatorEarnings.whopPaymentId, order.whopPaymentId),
          eq(schema.creatorEarnings.orderId, order.orderId),
        ),
      )
      .limit(2);

    if (earnings.length === 0) {
      return Response.json(
        { error: "earning_not_found" },
        { status: 404, headers: NO_STORE },
      );
    }

    if (earnings.length !== 1) {
      return Response.json(
        { error: "ambiguous_earning" },
        { status: 409, headers: NO_STORE },
      );
    }

    const earning = earnings[0];

    // Exact economic assertions for this one test:
    // $1.07 gross - 7 cents (7%) = $1.00 creator payable.
    if (
      earning.grossAmountMinor !== BigInt(107) ||
      earning.platformFeeMinor !== BigInt(7) ||
      earning.netAmountMinor !== BigInt(100) ||
      earning.platformFeeBps !== 700 ||
      earning.currency !== "usd" ||
      earning.status !== "held" ||
      earning.frozenByDispute ||
      earning.refundedGrossMinor !== BigInt(0) ||
      !earning.accountingTransactionId
    ) {
      return Response.json(
        { error: "earning_not_eligible_for_e2e_release" },
        { status: 409, headers: NO_STORE },
      );
    }

    const now = new Date();

    const updated = await db
      .update(schema.creatorEarnings)
      .set({
        status: "available",
        holdUntil: now,
        availableAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.creatorEarnings.earningId, earning.earningId),
          eq(schema.creatorEarnings.environment, "production"),
          eq(schema.creatorEarnings.status, "held"),
          eq(schema.creatorEarnings.frozenByDispute, false),
          eq(schema.creatorEarnings.refundedGrossMinor, BigInt(0)),
        ),
      )
      .returning({
        earningId: schema.creatorEarnings.earningId,
      });

    if (updated.length !== 1) {
      return Response.json(
        { error: "earning_state_changed" },
        { status: 409, headers: NO_STORE },
      );
    }

    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "production_e2e_release",
      targetType: "user",
      targetId: earning.firebaseUid,
      metadata: {
        earning_id: earning.earningId,
        order_id: order.orderId,
        whop_payment_id: order.whopPaymentId,
        gross_minor: 107,
        creator_net_minor: 100,
        currency: "usd",
        previous_status: "held",
        new_status: "available",
      },
    });

    return Response.json(
      {
        ok: true,
        order_id: order.orderId,
        earning_id: earning.earningId,
        creator_net_minor: 100,
        currency: "usd",
        status: "available",
      },
      { status: 200, headers: NO_STORE },
    );
  });
}





