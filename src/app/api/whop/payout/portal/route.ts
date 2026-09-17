import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { createPayoutPortalLink, resolvePlatformConfig } from "@/lib/server/whop-kyc";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

/* ==========================================================================
   POST /api/whop/payout/portal

   Mints a short-lived Whop-hosted link for managing payout settings
   (bank account, payout method). Returns the URL to the client for
   immediate navigation.

   SECURITY PROPERTIES:
   - Creator is authenticated via Firebase token before anything happens.
   - The connected account id comes from the database (bound to the caller's
     firebase_uid), never from the request body.
   - The return URL is built server-side from APP_PUBLIC_URL — never from
     user input.
   - The link is returned once and never stored. Raw banking details never
     reach ClipRewards at any point.

   THIS IS NOT KYC. Use POST /api/whop/kyc/start for identity verification.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const rl = await checkRateLimit(`whop:payout_portal:${firebaseUid}`, 20);
  if (!rl.ok) return rateLimitResponse();

  const platform = resolvePlatformConfig();
  if (!platform.ok) return json({ error: "unavailable", reason: platform.reason }, 503);

  const account = await getConnectedAccount(firebaseUid, platform.config.environment);
  if (!account) return json({ error: "account_not_provisioned" }, 400);

  // Return URL built entirely server-side — never from user input.
  const returnUrl = `${APP_PUBLIC_URL}/dashboard?step=payout_return`;

  const result = await createPayoutPortalLink(account.whopAccountId, returnUrl);
  if (!result.ok) {
    if (result.reason === "platforms_access_required") return json({ error: result.reason }, 403);
    if (result.reason === "provider_rejected") return json({ error: result.reason }, 422);
    return json({ error: result.reason }, 502);
  }

  return json({ ok: true, url: result.url }, 200);
}
