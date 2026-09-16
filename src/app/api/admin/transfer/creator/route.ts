import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { initiateCreatorTransfer } from "@/lib/server/creator-transfers";

/* ==========================================================================
   POST /api/admin/transfer/creator

   Admin-only. Initiates (or dry-runs) a payout transfer from the platform
   account to a creator's connected Whop account.

   THIS IS A HIGH-RISK ENDPOINT. Every invocation moves real money (unless
   dry_run is true). The following guards are enforced:

   1. ADMIN-ONLY. `withAdminApi` verifies the Firebase `admin` custom claim.
      No creator-facing auth path reaches this route.
   2. ACTOR FROM SESSION. `initiatedByUid` is taken from the verified admin
      session, never from the request body.
   3. AMOUNT IN BODY, NOT URL. The amount is in a POST body, not a query
      string, so it does not appear in access logs.
   4. DRY RUN DEFAULT. Callers must explicitly set `"dry_run": false` to send
      real money. Omitting the field or setting it true validates everything
      through the payout-readiness check without calling Whop.
   5. EVERY TRANSFER IS AUDITED. A row is written to `admin_audit_log` on
      every call, including dry runs, including failures.
   6. THE TARGET IS A UID, NOT AN ACCOUNT ID. Callers supply `firebase_uid`;
      the account id is looked up server-side. A caller cannot direct money to
      an arbitrary Whop account.

   BODY (JSON):
   {
     "firebase_uid": string,       // creator to pay
     "amount_minor": number,       // minor units — 1000 = $10.00
     "currency": "usd",            // currently the only accepted value
     "purpose": string,            // e.g. "campaign_payout"
     "campaign_id": string,        // optional
     "dry_run": boolean            // REQUIRED (must be explicit false to move money)
   }

   RESPONSE (2xx):
   {
     "ok": true,
     "dry_run": true,
     "payout_ready": boolean,
     "account_id": string,
     "amount_minor": number,
     "max_allowed": number
   }
   or (when dry_run is false):
   {
     "ok": true,
     "dry_run": false,
     "transfer_id": string,
     "provider_transfer_id": string,
     "status": "submitted"
   }
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  return withAdminApi(async (adminContext) => {
    // Parse body
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    // `dry_run` must be explicitly set. Omitting it defaults to true as a safety measure.
    const dryRun = body.dry_run !== false;

    const firebaseUid = typeof body.firebase_uid === "string" ? body.firebase_uid.trim() : null;
    if (!firebaseUid) return json({ error: "missing_firebase_uid" }, 400);

    const rawAmount = body.amount_minor;
    if (typeof rawAmount !== "number" || !Number.isInteger(rawAmount) || rawAmount <= 0) {
      return json({ error: "invalid_amount_minor" }, 400);
    }
    const amountMinor = BigInt(rawAmount);

    const currency = typeof body.currency === "string" ? body.currency.toLowerCase() : "usd";
    if (currency !== "usd") return json({ error: "unsupported_currency" }, 400);

    const purpose = typeof body.purpose === "string" && body.purpose.trim()
      ? body.purpose.trim()
      : null;
    if (!purpose) return json({ error: "missing_purpose" }, 400);

    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id.trim() : undefined;

    // Actor from verified admin session — never from the body
    const initiatedByUid = adminContext.uid;

    // Audit every call, including dry runs
    await writeAudit({
      adminUid: initiatedByUid,
      adminEmail: adminContext.email,
      action: dryRun ? "creator_transfer_dry_run" : "creator_transfer_initiate",
      targetType: "user",
      targetId: firebaseUid,
      metadata: {
        amount_minor: rawAmount,
        currency,
        purpose,
        campaign_id: campaignId ?? null,
        dry_run: dryRun,
      },
    });

    const result = await initiateCreatorTransfer({
      firebaseUid,
      amountMinor,
      currency: "usd",
      purpose,
      campaignId,
      initiatedByUid,
      dryRun,
    });

    if (!result.ok) {
      const statusCode =
        result.reason === "amount_below_minimum" || result.reason === "amount_above_maximum" ? 400 :
        result.reason === "creator_not_found" ? 404 :
        result.reason === "payout_not_ready" ? 422 :
        result.reason === "payout_check_failed" ? 502 :
        result.reason === "unconfigured" ? 503 :
        result.reason === "db_unavailable" ? 503 :
        500;
      return json({ ok: false, error: result.reason }, statusCode);
    }

    if (result.dryRun) {
      return json({
        ok: true,
        dry_run: true,
        payout_ready: result.payoutReady,
        account_id: result.accountId,
        amount_minor: Number(result.amountMinor),
        max_allowed: Number(result.maxAllowed),
      }, 200);
    }

    return json({
      ok: true,
      dry_run: false,
      transfer_id: result.transferId,
      provider_transfer_id: result.providerTransferId,
      status: result.status,
      account_id: result.accountId,
      amount_minor: Number(result.amountMinor),
    }, 200);
  });
}
