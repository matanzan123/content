import "server-only";

import { getAdminAuth } from "./firebase-admin";

/* ==========================================================================
   SIGNED-IN USER — the ClipRewards identity, server side.

   Firebase is and remains the canonical application identity. This is the
   ordinary-user counterpart to `admin-guard`: it answers "who is making this
   request" for any authenticated endpoint, with no privilege attached.

   The only accepted proof is a Firebase ID TOKEN in the Authorization header,
   verified with the Admin SDK on every request. Nothing else counts — not an
   email, not a uid in a body, not a query parameter. A caller cannot assert
   who they are; they can only present a token Firebase signed.

   DENY BY DEFAULT. With no service account configured the SDK returns null and
   every call here is a refusal. There is deliberately no development bypass:
   an unverifiable identity must never become "some user".
   ========================================================================== */

export type UserIdentity = {
  uid: string;
  /** Present when the token carries it. NEVER used to establish identity. */
  email: string | null;
  emailVerified: boolean;
};

export type UserCheck =
  | { ok: true; user: UserIdentity }
  /** No usable token. The caller should sign in. */
  | { ok: false; reason: "unauthenticated" }
  /** The server cannot verify anything. Treated as a denial, never a pass. */
  | { ok: false; reason: "unconfigured" };

/** Rejects anything that is not a plausible JWT before spending a verification. */
function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const token = match[1];
  if (token.length < 100 || token.length > 8192) return null;
  return token.split(".").length === 3 ? token : null;
}

/**
 * Resolves the caller's ClipRewards identity. Never throws.
 *
 * Revocation checking is on: a disabled account or a revoked refresh token
 * fails here rather than lingering until a cookie expires.
 */
export async function getUserFromRequest(request: Request): Promise<UserCheck> {
  const auth = getAdminAuth();
  if (!auth) return { ok: false, reason: "unconfigured" };

  const token = readBearer(request.headers.get("authorization"));
  if (!token) return { ok: false, reason: "unauthenticated" };

  try {
    const claims = await auth.verifyIdToken(token, true);
    return {
      ok: true,
      user: {
        uid: claims.uid,
        email: typeof claims.email === "string" ? claims.email : null,
        emailVerified: claims.email_verified === true,
      },
    };
  } catch {
    // Expired, revoked, tampered with, or signed by the wrong project.
    return { ok: false, reason: "unauthenticated" };
  }
}
