import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ==========================================================================
   DATABASE SCHEMA

   Five tables, three concerns that must never blur into each other:

     analytics_events / analytics_sessions  — product signals from browsers.
                                              Cheap, high volume, untrusted.
     user_analytics                         — reporting attributes per account.
                                              Keyed by Firebase uid; carries no
                                              email, name or token.
     financial_ledger                       — money. Integer minor units, DB
                                              constraints, server writes only.
     admin_audit_log                        — append-only record of privileged
                                              actions.

   PRIVACY, enforced by absence: there is no ip column, no ip_hash, no
   user_agent and no referrer_url. Those fields are not omitted by accident and
   must not be added without a Privacy Policy change.
   ========================================================================== */

/* ------------------------------- enums ---------------------------------- */

export const userTypeEnum = pgEnum("user_type", ["anonymous", "creator", "brand", "admin"]);
export const deviceCategoryEnum = pgEnum("device_category", [
  "mobile",
  "tablet",
  "desktop",
  "unknown",
]);
export const localeEnum = pgEnum("locale", ["en", "he"]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "brand_funding",
  "creator_payout",
  "platform_fee",
  "refund",
  "processing_fee",
  "adjustment",
]);
export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "completed",
  "failed",
  "refunded",
]);

/* --------------------------- analytics_events ---------------------------- */

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventName: text("event_name").notNull(),
    /** Browser clock — orders events inside one session. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Server clock — the one every report uses. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

    sessionId: uuid("session_id").notNull(),
    /** Rotating first-party visitor id. Never derived from IP or a fingerprint. */
    visitorId: uuid("visitor_id"),
    firebaseUid: text("firebase_uid"),
    userType: userTypeEnum("user_type").notNull().default("anonymous"),

    locale: localeEnum("locale").notNull(),
    /** Path only — a full URL could carry a query string with personal data. */
    path: text("path").notNull(),

    /** Host only, never the full referring URL. */
    referrerHost: text("referrer_host"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),

    /** ISO 3166-1 alpha-2, from a trusted platform header. */
    countryCode: char("country_code", { length: 2 }),
    deviceCategory: deviceCategoryEnum("device_category").notNull().default("unknown"),
    /** Family only — the full user-agent is high-entropy and is not stored. */
    browserFamily: text("browser_family"),

    campaignId: text("campaign_id"),
    /** Rebuilt field by field from the allow-list; never the raw browser body. */
    metadata: jsonb("metadata").$type<Record<string, string | number>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_events_occurred").on(t.occurredAt),
    index("idx_events_name_occurred").on(t.eventName, t.occurredAt),
    index("idx_events_country_occurred").on(t.countryCode, t.occurredAt),
    index("idx_events_uid_occurred").on(t.firebaseUid, t.occurredAt),
    index("idx_events_session_occurred").on(t.sessionId, t.occurredAt),
    index("idx_events_path_occurred").on(t.path, t.occurredAt),
  ],
);

/* -------------------------- analytics_sessions --------------------------- */

export const analyticsSessions = pgTable(
  "analytics_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    visitorId: uuid("visitor_id"),
    /** Set when a session becomes authenticated; stays set afterwards. */
    firebaseUid: text("firebase_uid"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),

    entryPath: text("entry_path").notNull(),
    lastPath: text("last_path").notNull(),
    pageViewCount: integer("page_view_count").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),

    countryCode: char("country_code", { length: 2 }),
    deviceCategory: deviceCategoryEnum("device_category").notNull().default("unknown"),
    browserFamily: text("browser_family"),
    locale: localeEnum("locale").notNull(),

    /** First-touch attribution, captured once at session start. */
    firstReferrerHost: text("first_referrer_host"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),

    /** True when no earlier session is known for this visitor id. */
    isNewVisitor: boolean("is_new_visitor").notNull().default(true),
  },
  (t) => [
    index("idx_sessions_last_activity").on(t.lastActivityAt),
    index("idx_sessions_started").on(t.startedAt),
    index("idx_sessions_uid").on(t.firebaseUid),
    index("idx_sessions_country").on(t.countryCode),
    index("idx_sessions_visitor").on(t.visitorId),
  ],
);

/* ---------------------------- user_analytics ----------------------------- */

/**
 * Reporting attributes per account. Deliberately does NOT hold email, display
 * name or any token — Firebase remains the identity system, and duplicating
 * identity here would create a second place to leak it from.
 */
export const userAnalytics = pgTable(
  "user_analytics",
  {
    firebaseUid: text("firebase_uid").primaryKey(),
    userType: userTypeEnum("user_type").notNull().default("anonymous"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    locale: localeEnum("locale"),
    countryCode: char("country_code", { length: 2 }),
    signupSource: text("signup_source"),

    creatorOnboardingStartedAt: timestamp("creator_onboarding_started_at", { withTimezone: true }),
    creatorOnboardingCompletedAt: timestamp("creator_onboarding_completed_at", {
      withTimezone: true,
    }),
    brandFormSubmittedAt: timestamp("brand_form_submitted_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_user_analytics_last_seen").on(t.lastSeenAt),
    index("idx_user_analytics_type").on(t.userType),
    index("idx_user_analytics_country").on(t.countryCode),
  ],
);

/* --------------------------- financial_ledger ---------------------------- */

/**
 * Money.
 *
 * `amount_minor` is a bigint of the currency's minor unit — never a float, and
 * never a JS number at rest. The currency is a 3-character ISO code so a row
 * can never be ambiguous about what it measures.
 *
 * No row is written from a browser. Inserts come from a payment webhook, an
 * audited admin adjustment, or a campaign settlement job.
 */
export const financialLedger = pgTable(
  "financial_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionType: transactionTypeEnum("transaction_type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: transactionStatusEnum("status").notNull().default("pending"),

    campaignId: text("campaign_id"),
    brandId: text("brand_id"),
    creatorId: text("creator_id"),

    /** Name of the payment provider. Null until one is integrated. */
    externalProvider: text("external_provider"),
    /** The provider's own id. Unique when present, so a webhook replay cannot double-post. */
    externalProviderReference: text("external_provider_reference"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    metadata: jsonb("metadata").$type<Record<string, string | number>>(),
  },
  (t) => [
    index("idx_ledger_created").on(t.createdAt),
    index("idx_ledger_status").on(t.status),
    index("idx_ledger_type").on(t.transactionType),
    index("idx_ledger_campaign").on(t.campaignId),
    index("idx_ledger_brand").on(t.brandId),
    index("idx_ledger_creator").on(t.creatorId),
    // Idempotency for provider webhooks. Partial: many rows have no reference yet.
    uniqueIndex("uniq_ledger_provider_ref")
      .on(t.externalProvider, t.externalProviderReference)
      .where(sql`external_provider_reference is not null`),
  ],
);

/* ---------------------------- admin_audit_log ---------------------------- */

/**
 * Append-only. There is no update or delete path in the application, and the
 * database role used at runtime should not be granted them either.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminUid: text("admin_uid").notNull(),
    /** Snapshot at the time of the action, so a later read needs no live lookup. */
    adminEmailAtTime: text("admin_email_at_time"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull().default("none"),
    targetId: text("target_id"),
    /** No IP is stored; country is enough to notice an anomalous session. */
    countryCode: char("country_code", { length: 2 }),
    sessionId: uuid("session_id"),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_created").on(t.createdAt),
    index("idx_audit_admin").on(t.adminUid),
    index("idx_audit_action").on(t.action),
  ],
);
