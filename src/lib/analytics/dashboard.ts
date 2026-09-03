import "server-only";

import { and, asc, countDistinct, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@/lib/db";
import { adminAuditLog, analyticsEvents, analyticsSessions, userAnalytics } from "@/lib/db/schema";
import { resolveComparison, resolveRange, type CompareKey, type RangeKey } from "./range";

/* ==========================================================================
   DASHBOARD QUERIES

   Every panel on the dashboard is one function here, and every one of them
   distinguishes three outcomes the UI must never blur:

     null            the source cannot answer — no database, or the query
                     failed. The panel says "not available".
     an empty array  the database answered and there is nothing. The panel
                     says "no data yet".
     a zero          a real count that happens to be zero.

   Queries are aggregate-only: nothing here pulls an event history into the
   process to count it in JavaScript. Each one is written against the indexes
   created in the migration.
   ========================================================================== */

export type Outcome<T> = { ok: true; data: T } | { ok: false; reason: "unconfigured" | "error" };

function unconfigured<T>(): Outcome<T> {
  return { ok: false, reason: "unconfigured" };
}

/** Wraps a query so one failing panel cannot take down a page. */
async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  if (!isDatabaseConfigured()) return unconfigured<T>();
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    // The panel shows a generic failure — a query or a host name must not
    // reach the browser. The reason is written to the server log so a real
    // fault is diagnosable instead of looking like a configuration problem.
    console.error(
      "[admin] dashboard query failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return { ok: false, reason: "error" };
  }
}

const inRange = (from: Date, to: Date) =>
  and(gte(analyticsEvents.occurredAt, from), lte(analyticsEvents.occurredAt, to));

const sessionsInRange = (from: Date, to: Date) =>
  and(gte(analyticsSessions.startedAt, from), lte(analyticsSessions.startedAt, to));

/* ----------------------------- headline KPIs ----------------------------- */

export type Headline = {
  pageviews: number;
  unique_visitors: number;
  sessions: number;
  new_visitors: number;
  returning_visitors: number;
  avg_session_seconds: number | null;
};

async function headlineFor(from: Date, to: Date): Promise<Headline> {
  const db = getDb()!;
  const [events] = await db
    .select({
      pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')`,
      visitors: countDistinct(analyticsEvents.visitorId),
      sessions: countDistinct(analyticsEvents.sessionId),
    })
    .from(analyticsEvents)
    .where(inRange(from, to));

  const [sessions] = await db
    .select({
      fresh: sql<number>`count(*) filter (where ${analyticsSessions.isNewVisitor})`,
      returning: sql<number>`count(*) filter (where not ${analyticsSessions.isNewVisitor})`,
      // A single-event session has no measurable duration; including it would
      // drag the average toward zero for reasons that are not about engagement.
      avg: sql<number | null>`avg(extract(epoch from (${analyticsSessions.lastActivityAt} - ${analyticsSessions.startedAt})))
        filter (where ${analyticsSessions.eventCount} > 1)`,
    })
    .from(analyticsSessions)
    .where(sessionsInRange(from, to));

  return {
    pageviews: Number(events?.pageviews ?? 0),
    unique_visitors: Number(events?.visitors ?? 0),
    sessions: Number(events?.sessions ?? 0),
    new_visitors: Number(sessions?.fresh ?? 0),
    returning_visitors: Number(sessions?.returning ?? 0),
    avg_session_seconds: sessions?.avg != null ? Math.round(Number(sessions.avg)) : null,
  };
}

export type HeadlineResult = {
  current: Headline;
  previous: Headline | null;
  /** True when the comparison window contains no data at all. */
  comparison_unavailable: boolean;
};

export async function getHeadline(
  rangeKey: RangeKey,
  compare: CompareKey,
): Promise<Outcome<HeadlineResult>> {
  return attempt(async () => {
    const range = resolveRange(rangeKey);
    const current = await headlineFor(range.from, range.to);

    const window = resolveComparison(range, compare);
    if (!window) return { current, previous: null, comparison_unavailable: false };

    const previous = await headlineFor(window.from, window.to);
    // A baseline of nothing is not a baseline. Saying "+100%" against a period
    // the product was not collecting in would invent a trend.
    const empty =
      previous.pageviews === 0 && previous.sessions === 0 && previous.unique_visitors === 0;
    return { current, previous: empty ? null : previous, comparison_unavailable: empty };
  });
}

