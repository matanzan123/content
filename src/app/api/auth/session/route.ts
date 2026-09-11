import { cookies } from "next/headers";
import { getAdminAuth } from "@/lib/server/firebase-admin";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  getUserSession,
  readIdToken,
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_MS,
  userSessionCookieOptions,
} from "@/lib/server/user-session";
import { provisionUser } from "@/lib/server/users";

/* ==========================================================================
   ORDINARY-USER SESSION EXCHANGE

   POST — the browser sends a freshly minted Firebase ID token. The server
   verifies it with the Admin SDK and mints an httpOnly Firebase session
   cookie. The ID token never becomes the session: it is readable by any script
   on the page and would have to be stored somewhere to be reused.

   NO ADMIN CLAIM IS REQUIRED HERE, and that is the difference from
   `/api/admin/session`. This endpoint gives an ordinary signed-in person a
   verifiable session and no privilege whatsoever. The admin area keeps its own
   endpoint, its own cookie and its own claim check.

   AND NO APPROVAL IS REQUIRED EITHER. A session says who someone is; approval
   says what they may do. An unapproved applicant needs a session to complete
   onboarding and book an interview at all — gating the session on approval
   would make the approval flow unreachable. Access is decided later, by
   `access.ts`, on every guarded request.

   PROVISIONING HAPPENS ON EXCHANGE, so a `users` row exists from the first
   sign-in. It is idempotent: a repeat login returns the same row and changes
   nothing, so the same Firebase UID is always the same ClipRewards user.

   DELETE — clears the cookie and revokes the account's refresh tokens, so the
   session cannot be resurrected from a copy of the cookie taken earlier.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 16_384;

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  // A session mint is a state-changing POST; a cross-site page must not be
  // able to trigger one on a visitor's behalf.
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const auth = getAdminAuth();
  // Deny by default: with no service account the server can verify nobody.
  if (!auth) return json({ error: "unconfigured" }, 503);

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let idToken: string | null = null;
  try {
    const body: unknown = await request.json();
    idToken = readIdToken((body as { idToken?: unknown } | null)?.idToken);
  } catch {
    idToken = null;
  }
  if (!idToken) return json({ error: "invalid_request" }, 400);

  try {
    // `true` = check revocation, so a disabled account cannot open a session.
    const decoded = await auth.verifyIdToken(idToken, true);

    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn: USER_SESSION_MAX_AGE_MS,
    });

    (await cookies()).set(
      USER_SESSION_COOKIE,
      sessionCookie,
      userSessionCookieOptions(USER_SESSION_MAX_AGE_MS / 1000),
    );

    // Idempotent. The UID comes from the verified token, never from the body.
    const provisioned = await provisionUser(decoded.uid);

    return json(
      {
        ok: true,
        // Enough for the client to route; never a credential, and never a
        // claim the client could act on without the server agreeing.
        created: provisioned.ok ? provisioned.created : false,
      },
      200,
    );
  } catch {
    return json({ error: "unauthorized" }, 401);
  }
}

export async function DELETE() {
  const session = await getUserSession();
  const jar = await cookies();

  // Clear first, so a failure to revoke still ends the session on this device.
  jar.set(USER_SESSION_COOKIE, "", userSessionCookieOptions(0));

  if (session.ok) {
    const auth = getAdminAuth();
    try {
      await auth?.revokeRefreshTokens(session.identity.uid);
    } catch {
      // Best effort — the cookie is already gone from this browser.
    }
  }

  return json({ ok: true }, 200);
}
