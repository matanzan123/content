import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getNotifications, getUnreadCount } from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** GET /api/creator/notifications?limit=20&before=<iso> */
export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get("limit");
  const beforeParam = searchParams.get("before");

  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;
  const before = beforeParam ? new Date(beforeParam) : undefined;

  const [items, unreadCount] = await Promise.all([
    getNotifications(firebaseUid, { limit, before: before && !isNaN(before.getTime()) ? before : undefined }),
    getUnreadCount(firebaseUid),
  ]);

  return json({
    ok: true,
    unread_count: unreadCount,
    notifications: items.map((n) => ({
      notification_id: n.notificationId,
      type: n.type,
      status: n.status,
      title: n.title,
      body: n.body,
      action_url: n.actionUrl,
      created_at: n.createdAt.toISOString(),
      read_at: n.readAt?.toISOString() ?? null,
    })),
  }, 200);
}
