import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { interviewBookings, userProfiles } from "@/lib/db/schema";
import { getAdminAuth } from "./firebase-admin";
import { resolveAvailabilityConfig } from "./interview-availability";
import {
  currentEnvironment,
  getCalendarAccessToken,
  rememberAccountEmail,
} from "./google-calendar-connection";
import {
  createInterviewEvent,
  eventIdForBooking,
  getInterviewEvent,
  isMeetUrl,
  isPlausibleEmail,
  type CalendarFailure,
} from "./google-calendar";

/* ==========================================================================
   INTERVIEW CALENDAR PROVISIONING.

   THE BOOKING IS ALREADY REAL WHEN THIS RUNS, and nothing here can undo it.
   A slot is reserved by `bookInterview` inside the database, with its own
   uniqueness guarantees; this module then goes out to Google. Google being
   slow, rate-limited or disconnected therefore degrades the Meet link, never
   the interview — which is why provisioning has its own status column rather
   than sharing the booking's.

   NO DATABASE TRANSACTION IS HELD ACROSS THE PROVIDER CALL. A lease is taken,
   the transaction closes, the network call happens, and the result is written
   back. Holding a row lock across an HTTP request is how one slow provider
   becomes a stalled application.

   IDEMPOTENCY HAS THREE LAYERS, and does not depend on any one of them:

     1. THE LOCAL RECORD IS THE AUTHORITY. A booking that already has an event
        id is never re-created; it is reconciled by reading that event.
     2. A LEASE. The claim below only succeeds for one caller at a time, so two
        simultaneous provisioners cannot both call Google.
     3. A DETERMINISTIC EVENT ID AND CONFERENCE REQUEST ID. Even if both of the
        above were bypassed, the second insert addresses the same event and the
        same conference rather than making new ones.
   ========================================================================== */

/** How long one provisioning attempt may hold the lease. */
const LEASE_SECONDS = 120;
/** Beyond this, a booking stops retrying on its own and waits for a person. */
export const MAX_AUTOMATIC_RETRIES = 5;

export type ProvisionOutcome =
  | { ok: true; status: "ready"; meetingUrl: string; eventId: string }
  /** The event exists but Google has not finished the conference yet. */
  | { ok: true; status: "pending"; eventId: string }
  | { ok: false; status: "failed"; code: ProvisionErrorCode }
  /** Another attempt holds the lease; this one did nothing. */
  | { ok: false; status: "in_progress"; code: "in_progress" };

export type ProvisionErrorCode =
  | CalendarFailure
  | "not_connected"
  | "reconnect_required"
  | "unconfigured"
  | "booking_not_found"
  | "booking_not_scheduled"
  | "availability_unconfigured"
  | "retry_limit_reached"
  | "storage_error";

type BookingRow = typeof interviewBookings.$inferSelect;

/**
 * Claims a booking for one provisioning attempt.
 *
 * The lease is the `calendar_updated_at` column itself: a claim only succeeds
 * when nobody has touched the row recently, so a concurrent attempt finds
 * nothing and stands down. No extra column, and no lock held over the network.
 */
async function claim(bookingId: string): Promise<BookingRow | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .update(interviewBookings)
    .set({
      calendarRetryCount: sql`${interviewBookings.calendarRetryCount} + 1`,
      calendarUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(interviewBookings.bookingId, bookingId),
        eq(interviewBookings.status, "scheduled"),
        // Not already finished, and not currently being attempted.
        sql`${interviewBookings.calendarProvisioningStatus} <> 'ready'`,
        or(
          isNull(interviewBookings.calendarUpdatedAt),
          sql`${interviewBookings.calendarUpdatedAt} < now() - make_interval(secs => ${LEASE_SECONDS})`,
        ),
      ),
    )
    .returning();
  return row ?? null;
}

