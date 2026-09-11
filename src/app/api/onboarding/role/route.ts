import { requireUser } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { setUserRole } from "@/lib/server/users";

/* ==========================================================================
   ROLE SELECTION — creator or brand, chosen by the caller for themselves.

   WHOSE ROW CHANGES IS NOT A PARAMETER. The uid comes from the verified
   session (or Bearer token) resolved by `requireUser`, and `setUserRole` takes
   it directly. There is no `firebase_uid` field in the accepted body, so
   "cannot assign another user's role" is true because there is no way to
   express it rather than because a check rejects it.

   CHOOSING A ROLE GRANTS NOTHING. It moves an account from `onboarding` to
   `pending_interview` at most, and only once a profile is complete. Approval
   remains an administrator's decision.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 4096;

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

  let role: unknown = null;
  try {
    const body = (await request.json()) as { role?: unknown } | null;
    role = body?.role ?? null;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await setUserRole(gate.context.uid as string, role);
  if (!result.ok) {
    const status =
      result.reason === "invalid_role" ? 400 : result.reason === "already_decided" ? 409 : 500;
    return Response.json({ error: result.reason }, { status, headers: NO_STORE });
  }

  return Response.json(
    { ok: true, role: result.user.role, status: result.user.approvalStatus },
    { headers: NO_STORE },
  );
}
