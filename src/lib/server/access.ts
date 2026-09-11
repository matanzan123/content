import "server-only";

import { getUserSession } from "./user-session";
import { getUserFromRequest } from "./user-auth";
import { getActiveBooking } from "./interviews";
import {
  getProfile,
  provisionUser,
  refreshProgress,
  type ClipRewardsUser,
  type UserProfile,
} from "./users";
import {
  resolveAccessStage,
  stageHasPlatformAccess,
  stageMayConnectWhop,
  STAGE_DESTINATIONS,
  type AccessStage,
} from "./user-lifecycle";
import type { Booking } from "./interviews";

/* ==========================================================================
   CANONICAL SERVER AUTHORIZATION — the one place a request becomes a verdict.

   Every guarded page and every guarded route asks this module, and nothing
   else, "who is this and what may they do". Having one answer is the point:
   two guards that compute access separately are two guards that will
   eventually disagree, and the one that disagrees generously is the breach.

   IT RESOLVES SEVEN STAGES, from `user-lifecycle.ts`:

     unauthenticated       no verified identity
     onboarding_incomplete signed in; role and/or profile missing
     interview_required    profile done; no interview booked
     awaiting_review       interview booked; staff have not decided
     rejected              turned down
     needs_followup        staff want another conversation
     approved_creator      approved, role creator
     approved_brand        approved, role brand
     admin                 Firebase custom claim `admin: true`

   THE CLIENT IS NEVER CONSULTED. Identity comes from a verified Firebase
   session cookie (or a Bearer ID token, for the API routes that already use
   one); role, approval status and booking come from our own tables. Nothing
   in a request body, query string or header other than the signed credential
   influences the outcome.

   `AuthGate` REMAINS, BUT IS NOT THE BOUNDARY. It is a client component that
   decides what to render; this module decides what is permitted. The previous
   build had only the former, which is why an unapproved user could reach the
   Whop connection step.
   ========================================================================== */

export type AccessContext = {
  stage: AccessStage;
  /** Null when unauthenticated. */
  uid: string | null;
  email: string | null;
  isAdmin: boolean;
  /** Null when unauthenticated, or when the row could not be provisioned. */
  user: ClipRewardsUser | null;
  profile: UserProfile | null;
  booking: Booking | null;
  /** May the caller enter operational ClipRewards areas? */
  hasPlatformAccess: boolean;
  /** May the caller begin Whop connection? Approved applicants only. */
  mayConnectWhop: boolean;
  /** Where a browser in this stage belongs, locale-relative. */
  destination: string;
  /** True when the server could not verify anything (Admin SDK absent). */
  unconfigured: boolean;
};

const UNAUTHENTICATED: AccessContext = {
  stage: "unauthenticated",
  uid: null,
  email: null,
  isAdmin: false,
  user: null,
  profile: null,
  booking: null,
  hasPlatformAccess: false,
  mayConnectWhop: false,
  destination: STAGE_DESTINATIONS.unauthenticated,
  unconfigured: false,
};

/**
 * Builds the full context for an already-verified identity.
 *
 * PROVISIONING HAPPENS HERE, and only here, so a user row exists from the
 * first authenticated request onward without any call site having to remember
 * to create one. It is idempotent, so doing it on every request is safe: a
 * repeat login is a no-op insert that returns the existing row.
 *
 * `refreshProgress` runs too, so a stage is never stale — a user who booked an
 * interview in another tab is `awaiting_review` on their next request without
 * anything having to invalidate a cache. It cannot produce a decision state,
 * so this convenience can never grant access.
 */
async function buildContext(
  uid: string,
  email: string | null,
  isAdmin: boolean,
): Promise<AccessContext> {
  const provisioned = await provisionUser(uid);
  if (!provisioned.ok) {
    // We know who they are but cannot read or create their account. Fail
    // CLOSED: treat as unconfigured rather than inventing a permissive
    // default.
    return {
      ...UNAUTHENTICATED,
      uid,
      email,
      isAdmin,
      stage: isAdmin ? "admin" : "unauthenticated",
      hasPlatformAccess: isAdmin,
      destination: isAdmin ? STAGE_DESTINATIONS.admin : STAGE_DESTINATIONS.unauthenticated,
      unconfigured: true,
    };
  }

  const refreshed = (await refreshProgress(uid)) ?? provisioned.user;
  const [profile, booking] = await Promise.all([getProfile(uid), getActiveBooking(uid)]);

  const stage = resolveAccessStage({
    authenticated: true,
    isAdmin,
    role: refreshed.role,
    status: refreshed.approvalStatus,
  });

  return {
    stage,
    uid,
    email,
    isAdmin,
    user: refreshed,
    profile,
    booking,
    hasPlatformAccess: stageHasPlatformAccess(stage),
    mayConnectWhop: stageMayConnectWhop(stage),
    destination: STAGE_DESTINATIONS[stage],
    unconfigured: false,
  };
}

