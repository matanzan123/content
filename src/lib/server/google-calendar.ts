import "server-only";

import { stableRequestId } from "./google-oauth";

/* ==========================================================================
   GOOGLE CALENDAR — event creation for interviews, server only.

   ONE EVENT PER BOOKING, AND THE ID SAYS SO. The event id is derived from the
   booking id rather than left to Google, so the same booking always addresses
   the same event: a retry either creates it or collides with the one already
   there, and a collision is reconciled by reading that event rather than
   making a second. Google documents client-specified ids as base32hex —
   lowercase `a`–`v` and digits — and a UUID's hex is a strict subset.

   THE MEET ROOM IS EQUALLY PINNED. `conferenceData.createRequest.requestId`
   is derived from the same booking id, and Google documents that reusing a
   requestId returns the same conference instead of minting another.

   CONFERENCE DATA CAN ARRIVE LATER. Google's own guide says the insert
   response "might not yet contain the fully-populated conferenceData", marked
   by a `pending` status. This client therefore treats a missing link as
   "not ready yet" rather than as a failure, and offers `getEvent` so the link
   can be collected on a later pass.

   NOTHING HERE TAKES A CALENDAR ID FROM A CALLER. Events are always written
   to the connected account's `primary` calendar.
   ========================================================================== */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
/** The connected account's own calendar. Never a parameter. */
const CALENDAR_ID = "primary";

export type CalendarEvent = {
  id: string;
  /** The Meet URL, when Google has finished creating the conference. */
  meetingUrl: string | null;
  /** `pending`, `success` or `failure`, as reported by Google. */
  conferenceStatus: string | null;
  /** The event's organizer — the connected ClipRewards account. */
  organizerEmail: string | null;
  htmlLink: string | null;
  status: string | null;
};

export type CalendarFailure =
  | "unauthorized"
  | "forbidden"
  | "already_exists"
  | "not_found"
  | "rate_limited"
  | "provider_rejected"
  | "malformed_response"
  | "network_error";

export type CalendarResult =
  | { ok: true; event: CalendarEvent }
  | { ok: false; reason: CalendarFailure };

/**
 * A Meet URL, validated before it is ever stored or shown.
 *
 * Anchored to Google's own host: a link is put in front of an applicant and
 * clicked, so "whatever the provider sent" is not a good enough test.
 */
export function isMeetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meet.google.com";
  } catch {
    return false;
  }
}

/**
 * The event id for a booking: stable, and inside Google's allowed alphabet.
 *
 * A booking id is a UUID, so its hex digits are already a subset of base32hex;
 * the `cr` prefix keeps it recognisable in the calendar's own tooling and is
 * itself within `a`–`v`.
 */
export function eventIdForBooking(bookingId: string): string | null {
  const hex = bookingId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `cr${hex}`;
}

function readEvent(body: unknown): CalendarEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) return null;

  const conference = (b.conferenceData ?? null) as Record<string, unknown> | null;
  const entryPoints = Array.isArray(conference?.entryPoints) ? conference.entryPoints : [];
  const video = entryPoints.find(
    (e) => (e as Record<string, unknown>)?.entryPointType === "video",
  ) as Record<string, unknown> | undefined;

  // `hangoutLink` and the video entry point are the two documented places the
  // URL appears. Both are validated; neither is trusted on shape alone.
  const candidates = [b.hangoutLink, video?.uri];
  const meetingUrl = candidates.find((c) => isMeetUrl(c)) as string | undefined;

  const createRequest = (conference?.createRequest ?? null) as Record<string, unknown> | null;
  const statusObject = (createRequest?.status ?? null) as Record<string, unknown> | null;

  const organizer = (b.organizer ?? null) as Record<string, unknown> | null;

  return {
    id: b.id,
    meetingUrl: meetingUrl ?? null,
    conferenceStatus: typeof statusObject?.statusCode === "string" ? statusObject.statusCode : null,
    organizerEmail: typeof organizer?.email === "string" ? organizer.email : null,
    htmlLink: typeof b.htmlLink === "string" ? b.htmlLink : null,
    status: typeof b.status === "string" ? b.status : null,
  };
}

function failureFor(status: number): CalendarFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "already_exists";
  if (status === 429) return "rate_limited";
  return "provider_rejected";
}

async function call(
  accessToken: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: CalendarFailure }> {
  let response: Response;
  try {
    response = await fetch(`${CALENDAR_BASE}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  // Google's error bodies quote the request. Only the STATUS is carried
  // forward, so nothing a provider says can reach a log line or a page.
  if (!response.ok) return { ok: false, reason: failureFor(response.status) };
  return { ok: true, body };
}

export type CreateInterviewEventInput = {
  bookingId: string;
  /** The interview instant, authoritative, from the booking row. */
  startsAt: Date;
  durationMinutes: number;
  /** IANA zone the interview is held in. */
  timeZone: string;
  summary: string;
  description: string;
  /** Added as an attendee when it is a plausible address; omitted otherwise. */
  attendeeEmail: string | null;
  /** Whether Google emails the attendee. */
  sendUpdates: "all" | "none";
};

/** A conservative address check. An invalid one is dropped, never sent. */
export function isPlausibleEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(value)
  );
}

/**
 * Creates the interview event, with a Meet conference, in the connected
 * account's primary calendar.
 *
 * The organizer is therefore always the ClipRewards interview account: the
 * credential decides whose calendar this is, and there is no parameter that
 * could point it at anyone else's.
 */
export async function createInterviewEvent(
  accessToken: string,
  input: CreateInterviewEventInput,
): Promise<CalendarResult> {
  const eventId = eventIdForBooking(input.bookingId);
  if (!eventId) return { ok: false, reason: "malformed_response" };

  const end = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);

  const body: Record<string, unknown> = {
    id: eventId,
    summary: input.summary,
    description: input.description,
    // Absolute instants, with the interview's zone alongside so the event
    // renders in the right wall-clock time for everyone who opens it.
    start: { dateTime: input.startsAt.toISOString(), timeZone: input.timeZone },
    end: { dateTime: end.toISOString(), timeZone: input.timeZone },
    conferenceData: {
      createRequest: {
        requestId: stableRequestId(input.bookingId),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    // Traceability inside Google's own tooling, and how a stray event can be
    // matched back to a booking without consulting our database.
    extendedProperties: { private: { cliprewards_booking_id: input.bookingId } },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };

  if (input.attendeeEmail && isPlausibleEmail(input.attendeeEmail)) {
    body.attendees = [{ email: input.attendeeEmail }];
  }

  const query = new URLSearchParams({
    conferenceDataVersion: "1",
    sendUpdates: input.sendUpdates,
  });

  const result = await call(accessToken, `/calendars/${CALENDAR_ID}/events?${query}`, {
    method: "POST",
    body,
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  const event = readEvent(result.body);
  return event ? { ok: true, event } : { ok: false, reason: "malformed_response" };
}

/**
 * Reads an event back.
 *
 * Two uses: collecting a Meet link that was still `pending` when the event was
 * created, and reconciling a booking whose event already exists — which is
 * what a duplicate creation attempt resolves to.
 */
export async function getInterviewEvent(
  accessToken: string,
  eventId: string,
): Promise<CalendarResult> {
  const result = await call(
    accessToken,
    `/calendars/${CALENDAR_ID}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
    { method: "GET" },
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  const event = readEvent(result.body);
  return event ? { ok: true, event } : { ok: false, reason: "malformed_response" };
}
