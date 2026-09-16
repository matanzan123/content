import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { recordCreatorEarning } from "@/lib/server/creator-earnings";
import { resolvePlatformConfig } from "@/lib/server/whop-accounts";

/* ==========================================================================
   POST /api/admin/earnings/record

   Records a creator earning from a settled brand payment.

   Body (JSON):
     firebase_uid    string  — target creator
     whop_payment_id string  — the Whop payment that settled
     order_id?       string  — optional order reference
     gross_minor     number  — gross amount in minor units (integer)
     currency        "usd"   — only USD in this version
     settled_at?     string  — ISO 8601; defaults to now if omitted
     description?    string  — label in the journal

   Guards:
     1. ADMIN-ONLY via withAdminApi (Firebase admin custom claim)
     2. Request origin check (same-origin / CSRF guard)
     3. Dry-run not supported — all calls write a real row
        (idempotency handles repeated calls for the same payment)
   ========================================================================== */

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return withAdminApi(async (adminCtx) => {
    const firebaseUid = body.firebase_uid;
    const whopPaymentId = body.whop_payment_id;
    const grossRaw = body.gross_minor;
    const currency = body.currency ?? "usd";

    if (typeof firebaseUid !== "string" || !firebaseUid) return { error: "missing_firebase_uid" };
    if (typeof whopPaymentId !== "string" || !whopPaymentId) return { error: "missing_whop_payment_id" };
    if (typeof grossRaw !== "number" || !Number.isInteger(grossRaw) || grossRaw <= 0)
      return { error: "invalid_gross_minor" };
    if (currency !== "usd") return { error: "unsupported_currency" };

    const grossAmountMinor = BigInt(grossRaw);
    const paymentSettledAt = body.settled_at
      ? new Date(body.settled_at as string)
      : new Date();

    if (isNaN(paymentSettledAt.getTime())) return { error: "invalid_settled_at" };

    const platform = resolvePlatformConfig();
    if (!platform.ok) return { error: "platform_unavailable" };

    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "record_creator_earning",
      targetType: "user",
      targetId: firebaseUid,
      metadata: { whopPaymentId, grossRaw, currency: currency as string },
    });

    const result = await recordCreatorEarning({
      firebaseUid,
      whopPaymentId,
      orderId: typeof body.order_id === "string" ? body.order_id : undefined,
      grossAmountMinor,
      currency: "usd",
      environment: platform.config.environment,
      paymentSettledAt,
      description: typeof body.description === "string" ? body.description : undefined,
    });

    if (!result.ok) return { error: result.reason };
    return { ok: true, earning_id: result.earningId, already_recorded: result.alreadyRecorded };
  });
}
