import "server-only";

import { and, countDistinct, desc, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { analyticsEvents, analyticsSessions } from "@/lib/db/schema";

/* ==========================================================================
   METRIC QUERIES

   Every figure the dashboard will show is defined here once, in SQL, with the
   definition written next to it. Two rules the brief asks for and this file
   enforces:

   1. AUTHENTICATED USERS AND ANONYMOUS VISITORS ARE COUNTED SEPARATELY.
      DAU/WAU/MAU count distinct firebase_uid — real people who signed in.
      Unique visitors count distinct visitor_id — browsers. Folding them
      together would inflate "active users" with every logged-out refresh.

   2. NOTHING IS INVENTED. With no database configured every function returns
      null, and the caller reports "not configured" rather than zero. An empty
      but connected database legitimately returns 0.
   ========================================================================== */

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

const DAY = 24 * 60 * 60 * 1000;

export type TrafficMetrics = {
  pageviews_today: number;
  sessions_today: number;
  unique_visitors_today: number;
  /** Distinct sessions with activity in the last 5 minutes. NOT "online now". */
  recently_active: number;
  new_visitors_today: number;
  returning_visitors_today: number;
  avg_session_seconds: number | null;
};

export async function getTrafficMetrics(): Promise<TrafficMetrics | null> {
  const db = getDb();
  if (!db) return null;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  try {
    const [events] = await db
      .select({
        pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')`,
        sessions: countDistinct(analyticsEvents.sessionId),
        visitors: countDistinct(analyticsEvents.visitorId),
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, startOfDay));

    const [active] = await db
      .select({ sessions: countDistinct(analyticsSessions.sessionId) })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.lastActivityAt, since(5 * 60 * 1000)));

    const [visitors] = await db
      .select({
        fresh: sql<number>`count(*) filter (where ${analyticsSessions.isNewVisitor})`,
        returning: sql<number>`count(*) filter (where not ${analyticsSessions.isNewVisitor})`,
        // Sessions with a single event have no measurable duration; excluding
        // them stops a bounce from dragging the average to zero.
        avgSeconds: sql<number | null>`avg(
          extract(epoch from (${analyticsSessions.lastActivityAt} - ${analyticsSessions.startedAt}))
        ) filter (where ${analyticsSessions.eventCount} > 1)`,
      })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.startedAt, startOfDay));

    return {
      pageviews_today: Number(events?.pageviews ?? 0),
      sessions_today: Number(events?.sessions ?? 0),
      unique_visitors_today: Number(events?.visitors ?? 0),
      recently_active: Number(active?.sessions ?? 0),
      new_visitors_today: Number(visitors?.fresh ?? 0),
      returning_visitors_today: Number(visitors?.returning ?? 0),
      avg_session_seconds: visitors?.avgSeconds != null ? Math.round(Number(visitors.avgSeconds)) : null,
    };
  } catch {
    return null;
  }
}

export type ActiveUserMetrics = {
  /** Distinct signed-in accounts. Anonymous traffic is NOT included. */
  dau: number;
  wau: number;
  mau: number;
};

export async function getActiveUsers(): Promise<ActiveUserMetrics | null> {
  const db = getDb();
  if (!db) return null;

  const count = async (windowMs: number) => {
    const [row] = await db
      .select({ n: countDistinct(analyticsEvents.firebaseUid) })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.occurredAt, since(windowMs)),
          sql`${analyticsEvents.firebaseUid} is not null`,
        ),
      );
    return Number(row?.n ?? 0);
  };

  try {
    return { dau: await count(DAY), wau: await count(7 * DAY), mau: await count(30 * DAY) };
  } catch {
    return null;
  }
}

/**
 * Funnel stages, counted as distinct sessions that produced each event within
 * the window. Only stages observable today are listed — the brand funnel stops
 * at form submission because campaign creation does not exist yet.
 */
async function funnelStage(eventName: string, windowMs: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: countDistinct(analyticsEvents.sessionId) })
    .from(analyticsEvents)
    .where(
      and(
        sql`${analyticsEvents.eventName} = ${eventName}`,
        gte(analyticsEvents.occurredAt, since(windowMs)),
      ),
    );
  return Number(row?.n ?? 0);
}

