import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { createAccountLink, resolvePlatformConfig } from "@/lib/server/whop-accounts";

/* ==========================================================================
   GET /api/whop/account/kyc-link

   Returns a short-lived Whop-hosted URL for the creator to complete KYC and
   payout onboarding. The URL is generated fresh on every request — Whop links
   expire quickly and must never be cached or reused across sessions.

   THE CREATOR IS NOT REDIRECTED HERE. The URL is returned as JSON so the
   client can attach it to a button that the creator explicitly clicks. A
   server-side redirect would fire on every page load instead.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const platform = resolvePlatformConfig();
  if (!platform.ok) return json({ error: "unavailable", reason: platform.reason }, 503);
  const { environment } = platform.config;

  const account = await getConnectedAccount(firebaseUid, environment);
  if (!account) return json({ error: "account_not_provisioned" }, 409);

  const appUrl = process.env.APP_PUBLIC_URL?.trim();
  if (!appUrl) return json({ error: "unavailable", reason: "missing_app_url" }, 503);

  const returnUrl = `${appUrl}/onboarding`;

  const link = await createAccountLink(platform.config, account.whopAccountId, returnUrl);
  if (!link.ok) {
    const status = link.reason === "platforms_access_required" ? 403 : 502;
    return json({ error: link.reason }, status);
  }

  return json({ ok: true, url: link.url }, 200);
}
