import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { interviewBookings, userProfiles, users } from "@/lib/db/schema";
import {
  computeProgressStatus,
  isAdminDecision,
  isDecided,
  isSelectableRole,
  type AdminDecision,
  type ApprovalStatus,
  type UserRole,
} from "./user-lifecycle";

/* ==========================================================================
   THE CANONICAL CLIPREWARDS USER — server only.

   ONE ROW PER FIREBASE UID, and the UID is the only identity. There is no
   lookup by email in this module, no email column to look up, and no merge
   path. Two people who once shared an address are two users; one person who
   changes address is one user. Firebase owns the address.

   THE UID ALWAYS COMES FROM A VERIFIED TOKEN. Every function here takes a
   `firebaseUid` that its caller obtained from `getUserFromRequest` or
   `getUserSession` — never from a request body, a query parameter or a form
   field. That is the property that makes "cannot act as another user" true:
   there is no parameter through which a caller could name someone else.

   APPROVAL HAS EXACTLY TWO WRITERS, and they cannot reach each other's values:

     refreshProgress()  may write onboarding / pending_interview /
                        pending_review, and ONLY those. It derives them from
                        facts in our own tables and refuses to touch a row that
                        already carries a decision.

     decideUser()       may write approved / rejected / needs_followup, and
                        ONLY those. Its callers are behind `requireAdmin`.

   Neither can produce the other's states. That separation, not a permission
   check inside a shared setter, is what makes self-approval impossible.
   ========================================================================== */

export type ClipRewardsUser = {
  firebaseUid: string;
  role: UserRole | null;
  approvalStatus: ApprovalStatus;
  onboardingCompletedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  decidedByUid: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type UserProfile = {
  firebaseUid: string;
  fullName: string | null;
  bio: string | null;
  photoUrl: string | null;
  languages: string[] | null;
  creatorType: string | null;
  referralSource: string | null;
  socials: string[] | null;
  companyName: string | null;
  lastStep: number;
};

/* -------------------------------------------------------------------------
   PROVISIONING
   ------------------------------------------------------------------------- */

export type ProvisionResult =
  | { ok: true; user: ClipRewardsUser; created: boolean }
  | { ok: false; reason: "unconfigured" | "invalid_uid" | "storage_error" };

/** A Firebase UID is opaque; only blanks and absurd lengths are refused. */
export function isFirebaseUid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

/**
 * Ensures exactly one row exists for a UID. Idempotent by construction.
 *
 * `insert … on conflict (firebase_uid) do nothing … returning` is one
 * statement, so two simultaneous first logins cannot both insert: the primary
 * key decides, and the loser reads back the winner's row. A `select` then
 * `insert` could not do this — both callers would see nothing and both would
 * try.
 *
 * A REPEAT LOGIN CHANGES NOTHING. No field is updated on conflict, so
 * provisioning can be called on every request without touching `updated_at` or
 * disturbing an approval. The new user always starts `onboarding` with a null
 * role: signing in is not joining, and nobody is defaulted to `creator`.
 */
export async function provisionUser(firebaseUid: string): Promise<ProvisionResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!isFirebaseUid(firebaseUid)) return { ok: false, reason: "invalid_uid" };

  try {
    const inserted = await db
      .insert(users)
      .values({ firebaseUid, role: null, approvalStatus: "onboarding" })
      .onConflictDoNothing({ target: users.firebaseUid })
      .returning();

    if (inserted.length === 1) {
      return { ok: true, user: inserted[0] as ClipRewardsUser, created: true };
    }

    const existing = await getUser(firebaseUid);
    if (!existing) return { ok: false, reason: "storage_error" };
    return { ok: true, user: existing, created: false };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getUser(firebaseUid: string): Promise<ClipRewardsUser | null> {
  const db = getDb();
  if (!db || !isFirebaseUid(firebaseUid)) return null;
  const [row] = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid));
  return (row as ClipRewardsUser | undefined) ?? null;
}

export async function getProfile(firebaseUid: string): Promise<UserProfile | null> {
  const db = getDb();
  if (!db || !isFirebaseUid(firebaseUid)) return null;
  const [row] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.firebaseUid, firebaseUid));
  return (row as UserProfile | undefined) ?? null;
}

/* -------------------------------------------------------------------------
   ROLE
   ------------------------------------------------------------------------- */

export type RoleResult =
  | { ok: true; user: ClipRewardsUser }
  | {
      ok: false;
      reason: "unconfigured" | "invalid_role" | "user_not_found" | "already_decided" | "storage_error";
    };

/**
 * Records the role a user chose for themselves.
 *
 * THE UID IS THE CALLER'S, ALWAYS. There is no parameter for whose row to
 * change other than the verified UID the caller was resolved to, so "cannot
 * assign another user's role" is true by there being no way to express it.
 *
 * REFUSED ONCE A DECISION EXISTS. An approved or rejected account changing
 * from creator to brand would silently change what it was approved as. That is
 * an admin action if it is ever needed, not a self-service one.
 */
