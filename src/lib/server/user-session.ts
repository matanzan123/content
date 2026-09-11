import "server-only";

import { cookies } from "next/headers";
import { getAdminAuth } from "./firebase-admin";

/* ==========================================================================
   THE ORDINARY-USER SESSION — the non-privileged twin of `admin-guard`.

   DELIBERATELY THE SAME SHAPE AS THE ADMIN SESSION, because that pattern is
   already proven here: a short-lived Firebase ID token is exchanged once,
   server-side, for an httpOnly Firebase SESSION COOKIE, and every subsequent
   request re-verifies that cookie against Firebase with revocation checking
   on. The ID token never becomes the session — it is readable by any script on
   the page and would have to be stored somewhere to be reused.

   WHAT IS DIFFERENT FROM THE ADMIN SESSION, and why:

     - NO `admin` CLAIM IS REQUIRED. This is the whole point: an ordinary user
       must get a session without privilege. `admin-guard` keeps its own
       stricter check and its own cookie.
     - A SEPARATE COOKIE NAME. One cookie cannot serve both, because the admin
       cookie means "this person passed the admin claim check at mint time".
       Reusing it would make an ordinary session indistinguishable from an
       administrator's on the wire.
     - `sameSite: "lax"`, not `strict`. Users arrive back from an external
       identity flow and from emailed links, and `strict` drops the cookie on
       those top-level navigations — the session would appear to vanish. `lax`
       still withholds the cookie from cross-site POSTs, which is the case that
       matters. The admin area keeps `strict` because nobody should ever reach
       it from an outside link.
     - NO FRESHNESS WINDOW. The admin exchange refuses a sign-in older than
       five minutes because it is a privilege escalation. An ordinary sign-in
       is not, and a five-minute rule there would log people out for no reason.

   DENY BY DEFAULT. With no service account the SDK returns null and every call
   here is a refusal. There is no development bypass: an unverifiable identity
   must never become "some user".
   ========================================================================== */

/** Namespaced, and distinct from the admin cookie. Carries no meaning to a client. */
export const USER_SESSION_COOKIE = "cliprewards_user_session";

/**
 * Session lifetime. Firebase caps session cookies at 14 days; 5 is a
 * deliberate step below that — long enough that ordinary users are not
 * re-authenticating constantly, short enough that a stolen cookie expires.
 */
export const USER_SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export type SessionIdentity = {
  uid: string;
  /** Present when the token carries it. NEVER used to establish identity. */
  email: string | null;
  emailVerified: boolean;
  /** True when the account also holds the admin custom claim. */
  isAdmin: boolean;
};

export type SessionCheck =
  | { ok: true; identity: SessionIdentity }
  /** No usable cookie. The visitor should sign in. */
  | { ok: false; reason: "unauthenticated" }
  /** The server cannot verify anything. A denial, never a pass. */
  | { ok: false; reason: "unconfigured" };

/**
 * Resolves the caller's identity from the session cookie. Never throws.
 *
 * Revocation checking is on, so a disabled account or a revoked refresh token
 * fails here rather than lingering until the cookie expires.
 */
export async function getUserSession(): Promise<SessionCheck> {
  const auth = getAdminAuth();
  if (!auth) return { ok: false, reason: "unconfigured" };

  const cookie = (await cookies()).get(USER_SESSION_COOKIE)?.value;
  if (!cookie) return { ok: false, reason: "unauthenticated" };

  try {
    const claims = await auth.verifySessionCookie(cookie, true);
    return {
      ok: true,
      identity: {
        uid: claims.uid,
        email: typeof claims.email === "string" ? claims.email : null,
        emailVerified: claims.email_verified === true,
        // Read, never required. The admin AREA still goes through
        // `admin-guard` and its own cookie; this only lets a page know that
        // the signed-in person is also staff.
        isAdmin: claims.admin === true,
      },
    };
  } catch {
    // Expired, revoked, tampered with, or signed by the wrong project.
    return { ok: false, reason: "unauthenticated" };
  }
}

/** Rejects anything that is not a plausible JWT before spending a verification. */
export function readIdToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length < 100 || token.length > 8192) return null;
  return token.split(".").length === 3 ? token : null;
}

/** The cookie attributes, in one place so mint and clear cannot disagree. */
export function userSessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
