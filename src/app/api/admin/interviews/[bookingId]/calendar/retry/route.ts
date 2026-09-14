import { requireAdmin } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { provisionBookingCalendar } from "@/lib/server/interview-calendar";

/* ==========================================================================
   RETRY CALENDAR PROVISIONING for one booking — administrators only.

   NEVER CREATES A SECOND EVENT. It calls the same provisioning path the
   booking flow uses, which treats the stored event id as the authority and
   reconciles an existing event rather than making another. `force` only lifts
   the automatic retry ceiling; it does not bypass the lease, the
   deterministic event id or the stable conference request id.

   THE BOOKING ITSELF IS NEVER MODIFIED HERE. Only provisioning fields move,
   so a retry cannot cancel, reschedule or approve anything.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const { bookingId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const outcome = await provisionBookingCalendar(bookingId, { force: true });

  await writeAudit({
    adminUid: admin.uid,
    adminEmail: admin.email,
    action: "interview_calendar_retried",
    targetType: "booking",
    targetId: bookingId,
    metadata: { status: outcome.status },
  });

  if (outcome.ok) {
    return Response.json(
      {
        ok: true,
        status: outcome.status,
        meeting_url: outcome.status === "ready" ? outcome.meetingUrl : null,
      },
      { headers: NO_STORE },
    );
  }

  // A concurrent attempt holds the lease: not an error, just "not now".
  const status = outcome.status === "in_progress" ? 409 : 502;
  return Response.json(
    { ok: false, status: outcome.status, code: outcome.code },
    { status, headers: NO_STORE },
  );
}
