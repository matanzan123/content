import "server-only";

import { sql } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@/lib/db";
import { analyticsEvents, analyticsSessions, userAnalytics } from "@/lib/db/schema";
import type { AnalyticsEvent } from "./schema";

/* ==========================================================================
   EVENT PERSISTENCE

   One durable write path. It does two things per batch: append the events, and
   fold them into the session row that summarises them.

   The session row is an upsert rather than a read-then-write, so two events
   arriving at once cannot race into two conflicting sessions. First-touch
   attribution (referrer, UTM) is written only on insert — `COALESCE` on
   update keeps the first value rather than letting a later event overwrite
   where the visitor originally came from.
   ========================================================================== */

export type StoreResult = { stored: number; configured: boolean };

export async function storeEvents(events: AnalyticsEvent[]): Promise<StoreResult> {
  if (!events.length) return { stored: 0, configured: isDatabaseConfigured() };

  const db = getDb();
  // Fail safe: report honestly rather than pretending the write happened.
  if (!db) return { stored: 0, configured: false };

  const first = events[0];

  try {
    await db.insert(analyticsEvents).values(
      events.map((e) => ({
        eventName: e.name,
        occurredAt: new Date(e.occurred_at),
        receivedAt: new Date(e.received_at),
        sessionId: e.session_id,
        visitorId: e.visitor_id,
        firebaseUid: e.user_id,
        userType: e.user_type,
        locale: e.locale,
        path: e.path,
        referrerHost: e.referrer_host,
        utmSource: e.utm_source,
        utmMedium: e.utm_medium,
        utmCampaign: e.utm_campaign,
        utmContent: e.utm_content,
        utmTerm: e.utm_term,
        countryCode: e.country,
        deviceCategory: e.device_category,
        browserFamily: e.browser_family,
        campaignId: e.metadata?.campaign_id ?? null,
        metadata: (e.metadata ?? null) as Record<string, string | number> | null,
      })),
    );

    const pageViews = events.filter((e) => e.name === "page_view").length;
    const last = events[events.length - 1];

    await db
      .insert(analyticsSessions)
      .values({
        sessionId: first.session_id,
        visitorId: first.visitor_id,
        firebaseUid: first.user_id,
        startedAt: new Date(first.received_at),
        lastActivityAt: new Date(last.received_at),
        entryPath: first.path,
        lastPath: last.path,
        pageViewCount: pageViews,
        eventCount: events.length,
        countryCode: first.country,
        deviceCategory: first.device_category,
        browserFamily: first.browser_family,
        locale: first.locale,
        firstReferrerHost: first.referrer_host,
        utmSource: first.utm_source,
        utmMedium: first.utm_medium,
        utmCampaign: first.utm_campaign,
        utmContent: first.utm_content,
        utmTerm: first.utm_term,
        isNewVisitor: first.is_new_visitor,
      })
      .onConflictDoUpdate({
        target: analyticsSessions.sessionId,
        set: {
          lastActivityAt: sql`greatest(${analyticsSessions.lastActivityAt}, excluded.last_activity_at)`,
          lastPath: sql`excluded.last_path`,
          pageViewCount: sql`${analyticsSessions.pageViewCount} + excluded.page_view_count`,
          eventCount: sql`${analyticsSessions.eventCount} + excluded.event_count`,
          // Identity, once known, sticks for the rest of the session.
          firebaseUid: sql`coalesce(${analyticsSessions.firebaseUid}, excluded.firebase_uid)`,
          // First-touch attribution: keep what we already had.
          firstReferrerHost: sql`coalesce(${analyticsSessions.firstReferrerHost}, excluded.first_referrer_host)`,
          utmSource: sql`coalesce(${analyticsSessions.utmSource}, excluded.utm_source)`,
          utmMedium: sql`coalesce(${analyticsSessions.utmMedium}, excluded.utm_medium)`,
          utmCampaign: sql`coalesce(${analyticsSessions.utmCampaign}, excluded.utm_campaign)`,
          utmContent: sql`coalesce(${analyticsSessions.utmContent}, excluded.utm_content)`,
          utmTerm: sql`coalesce(${analyticsSessions.utmTerm}, excluded.utm_term)`,
          countryCode: sql`coalesce(${analyticsSessions.countryCode}, excluded.country_code)`,
        },
      });

    // Reporting attributes for signed-in visitors. No email, name or token.
    if (first.user_id) {
      await db
        .insert(userAnalytics)
        .values({
          firebaseUid: first.user_id,
          userType: first.user_type,
          firstSeenAt: new Date(first.received_at),
          lastSeenAt: new Date(last.received_at),
          locale: first.locale,
          countryCode: first.country,
        })
        .onConflictDoUpdate({
          target: userAnalytics.firebaseUid,
          set: {
            lastSeenAt: sql`greatest(${userAnalytics.lastSeenAt}, excluded.last_seen_at)`,
            locale: sql`excluded.locale`,
            countryCode: sql`coalesce(excluded.country_code, ${userAnalytics.countryCode})`,
            userType: sql`excluded.user_type`,
          },
        });
    }

    return { stored: events.length, configured: true };
  } catch (error) {
    // Never surface a database error to a browser: the message can carry table
    // names, the query, or the host. The collector answers 204 regardless.
    //
    // It does go to the server log. A write that fails silently on both sides
    // is indistinguishable from no traffic at all, which would make a broken
    // connection look like an empty database — exactly the confusion the
    // unconfigured/empty/zero distinction exists to prevent.
    console.error(
      "[analytics] event write failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return { stored: 0, configured: true };
  }
}
