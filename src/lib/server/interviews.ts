import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { interviewBookings } from "@/lib/db/schema";
import { isBookableSlot, resolveAvailabilityConfig } from "./interview-availability";
import { isFirebaseUid, refreshProgress, getUser } from "./users";
import { isDecided } from "./user-lifecycle";

/* ==========================================================================
   INTERVIEW BOOKINGS — server only.

   OWNERSHIP IS NEVER A PARAMETER. Every function takes the UID its caller
   resolved from a verified session. There is no "book on behalf of" path,
   because there is no argument that could express one — which is a stronger
   guarantee than checking that a supplied uid matches the session.

   THE SLOT IS RE-VALIDATED SERVER-SIDE, always. A client can post any instant
   it likes, including one that was never offered, so the offered list is a
   convenience and `isBookableSlot` is the boundary. Both use the same
   predicate, so the list and the check cannot drift.

   BOOKING IS NOT APPROVAL. Creating a booking moves an account to
   `pending_review` and no further; the status write goes through
   `refreshProgress`, which is structurally incapable of producing a decision.
   ========================================================================== */

export type Booking = {
  bookingId: string;
  firebaseUid: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: "scheduled" | "cancelled" | "completed" | "no_show";
  meetingUrl: string | null;
  adminNotes: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BookingResult =
  | { ok: true; booking: Booking }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "availability_unconfigured"
        | "user_not_found"
        | "already_decided"
        | "onboarding_incomplete"
        | "invalid_instant"
        | "slot_unavailable"
        | "already_booked"
        | "slot_taken"
        | "storage_error";
      detail?: string;
    };

/**
 * Books an interview for the CALLER.
 *
 * The checks, in order, each refusing rather than guessing:
 *
 *   1. availability must be configured — with no operating hours there are no
 *      slots, and inventing some would commit staff to times nobody agreed to;
 *   2. the user must exist and must not already carry a decision;
 *   3. onboarding must be finished — an interview is for a completed
 *      application, not a blank one;
 *   4. the instant must be a real bookable slot, re-checked here;
 *   5. the database must accept it, which is where the two race conditions are
 *      actually settled.
 *
 * THE UNIQUE INDEXES DO THE CONCURRENCY WORK. `uniq_bookings_active_user`
 * refuses a second live booking for one person and `uniq_bookings_active_slot`
 * refuses two people in one slot. Both are partial on `status = 'scheduled'`,
 * so cancelled history neither collides nor blocks a rebooking. A read-then-
 * insert would lose both races.
 */
export async function bookInterview(
  firebaseUid: string,
  scheduledAtIso: unknown,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<BookingResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!isFirebaseUid(firebaseUid)) return { ok: false, reason: "user_not_found" };

  const availability = resolveAvailabilityConfig(env);
  if (!availability.ok) {
    return {
      ok: false,
      reason: "availability_unconfigured",
      detail: availability.missing.join(","),
    };
  }

  const user = await getUser(firebaseUid);
  if (!user) return { ok: false, reason: "user_not_found" };
  if (isDecided(user.approvalStatus)) return { ok: false, reason: "already_decided" };
  if (user.role === null || user.onboardingCompletedAt === null) {
    return { ok: false, reason: "onboarding_incomplete" };
  }

  if (typeof scheduledAtIso !== "string") return { ok: false, reason: "invalid_instant" };
  const instant = new Date(scheduledAtIso);
  if (Number.isNaN(instant.getTime())) return { ok: false, reason: "invalid_instant" };

  const slot = isBookableSlot(instant, now, env);
  if (!slot.ok) {
    return slot.reason === "availability_unconfigured"
      ? { ok: false, reason: "availability_unconfigured" }
      : { ok: false, reason: "slot_unavailable", detail: slot.reason };
  }

  try {
    const [row] = await db
      .insert(interviewBookings)
      .values({
        firebaseUid,
        scheduledAt: instant,
        // Captured on the row so a later configuration change cannot
        // retroactively resize a booking that was already agreed.
        durationMinutes: availability.config.slotMinutes,
        status: "scheduled",
      })
      .returning();

    await refreshProgress(firebaseUid);
    return { ok: true, booking: row as Booking };
  } catch (error) {
    // Tell the two collisions apart: "you already have one" and "someone else
    // took that slot" need different words in the UI.
    //
    // THE CONSTRAINT NAME IS IN THE CAUSE, not the message. Drizzle wraps the
    // driver error and its own `message` is the rendered SQL plus parameters;
    // the Postgres error — which carries `constraint_name` — is one level down
    // in `cause`. Reading only `message` silently turned both collisions into
    // `storage_error`.
    const cause = (error as { cause?: unknown })?.cause;
    const constraint =
      (cause as { constraint_name?: string })?.constraint_name ??
      (error as { constraint_name?: string })?.constraint_name ??
      "";
    const text = `${constraint} ${error instanceof Error ? error.message : ""} ${
      cause instanceof Error ? cause.message : ""
    }`;

    if (text.includes("uniq_bookings_active_user")) {
      return { ok: false, reason: "already_booked" };
    }
    if (text.includes("uniq_bookings_active_slot")) {
      return { ok: false, reason: "slot_taken" };
    }
    return { ok: false, reason: "storage_error" };
  }
}

/** The caller's live booking, if any. */
export async function getActiveBooking(firebaseUid: string): Promise<Booking | null> {
  const db = getDb();
  if (!db || !isFirebaseUid(firebaseUid)) return null;
  const [row] = await db
    .select()
    .from(interviewBookings)
    .where(
      and(
        eq(interviewBookings.firebaseUid, firebaseUid),
        eq(interviewBookings.status, "scheduled"),
      ),
    );
  return (row as Booking | undefined) ?? null;
}

export async function listBookingsForUser(firebaseUid: string): Promise<Booking[]> {
  const db = getDb();
  if (!db || !isFirebaseUid(firebaseUid)) return [];
  const rows = await db
    .select()
    .from(interviewBookings)
    .where(eq(interviewBookings.firebaseUid, firebaseUid))
    .orderBy(desc(interviewBookings.scheduledAt));
  return rows as Booking[];
}

/**
 * Cancels the CALLER's own live booking.
 *
 * Scoped by uid in the WHERE clause as well as by the caller's identity, so
 * even a mis-wired call site cannot cancel a stranger's interview.
 */
export async function cancelOwnBooking(
  firebaseUid: string,
  bookingId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const updated = await db
    .update(interviewBookings)
    .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(interviewBookings.bookingId, bookingId),
        eq(interviewBookings.firebaseUid, firebaseUid),
        eq(interviewBookings.status, "scheduled"),
      ),
    )
    .returning({ id: interviewBookings.bookingId });

  if (updated.length === 0) return { ok: false, reason: "not_found" };
  await refreshProgress(firebaseUid);
  return { ok: true };
}

/**
 * Attaches a meeting URL to a booking. ADMIN ONLY — the caller must already
 * have passed `requireAdmin`.
 *
 * There is no user-facing writer for this column anywhere, which is what keeps
 * "staff paste the link" true. The https shape is enforced by the database
 * (`interview_bookings_meeting_url_https`) rather than only here.
 */
export async function setMeetingUrl(
  bookingId: string,
  meetingUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!/^https:\/\/\S{3,500}$/.test(meetingUrl)) return { ok: false, reason: "invalid_url" };

  try {
    const updated = await db
      .update(interviewBookings)
      .set({ meetingUrl, updatedAt: sql`now()` })
      .where(eq(interviewBookings.bookingId, bookingId))
      .returning({ id: interviewBookings.bookingId });
    return updated.length === 1 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}
