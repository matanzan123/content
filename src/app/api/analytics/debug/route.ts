import { readRecentEvents } from "@/lib/analytics/sink";
import { withAdminApi } from "@/lib/server/admin-guard";

/**
 * Development-only inspection of generated events.
 *
 * Two locks, not one: the route 404s outside development, and even in
 * development it runs the admin guard. A debug surface that is merely
 * "probably not deployed" is the kind of thing that ends up deployed.
 */
export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return new Response(null, { status: 404 });
  }
  return withAdminApi(async () => ({ events: readRecentEvents() }));
}