async function ctaStage(ctaId: string, windowMs: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: countDistinct(analyticsEvents.sessionId) })
    .from(analyticsEvents)
    .where(
      and(
        sql`${analyticsEvents.eventName} = 'cta_clicked'`,
        sql`${analyticsEvents.metadata} ->> 'cta_id' = ${ctaId}`,
        gte(analyticsEvents.occurredAt, since(windowMs)),
      ),
    );
  return Number(row?.n ?? 0);
}

export type Funnels = {
  creator: { visitors: number; start_earning_cta: number; onboarding_started: number; onboarding_step: number; onboarding_completed: number };
  brand: { brand_page_visitors: number; launch_campaign_cta: number; form_started: number; form_submitted: number };
  /** Stages that cannot be measured because the feature does not exist. */
  unavailable_stages: string[];
};

export async function getFunnels(windowMs = 30 * DAY): Promise<Funnels | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [visitorRow] = await db
      .select({ n: countDistinct(analyticsEvents.sessionId) })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, since(windowMs)));

    const [brandVisitorRow] = await db
      .select({ n: countDistinct(analyticsEvents.sessionId) })
      .from(analyticsEvents)
      .where(
        and(
          sql`${analyticsEvents.path} like '%/brand'`,
          gte(analyticsEvents.occurredAt, since(windowMs)),
        ),
      );

    return {
      creator: {
        visitors: Number(visitorRow?.n ?? 0),
        start_earning_cta: await ctaStage("creator_hero_start_earning", windowMs),
        onboarding_started: await funnelStage("creator_signup_started", windowMs),
        onboarding_step: await funnelStage("creator_onboarding_step_completed", windowMs),
        onboarding_completed: await funnelStage("creator_signup_completed", windowMs),
      },
      brand: {
        brand_page_visitors: Number(brandVisitorRow?.n ?? 0),
        launch_campaign_cta: await ctaStage("brand_hero_launch_campaign", windowMs),
        form_started: await funnelStage("brand_form_started", windowMs),
        form_submitted: await funnelStage("brand_form_submitted", windowMs),
      },
      // Named explicitly so the dashboard shows an honest gap rather than a zero.
      unavailable_stages: [
        "campaign_created — campaign creation is not implemented",
        "campaign_funded — no payment provider is connected",
        "campaign_launched — campaign lifecycle is not implemented",
      ],
    };
  } catch {
    return null;
  }
}

export type CountryRow = { country_code: string | null; sessions: number; users: number };

export async function getTopCountries(limit = 10): Promise<CountryRow[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({
        country_code: analyticsSessions.countryCode,
        sessions: sql<number>`count(*)`,
        users: countDistinct(analyticsSessions.firebaseUid),
      })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.startedAt, since(30 * DAY)))
      .groupBy(analyticsSessions.countryCode)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({
      country_code: r.country_code,
      sessions: Number(r.sessions),
      users: Number(r.users),
    }));
  } catch {
    return null;
  }
}

export type PageRow = { path: string; views: number };

export async function getTopPages(limit = 10): Promise<PageRow[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({ path: analyticsEvents.path, views: sql<number>`count(*)` })
      .from(analyticsEvents)
      .where(
        and(
          sql`${analyticsEvents.eventName} = 'page_view'`,
          gte(analyticsEvents.occurredAt, since(30 * DAY)),
        ),
      )
      .groupBy(analyticsEvents.path)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({ path: r.path, views: Number(r.views) }));
  } catch {
    return null;
  }
}

export type ReferrerRow = { source: string; sessions: number };

/** First-touch attribution: UTM source when present, else referrer host, else direct. */
export async function getTopReferrers(limit = 10): Promise<ReferrerRow[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({
        source: sql<string>`coalesce(${analyticsSessions.utmSource}, ${analyticsSessions.firstReferrerHost}, 'direct')`,
        sessions: sql<number>`count(*)`,
      })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.startedAt, since(30 * DAY)))
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({ source: r.source, sessions: Number(r.sessions) }));
  } catch {
    return null;
  }
}

export async function getEventStats(): Promise<{ total: number; last_received: string | null } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        last: sql<Date | null>`max(${analyticsEvents.receivedAt})`,
      })
      .from(analyticsEvents);
    return {
      total: Number(row?.total ?? 0),
      last_received: row?.last ? new Date(row.last).toISOString() : null,
    };
  } catch {
    return null;
  }
}
