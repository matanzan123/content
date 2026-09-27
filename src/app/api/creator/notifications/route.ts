import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import {
  clampNotificationLimit,
  getNotifications,
  getUnreadCount,
  type NotificationCursor,
} from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/* ==========================================================================
   GET /api/creator/notifications?limit=20&before=<iso>&before_id=<uuid>

   THE RECIPIENT IS THE SESSION, NEVER AN INPUT. `firebaseUid` comes from the
   verified access gate; there is no parameter that selects a creator, so this
   endpoint cannot be pointed at somebody else's notifications.

   PAGINATION IS COMPOUND. `created_at` is not unique — several triggers can
   fire inside one webhook handler — so a cursor of a timestamp alone drops every
   row sharing the boundary instant. `before` and `before_id` travel together and
   are only honoured as a pair.

   UNAVAILABLE IS NOT EMPTY. A failed read answers 503, not `ok: true` with an
   empty list. An outage must not look to a creator like an empty inbox.
   ========================================================================== */
export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const { searchParams } = new URL(request.url);

  /* THE LIMIT IS CLAMPED BY THE SERVICE, which owns the maximum. `parseInt`
   * returns NaN for junk and a negative number for "-5"; both are handled there
   * rather than by a truthiness test that let "-5" through. */
  const limitRaw = searchParams.get("limit");
  const limit = clampNotificationLimit(limitRaw === null ? undefined : Number.parseInt(limitRaw, 10));

  /* THE CURSOR IS ALL-OR-NOTHING. A timestamp without its id would reintroduce
   * the boundary the compound order exists to fix, so a half-supplied cursor is
   * ignored rather than partly honoured. */
  const beforeRaw = searchParams.get("before");
  const beforeIdRaw = searchParams.get("before_id");
  let before: NotificationCursor | undefined;
  if (beforeRaw && beforeIdRaw) {
    const at = new Date(beforeRaw);
    if (!Number.isNaN(at.getTime())) before = { createdAt: at, notificationId: beforeIdRaw };
  }

  const [page, unreadCount] = await Promise.all([
    getNotifications(firebaseUid, { limit, before }),
    getUnreadCount(firebaseUid),
  ]);

  if (!page.ok) return json({ error: page.reason }, 503);

  return json(
    {
      ok: true,
      /* NULL WHEN UNKNOWN, never a reassuring zero. The client shows nothing
       * rather than an empty badge it cannot vouch for. */
      unread_count: unreadCount,
      /* The cursor to pass back as `before` + `before_id`, or null at the end. */
      next_cursor: page.nextCursor
        ? {
            before: page.nextCursor.createdAt.toISOString(),
            before_id: page.nextCursor.notificationId,
          }
        : null,
      notifications: page.items.map((n) => ({
        notification_id: n.notificationId,
        type: n.type,
        status: n.status,
        title: n.title,
        body: n.body,
        action_url: n.actionUrl,
        created_at: n.createdAt.toISOString(),
        read_at: n.readAt?.toISOString() ?? null,
      })),
    },
    200,
  );
}
