import { getUserFromRequest } from "@/lib/server/user-auth";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { disconnectWhop } from "@/lib/server/whop-connections";
import { resolveOAuthConfig, revokeToken } from "@/lib/server/whop-oauth";

/* ==========================================================================
   DISCONNECT WHOP.

   Ownership is the whole of the authorization: the uid comes from a verified
   Firebase ID token, and the update is scoped to it. There is no body field
   naming a connection, so one user cannot disconnect another.

   LOCAL FIRST, PROVIDER SECOND. The row is revoked and its credentials cleared
   before Whop is contacted, and provider revocation is reported but never
   blocking. Someone must be able to unlink an account even when Whop is
   unreachable — the alternative is a link they cannot remove.

   Signing out of ClipRewards does NOT come through here. A Firebase logout
   leaves the link intact, which is what someone signing back in expects.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const auth = await getUserFromRequest(request);
  if (!auth.ok) {
    return Response.json(
      { error: auth.reason },
      { status: auth.reason === "unconfigured" ? 503 : 401, headers: NO_STORE },
    );
  }

  const result = await disconnectWhop(auth.user.uid);
  if (!result.ok) {
    return Response.json(
      { error: result.reason },
      { status: result.reason === "not_connected" ? 404 : 503, headers: NO_STORE },
    );
  }

  // Best effort, and reported honestly. The link is already gone locally.
  let providerRevoked = false;
  const config = resolveOAuthConfig();
  if (config.ok && result.revokedToken) {
    providerRevoked = await revokeToken({ config: config.config, token: result.revokedToken });
  }

  return Response.json(
    { disconnected: true, provider_revoked: providerRevoked },
    { headers: NO_STORE },
  );
}
