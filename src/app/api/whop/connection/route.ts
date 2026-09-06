import { getUserFromRequest } from "@/lib/server/user-auth";
import { getActiveConnection } from "@/lib/server/whop-connections";

/* ==========================================================================
   CONNECTION STATUS for the signed-in user.

   Reports whether THIS user has a Whop link, and shows a handle if there is
   one. It reports on the caller and only the caller: the uid comes from a
   verified ID token, so there is no parameter that could ask about anyone
   else.

   No token, no refresh token, no provider payload — a status endpoint has no
   business carrying credentials, and this one cannot.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const auth = await getUserFromRequest(request);
  if (!auth.ok) {
    return Response.json(
      { error: auth.reason },
      { status: auth.reason === "unconfigured" ? 503 : 401, headers: NO_STORE },
    );
  }

  const connection = await getActiveConnection(auth.user.uid);
  return Response.json(
    connection
      ? {
          connected: true,
          username: connection.whopUsername,
          scopes: connection.scopes,
          connected_at: connection.connectedAt.toISOString(),
        }
      : { connected: false },
    { headers: NO_STORE },
  );
}