/**
 * THE HELPER FOR PAGES AND SERVER COMPONENTS. Reads the session cookie.
 *
 * Use this in a layout or page to decide whether to render or redirect.
 */
export async function getAccessContext(): Promise<AccessContext> {
  const session = await getUserSession();
  if (!session.ok) {
    return session.reason === "unconfigured"
      ? { ...UNAUTHENTICATED, unconfigured: true }
      : UNAUTHENTICATED;
  }
  const { uid, email, isAdmin } = session.identity;
  return await buildContext(uid, email, isAdmin);
}

/**
 * THE HELPER FOR API ROUTES that authenticate with a Bearer ID token.
 *
 * Kept alongside the cookie path rather than replacing it: the Whop OAuth
 * routes already send a Bearer token from the browser and work correctly, and
 * migrating them in the same change that introduces sessions would risk
 * breaking a proven flow for no gain. Both paths converge on the same context,
 * so a route can move to cookies later without its authorization changing.
 */
export async function getAccessContextFromRequest(request: Request): Promise<AccessContext> {
  const bearer = await getUserFromRequest(request);
  if (bearer.ok) {
    // `getUserFromRequest` does not report admin status, so it is read from
    // the session cookie when one is also present. A Bearer-only caller is
    // simply not treated as an administrator, which is the safe direction.
    const session = await getUserSession();
    const isAdmin = session.ok && session.identity.uid === bearer.user.uid && session.identity.isAdmin;
    return await buildContext(bearer.user.uid, bearer.user.email, isAdmin);
  }

  // No Bearer token — fall back to the session cookie, so a route can accept
  // either without every handler having to try both.
  if (bearer.reason === "unconfigured") return { ...UNAUTHENTICATED, unconfigured: true };
  return await getAccessContext();
}

/* -------------------------------------------------------------------------
   ROUTE GUARDS
   ------------------------------------------------------------------------- */

export type ApiDenial = { denied: true; response: Response };
export type ApiAllowance = { denied: false; context: AccessContext };

const NO_STORE = { "cache-control": "no-store" };

/**
 * Requires a verified identity, nothing more. For endpoints an onboarding user
 * legitimately needs — choosing a role, saving a profile, booking an interview.
 */
export async function requireUser(request: Request): Promise<ApiDenial | ApiAllowance> {
  const context = await getAccessContextFromRequest(request);
  if (context.unconfigured) {
    return {
      denied: true,
      response: Response.json({ error: "unconfigured" }, { status: 503, headers: NO_STORE }),
    };
  }
  if (context.uid === null) {
    return {
      denied: true,
      response: Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE }),
    };
  }
  return { denied: false, context };
}

/**
 * Requires an APPROVED account. The gate in front of every operational area.
 *
 * A blocked caller is told only that they are not approved and where they
 * stand — never why someone else was approved, and never whether a resource
 * exists.
 */
export async function requireApproved(request: Request): Promise<ApiDenial | ApiAllowance> {
  const gate = await requireUser(request);
  if (gate.denied) return gate;

  if (!gate.context.hasPlatformAccess) {
    return {
      denied: true,
      response: Response.json(
        { error: "not_approved", stage: gate.context.stage },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  return gate;
}

/**
 * Requires an approved CREATOR or BRAND specifically — the gate in front of
 * Whop connection.
 *
 * Stricter than `requireApproved`, which also admits an administrator. An
 * admin has platform access but is not an applicant and has no Whop account of
 * their own to link, so letting one through here would start an OAuth flow
 * that belongs to nobody.
 */
export async function requireWhopEligible(
  request: Request,
): Promise<ApiDenial | ApiAllowance> {
  const gate = await requireUser(request);
  if (gate.denied) return gate;

  if (!gate.context.mayConnectWhop) {
    return {
      denied: true,
      response: Response.json(
        { error: "not_approved", stage: gate.context.stage },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  return gate;
}

export { STAGE_DESTINATIONS };
export type { AccessStage };
