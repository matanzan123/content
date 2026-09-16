import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { fetchKycStatus, resolvePlatformConfig } from "@/lib/server/whop-kyc";
import { resolveKycUiState } from "@/lib/server/kyc-state";

/* ==========================================================================
   GET /api/whop/kyc/status

   Returns the AUTHORITATIVE KYC state for the creator's connected account,
   fetched live from Whop on every request.

   THE RETURN URL IS NOT PROOF. This endpoint is what proves KYC is complete —
   not a query parameter or a redirect. The client must call this after the
   creator returns from Whop's hosted onboarding.
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

  const account = await getConnectedAccount(firebaseUid, platform.config.environment);
  if (!account) return json({ ok: true, provisioned: false }, 200);

  const kyc = await fetchKycStatus(account.whopAccountId);
  if (!kyc.ok) {
    if (kyc.reason === "platforms_access_required") return json({ error: kyc.reason }, 403);
    if (kyc.reason === "not_found") return json({ error: "account_not_found" }, 404);
    return json({ error: kyc.reason }, 502);
  }

  const { state, requiredActions, pastDueActions, providerStatus } = kyc.kycStatus;
  const uiState = resolveKycUiState(state, requiredActions, pastDueActions);

  return json(
    {
      ok: true,
      provisioned: true,
      whop_account_id: account.whopAccountId,
      provider_status: providerStatus,
      kyc: uiState,
    },
    200,
  );
}