async function markReady(bookingId: string, eventId: string, meetingUrl: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(interviewBookings)
    .set({
      googleCalendarEventId: eventId,
      meetingUrl,
      calendarProvisioningStatus: "ready",
      lastCalendarErrorCode: null,
      calendarUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(interviewBookings.bookingId, bookingId));
}

async function markPending(bookingId: string, eventId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(interviewBookings)
    .set({
      googleCalendarEventId: eventId,
      calendarProvisioningStatus: "pending",
      calendarUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(interviewBookings.bookingId, bookingId));
}

/** Records a failure WITHOUT touching the booking itself. */
async function markFailed(bookingId: string, code: ProvisionErrorCode): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(interviewBookings)
    .set({
      calendarProvisioningStatus: "failed",
      // A short code, never a provider body: this is read by an administrator
      // and must not become a channel for someone else's error text.
      lastCalendarErrorCode: code.slice(0, 64),
      calendarUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(interviewBookings.bookingId, bookingId));
}

/** The applicant's own address, from Firebase. Never from a request. */
async function applicantEmail(firebaseUid: string): Promise<string | null> {
  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const record = await auth.getUser(firebaseUid);
    return isPlausibleEmail(record.email) ? record.email : null;
  } catch {
    return null;
  }
}

async function applicantName(firebaseUid: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select({ fullName: userProfiles.fullName })
      .from(userProfiles)
      .where(eq(userProfiles.firebaseUid, firebaseUid));
    return row?.fullName?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Provisions (or reconciles) the Google Calendar event for one booking.
 *
 * Safe to call repeatedly: an already-ready booking is left alone, an event
 * that already exists is read rather than recreated, and a concurrent attempt
 * is refused by the lease.
 */
export async function provisionBookingCalendar(
  bookingId: string,
  options: { force?: boolean } = {},
): Promise<ProvisionOutcome> {
  const db = getDb();
  if (!db) return { ok: false, status: "failed", code: "unconfigured" };

  const environment = currentEnvironment();
  if (!environment) return { ok: false, status: "failed", code: "unconfigured" };

  const [existing] = await db
    .select()
    .from(interviewBookings)
    .where(eq(interviewBookings.bookingId, bookingId));
  if (!existing) return { ok: false, status: "failed", code: "booking_not_found" };
  if (existing.status !== "scheduled") {
    return { ok: false, status: "failed", code: "booking_not_scheduled" };
  }

  // Already done. Nothing to do, and nothing to ask Google.
  if (
    existing.calendarProvisioningStatus === "ready" &&
    existing.googleCalendarEventId &&
    existing.meetingUrl
  ) {
    return {
      ok: true,
      status: "ready",
      meetingUrl: existing.meetingUrl,
      eventId: existing.googleCalendarEventId,
    };
  }

  if (!options.force && existing.calendarRetryCount >= MAX_AUTOMATIC_RETRIES) {
    return { ok: false, status: "failed", code: "retry_limit_reached" };
  }

  const claimed = await claim(bookingId);
  if (!claimed) return { ok: false, status: "in_progress", code: "in_progress" };

  const availability = resolveAvailabilityConfig();
  if (!availability.ok) {
    await markFailed(bookingId, "availability_unconfigured");
    return { ok: false, status: "failed", code: "availability_unconfigured" };
  }

  const token = await getCalendarAccessToken(environment);
  if (!token.ok) {
    const code: ProvisionErrorCode =
      token.reason === "not_connected"
        ? "not_connected"
        : token.reason === "reconnect_required"
          ? "reconnect_required"
          : token.reason === "unconfigured"
            ? "unconfigured"
            : "provider_rejected";
    await markFailed(bookingId, code);
    return { ok: false, status: "failed", code };
  }

  const eventId = claimed.googleCalendarEventId ?? eventIdForBooking(bookingId);
  if (!eventId) {
    await markFailed(bookingId, "storage_error");
    return { ok: false, status: "failed", code: "storage_error" };
  }

  // A booking that already has an event is RECONCILED, never recreated.
  if (claimed.googleCalendarEventId) {
    return await reconcile(bookingId, eventId, token.accessToken, token.connectionId);
  }

  const [email, name] = await Promise.all([
    applicantEmail(claimed.firebaseUid),
    applicantName(claimed.firebaseUid),
  ]);

  const created = await createInterviewEvent(token.accessToken, {
    bookingId,
    startsAt: claimed.scheduledAt,
    durationMinutes: claimed.durationMinutes,
    timeZone: availability.config.timezone,
    summary: name ? `ClipRewards interview — ${name}` : "ClipRewards interview",
    description:
      "A short onboarding call with the ClipRewards team before your account is approved.",
    attendeeEmail: email,
    // The Google invitation IS the applicant's notification in this version,
    // so it is only suppressed when there is nobody to send it to.
    sendUpdates: email ? "all" : "none",
  });

  if (!created.ok) {
    // The event id is deterministic, so "already exists" means a previous
    // attempt succeeded at Google and failed to record locally. That is a
    // reconciliation, not an error.
    if (created.reason === "already_exists") {
      return await reconcile(bookingId, eventId, token.accessToken, token.connectionId);
    }
    await markFailed(bookingId, created.reason);
    return { ok: false, status: "failed", code: created.reason };
  }

  if (created.event.organizerEmail) {
    await rememberAccountEmail(token.connectionId, created.event.organizerEmail);
  }

  if (isMeetUrl(created.event.meetingUrl)) {
    await markReady(bookingId, created.event.id, created.event.meetingUrl);
    return {
      ok: true,
      status: "ready",
      meetingUrl: created.event.meetingUrl,
      eventId: created.event.id,
    };
  }

  // Google documents that conference data may still be `pending` in the insert
  // response. The event is real and recorded; the link is collected later.
  await markPending(bookingId, created.event.id);
  const settled = await reconcile(bookingId, created.event.id, token.accessToken, token.connectionId);
  return settled;
}

/**
 * Reads the event back and settles the booking against it.
 *
 * This is the whole duplicate-prevention story in practice: whatever happened
 * before, the answer comes from the ONE event the booking's deterministic id
 * addresses.
 */
async function reconcile(
  bookingId: string,
  eventId: string,
  accessToken: string,
  connectionId: string,
): Promise<ProvisionOutcome> {
  const fetched = await getInterviewEvent(accessToken, eventId);
  if (!fetched.ok) {
    if (fetched.reason === "not_found") {
      // The local record points at an event that is gone. Clearing the id lets
      // the next attempt create it again under the same deterministic id.
      const db = getDb();
      if (db) {
        await db
          .update(interviewBookings)
          .set({
            googleCalendarEventId: null,
            calendarProvisioningStatus: "failed",
            lastCalendarErrorCode: "not_found",
            calendarUpdatedAt: sql`now()`,
          })
          .where(eq(interviewBookings.bookingId, bookingId));
      }
      return { ok: false, status: "failed", code: "not_found" };
    }
    await markFailed(bookingId, fetched.reason);
    return { ok: false, status: "failed", code: fetched.reason };
  }

  if (fetched.event.organizerEmail) {
    await rememberAccountEmail(connectionId, fetched.event.organizerEmail);
  }

  if (isMeetUrl(fetched.event.meetingUrl)) {
    await markReady(bookingId, fetched.event.id, fetched.event.meetingUrl);
    return {
      ok: true,
      status: "ready",
      meetingUrl: fetched.event.meetingUrl,
      eventId: fetched.event.id,
    };
  }

  await markPending(bookingId, fetched.event.id);
  return { ok: true, status: "pending", eventId: fetched.event.id };
}
