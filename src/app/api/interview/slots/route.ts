import { requireUser } from "@/lib/server/access";
import { listAvailableSlots } from "@/lib/server/interview-availability";

/* ==========================================================================
   AVAILABLE INTERVIEW SLOTS.

   FAILS SAFE WHEN UNCONFIGURED. ClipRewards has no configured operating hours
   yet, and this endpoint refuses with `availability_unconfigured` and the list
   of settings an operator must provide, rather than inventing a schedule.
   Offering a default 9-to-5 would commit staff to times nobody agreed to.

   THE LIST IS A CONVENIENCE, NOT A BOUNDARY. A client can post any instant to
   the booking endpoint, so that endpoint re-validates against the same
   predicate this list is generated from.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const gate = await requireUser(request);
  if (gate.denied) return gate.response;

  const listing = listAvailableSlots(new Date());
  if (!listing.ok) {
    return Response.json(
      { error: listing.reason, missing: listing.missing },
      { status: 503, headers: NO_STORE },
    );
  }

  return Response.json(
    {
      slots: listing.slots,
      timezone: listing.timezone,
      slotMinutes: listing.slotMinutes,
    },
    { headers: NO_STORE },
  );
}