/* --------------------------- recently active ----------------------------- */

export async function getRecentlyActiveCount(): Promise<Outcome<number>> {
  return attempt(async () => {
    const db = getDb()!;
    const [row] = await db
      .select({ n: countDistinct(analyticsSessions.sessionId) })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.lastActivityAt, new Date(Date.now() - 5 * 60 * 1000)));
    return Number(row?.n ?? 0);
  });
}

export type ActiveSession = {
  last_path: string;
  country_code: string | null;
  device_category: string;
  browser_family: string | null;
  locale: string;
  started_at: string;
  last_activity_at: string;
  page_view_count: number;
};

export async function getActiveSessions(limit = 50): Promise<Outcome<ActiveSession[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const rows = await db
      .select({
        last_path: analyticsSessions.lastPath,
        country_code: analyticsSessions.countryCode,
        device_category: analyticsSessions.deviceCategory,
        browser_family: analyticsSessions.browserFamily,
        locale: analyticsSessions.locale,
        started_at: analyticsSessions.startedAt,
        last_activity_at: analyticsSessions.lastActivityAt,
        page_view_count: analyticsSessions.pageViewCount,
      })
      .from(analyticsSessions)
      .where(gte(analyticsSessions.lastActivityAt, new Date(Date.now() - 5 * 60 * 1000)))
      .orderBy(desc(analyticsSessions.lastActivityAt))
      .limit(limit);

    // Session and visitor ids are deliberately not selected: an operator does
    // not need a per-visitor identifier to read an activity list.
    return rows.map((r) => ({
      ...r,
      started_at: r.started_at.toISOString(),
      last_activity_at: r.last_activity_at.toISOString(),
    }));
  });
}

/* ------------------------------ active users ----------------------------- */

export type ActiveUsers = { dau: number; wau: number; mau: number };

export async function getActiveUsers(): Promise<Outcome<ActiveUsers>> {
  return attempt(async () => {
    const db = getDb()!;
    const day = 24 * 60 * 60 * 1000;
    const count = async (ms: number) => {
      const [row] = await db
        .select({ n: countDistinct(analyticsEvents.firebaseUid) })
        .from(analyticsEvents)
        .where(
          and(
            gte(analyticsEvents.occurredAt, new Date(Date.now() - ms)),
            sql`${analyticsEvents.firebaseUid} is not null`,
          ),
        );
      return Number(row?.n ?? 0);
    };
    return { dau: await count(day), wau: await count(7 * day), mau: await count(30 * day) };
  });
}

/* ------------------------------ time series ------------------------------ */

export type SeriesPoint = { bucket: string; pageviews: number; visitors: number; sessions: number };

export async function getTrafficSeries(rangeKey: RangeKey): Promise<Outcome<SeriesPoint[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    // date_trunc keeps the bucketing in the database, where the index is.
    const rows = await db
      .select({
        bucket: sql<Date>`date_trunc(${range.bucket}, ${analyticsEvents.occurredAt})`,
        pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')`,
        visitors: countDistinct(analyticsEvents.visitorId),
        sessions: countDistinct(analyticsEvents.sessionId),
      })
      .from(analyticsEvents)
      .where(inRange(range.from, range.to))
      .groupBy(sql`1`)
      .orderBy(asc(sql`1`));

    return rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      pageviews: Number(r.pageviews),
      visitors: Number(r.visitors),
      sessions: Number(r.sessions),
    }));
  });
}

export type VisitorSplitPoint = { bucket: string; fresh: number; returning: number };

