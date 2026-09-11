import { requireAdmin, withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { setMeetingUrl } from "@/lib/server/interviews";
import { decideUser, listApplicants, getUserCounts } from "@/lib/server/users";
import { isAdminDecision } from "@/lib/server/user-lifecycle";

/* ==========================================================================
   ADMIN APPLICANT REVIEW.

   THE ONLY ROUTE THAT CAN APPROVE ANYONE. It runs its own authorization
   through `withAdminApi` / `requireAdmin` rather than relying on the admin
   layout — route handlers are reachable directly and no layout covers them.
   The administrator's identity comes from the httpOnly admin session cookie
   and the Firebase `admin` custom claim; nothing in a request body influences
   who the actor is.

   AN APPLICANT'S UID IS A TARGET, NOT AN IDENTITY. `firebase_uid` in the body
   names WHO IS BEING REVIEWED — it never says who is doing the reviewing, and
   it cannot: the actor is read from the verified session. That distinction is
   what keeps "cannot spoof admin identity" true while still allowing an admin
   to act on someone else's account, which is the entire purpose of the
   endpoint.

   EVERY DECISION IS AUDITED, twice over: `users.decided_by_uid` /
   `decided_at` on the row itself (which the database insists on — a decision
   state with no attribution violates `users_decision_is_attributed`), and an
   `admin_audit_log` entry naming the prior status.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 8192;

/** The review queue and the role counts, for the admin dashboard. */
export async function GET() {
  return withAdminApi(async () => ({
    applicants: await listApplicants(),
    counts: await getUserCounts(),
  }));
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  // Authorization first, before the body is even read.
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  }

  let body: { firebase_uid?: unknown; decision?: unknown; meeting_url?: unknown; booking_id?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const targetUid = body?.firebase_uid;
  if (typeof targetUid !== "string" || targetUid.length === 0) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  /* --- optionally attach the Meet link staff pasted --- */
  if (typeof body?.meeting_url === "string" && typeof body?.booking_id === "string") {
    const linked = await setMeetingUrl(body.booking_id, body.meeting_url);
    if (!linked.ok) {
      return Response.json({ error: linked.reason }, { status: 400, headers: NO_STORE });
    }
    await writeAudit({
      adminUid: admin.uid,
      adminEmail: admin.email,
      action: "interview_meeting_url_set",
      targetType: "user",
      targetId: targetUid,
      metadata: { booking_id: body.booking_id },
    });
    // A link with no decision is a legitimate, complete action on its own.
    if (body?.decision === undefined) {
      return Response.json({ ok: true, linked: true }, { headers: NO_STORE });
    }
  }

  const decision = body?.decision;
  if (!isAdminDecision(decision)) {
    return Response.json({ error: "invalid_decision" }, { status: 400, headers: NO_STORE });
  }

  const result = await decideUser(targetUid, decision, admin.uid);
  if (!result.ok) {
    const status = result.reason === "user_not_found" ? 404 : 400;
    return Response.json({ error: result.reason }, { status, headers: NO_STORE });
  }

  const audited = await writeAudit({
    adminUid: admin.uid,
    adminEmail: admin.email,
    action:
      decision === "approved"
        ? "applicant_approved"
        : decision === "rejected"
          ? "applicant_rejected"
          : "applicant_needs_followup",
    targetType: "user",
    targetId: targetUid,
    metadata: { decision, role: result.user.role },
  });

  return Response.json(
    {
      ok: true,
      status: result.user.approvalStatus,
      // Reported honestly: the decision stands either way, and an operator
      // should know if the trail did not record it.
      audited: audited.ok,
    },
    { headers: NO_STORE },
  );
}
