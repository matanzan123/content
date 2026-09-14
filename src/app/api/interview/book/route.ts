import { requireUser } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { bookInterview, cancelOwnBooking, getActiveBooking } from "@/lib/server/interviews";
import { provisionBookingCalendar } from "@/lib/server/interview-calendar";

/* ==========================================================================
   INTERVIEW BOOKING.

   OWNERSHIP IS THE SESSION, NEVER THE BODY. The only accepted field is
   `scheduled_at`; there is no uid parameter, so a caller cannot book for
   anyone but themselves.

   BOOKING GRANTS NOTHING. It moves the account to `pending_review` and stops
   there. Approval is an administrator's decision, made later.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 4096;

/** How a refusal maps to a status code. A conflict is not a client error. */
const STATUS: Record<string, number> = {
  availability_unconfigured: 503,
  unconfigured: 503,
  user_not_found: 404,
  already_decided: 409,
  already_booked: 409,
  slot_taken: 409,
  onboarding_incomplete: 409,
  invalid_instant: 400,
  slot_unavailable: 400,
  storage_error: 500,
};

export async function GET(request: Request) {
  const gate = await requireUser(request);
  if (gate.denied) return gate.response;
  return Response.json(
    { booking: await getActiveBooking(gate.context.uid as string) },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const gate = await requireUser(request);
  if (gate.denied) return gate.response;

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  }

  let scheduledAt: unknown = null;
  try {
    const body = (await request.json()) as { scheduled_at?: unknown } | null;
    scheduledAt = body?.scheduled_at ?? null;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await bookInterview(gate.context.uid as string, scheduledAt);
  if (!result.ok) {
    return Response.json(
      { error: result.reason, detail: result.detail },
      { status: STATUS[result.reason] ?? 400, headers: NO_STORE },
    );
  }

  /*
   * THE BOOKING IS ALREADY CONFIRMED. Provisioning the Google Calendar event
   * happens after it, outside any transaction, and CANNOT undo it: a Google
   * outage leaves a real interview whose Meet link arrives later, which is
   * the honest outcome. The provisioning path records its own status and is
   * safe to call again, so nothing is lost by this attempt failing.
   */
  const calendar = await provisionBookingCalendar(result.booking.bookingId);

  return Response.json(
    {
      ok: true,
      booking: {
        id: result.booking.bookingId,
        scheduled_at: result.booking.scheduledAt,
        duration_minutes: result.booking.durationMinutes,
        // What the applicant's page should expect to show. Never an error
        // detail — a failure here is not the applicant's problem to solve.
        calendar_status: calendar.ok ? calendar.status : "pending",
        meeting_url: calendar.ok && calendar.status === "ready" ? calendar.meetingUrl : null,
      },
    },
    { headers: NO_STORE },
  );
}

export async function DELETE(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const gate = await requireUser(request);
  if (gate.denied) return gate.response;

  let bookingId: unknown = null;
  try {
    const body = (await request.json()) as { booking_id?: unknown } | null;
    bookingId = body?.booking_id ?? null;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof bookingId !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await cancelOwnBooking(gate.context.uid as string, bookingId);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