export async function getVisitorSplitSeries(
  rangeKey: RangeKey,
): Promise<Outcome<VisitorSplitPoint[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({
        bucket: sql<Date>`date_trunc(${range.bucket}, ${analyticsSessions.startedAt})`,
        fresh: sql<number>`count(*) filter (where ${analyticsSessions.isNewVisitor})`,
        returning: sql<number>`count(*) filter (where not ${analyticsSessions.isNewVisitor})`,
      })
      .from(analyticsSessions)
      .where(sessionsInRange(range.from, range.to))
      .groupBy(sql`1`)
      .orderBy(asc(sql`1`));

    return rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      fresh: Number(r.fresh),
      returning: Number(r.returning),
    }));
  });
}

/* ------------------------------- breakdowns ------------------------------ */

export type CountryRow = {
  country_code: string | null;
  sessions: number;
  visitors: number;
  users: number;
};

export async function getCountries(rangeKey: RangeKey, limit = 20): Promise<Outcome<CountryRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({
        country_code: analyticsSessions.countryCode,
        sessions: sql<number>`count(*)`,
        visitors: countDistinct(analyticsSessions.visitorId),
        users: countDistinct(analyticsSessions.firebaseUid),
      })
      .from(analyticsSessions)
      .where(sessionsInRange(range.from, range.to))
      .groupBy(analyticsSessions.countryCode)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({
      country_code: r.country_code,
      sessions: Number(r.sessions),
      visitors: Number(r.visitors),
      users: Number(r.users),
    }));
  });
}

export type PageRow = {
  path: string;
  pageviews: number;
  visitors: number;
  sessions: number;
  cta_clicks: number;
};

export async function getPages(rangeKey: RangeKey, limit = 50): Promise<Outcome<PageRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({
        path: analyticsEvents.path,
        pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')`,
        visitors: countDistinct(analyticsEvents.visitorId),
        sessions: countDistinct(analyticsEvents.sessionId),
        cta_clicks: sql<number>`count(*) filter (where ${analyticsEvents.eventName} = 'cta_clicked')`,
      })
      .from(analyticsEvents)
      .where(inRange(range.from, range.to))
      .groupBy(analyticsEvents.path)
      .orderBy(desc(sql`count(*) filter (where ${analyticsEvents.eventName} = 'page_view')`))
      .limit(limit);
    return rows.map((r) => ({
      path: r.path,
      pageviews: Number(r.pageviews),
      visitors: Number(r.visitors),
      sessions: Number(r.sessions),
      cta_clicks: Number(r.cta_clicks),
    }));
  });
}

export type EntryExitRow = { path: string; entries: number; exits: number };

export async function getEntryExit(rangeKey: RangeKey, limit = 50): Promise<Outcome<EntryExitRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    // Entry and exit both come from the session row, so this is one scan of a
    // much smaller table rather than a window function over every event.
    const rows = await db
      .select({
        path: sql<string>`p`,
        entries: sql<number>`sum(e)`,
        exits: sql<number>`sum(x)`,
      })
      .from(
        sql`(
          select ${analyticsSessions.entryPath} as p, 1 as e, 0 as x from ${analyticsSessions}
            where ${sessionsInRange(range.from, range.to)}
          union all
          select ${analyticsSessions.lastPath} as p, 0 as e, 1 as x from ${analyticsSessions}
            where ${sessionsInRange(range.from, range.to)}
        ) as t`,
      )
      .groupBy(sql`p`)
      .orderBy(desc(sql`sum(e) + sum(x)`))
      .limit(limit);
    return rows.map((r) => ({
      path: r.path,
      entries: Number(r.entries),
      exits: Number(r.exits),
    }));
  });
}

export type SourceRow = { source: string; sessions: number; visitors: number };

export async function getSources(rangeKey: RangeKey, limit = 20): Promise<Outcome<SourceRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({
        source: sql<string>`coalesce(${analyticsSessions.utmSource}, ${analyticsSessions.firstReferrerHost}, 'direct')`,
        sessions: sql<number>`count(*)`,
        visitors: countDistinct(analyticsSessions.visitorId),
      })
      .from(analyticsSessions)
      .where(sessionsInRange(range.from, range.to))
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({
      source: r.source,
      sessions: Number(r.sessions),
      visitors: Number(r.visitors),
    }));
  });
}

