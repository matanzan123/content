import { headers } from "next/headers";
import { getAdminCheck } from "@/lib/server/admin-guard";
import { enrichEvent } from "@/lib/analytics/server";
import { getEventSink } from "@/lib/analytics/sink";
import { storeEvents } from "@/lib/analytics/store";
import type { ClientEvent, UserType } from "@/lib/analytics/schema";
import { MAX_BATCH, MAX_BODY_BYTES, parseEvent } from "@/lib/analytics/validate";

/* ==========================================================================
   EVENT COLLECTION

   Public by necessity — anonymous visitors generate most events — so the body
   is treated as hostile. Anything not on the allow-list is dropped rather than
   stored, which is what keeps the metadata column from becoming a place to
   smuggle personal data or oversized payloads.

   The response is always 204: an analytics endpoint must not become an oracle
   that tells a prober which event names or fields exist.
   ========================================================================== */

export async function POST(request: Request) {
  const noContent = new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return noContent;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noContent;
  }

  const list = Array.isArray(body) ? body.slice(0, MAX_BATCH) : [body];
  const events = list.map(parseEvent).filter((e): e is ClientEvent => e !== null);
  if (!events.length) return noContent;

  // Identity is resolved server-side. An admin session is the only verified
  // identity this build has; everyone else is anonymous for analytics purposes.
  const check = await getAdminCheck();
  const userId = check.ok ? check.admin.uid : null;
  const userType: UserType = check.ok ? "admin" : "anonymous";

  const requestHeaders = await headers();
  const search = (() => {
    try {
      return new URL(request.url).search;
    } catch {
      return "";
    }
  })();

  // `is_new_visitor` is a browser claim, so it is only ever used to seed a
  // session row on first insert — never to overwrite one that already exists.
  const isNewVisitor = (body as { is_new_visitor?: unknown })?.is_new_visitor === true;

  const enriched = events.map((event) =>
    enrichEvent(event, { headers: requestHeaders, userId, userType, isNewVisitor, search }),
  );

  // Durable first. The dev sink stays on top of it as a local inspection aid.
  await storeEvents(enriched);

  const sink = getEventSink();
  for (const event of enriched) await sink.write(event);

  return noContent;
}
