import "server-only";

import { cookies } from "next/headers";
import { getAdminAuth } from "./firebase-admin";

/* ==========================================================================
   ADMIN AUTHORIZATION — the single source of truth.

   Every admin page, server action and API route funnels through this file.
   Nothing here reads anything the browser can set: the only input is a
   Firebase *session cookie*, which is httpOnly, minted server-side from a
   verified ID token, and re-verified against Firebase on every request with
   revocation checking on.

   The admin claim itself lives in Firebase custom claims (`admin: true`),
   which are baked into the token by Firebase and cannot be forged or edited
   from the client. A user cannot grant themselves the claim; it is set with
   the Admin SDK out of band (see scripts/grant-admin.mjs).

   Outcomes are a closed set, so a caller cannot accidentally treat an
   unexpected state as success.
   ========================================================================== */

/** Name is namespaced and carries no meaning to the client. */
export const ADMIN_SESSION_COOKIE = "cliprewards_admin_session";

/** Session lifetime. Firebase caps session cookies at 14 days; we stay well under. */
export const ADMIN_SESSION_MAX_AGE_MS = 60 * 60 * 8 * 1000; // 8 hours

export type AdminIdentity = {
  uid: string;
  email: string | null;
  name: string | null;
  /** Seconds since epoch — when the underlying sign-in happened. */
  authTime: number;
};

export type AdminCheck =
  | { ok: true; admin: AdminIdentity }
  /** No usable session cookie — the visitor should be sent to sign in. */
  | { ok: false; reason: "unauthenticated" }
  /** A valid, signed-in identity that simply is not an administrator. */
  | { ok: false; reason: "forbidden" }
  /** The server cannot verify anything. Treated as a denial, never as a pass. */
  | { ok: false; reason: "unconfigured" };

/**
 * Resolves the caller's admin status. Never throws — callers decide what a
 * denial looks like (redirect, 403 page, JSON error).
 */
export async function getAdminCheck(): Promise<AdminCheck> {
  const auth = getAdminAuth();
  if (!auth) return { ok: false, reason: "unconfigured" };

  const cookie = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!cookie) return { ok: false, reason: "unauthenticated" };

  try {
    // `true` = check revocation. A disabled account or a revoked refresh token
    // fails here, so removing an admin takes effect on their next request
    // rather than whenever their cookie happens to expire.
    const claims = await auth.verifySessionCookie(cookie, true);

    // The claim must be exactly boolean true. A truthy string from a
    // mis-scripted claim update must not be enough.
    if (claims.admin !== true) return { ok: false, reason: "forbidden" };

    return {
      ok: true,
      admin: {
        uid: claims.uid,
        email: typeof claims.email === "string" ? claims.email : null,
        name: typeof claims.name === "string" ? claims.name : null,
        authTime: typeof claims.auth_time === "number" ? claims.auth_time : 0,
      },
    };
  } catch {
    // Expired, revoked, tampered with, or signed by the wrong project.
    return { ok: false, reason: "unauthenticated" };
  }
}

/** Convenience for call sites that only care whether to proceed. */
export async function isAdminRequest(): Promise<boolean> {
  return (await getAdminCheck()).ok;
}

export class AdminAccessError extends Error {
  constructor(readonly reason: Exclude<AdminCheck, { ok: true }>["reason"]) {
    super(`admin access denied: ${reason}`);
    this.name = "AdminAccessError";
  }
}

/**
 * Throws unless the caller is a verified administrator. Use in server actions
 * and anywhere a denial should abort the work outright.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const check = await getAdminCheck();
  if (!check.ok) throw new AdminAccessError(check.reason);
  return check.admin;
}

/**
 * The one wrapper every admin API route uses. Runs its own authorization —
 * route handlers are not covered by the locale middleware and must never
 * assume a page guard ran first.
 *
 * Responses are deliberately terse: an unauthorised caller learns only that
 * they were refused, not whether the endpoint or the data exists.
 */
export async function withAdminApi<T>(
  handler: (admin: AdminIdentity) => Promise<T>,
): Promise<Response> {
  const check = await getAdminCheck();

  if (!check.ok) {
    const status = check.reason === "forbidden" ? 403 : 401;
    return Response.json(
      { error: check.reason === "forbidden" ? "forbidden" : "unauthorized" },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  const body = await handler(check.admin);
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