export type UtmRow = { value: string; sessions: number };

export async function getUtm(
  field: "source" | "medium" | "campaign",
  rangeKey: RangeKey,
  limit = 20,
): Promise<Outcome<UtmRow[]>> {
  const column = {
    source: analyticsSessions.utmSource,
    medium: analyticsSessions.utmMedium,
    campaign: analyticsSessions.utmCampaign,
  }[field];

  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({ value: column, sessions: sql<number>`count(*)` })
      .from(analyticsSessions)
      .where(and(sessionsInRange(range.from, range.to), sql`${column} is not null`))
      .groupBy(column)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows.map((r) => ({ value: r.value ?? "", sessions: Number(r.sessions) }));
  });
}

export type DistributionRow = { value: string | null; count: number };

export async function getLocaleSplit(rangeKey: RangeKey): Promise<Outcome<DistributionRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({ value: analyticsSessions.locale, count: sql<number>`count(*)` })
      .from(analyticsSessions)
      .where(sessionsInRange(range.from, range.to))
      .groupBy(analyticsSessions.locale)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  });
}

export async function getDeviceSplit(rangeKey: RangeKey): Promise<Outcome<DistributionRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);
    const rows = await db
      .select({ value: analyticsSessions.deviceCategory, count: sql<number>`count(*)` })
      .from(analyticsSessions)
      .where(sessionsInRange(range.from, range.to))
      .groupBy(analyticsSessions.deviceCategory)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  });
}

/* -------------------------------- funnels -------------------------------- */

export type FunnelStage = {
  key: string;
  count: number | null;
  /** False when the product cannot observe this stage at all. */
  observable: boolean;
};

export type FunnelData = { creator: FunnelStage[]; brand: FunnelStage[] };

export async function getFunnels(rangeKey: RangeKey): Promise<Outcome<FunnelData>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);

    const byEvent = async (name: string) => {
      const [row] = await db
        .select({ n: countDistinct(analyticsEvents.sessionId) })
        .from(analyticsEvents)
        .where(and(eq(analyticsEvents.eventName, name), inRange(range.from, range.to)));
      return Number(row?.n ?? 0);
    };

    const byCta = async (ctaId: string) => {
      const [row] = await db
        .select({ n: countDistinct(analyticsEvents.sessionId) })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.eventName, "cta_clicked"),
            sql`${analyticsEvents.metadata} ->> 'cta_id' = ${ctaId}`,
            inRange(range.from, range.to),
          ),
        );
      return Number(row?.n ?? 0);
    };

    const [allSessions] = await db
      .select({ n: countDistinct(analyticsEvents.sessionId) })
      .from(analyticsEvents)
      .where(inRange(range.from, range.to));

    const [brandSessions] = await db
      .select({ n: countDistinct(analyticsEvents.sessionId) })
      .from(analyticsEvents)
      .where(and(sql`${analyticsEvents.path} like '%/brand'`, inRange(range.from, range.to)));

    return {
      creator: [
        { key: "stVisitor", count: Number(allSessions?.n ?? 0), observable: true },
        { key: "stStartEarning", count: await byCta("creator_hero_start_earning"), observable: true },
        { key: "stLoginStarted", count: await byEvent("login_started"), observable: true },
        { key: "stLoginCompleted", count: await byEvent("login_completed"), observable: true },
        { key: "stOnboardingStarted", count: await byEvent("creator_signup_started"), observable: true },
        { key: "stOnboardingStep", count: await byEvent("creator_onboarding_step_completed"), observable: true },
        { key: "stOnboardingDone", count: await byEvent("creator_signup_completed"), observable: true },
      ],
      brand: [
        { key: "stBrandVisitor", count: Number(brandSessions?.n ?? 0), observable: true },
        { key: "stLaunchCta", count: await byCta("brand_hero_launch_campaign"), observable: true },
        { key: "stFormStarted", count: await byEvent("brand_form_started"), observable: true },
        { key: "stFormSubmitted", count: await byEvent("brand_form_submitted"), observable: true },
        // Declared so the shape of the real funnel is visible, but null and
        // flagged — a zero here would say nobody converted, which is not what
        // is happening. Nothing can convert through a stage that has no code.
        { key: "stCampaignCreated", count: null, observable: false },
        { key: "stCampaignFunded", count: null, observable: false },
        { key: "stCampaignLaunched", count: null, observable: false },
      ],
    };
  });
}

