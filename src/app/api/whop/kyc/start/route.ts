import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { createKycLink, resolvePlatformConfig } from "@/lib/server/whop-kyc";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

/* ==========================================================================
   POST /api/whop/kyc/start

   Returns a short-lived Whop-hosted onboarding URL for the creator to
   complete KYC. The URL is minted fresh on every request — Whop links
   expire quickly and must never be cached.

   THE RETURN URL IS NOT PROOF. Landing back on our page after following this
   link does NOT mean KYC is complete. The client must call
   GET /api/whop/kyc/status to get the authoritative state from Whop.

   THE LINK USES company_id FIRST. See whop-kyc.ts for the full rationale.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const rl = await checkRateLimit(`whop:kyc_start:${firebaseUid}`, 10);
  if (!rl.ok) return rateLimitResponse();

  const platform = resolvePlatformConfig();
  if (!platform.ok) return json({ error: "unavailable", reason: platform.reason }, 503);

  const account = await getConnectedAccount(firebaseUid, platform.config.environment);
  if (!account) return json({ error: "account_not_provisioned" }, 409);

  const appUrl = process.env.APP_PUBLIC_URL?.trim();
  if (!appUrl) return json({ error: "unavailable", reason: "missing_app_url" }, 503);

  // The creator returns here whether they finished or abandoned. The return
  // page must fetch /api/whop/kyc/status to determine the real outcome.
  const returnUrl = `${appUrl}/onboarding?step=kyc_return`;

  const link = await createKycLink(account.whopAccountId, returnUrl);

  if (!link.ok) {
    if (link.reason === "platforms_access_required") return json({ error: link.reason }, 403);
    if (link.reason === "provider_rejected") return json({ error: link.reason }, 502);
    return json({ error: link.reason }, 502);
  }

  return json({ ok: true, url: link.url }, 200);
}
