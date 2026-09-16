import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { fetchPayoutStatus } from "@/lib/server/whop-payout-status";
import { resolvePlatformConfig } from "@/lib/server/whop-accounts";

/* ==========================================================================
   GET /api/whop/payout/status

   Returns payout readiness for the creator's connected account.

   THIS IS NOT KYC. KYC (GET /api/whop/kyc/status) tells you whether the
   creator's identity is verified. This endpoint tells you whether the
   provider can actually move money to the creator right now.

   A creator may be KYC-verified but still not payout-ready if they have not
   added a bank account or completed provider-specific payout setup.

   SOURCE OF TRUTH: GET /accounts/{id} on the Whop Platforms API.
   Note: GET /payout_methods?account_id=... returned 403 in sandbox — that
   scope is not available with the platform API key. The payout readiness
   model is derived from account capabilities instead (documented, not silent).
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

  const result = await fetchPayoutStatus(account.whopAccountId);
  if (!result.ok) {
    if (result.reason === "platforms_access_required") return json({ error: result.reason }, 403);
    if (result.reason === "not_found") return json({ error: "account_not_found" }, 404);
    return json({ error: result.reason }, 502);
  }

  const { status } = result;

  return json(
    {
      ok: true,
      provisioned: true,
      whop_account_id: account.whopAccountId,
      can_receive_payout: status.canReceivePayout,
      readiness: status.readiness,
      capabilities: {
        outbound: status.capabilities.outbound,
        any_outbound_active: status.capabilities.anyOutboundActive,
      },
      pending_requirements: status.pendingRequirements,
      past_due_requirements: status.pastDueRequirements,
    },
    200,
  );
}