/* -------------------------------- users ---------------------------------- */

export type UserSummary = {
  total: number;
  creators: number;
  brands: number;
  admins: number;
  onboarding_started: number;
  onboarding_completed: number;
  brand_form_submitted: number;
};

export async function getUserSummary(): Promise<Outcome<UserSummary>> {
  return attempt(async () => {
    const db = getDb()!;
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        creators: sql<number>`count(*) filter (where ${userAnalytics.userType} = 'creator')`,
        brands: sql<number>`count(*) filter (where ${userAnalytics.userType} = 'brand')`,
        admins: sql<number>`count(*) filter (where ${userAnalytics.userType} = 'admin')`,
        started: sql<number>`count(*) filter (where ${userAnalytics.creatorOnboardingStartedAt} is not null)`,
        completed: sql<number>`count(*) filter (where ${userAnalytics.creatorOnboardingCompletedAt} is not null)`,
        brandForm: sql<number>`count(*) filter (where ${userAnalytics.brandFormSubmittedAt} is not null)`,
      })
      .from(userAnalytics);
    return {
      total: Number(row?.total ?? 0),
      creators: Number(row?.creators ?? 0),
      brands: Number(row?.brands ?? 0),
      admins: Number(row?.admins ?? 0),
      onboarding_started: Number(row?.started ?? 0),
      onboarding_completed: Number(row?.completed ?? 0),
      brand_form_submitted: Number(row?.brandForm ?? 0),
    };
  });
}

export type UserRow = {
  firebase_uid: string;
  user_type: string;
  country_code: string | null;
  locale: string | null;
  first_seen_at: string;
  last_seen_at: string;
  onboarding: "completed" | "started" | "none";
};

export async function getUsers(limit = 50, offset = 0): Promise<Outcome<UserRow[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const rows = await db
      .select({
        firebase_uid: userAnalytics.firebaseUid,
        user_type: userAnalytics.userType,
        country_code: userAnalytics.countryCode,
        locale: userAnalytics.locale,
        first_seen_at: userAnalytics.firstSeenAt,
        last_seen_at: userAnalytics.lastSeenAt,
        started: userAnalytics.creatorOnboardingStartedAt,
        completed: userAnalytics.creatorOnboardingCompletedAt,
      })
      .from(userAnalytics)
      .orderBy(desc(userAnalytics.lastSeenAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      firebase_uid: r.firebase_uid,
      user_type: r.user_type,
      country_code: r.country_code,
      locale: r.locale,
      first_seen_at: r.first_seen_at.toISOString(),
      last_seen_at: r.last_seen_at.toISOString(),
      onboarding: r.completed ? ("completed" as const) : r.started ? ("started" as const) : ("none" as const),
    }));
  });
}

/* -------------------------------- events --------------------------------- */

export type EventRow = {
  id: string;
  event_name: string;
  occurred_at: string;
  path: string;
  locale: string;
  country_code: string | null;
  device_category: string;
  browser_family: string | null;
  campaign_id: string | null;
  metadata: Record<string, string | number> | null;
};

export type EventFilters = {
  name?: string;
  country?: string;
  locale?: string;
  path?: string;
};

