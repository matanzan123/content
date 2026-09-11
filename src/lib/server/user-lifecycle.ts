import "server-only";

/* ==========================================================================
   THE CLIPREWARDS ACCOUNT LIFECYCLE — one place where account state is decided.

   THE RULE THIS FILE EXISTS TO ENFORCE: signing in is not joining.

   A Google sign-in proves who someone is. It says nothing about whether
   ClipRewards wants them on the platform, and every state below except
   `approved` denies operational access. Nothing a user does to their own
   account — choosing a role, filling in a profile, booking an interview —
   moves them to `approved`. Only an administrator can, and only through the
   server-side review path.

   THE STATES, chosen to match the actual product flow and no larger:

     onboarding         signed in; role and/or profile still incomplete
     pending_interview  profile complete; no interview booked yet
     pending_review     interview booked; waiting on ClipRewards staff
     approved           an administrator let them in        <- the only pass
     rejected           an administrator turned them down
     needs_followup     an administrator wants another conversation

   `needs_followup` is deliberately NOT a pass. It means "we are not finished
   deciding", and treating it as provisional access would be the one shortcut
   that lets an unvetted account onto the platform.

   WHY THE FIRST THREE ARE DERIVED, NOT SET BY A USER. `onboarding`,
   `pending_interview` and `pending_review` are functions of facts we can
   verify — is there a role, is the profile complete, is there a live booking.
   `computeProgressStatus` below is that function. A client cannot post itself
   forward because it does not supply the inputs; the server reads them from
   its own tables.

   WHY THE LAST THREE ARE TERMINAL-ISH. `approved`, `rejected` and
   `needs_followup` are DECISIONS. Once a decision exists, no amount of user
   activity may overwrite it — a rejected user who edits their profile does not
   silently return to `pending_review` and get re-queued. Only another admin
   decision moves them. That is what `isDecided` guards.
   ========================================================================== */

