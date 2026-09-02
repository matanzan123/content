import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_MS,
  getAdminCheck,
} from "@/lib/server/admin-guard";
import { getAdminAuth } from "@/lib/server/firebase-admin";

/* ==========================================================================
   ADMIN SESSION EXCHANGE

   POST — the browser sends a freshly minted Firebase ID token. The server
   verifies it with the Admin SDK, refuses it unless the account carries the
   `admin` custom claim, and only then mints a Firebase session cookie.

   The ID token never becomes the session. It is short-lived, readable by the
   page that holds it, and would have to be stored somewhere to be reused. The
   session cookie is httpOnly, so no script — ours or an injected one — can
   read it, and it is verifiable server-side on every request.

   DELETE — clears the cookie and revokes the account's refresh tokens, so the
   session cannot be resurrected from a copy of the cookie taken earlier.
   ========================================================================== */

/** Reject anything that is not a plausible JWT before spending a verification. */
function readIdToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length < 100 || token.length > 8192) return null;
  return token.split(".").length === 3 ? token : null;
}

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  const auth = getAdminAuth();
  // Deny by default: with no service account the server cannot verify anyone.
  if (!auth) {
    return Response.json({ error: "unconfigured" }, { status: 503, headers: NO_STORE });
  }

  let idToken: string | null = null;
  try {
    const body: unknown = await request.json();
    idToken = readIdToken((body as { idToken?: unknown } | null)?.idToken);
  } catch {
    idToken = null;
  }
  if (!idToken) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const decoded = await auth.verifyIdToken(idToken, true);

    // Authorization happens here, before any cookie is issued: a non-admin
    // never receives an admin session in the first place.
    if (decoded.admin !== true) {
      return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    }

    // Require a recent sign-in. This is also the hook MFA will use later:
    // once step-up is enforced, the freshness window is what forces a
    // re-authentication rather than a silently reused old token.
    const ageMs = Date.now() - decoded.auth_time * 1000;
    if (ageMs > 5 * 60 * 1000) {
      return Response.json({ error: "stale_login" }, { status: 401, headers: NO_STORE });
    }

    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn: ADMIN_SESSION_MAX_AGE_MS,
    });

    (await cookies()).set(ADMIN_SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: ADMIN_SESSION_MAX_AGE_MS / 1000,
    });

    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
}

export async function DELETE() {
  const check = await getAdminCheck();
  const jar = await cookies();

  // Clear first, so a failure to revoke still ends the session on this device.
  jar.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });

  if (check.ok) {
    const auth = getAdminAuth();
    try {
      await auth?.revokeRefreshTokens(check.admin.uid);
    } catch {
      // Best effort — the cookie is already gone from this browser.
    }
  }

  return Response.json({ ok: true }, { headers: NO_STORE });
}
