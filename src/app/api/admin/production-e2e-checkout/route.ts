import { withAdminApi } from "@/lib/server/admin-guard";
import { writeAudit } from "@/lib/server/admin-audit";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";
import { getWhopEnvironment } from "@/lib/server/whop-payments";
import { findOrCreateProductionE2EOrder } from "@/lib/server/payment-orders";
import { createWhopCheckoutForOrder } from "@/lib/server/whop-checkout";

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
      `admin:production_e2e_checkout:${adminCtx.uid}`,
      1,
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

    if (body.confirm !== "CREATE_PRODUCTION_E2E_107_CENTS") {
      return Response.json(
        { error: "confirmation_required" },
        { status: 400, headers: NO_STORE },
      );
    }

    // HARD-CODED $1.07 USD.
    // The browser cannot choose or change the amount.
    const created = await findOrCreateProductionE2EOrder();

    if (!created.ok) {
      return Response.json(
        { error: created.reason },
        { status: 503, headers: NO_STORE },
      );
    }

    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "production_e2e_checkout",
      targetType: "user",
      targetId: adminCtx.uid,
      metadata: {
        order_id: created.order.orderId,
        amount_minor: 107,
        currency: "usd",
        purpose: "production_e2e_test",
        order_status: created.order.status,
        existing_checkout: created.order.whopCheckoutId !== null,
      },
    });

    const checkout = await createWhopCheckoutForOrder(
      created.order.orderId,
      "he",
    );

    if (!checkout.ok) {
      return Response.json(
        {
          error: checkout.reason,
          order_id: created.order.orderId,
        },
        { status: 502, headers: NO_STORE },
      );
    }

    return Response.json(
      {
        ok: true,
        order_id: created.order.orderId,
        checkout_id: checkout.session.checkoutId,
        plan_id: checkout.session.planId,
        amount_minor: 107,
        currency: "usd",
        environment: checkout.session.environment,
        reused: checkout.reused,
      },
      { status: 200, headers: NO_STORE },
    );
  });
}