export async function getEvents(
  rangeKey: RangeKey,
  filters: EventFilters,
  limit = 50,
  offset = 0,
): Promise<Outcome<{ rows: EventRow[]; total: number }>> {
  return attempt(async () => {
    const db = getDb()!;
    const range = resolveRange(rangeKey);

    const conditions = [inRange(range.from, range.to)];
    if (filters.name) conditions.push(eq(analyticsEvents.eventName, filters.name));
    if (filters.country) conditions.push(eq(analyticsEvents.countryCode, filters.country));
    if (filters.locale === "en" || filters.locale === "he") {
      conditions.push(eq(analyticsEvents.locale, filters.locale));
    }
    // Path is matched as a prefix on an indexed column, never as a free-text
    // scan across the row.
    if (filters.path) conditions.push(sql`${analyticsEvents.path} like ${filters.path + "%"}`);

    const where = and(...conditions);

    const [count] = await db
      .select({ n: sql<number>`count(*)` })
      .from(analyticsEvents)
      .where(where);

    const rows = await db
      .select({
        id: analyticsEvents.id,
        event_name: analyticsEvents.eventName,
        occurred_at: analyticsEvents.occurredAt,
        path: analyticsEvents.path,
        locale: analyticsEvents.locale,
        country_code: analyticsEvents.countryCode,
        device_category: analyticsEvents.deviceCategory,
        browser_family: analyticsEvents.browserFamily,
        campaign_id: analyticsEvents.campaignId,
        metadata: analyticsEvents.metadata,
      })
      .from(analyticsEvents)
      .where(where)
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(limit)
      .offset(offset);

    return {
      total: Number(count?.n ?? 0),
      rows: rows.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() })),
    };
  });
}

export async function getEventNames(): Promise<Outcome<string[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const rows = await db
      .selectDistinct({ name: analyticsEvents.eventName })
      .from(analyticsEvents)
      .orderBy(asc(analyticsEvents.eventName));
    return rows.map((r) => r.name);
  });
}

/* ------------------------------- audit log -------------------------------- */

export type AuditRow = {
  id: string;
  admin_uid: string;
  admin_email_at_time: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  country_code: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  created_at: string;
};

export async function getAuditLog(
  limit = 50,
  offset = 0,
): Promise<Outcome<{ rows: AuditRow[]; total: number }>> {
  return attempt(async () => {
    const db = getDb()!;
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(adminAuditLog);
    const rows = await db
      .select({
        id: adminAuditLog.id,
        admin_uid: adminAuditLog.adminUid,
        admin_email_at_time: adminAuditLog.adminEmailAtTime,
        action: adminAuditLog.action,
        target_type: adminAuditLog.targetType,
        target_id: adminAuditLog.targetId,
        country_code: adminAuditLog.countryCode,
        metadata: adminAuditLog.metadata,
        created_at: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset);
    return {
      total: Number(count?.n ?? 0),
      rows: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    };
  });
}

/* ------------------------------ system status ---------------------------- */

export async function getEventStats(): Promise<Outcome<{ total: number; last: string | null }>> {
  return attempt(async () => {
    const db = getDb()!;
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        last: sql<Date | null>`max(${analyticsEvents.receivedAt})`,
      })
      .from(analyticsEvents);
    return {
      total: Number(row?.total ?? 0),
      last: row?.last ? new Date(row.last).toISOString() : null,
    };
  });
}

export async function getMigrationState(): Promise<Outcome<{ tables: string[] }>> {
  return attempt(async () => {
    const db = getDb()!;
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
    );
    return { tables: Array.from(rows).map((r) => r.table_name) };
  });
}

/** Ledger totals per currency. Never summed across currencies. */
export type CurrencyTotal = { currency: string; completed_minor: string; pending_minor: string };

export async function getLedgerTotals(): Promise<Outcome<CurrencyTotal[]>> {
  return attempt(async () => {
    const db = getDb()!;
    const rows = await db.execute<{ currency: string; completed: string; pending: string }>(
      sql`select currency,
                 coalesce(sum(amount_minor) filter (where status = 'completed'), 0)::text as completed,
                 coalesce(sum(amount_minor) filter (where status = 'pending'), 0)::text as pending
          from financial_ledger group by currency order by currency`,
    );
    return Array.from(rows).map((r) => ({
      currency: r.currency,
      completed_minor: r.completed,
      pending_minor: r.pending,
    }));
  });
}

export { lt };
