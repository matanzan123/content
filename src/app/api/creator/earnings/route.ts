import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getCreatorBalance } from "@/lib/server/creator-earnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** GET /api/creator/earnings — authenticated creator's balance across all states */
export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const result = await getCreatorBalance(firebaseUid);
  if (!result.ok) return json({ error: "db_unavailable" }, 503);

  const { balance } = result;
  return json({
    ok: true,
    currency: balance.currency,
    earned_minor: balance.earnedMinor.toString(),
    pending_minor: balance.pendingMinor.toString(),
    available_minor: balance.availableMinor.toString(),
    transferred_minor: balance.transferredMinor.toString(),
    reversed_minor: balance.reversedMinor.toString(),
  }, 200);
}