export const APPROVAL_STATUSES = [
  "onboarding",
  "pending_interview",
  "pending_review",
  "approved",
  "rejected",
  "needs_followup",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const USER_ROLES = ["creator", "brand"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * A role a caller is allowed to choose for themselves.
 *
 * `admin` is deliberately absent. Administrator status lives in a Firebase
 * custom claim set out of band, never in this column and never selectable —
 * a role a user can pick must never be one that grants privilege.
 */
export function isSelectableRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
   DECISIONS
   ------------------------------------------------------------------------- */

/** The three states only an administrator can produce. */
export const ADMIN_DECISIONS = ["approved", "rejected", "needs_followup"] as const;
export type AdminDecision = (typeof ADMIN_DECISIONS)[number];

export function isAdminDecision(value: unknown): value is AdminDecision {
  return typeof value === "string" && (ADMIN_DECISIONS as readonly string[]).includes(value);
}

/**
 * Whether a status is the result of a human decision rather than of progress.
 *
 * Used to stop ordinary user activity from overwriting a verdict: once this is
 * true, `computeProgressStatus` is not allowed to move the row at all.
 */
export function isDecided(status: ApprovalStatus): boolean {
  return isAdminDecision(status);
}

/**
 * THE ONE PREDICATE THAT GRANTS ACCESS. Exactly one status passes.
 *
 * A named function rather than an inline `=== "approved"` at each call site,
 * because this is the single most consequential test in the build and it
 * deserves to be greppable, testable, and impossible to fudge with a truthy
 * check.
 */
export function grantsPlatformAccess(status: ApprovalStatus): boolean {
  return status === "approved";
}

/**
 * Whether the account is blocked pending or following a decision. Everything
 * that is not `approved` is blocked; this exists to make that explicit rather
 * than implied by the absence of a pass.
 */
export function isBlocked(status: ApprovalStatus): boolean {
  return !grantsPlatformAccess(status);
}

/* -------------------------------------------------------------------------
   PROGRESS
   ------------------------------------------------------------------------- */

/**
 * The verifiable facts that decide a pre-decision status. Every one is read
 * from our own tables — none is supplied by a caller.
 */
export type ProgressFacts = {
  role: UserRole | null;
  onboardingCompletedAt: Date | null;
  /** True when the user holds a booking that is still live (not cancelled). */
  hasActiveBooking: boolean;
};

/**
 * Where an undecided account stands, derived from facts.
 *
 * Returns null when the account already carries an admin decision — the caller
 * must leave it alone. That is the guard which stops a rejected user from
 * editing their way back into the review queue.
 */
export function computeProgressStatus(
  current: ApprovalStatus,
  facts: ProgressFacts,
): ApprovalStatus | null {
  if (isDecided(current)) return null;

  // A role AND a completed profile are both required to leave onboarding.
  // Either one alone is an unfinished account.
  if (facts.role === null || facts.onboardingCompletedAt === null) return "onboarding";

  return facts.hasActiveBooking ? "pending_review" : "pending_interview";
}

/**
 * Whether an admin may move an account from `from` to `to`.
 *
 * EVERY decision is reachable from EVERY state, and that is the honest rule
 * rather than a gap. An admin genuinely needs to approve someone previously
 * rejected, withdraw an approval that turns out to be wrong, or re-assert the
 * same verdict idempotently after a double-click. There is no ordering here to
 * enforce, so this function does not pretend to enforce one.
 *
 * The real constraint is not WHICH transition but WHO: these three values have
 * exactly one writer — `decideUser` in `users.ts`, behind `requireAdmin` — and
 * no user-facing path can produce them. That is enforced by construction, and
 * asserted by the tests, rather than by a table of permitted moves.
 *
 * `from` is taken so a caller can log the prior state, and so this signature
 * does not have to change if a future rule does need it.
 */
export function isAdminTransitionAllowed(_from: ApprovalStatus, to: AdminDecision): boolean {
  return isAdminDecision(to);
}

/**
 * The transitions this build will ever ask for, as a table, so a reader can
 * check the rules without following three call sites. Used by the tests.
 *
 * Note the shape: user activity NEVER produces a decision, and an admin
 * decision NEVER arises from progress. The two columns of this table do not
 * overlap, which is the property that matters.
 */
export const LIFECYCLE_RULES: {
  from: ApprovalStatus;
  to: ApprovalStatus;
  by: "progress" | "admin";
  allowed: boolean;
  why: string;
}[] = [
  { from: "onboarding", to: "pending_interview", by: "progress", allowed: true, why: "role and profile complete" },
  { from: "pending_interview", to: "pending_review", by: "progress", allowed: true, why: "interview booked" },
  { from: "pending_review", to: "pending_interview", by: "progress", allowed: true, why: "booking cancelled" },
  { from: "onboarding", to: "approved", by: "progress", allowed: false, why: "users cannot approve themselves" },
  { from: "pending_review", to: "approved", by: "progress", allowed: false, why: "users cannot approve themselves" },
  { from: "pending_review", to: "approved", by: "admin", allowed: true, why: "the interview went well" },
  { from: "pending_review", to: "rejected", by: "admin", allowed: true, why: "not a fit" },
  { from: "pending_review", to: "needs_followup", by: "admin", allowed: true, why: "another conversation needed" },
  { from: "rejected", to: "pending_review", by: "progress", allowed: false, why: "a verdict is not undone by editing a profile" },
  { from: "approved", to: "onboarding", by: "progress", allowed: false, why: "a verdict is not undone by editing a profile" },
  { from: "needs_followup", to: "approved", by: "admin", allowed: true, why: "the follow-up resolved it" },
  { from: "rejected", to: "approved", by: "admin", allowed: true, why: "an admin may revisit a verdict" },
];

/* -------------------------------------------------------------------------
   ACCESS STAGES
   ------------------------------------------------------------------------- */

/**
 * What the server should DO about a caller, as a closed set.
 *
 * This is the vocabulary every guarded page and route speaks. It is
 * deliberately not "allowed: boolean": a blocked user needs to be sent
 * somewhere specific, and collapsing six reasons into one boolean is how a
 * rejected applicant ends up staring at a login screen.
 */
export type AccessStage =
  /** A. no verified identity at all. */
  | "unauthenticated"
  /** B. signed in, role and/or profile incomplete. */
  | "onboarding_incomplete"
  /** C1. profile done, no interview booked. */
  | "interview_required"
  /** C2. interview booked, waiting on staff. */
  | "awaiting_review"
  /** D1. turned down. */
  | "rejected"
  /** D2. staff want another conversation. */
  | "needs_followup"
  /** E. approved creator. */
  | "approved_creator"
  /** F. approved brand. */
  | "approved_brand"
  /** G. administrator, by Firebase custom claim. */
  | "admin";

/**
 * Maps an account to its access stage.
 *
 * `isAdmin` wins over everything, and comes from a Firebase custom claim
 * rather than this database — an administrator is not an approved applicant
 * and must not have to be one to reach the admin area.
 */
export function resolveAccessStage(input: {
  authenticated: boolean;
  isAdmin: boolean;
  role: UserRole | null;
  status: ApprovalStatus;
}): AccessStage {
  if (!input.authenticated) return "unauthenticated";
  if (input.isAdmin) return "admin";

  switch (input.status) {
    case "rejected":
      return "rejected";
    case "needs_followup":
      return "needs_followup";
    case "approved":
      // An approved account with no role is not reachable through the normal
      // flow — progress cannot leave `onboarding` without one — but if it ever
      // occurs, the safe reading is "not finished", never "let them in".
      if (input.role === "creator") return "approved_creator";
      if (input.role === "brand") return "approved_brand";
      return "onboarding_incomplete";
    case "pending_review":
      return "awaiting_review";
    case "pending_interview":
      return "interview_required";
    case "onboarding":
      return "onboarding_incomplete";
  }
}

/** Whether a stage may enter operational ClipRewards areas. */
export function stageHasPlatformAccess(stage: AccessStage): boolean {
  return stage === "approved_creator" || stage === "approved_brand" || stage === "admin";
}

/**
 * WHETHER A STAGE MAY BEGIN WHOP CONNECTION.
 *
 * Separate from `stageHasPlatformAccess` on purpose, and stricter: an
 * administrator has platform access but is not an applicant and has no Whop
 * account of their own to link. Connecting Whop is something an APPROVED
 * CREATOR OR BRAND does, and nobody else.
 *
 * This is the predicate that corrects the previous flow, where the onboarding
 * wizard's final step offered "Connect Whop" to anyone who had signed in —
 * before ClipRewards had approved them at all.
 */
export function stageMayConnectWhop(stage: AccessStage): boolean {
  return stage === "approved_creator" || stage === "approved_brand";
}

/**
 * Where to send a browser for a given stage. One table, so page guards and
 * tests cannot disagree about the routing.
 *
 * Paths are locale-relative; callers prefix the active locale.
 */
export const STAGE_DESTINATIONS: Record<AccessStage, string> = {
  unauthenticated: "/login",
  onboarding_incomplete: "/onboarding",
  interview_required: "/onboarding/interview",
  awaiting_review: "/onboarding/review",
  rejected: "/onboarding/not-approved",
  needs_followup: "/onboarding/follow-up",
  approved_creator: "/dashboard",
  approved_brand: "/brand/dashboard",
  admin: "/admin",
};
