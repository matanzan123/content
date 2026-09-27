import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { createAccountLink } from "@/lib/server/whop-account-links";
import { resolvePlatformConfig } from "@/lib/server/whop-kyc";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

/* ==========================================================================
   POST /api/whop/kyc/start

   Returns a short-lived Whop-hosted onboarding URL for the creator to
   complete KYC. The URL is minted fresh on every request — Whop links
   expire quickly and must never be cached.

   THE RETURN URL IS NOT PROOF. Landing back on our page after following this
   link does NOT mean KYC is complete. The client must call
   GET /api/whop/kyc/status to get the authoritative state from Whop.

   THE ACCOUNT ID IS NEVER THE CALLER'S. It is read from the database with the
   session uid AND the trusted environment; the request body is not consulted.
   Both redirect URLs are built server-side in whop-account-links.ts.
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
  if (!rl.ok) return rateLimitResponse(rl.retryAfterSeconds);

  const platform = resolvePlatformConfig();
  if (!platform.ok) return json({ error: "unavailable", reason: platform.reason }, 503);

  const account = await getConnectedAccount(firebaseUid, platform.config.environment);
  if (!account) return json({ error: "account_not_provisioned" }, 409);

  const link = await createAccountLink(account.whopAccountId, "account_onboarding");

  if (!link.ok) {
    if (link.reason === "platforms_access_required") return json({ error: link.reason }, 403);
    if (link.reason === "unconfigured") return json({ error: "unavailable" }, 503);
    if (link.reason === "provider_rejected") return json({ error: link.reason }, 502);
    return json({ error: link.reason }, 502);
  }

  return json({ ok: true, url: link.url }, 200);
}