export async function setUserRole(firebaseUid: string, role: unknown): Promise<RoleResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!isSelectableRole(role)) return { ok: false, reason: "invalid_role" };

  const existing = await getUser(firebaseUid);
  if (!existing) return { ok: false, reason: "user_not_found" };
  if (isDecided(existing.approvalStatus)) return { ok: false, reason: "already_decided" };

  try {
    const [row] = await db
      .update(users)
      .set({ role, updatedAt: sql`now()` })
      .where(
        and(
          eq(users.firebaseUid, firebaseUid),
          // The absorbing guard, in SQL as well as in the read above.
          sql`${users.approvalStatus} not in ('approved','rejected','needs_followup')`,
        ),
      )
      .returning();
    if (!row) return { ok: false, reason: "already_decided" };
    return { ok: true, user: row as ClipRewardsUser };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   PROFILE
   ------------------------------------------------------------------------- */

export type ProfileInput = {
  fullName?: string | null;
  bio?: string | null;
  photoUrl?: string | null;
  languages?: string[] | null;
  creatorType?: string | null;
  referralSource?: string | null;
  socials?: string[] | null;
  companyName?: string | null;
  lastStep?: number;
  /** True when the user has finished the profile step. */
  complete?: boolean;
};

/**
 * Saves onboarding answers and, when the step is finished, stamps
 * `onboarding_completed_at`.
 *
 * COMPLETING A PROFILE IS NOT AN APPROVAL, and this function cannot make it
 * one: it writes `onboarding_completed_at` and then calls `refreshProgress`,
 * which is structurally incapable of producing a decision state.
 */
export async function saveProfile(
  firebaseUid: string,
  input: ProfileInput,
): Promise<{ ok: true; user: ClipRewardsUser } | { ok: false; reason: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const existing = await getUser(firebaseUid);
  if (!existing) return { ok: false, reason: "user_not_found" };
  if (isDecided(existing.approvalStatus)) return { ok: false, reason: "already_decided" };

  const clamp = (v: string | null | undefined, max: number) =>
    typeof v === "string" ? v.slice(0, max) : (v ?? null);

  const values = {
    firebaseUid,
    fullName: clamp(input.fullName, 120),
    bio: clamp(input.bio, 280),
    photoUrl: clamp(input.photoUrl, 500),
    languages: Array.isArray(input.languages) ? input.languages.slice(0, 20) : null,
    creatorType: clamp(input.creatorType, 64),
    referralSource: clamp(input.referralSource, 64),
    socials: Array.isArray(input.socials) ? input.socials.slice(0, 20) : null,
    companyName: clamp(input.companyName, 120),
    lastStep: Number.isInteger(input.lastStep) ? Math.max(0, Math.min(20, input.lastStep!)) : 0,
    updatedAt: sql`now()`,
  };

  try {
    await db
      .insert(userProfiles)
      .values(values)
      .onConflictDoUpdate({ target: userProfiles.firebaseUid, set: values });

    if (input.complete === true) {
      await db
        .update(users)
        .set({
          // COALESCE: the first completion is the true one, and a later edit
          // must not restamp it.
          onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.firebaseUid, firebaseUid));
    }

    const refreshed = await refreshProgress(firebaseUid);
    return refreshed
      ? { ok: true, user: refreshed }
      : { ok: false, reason: "storage_error" };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   PROGRESS
   ------------------------------------------------------------------------- */

/**
 * Recomputes an undecided account's status from facts, and writes it.
 *
 * THE ONLY VALUES THIS CAN WRITE are the three progress states — the SQL
 * below carries `approval_status not in ('approved','rejected',
 * 'needs_followup')` in its WHERE clause, so a decided row is untouched even
 * if `computeProgressStatus` were ever changed to return one.
 *
 * Safe to call after any user action. Returns the current row either way.
 */
export async function refreshProgress(firebaseUid: string): Promise<ClipRewardsUser | null> {
  const db = getDb();
  if (!db) return null;

  const user = await getUser(firebaseUid);
  if (!user) return null;
  if (isDecided(user.approvalStatus)) return user;

  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interviewBookings)
    .where(
      and(
        eq(interviewBookings.firebaseUid, firebaseUid),
        eq(interviewBookings.status, "scheduled"),
      ),
    );

  const next = computeProgressStatus(user.approvalStatus, {
    role: user.role,
    onboardingCompletedAt: user.onboardingCompletedAt,
    hasActiveBooking: (active?.n ?? 0) > 0,
  });
  if (next === null || next === user.approvalStatus) return user;

  const [row] = await db
    .update(users)
    .set({ approvalStatus: next, updatedAt: sql`now()` })
    .where(
      and(
        eq(users.firebaseUid, firebaseUid),
        sql`${users.approvalStatus} not in ('approved','rejected','needs_followup')`,
      ),
    )
    .returning();

  return (row as ClipRewardsUser | undefined) ?? user;
}

/* -------------------------------------------------------------------------
   ADMIN DECISIONS
   ------------------------------------------------------------------------- */

export type DecisionResult =
  | { ok: true; user: ClipRewardsUser }
  | {
      ok: false;
      reason: "unconfigured" | "invalid_decision" | "user_not_found" | "storage_error";
    };

/**
 * THE ONLY WRITER OF `approved`, `rejected` AND `needs_followup`.
 *
 * `adminUid` is the verified administrator's own UID, taken from
 * `requireAdmin` by the caller — never from a request body. It is recorded on
 * the row so every verdict is attributed, and the database refuses a decision
 * state with no attribution (`users_decision_is_attributed` in 0007).
 *
 * The timestamp columns are kept coherent with the status because the database
 * insists: `approved_at` exists exactly when the status is `approved`, and the
 * same for `rejected_at`. Moving a user from rejected to approved therefore
 * clears one and sets the other in the same statement.
 *
 * `approved_at` uses COALESCE so re-approving an already-approved account is
 * idempotent and keeps the original moment.
 */
export async function decideUser(
  firebaseUid: string,
  decision: unknown,
  adminUid: string,
): Promise<DecisionResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!isAdminDecision(decision)) return { ok: false, reason: "invalid_decision" };
  if (!isFirebaseUid(firebaseUid) || !isFirebaseUid(adminUid)) {
    return { ok: false, reason: "user_not_found" };
  }

  const verdict = decision as AdminDecision;

  try {
    const [row] = await db
      .update(users)
      .set({
        approvalStatus: verdict,
        approvedAt:
          verdict === "approved" ? sql`coalesce(${users.approvedAt}, now())` : sql`null`,
        rejectedAt: verdict === "rejected" ? sql`now()` : sql`null`,
        decidedByUid: adminUid,
        decidedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.firebaseUid, firebaseUid))
      .returning();

    if (!row) return { ok: false, reason: "user_not_found" };
    return { ok: true, user: row as ClipRewardsUser };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   READING FOR ADMIN REVIEW
   ------------------------------------------------------------------------- */

export type ApplicantRow = {
  firebaseUid: string;
  role: UserRole | null;
  approvalStatus: ApprovalStatus;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
  fullName: string | null;
  companyName: string | null;
  scheduledAt: Date | null;
  meetingUrl: string | null;
  bookingStatus: string | null;
};

/**
 * The review queue: every user with their profile name and live booking.
 *
 * Bounded, and ordered oldest-first so the longest-waiting applicant is at the
 * top rather than the newest.
 */
export async function listApplicants(limit = 200): Promise<ApplicantRow[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      firebaseUid: users.firebaseUid,
      role: users.role,
      approvalStatus: users.approvalStatus,
      onboardingCompletedAt: users.onboardingCompletedAt,
      createdAt: users.createdAt,
      fullName: userProfiles.fullName,
      companyName: userProfiles.companyName,
      scheduledAt: interviewBookings.scheduledAt,
      meetingUrl: interviewBookings.meetingUrl,
      bookingStatus: interviewBookings.status,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.firebaseUid, users.firebaseUid))
    .leftJoin(
      interviewBookings,
      and(
        eq(interviewBookings.firebaseUid, users.firebaseUid),
        eq(interviewBookings.status, "scheduled"),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(limit);

  return rows as ApplicantRow[];
}

/** Counts for the admin dashboard. `unassigned` is a real, reportable state. */
export async function getUserCounts(): Promise<{
  total: number;
  creators: number;
  brands: number;
  unassigned: number;
  byStatus: Record<string, number>;
}> {
  const db = getDb();
  if (!db) return { total: 0, creators: 0, brands: 0, unassigned: 0, byStatus: {} };

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      creators: sql<number>`count(*) filter (where ${users.role} = 'creator')::int`,
      brands: sql<number>`count(*) filter (where ${users.role} = 'brand')::int`,
      unassigned: sql<number>`count(*) filter (where ${users.role} is null)::int`,
    })
    .from(users);

  const statuses = await db
    .select({ status: users.approvalStatus, n: sql<number>`count(*)::int` })
    .from(users)
    .groupBy(users.approvalStatus);

  return {
    total: totals?.total ?? 0,
    creators: totals?.creators ?? 0,
    brands: totals?.brands ?? 0,
    unassigned: totals?.unassigned ?? 0,
    byStatus: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
  };
}

/** Users who have never chosen a role. Used by the admin dashboard. */
export async function listUnassigned(limit = 100): Promise<ClipRewardsUser[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(users)
    .where(isNull(users.role))
    .orderBy(asc(users.createdAt))
    .limit(limit);
  return rows as ClipRewardsUser[];
}
