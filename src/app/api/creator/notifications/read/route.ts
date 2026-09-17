import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { markRead, markAllRead } from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** POST /api/creator/notifications/read — body: { id?: string, all?: boolean } */
export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  let body: { id?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.all === true) {
    const result = await markAllRead(firebaseUid);
    return json({ ok: result.ok }, result.ok ? 200 : 503);
  }

  if (typeof body.id === "string" && body.id.length > 0) {
    const result = await markRead(body.id, firebaseUid);
    return json({ ok: result.ok }, result.ok ? 200 : 503);
  }

  return json({ error: "provide id or all:true" }, 400);
}
