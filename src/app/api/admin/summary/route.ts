import { withAdminApi } from "@/lib/server/admin-guard";
import { isDatabaseConfigured } from "@/lib/db";
import {
  getActiveUsers,
  getEventStats,
  getFunnels,
  getTopCountries,
  getTopPages,
  getTopReferrers,
  getTrafficMetrics,
} from "@/lib/analytics/queries";
import { PRESENCE_MODEL } from "@/lib/analytics/sessions";
import { getLedgerAvailability } from "@/lib/analytics/ledger-source";

/**
 * Real metrics only.
 *
 * A null from a query means "cannot answer" — no database, or the query
 * failed — and is passed through as null so the dashboard says so. A zero
 * means the database answered and the count really is zero.
 *
 * Financial figures are absent rather than zero. "$0 revenue" would read as a
 * business fact; `source_available: false` says the truth, which is that no
 * payment source is connected.
 */
export async function GET() {
  return withAdminApi(async (admin) => {
    const configured = isDatabaseConfigured();

    const [traffic, activeUsers, funnels, countries, pages, referrers, events] = configured
      ? await Promise.all([
          getTrafficMetrics(),
          getActiveUsers(),
          getFunnels(),
          getTopCountries(),
          getTopPages(),
          getTopReferrers(),
          getEventStats(),
        ])
      : [null, null, null, null, null, null, null];

    return {
      admin: { uid: admin.uid, email: admin.email },
      status: {
        database: configured ? "connected" : "not_configured",
        analytics_durable: configured,
        events_stored: events?.total ?? null,
        last_event_received: events?.last_received ?? null,
      },
      traffic,
      active_users: activeUsers,
      /** Definitions travel with the numbers so a reader cannot misread them. */
      definitions: {
        active_users: "Distinct signed-in Firebase accounts in the window. Anonymous traffic excluded.",
        unique_visitors: "Distinct first-party visitor ids — browsers, not people.",
        recently_active: PRESENCE_MODEL.RECENTLY_ACTIVE.definition,
      },
      funnels,
      geography: countries,
      top_pages: pages,
      referrers,
      financial: getLedgerAvailability(),
      presence: {
        recently_active_available: PRESENCE_MODEL.RECENTLY_ACTIVE.available,
        realtime_available: PRESENCE_MODEL.TRUE_REALTIME.available,
        realtime_blocked_by: PRESENCE_MODEL.TRUE_REALTIME.blocked_by,
      },
    };
  });
}
