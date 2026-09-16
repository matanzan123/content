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

/* ------------------------ whop_webhook_receipts -------------------------- */

/** Sandbox and production money are different money. Never inferred. */
export const whopEnvironmentEnum = pgEnum("whop_environment", ["sandbox", "production"]);

/**
 * What happened to a delivery. Deliberately not a boolean: "we have not built
 * the handler yet" and "the handler ran and succeeded" must never look alike.
 */
export const whopWebhookStatusEnum = pgEnum("whop_webhook_status", [
  /** Verified and recorded; a handler is running or was interrupted. */
  "received",
  /** Handled end to end. Only this and the two below are terminal. */
  "processed",
  /** A supported financial event with no ClipRewards mapping to write yet. */
  "awaiting_mapping",
  /** Correctly signed, but not an event this build claims to understand. */
  "unsupported",
  /** Signed by Whop but for another company. Quarantined, never processed. */
  "rejected_company",
  /** Processing raised. Retryable — a redelivery is allowed to try again. */
  "failed",
]);

/**
 * DELIVERY LEDGER for inbound Whop webhooks. Not a financial record.
 *
 * Whop delivers at least once and does not guarantee order, so the same event
 * arrives more than once as a matter of course. `webhook_id` — the Standard
 * Webhooks message id, unique per event by the spec — is the PRIMARY KEY, so
 * deduplication is a database constraint rather than application logic: an
 * `insert … on conflict do nothing` decides the winner even when two instances
 * race on the same delivery. A `check-then-insert` could not.
 *
 * WHY NOT REUSE `financial_ledger.uniq_ledger_provider_ref`: that index is
 * keyed on the financial RESOURCE. `payment.succeeded`, `refund.created` and
 * `dispute.created` can all legitimately reference one payment id, so it
 * cannot tell a redelivery apart from a different event about the same money —
 * and a delivery that produces no ledger row at all (which is every delivery
 * today) would have nothing to deduplicate against.
 *
 * PRIVACY, enforced by absence: no raw body, no card or bank details, no
 * customer name, email or address. Only the delivery id, what kind of event it
 * was, which resource and company it named, and how far we got.
 */
export const whopWebhookReceipts = pgTable(
  "whop_webhook_receipts",
  {
    /** Standard Webhooks `webhook-id`. The deduplication key. */
    webhookId: text("webhook_id").primaryKey(),
    /** Official Whop event name, e.g. "payment.succeeded". */
    eventType: text("event_type").notNull(),
    /** The Whop resource the event named, when the payload exposes one. */
    resourceId: text("resource_id"),
    /** Company the event belongs to. Compared against WHOP_COMPANY_ID. */
    companyId: text("company_id"),
    environment: whopEnvironmentEnum("environment").notNull(),

    status: whopWebhookStatusEnum("status").notNull().default("received"),
    /** Short category for a failure. Never a message that could quote a secret. */
    failureCategory: text("failure_category"),
    /** How many times Whop has delivered this same message id. */
    deliveryCount: integer("delivery_count").notNull().default(1),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * PROCESSING LEASE. Set when an instance takes ownership of the delivery,
     * cleared implicitly by reaching a terminal status.
     *
     * Without it, an instance that dies mid-handler leaves the row `received`
     * forever and no redelivery may ever touch it again — a verified payment
     * stuck permanently, which is not an acceptable failure mode for money.
     * A lease older than the window is treated as abandoned and may be
     * reclaimed.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Set only when a terminal state is actually reached. Never in advance. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_whop_receipts_received").on(t.receivedAt),
    index("idx_whop_receipts_status").on(t.status),
    index("idx_whop_receipts_event").on(t.eventType, t.receivedAt),
    index("idx_whop_receipts_resource").on(t.resourceId),
    // Finds abandoned leases without scanning the table.
    index("idx_whop_receipts_claimed").on(t.status, t.claimedAt),
  ],
);

/* --------------------------- payment_orders ------------------------------ */

/**
 * Where an order is in its life. Minimal on purpose: refund and payout states
 * are absent because neither flow exists, and inventing them would imply a
 * capability we do not have.
 */
export const paymentOrderStatusEnum = pgEnum("payment_order_status", [
  /** Created internally. The amount is fixed from this moment on. */
  "created",
  /** A Whop checkout configuration exists for it. */
  "checkout_created",
  /** The provider reports a charge in flight. */
  "payment_pending",
  /** A verified provider payment matched this order in every particular. */
  "paid",
  /** The provider reports the charge did not succeed. Retryable. */
  "failed",
  /** Abandoned before payment. Terminal. */
  "cancelled",
]);

/**
 * INTERNAL PAYMENT ORDERS — our own record of an intended payment.
 *
 * This is the authority for what an order is worth. A checkout is built FROM a
 * row here, never the other way round: the browser asks to pay for an order,
 * and the price comes out of this table. Nothing a browser sends can change an
 * amount once the row exists.
 *
 * Deliberately generic. It is not "campaign funding" — campaigns do not exist
 * yet, and naming it for a feature we have not built would be a lie in the
 * schema. `purpose` records what an order was for, so campaign funding, brand
 * payments and whatever comes later can share it without a rewrite.
 *
 * MONEY: `amount_minor` is a bigint of the currency's minor unit, never a
 * float and never a JS number at rest. `currency` is a lowercase ISO 4217 code
 * so a row can never be ambiguous about what it measures. Nothing here is
 * summed across currencies.
 *
 * This table records an ORDER, not a ledger entry. `financial_ledger` remains
 * the only place money is accounted for, and nothing writes it yet.
 */
export const paymentOrders = pgTable(
  "payment_orders",
  {
    /** Server-generated. A client-supplied id is never accepted. */
    orderId: uuid("order_id").primaryKey().defaultRandom(),
    environment: whopEnvironmentEnum("environment").notNull(),

    /** Minor units. 1000 = $10.00. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** Lowercase ISO 4217, matching how Whop reports a currency. */
    currency: char("currency", { length: 3 }).notNull(),

    status: paymentOrderStatusEnum("status").notNull().default("created"),
    /** What this order is for. Free-form but server-set; never a fake entity id. */
    purpose: text("purpose").notNull(),

    /** Whop checkout configuration, prefixed `ch_`. */
    whopCheckoutId: text("whop_checkout_id"),
    /** The plan Whop created or reused for the checkout, prefixed `plan_`. */
    whopPlanId: text("whop_plan_id"),
    /**
     * The provider payment that settled this order, prefixed `pay_`.
     * UNIQUE: one Whop payment must never be able to settle two orders, and
     * that has to be a database constraint — an application check loses the
     * race between two concurrent deliveries.
     */
    whopPaymentId: text("whop_payment_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set only when a verified provider payment matched. Never in advance. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_orders_status").on(t.status),
    index("idx_orders_created").on(t.createdAt),
    index("idx_orders_checkout").on(t.whopCheckoutId),
    // Partial: most orders have no payment yet, and many nulls must not collide.
    uniqueIndex("uniq_orders_whop_payment")
      .on(t.whopPaymentId)
      .where(sql`whop_payment_id is not null`),
  ],
);

/* --------------------------- whop_oauth_states --------------------------- */

/**
 * IN-FLIGHT OAuth authorizations.
 *
 * A row exists only between "Connect Whop" and the callback. It is what makes
 * `state` one-time and replay-resistant: the callback consumes it with a
 * `DELETE … RETURNING`, so a replayed authorization code arrives to find
 * nothing and is refused. A cookie could not do this — a cookie can be
 * replayed until it expires, and it is not shared across server instances.
 *
 * `firebase_uid` is captured at the START of the flow, from a verified
 * Firebase ID token. The callback has no session of its own, so this row is
 * the only thing that says whose account the link belongs to. That is
 * deliberate: the identity is decided where it can be proved.
 *
 * The PKCE code verifier is stored ENCRYPTED. It never travels to the browser
 * and never appears in a URL — only its S256 hash does.
 */
export const whopOauthStates = pgTable(
  "whop_oauth_states",
  {
    /** High-entropy random value. Also the `state` parameter. */
    state: text("state").primaryKey(),
    /** Whose link this will be. From a verified ID token, never from a body. */
    firebaseUid: text("firebase_uid").notNull(),
    /** AES-256-GCM envelope. Never leaves the server. */
    codeVerifierCiphertext: text("code_verifier_ciphertext").notNull(),
    // No `nonce` column, deliberately. One is sent on the authorize request
    // because Whop documents the parameter, but this flow never reads an
    // id_token — identity comes from a server-to-server userinfo call — so
    // there is nothing to compare it against. Storing it would imply a
    // verification step that does not exist.
    /** Where to send the person afterwards. Server-built, never accepted. */
    returnPath: text("return_path").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Short. An authorization the user walked away from must not stay usable. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_oauth_states_expires").on(t.expiresAt),
    index("idx_oauth_states_uid").on(t.firebaseUid),
  ],
);

/* --------------------------- whop_connections ---------------------------- */

/**
 * THE LINK between a ClipRewards account and a Whop identity.
 *
 * Firebase remains the canonical identity; this table records that a user has
 * additionally connected Whop. It is not a login: nothing here can sign
 * anyone in.
 *
 * THE JOIN KEY IS THE OIDC SUBJECT, never an email address. Whop's `sub` is
 * stable and provider-issued; an email is neither, is often shared or reused,
 * and can be changed by the person who controls the mailbox. Linking on email
 * is the classic account-takeover path, so `email` does not appear here at
 * all — not to match on, and not to store.
 *
 * TOKENS ARE ENCRYPTED, bound to the owning uid as additional authenticated
 * data. A row moved between users fails to decrypt.
 *
 * TWO PARTIAL UNIQUE INDEXES enforce the rules that matter, in the database
 * rather than in code:
 *   - one Whop identity cannot be linked by two ClipRewards users;
 *   - one ClipRewards user cannot hold two active links.
 * Both are scoped to ACTIVE rows, so a revoked link stays as history without
 * blocking a later, legitimate reconnection.
 */
export const whopConnections = pgTable(
  "whop_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firebaseUid: text("firebase_uid").notNull(),
    /** The OIDC `sub` from userinfo. The authoritative provider identity. */
    whopUserId: text("whop_user_id").notNull(),
    /** Display only — a handle to show in the UI. Never used to match. */
    whopUsername: text("whop_username"),
    /** Exactly what was granted, so a later scope change is detectable. */
    scopes: text("scopes").notNull(),

    /** AES-256-GCM envelopes. Null once revoked. */
    accessTokenCiphertext: text("access_token_ciphertext"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    /** When the access token stops working. Refresh is driven from this. */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),

    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    /** Set on disconnect. The row survives as history; the credentials do not. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_whop_connections_uid").on(t.firebaseUid),
    index("idx_whop_connections_whop_user").on(t.whopUserId),
    // One ACTIVE link per ClipRewards user.
    uniqueIndex("uniq_whop_connection_active_user")
      .on(t.firebaseUid)
      .where(sql`revoked_at is null`),
    // One ACTIVE link per Whop identity — the anti-takeover constraint.
    uniqueIndex("uniq_whop_connection_active_whop_user")
      .on(t.whopUserId)
      .where(sql`revoked_at is null`),
  ],
);

/* =========================================================================
   ACCOUNTING — the double-entry journal.

   `financial_ledger` above is left exactly as it is. It was a
   single-row-per-movement sketch written before a provider existed, and it
   cannot express the thing that actually happens when a payment settles: one
   customer payment splits into a net that reaches our provider balance, a set
   of provider fees, and tax — three amounts that must be recorded together or
   not at all. A one-row-per-movement table can record the pieces but cannot
   prove they belong to the same event or that they add up.

   It is not dropped and not rewritten. It holds ZERO rows, so nothing is
   migrated; it is simply superseded, and the two tables below are the only
   place money is accounted for from here on.

   THE MODEL IS A BALANCED JOURNAL: a header (one economic event) and its legs
   (one row per account touched). Every leg carries a SIGNED integer in minor
   units, debit positive and credit negative, and the legs of a transaction
   must sum to exactly zero. That single invariant is what makes the ledger
   checkable: a total that does not balance is a bug the database refuses
   rather than a number someone has to notice.
   ========================================================================= */

/**
 * What happened economically. NOT a webhook event name.
 *
 * `payment.succeeded` is a delivery; `payment_settled` is the settlement it
 * describes, however many times it is delivered. Most values here have no
 * posting rule yet — they are named so the model is whole, and so adding
 * refunds later is a new rule rather than a migration.
 */
export const economicEventEnum = pgEnum("economic_event", [
  "payment_settled",
  "payment_refunded",
  "dispute_opened",
  "dispute_won",
  "dispute_lost",
  "payout_sent",
  "payout_reversed",
  "manual_adjustment",
  "reversal",
  /**
   * The second transaction that moves settled funds out of suspense:
   * DR unallocated_customer_funds (clears suspense)
   * CR platform_revenue           (fee earned)
   * CR creator_payable            (net owed to creator)
   *
   * Written once per payment settlement, after the revenue model is applied.
   */
  "revenue_split",
  /**
   * Unwinds a revenue_split for a refund or dispute loss:
   * DR creator_payable            (no longer owed)
   * DR platform_revenue           (percentage fee returned; processing fee kept)
   * CR unallocated_customer_funds (back to suspense, drained by payment_refunded)
   */
  "revenue_split_reversed",
]);

/** The chart of accounts. Mirrors ACCOUNTS in src/lib/server/accounting/accounts.ts. */
export const ledgerAccountEnum = pgEnum("ledger_account", [
  "provider_balance",
  "payout_clearing",
  "unallocated_customer_funds",
  "tax_payable",
  "creator_payable",
  "campaign_funds",
  "refunds_payable",
  "dispute_reserve",
  "platform_revenue",
  "provider_fee_expense",
  "fx_adjustment",
]);

/**
 * ONE ECONOMIC EVENT. The journal header.
 *
 * IDEMPOTENCY IS `idempotency_key`, and it is built from what happened —
 * `whop:payment_settled:pay_abc` — never from a delivery id. Whop sends the
 * same event more than once with different message ids, so a delivery id would
 * let a redelivery post the money twice; and a refund legitimately names the
 * same payment as the settlement, so the resource id alone would wrongly
 * collapse two different events into one. The key is UNIQUE, so a duplicate is
 * refused by Postgres rather than by a check that can lose a race.
 *
 * `source_webhook_id` is EVIDENCE ONLY — it records which delivery caused the
 * posting so a row can be traced back, and it is deliberately not unique and
 * not part of any key.
 *
 * APPEND-ONLY. Nothing in the application updates or deletes a row here or in
 * `accounting_entries`; a correction is a new transaction pointing back
 * through `reverses_transaction_id`. The runtime database role should not be
 * granted UPDATE or DELETE on either table.
 */
export const accountingTransactions = pgTable(
  "accounting_transactions",
  {
    transactionId: uuid("transaction_id").primaryKey().defaultRandom(),

    /** What happened. */
    economicEvent: economicEventEnum("economic_event").notNull(),
    /** Who told us. "whop", or "internal" for a correction we originated. */
    provider: text("provider").notNull(),
    /** The provider's own id for the thing that happened, e.g. `pay_...`. */
    providerResourceId: text("provider_resource_id"),
    environment: whopEnvironmentEnum("environment").notNull(),

    /**
     * The currency of EVERY leg. One transaction, one currency — a journal
     * that mixed currencies could not be checked for balance at all.
     */
    currency: char("currency", { length: 3 }).notNull(),

    /** The economic key. See the table comment. */
    idempotencyKey: text("idempotency_key").notNull(),

    /** The internal order this settles, when there is one. */
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    /**
     * Set only on a transaction that exists to undo another one, in full.
     * A PARTIAL undo is not this: it is an ordinary transaction of its own
     * kind (a refund is `payment_refunded`, keyed on the refund's own resource
     * id), because a partial reversal is a new economic event rather than a
     * retraction of the original.
     */
    reversesTransactionId: uuid("reverses_transaction_id"),

    /** Which delivery caused this posting. Traceability only, never a key. */
    sourceWebhookId: text("source_webhook_id"),

    /** Short, human, and never carrying a secret or a customer detail. */
    description: text("description"),

    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the event happened at the provider, if that differs from posting. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),

    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
  },
  (t) => [
    // THE economic idempotency constraint.
    uniqueIndex("uniq_accounting_idempotency").on(t.idempotencyKey),
    // A transaction may be reversed at most once. Partial: almost every row
    // reverses nothing, and many nulls must not collide.
    uniqueIndex("uniq_accounting_reversal")
      .on(t.reversesTransactionId)
      .where(sql`reverses_transaction_id is not null`),
    index("idx_accounting_posted").on(t.postedAt),
    index("idx_accounting_event").on(t.economicEvent, t.postedAt),
    index("idx_accounting_resource").on(t.provider, t.providerResourceId),
    index("idx_accounting_order").on(t.orderId),
    index("idx_accounting_webhook").on(t.sourceWebhookId),
  ],
);

/**
 * THE LEGS. One row per account a transaction touches.
 *
 * `amount_minor` is a SIGNED bigint of the currency's minor unit: positive is
 * a debit, negative is a credit, and zero is meaningless and refused. The legs
 * of a transaction must sum to zero — enforced in migration 0004 by a
 * DEFERRABLE constraint trigger, so the check runs once at COMMIT rather than
 * after each insert, which is the only way a multi-leg journal can be written
 * at all.
 *
 * `leg` is the position within the transaction and is unique with it. That
 * makes an interrupted insert impossible to complete twice: a retry that
 * re-inserts leg 1 collides instead of producing a fourth leg on a
 * three-legged journal.
 */
export const accountingEntries = pgTable(
  "accounting_entries",
  {
    entryId: uuid("entry_id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => accountingTransactions.transactionId),

    /** 1-based position within the transaction. Unique with it. */
    leg: integer("leg").notNull(),

    account: ledgerAccountEnum("account").notNull(),
    /** Signed minor units. Debit positive, credit negative, never zero. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** Repeated from the header so a leg can never be read without it. */
    currency: char("currency", { length: 3 }).notNull(),

    /** Who the leg is with, when that is known. Never an invented id. */
    counterpartyType: text("counterparty_type"),
    counterpartyId: text("counterparty_id"),

    /** For a fee leg, Whop's own `origin`, e.g. `stripe_radar_fee`. */
    sourceDetail: text("source_detail"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_accounting_entry_leg").on(t.transactionId, t.leg),
    index("idx_entries_transaction").on(t.transactionId),
    index("idx_entries_account").on(t.account, t.createdAt),
    index("idx_entries_counterparty").on(t.counterpartyType, t.counterpartyId),
  ],
);

/* --------------------------- payment_refunds ----------------------------- */

/**
 * The local lifecycle of a refund, reduced from Whop's five provider statuses.
 * See `src/lib/server/refund-lifecycle.ts` for why it is three and not five;
 * the raw provider status is kept alongside in `provider_status`.
 */
export const paymentRefundStatusEnum = pgEnum("payment_refund_status", [
  "pending",
  "completed",
  "failed",
]);

/**
 * ONE ROW PER PROVIDER REFUND RESOURCE.
 *
 * ONE PAYMENT HAS MANY REFUNDS. That is the entire reason this is a table and
 * not three columns on `payment_orders`: a $10 payment refunded $2, then $3,
 * then $5 is THREE `rf_` resources with three ids, three statuses and three
 * outcomes, and a design that could hold only "the refund" would represent the
 * last of them and silently lose the rest.
 *
 * WHAT IS DELIBERATELY ABSENT: any raw provider payload. There is no `payload`
 * or `raw` jsonb column. A refund payload carries buyer identity, card detail
 * and a nested copy of the payment, none of which the lifecycle or
 * reconciliation needs, and all of which would then have to be protected,
 * retained and deleted to a policy that does not exist. Every column below is
 * one this build actually reads.
 *
 * THIS TABLE IS OPERATIONAL, NOT FINANCIAL. It records where a refund stands
 * with the provider. The money is in `accounting_transactions` and nowhere
 * else, and the two are kept apart on purpose: this table is UPDATED as a
 * refund moves through its states, while the journal is append-only and cannot
 * be. A row here saying `completed` is a claim; the posting keyed
 * `whop:payment_refunded:<rf_id>` is the money.
 */
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    /** Server-generated. Never a provider id, and never client-supplied. */
    refundId: uuid("refund_id").primaryKey().defaultRandom(),

    /** "whop". A column rather than an assumption, so a second provider is a
     * row value and not a schema migration. */
    provider: text("provider").notNull().default("whop"),

    /**
     * THE ECONOMIC IDENTITY, prefixed `rf_`.
     * UNIQUE with `provider`: two webhook deliveries with different message
     * ids naming the same refund must converge on ONE row, and that has to be
     * a database constraint — an application check loses the race between two
     * concurrent deliveries.
     */
    whopRefundId: text("whop_refund_id").notNull(),

    /** The payment this refund reverses, prefixed `pay_`. NOT unique: one
     * payment legitimately has many refunds. */
    whopPaymentId: text("whop_payment_id").notNull(),

    /** The order that payment settled. Null only if the payment maps to none. */
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** Minor units, always positive. The amount RETURNED, in `currency`. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** Lowercase ISO 4217, matching how Whop reports a currency. */
    currency: char("currency", { length: 3 }).notNull(),

    /** Whop's own status verbatim: one of the five in `RefundStatuses`. Kept
     * raw so the reduction below never loses what the provider actually said. */
    providerStatus: text("provider_status").notNull(),
    /** Our three-value reduction of it. */
    status: paymentRefundStatusEnum("status").notNull().default("pending"),

    /** Whop's normalised `failure_reason`, when it reported one. */
    failureReason: text("failure_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set once, when the provider first reported `succeeded`. Never rewritten. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Set when the provider reported `failed` or `canceled`. */
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (t) => [
    // THE refund identity constraint. Everything about idempotency rests here.
    uniqueIndex("uniq_refunds_provider_refund").on(t.provider, t.whopRefundId),
    index("idx_refunds_payment").on(t.whopPaymentId),
    index("idx_refunds_order").on(t.orderId),
    index("idx_refunds_status").on(t.status),
    index("idx_refunds_created").on(t.createdAt),
  ],
);

/* --------------------------- dispute family ------------------------------ */

/**
 * Our five-value reduction of Whop's dispute vocabulary. See
 * `src/lib/server/dispute-lifecycle.ts` for why the nine provider statuses
 * become these five, and why `warning` is kept separate from `open` — an
 * inquiry moves no funds unless it escalates, and collapsing the two would
 * hide which disputes are actually at risk. The raw provider status is stored
 * alongside in `provider_status`.
 */
export const disputeStatusEnum = pgEnum("dispute_status", [
  "warning",
  "open",
  "won",
  "lost",
  "closed",
]);

/** Can a refund still avoid the chargeback? The only question an alert poses. */
export const disputeAlertStatusEnum = pgEnum("dispute_alert_status", [
  "actionable",
  "not_actionable",
]);

/** A Resolution Center case is open or it is closed; the outcome is separate. */
export const resolutionCaseStatusEnum = pgEnum("resolution_case_status", ["open", "closed"]);

/**
 * ONE ROW PER PROVIDER DISPUTE RESOURCE, keyed on the `dspt_` id.
 *
 * OPERATIONAL, NOT FINANCIAL. This records where a chargeback stands with the
 * processor. It holds no money: dispute economics live in
 * `accounting_transactions`, posted from the provider's own ledger feed, and
 * the two are reconciled against each other rather than one being derived from
 * the other.
 *
 * WHAT IS DELIBERATELY ABSENT. No evidence documents, no attachment contents,
 * no customer name, email or billing address, no card number or brand — the
 * dispute resource carries all of those and this build stores none of them.
 * They belong to the customer, they are not needed to run the lifecycle or to
 * reconcile the money, and storing them would create a retention and
 * protection obligation that does not otherwise exist. `reason` and
 * `reason_code` are kept because triage genuinely needs them.
 */
export const paymentDisputes = pgTable(
  "payment_disputes",
  {
    disputeId: uuid("dispute_id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("whop"),

    /** THE economic identity, prefixed `dspt_`. Unique with `provider`. */
    whopDisputeId: text("whop_dispute_id").notNull(),
    /** The payment being disputed, prefixed `pay_`. */
    whopPaymentId: text("whop_payment_id").notNull(),
    /** The order that payment settled, when it maps to one. */
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** Minor units. The amount under dispute, not necessarily money moved. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),

    /** Whop's status verbatim — one of the nine it can produce. */
    providerStatus: text("provider_status").notNull(),
    status: disputeStatusEnum("status").notNull().default("open"),

    /**
     * TRUE for a pre-dispute inquiry, which "moves no funds unless one
     * escalates". Stored because it changes what a `lost` means: an inquiry
     * that closes against us may have cost nothing at all.
     */
    inquiry: boolean("inquiry").notNull().default(false),
    /** Visa RDR settled it automatically by refunding the customer. */
    rapidDisputeResolution: boolean("rapid_dispute_resolution").notNull().default(false),

    reason: text("reason"),
    reasonCode: text("reason_code"),

    /** When evidence is due. Operational: it drives a deadline queue. */
    evidenceDueAt: timestamp("evidence_due_at", { withTimezone: true }),
    evidenceSubmittedAt: timestamp("evidence_submitted_at", { withTimezone: true }),

    /** When Whop says the dispute was opened, as distinct from when we saw it. */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /** The provider's own last-changed time, for staleness comparison. */
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    /** Set once, when the dispute first reached a resolved status. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_disputes_provider_dispute").on(t.provider, t.whopDisputeId),
    index("idx_disputes_payment").on(t.whopPaymentId),
    index("idx_disputes_order").on(t.orderId),
    index("idx_disputes_status").on(t.status),
    index("idx_disputes_evidence_due").on(t.evidenceDueAt),
  ],
);

/**
 * ONE ROW PER PROVIDER DISPUTE ALERT, keyed on the `dspa_` id.
 *
 * AN ALERT IS NOT A DISPUTE, and this is a separate table for exactly that
 * reason: one payment can carry an alert and then a dispute, and folding them
 * into one row would either lose the alert or double-count the chargeback.
 *
 * `whop_payment_id` IS NULLABLE HERE, unlike on a dispute. Whop documents the
 * field as "null when Whop could not match the report to a payment", and an
 * unmatched alert is a real state worth recording — it is precisely the one an
 * operator can do nothing about, and pretending it must have a payment would
 * mean discarding it.
 *
 * NOTHING HERE POSTS MONEY. `fee_charged` is a boolean with no amount anywhere
 * on the resource, so the fee — if there was one — is knowable only from the
 * provider's ledger feed, and that is what gets posted.
 */
export const disputeAlerts = pgTable(
  "dispute_alerts",
  {
    alertId: uuid("alert_id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("whop"),

    whopAlertId: text("whop_alert_id").notNull(),
    /** Nullable: an alert Whop could not match to a payment is still real. */
    whopPaymentId: text("whop_payment_id"),
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** What the ISSUER reported. Documented as possibly differing from the
     * payment's own amount, and never posted. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),

    /** `early_fraud_warning` | `dispute_alert` | `rapid_dispute_resolution`. */
    alertType: text("alert_type").notNull(),
    status: disputeAlertStatusEnum("status").notNull().default("not_actionable"),
    notActionableReason: text("not_actionable_reason"),

    /** Whether Whop charged a fee. A flag, never an amount — see the header. */
    feeCharged: boolean("fee_charged").notNull().default(false),

    /** When the issuer filed it, which precedes when Whop received it. */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_alerts_provider_alert").on(t.provider, t.whopAlertId),
    index("idx_alerts_payment").on(t.whopPaymentId),
    index("idx_alerts_order").on(t.orderId),
    index("idx_alerts_status").on(t.status),
  ],
);

/**
 * ONE ROW PER RESOLUTION CENTER CASE, keyed on the `reso_` id.
 *
 * A CASE IS NOT A REFUND AND NOT A DISPUTE. It is Whop's mediation process,
 * which may end in either — and when it does, Whop emits that real financial
 * resource separately, so the money belongs there. This table posts nothing.
 *
 * `refund_source` IS THE REASON THIS TABLE EXISTS. Whop documents it as
 * "whether money moved and off whose balance: none, merchant, or platform",
 * and explicitly "independent of outcome". Storing it lets reconciliation ask
 * the one question that matters: a case claiming `merchant` should have a real
 * refund or dispute in our books for the same payment, and one claiming
 * `platform` should NOT — that was Whop's money, not ours.
 */
export const resolutionCenterCases = pgTable(
  "resolution_center_cases",
  {
    caseId: uuid("case_id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("whop"),

    whopCaseId: text("whop_case_id").notNull(),
    whopPaymentId: text("whop_payment_id"),
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    environment: whopEnvironmentEnum("environment").notNull(),

    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),

    /** Whop's status verbatim: awaiting_merchant / awaiting_customer /
     * under_review / closed. */
    providerStatus: text("provider_status").notNull(),
    status: resolutionCaseStatusEnum("status").notNull().default("open"),

    /** `customer_won` | `merchant_won` | `withdrawn`, null while open. */
    outcome: text("outcome"),
    /** `none` | `merchant` | `platform`, null while open. See the header. */
    refundSource: text("refund_source"),
    reason: text("reason"),
    /** Whether Whop itself is involved in deciding the case. */
    escalated: boolean("escalated").notNull().default(false),

    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_cases_provider_case").on(t.provider, t.whopCaseId),
    index("idx_cases_payment").on(t.whopPaymentId),
    index("idx_cases_order").on(t.orderId),
    index("idx_cases_status").on(t.status),
  ],
);

/* ------------------------------- users ----------------------------------- */

/**
 * The role a person chose for themselves. `admin` is deliberately NOT here:
 * administrator status lives in a Firebase custom claim set out of band, and a
 * role a user can select must never be one that grants privilege.
 */
export const userRoleEnum = pgEnum("user_role", ["creator", "brand"]);

/**
 * Where an account stands in the ClipRewards approval process. See
 * `src/lib/server/user-lifecycle.ts` for why these six and no more.
 */
export const approvalStatusEnum = pgEnum("approval_status", [
  "onboarding",
  "pending_interview",
  "pending_review",
  "approved",
  "rejected",
  "needs_followup",
]);

/**
 * THE CANONICAL CLIPREWARDS USER.
 *
 * One row per Firebase account, keyed on the Firebase UID. This is the
 * application's identity record — `user_analytics` is NOT, and never becomes
 * one: that table is reporting attributes, deliberately holds no identity, and
 * overloading it with application state would put access decisions in a table
 * written by browser analytics.
 *
 * IDENTITY IS THE UID AND ONLY THE UID. There is no email column, no unique
 * index on an address, and no lookup by one anywhere in the codebase. Two
 * Google accounts sharing an address at different times are two users; one
 * account that changes address is still one user. Email is a display detail
 * Firebase already owns.
 *
 * NO CREDENTIAL IS STORED. No password, no Firebase ID token, no session
 * cookie, no refresh token. Firebase holds those; duplicating any of them here
 * would create a second place to leak them from.
 *
 * `role` IS NULLABLE ON PURPOSE. A user who has signed in but not yet chosen
 * is genuinely un-roled, and defaulting them to `creator` — as the admin
 * dashboard previously did when reading Firebase claims — invents a fact.
 * Unassigned is a state the product must be able to see and report.
 *
 * `approval_status` HAS EXACTLY ONE ADMIN WRITER. The three decision values
 * (`approved`, `rejected`, `needs_followup`) are set only by `decideUser`
 * behind `requireAdmin`; the three progress values are derived by the server
 * from facts it owns. No request body can set this column.
 */
export const users = pgTable(
  "users",
  {
    /** The Firebase UID. The canonical ClipRewards identity. */
    firebaseUid: text("firebase_uid").primaryKey(),

    /** Null until the person explicitly chooses. Never defaulted. */
    role: userRoleEnum("role"),

    /** Never `approved` on insert — signing in is not joining. */
    approvalStatus: approvalStatusEnum("approval_status").notNull().default("onboarding"),

    /** Set when the profile step is finished. Null while incomplete. */
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),

    /** Set once, by an admin approval. Never rewritten by a later re-approval. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Set when an admin rejects. Cleared if they later approve. */
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),

    /** Which admin decided, and when they last did. Audit support. */
    decidedByUid: text("decided_by_uid"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_users_status").on(t.approvalStatus),
    index("idx_users_role").on(t.role),
    index("idx_users_created").on(t.createdAt),
  ],
);

/**
 * The onboarding answers worth surviving a reload or a new device.
 *
 * A SEPARATE TABLE from `users`, because they answer different questions and
 * have different lifetimes: `users` decides access and is read on every
 * guarded request, while this is a form payload read only during onboarding
 * and admin review. Keeping them apart means the hot path does not carry a
 * bio and a photo URL.
 *
 * FIELDS MIRROR THE EXISTING WIZARD and nothing more — full name, bio,
 * languages, creator type, referral source, socials. The wizard previously
 * kept these in `localStorage` only, which is why signing in on a second
 * device restarted onboarding from scratch. No new profile schema is invented
 * here; this is the same data, made durable.
 */
export const userProfiles = pgTable(
  "user_profiles",
  {
    firebaseUid: text("firebase_uid")
      .primaryKey()
      .references(() => users.firebaseUid),

    /** Display name as typed. Not an identity, and not unique. */
    fullName: text("full_name"),
    bio: text("bio"),
    /** A URL Firebase or the user supplied. No image bytes are stored. */
    photoUrl: text("photo_url"),

    /** Chosen content languages, as stored by the wizard. */
    languages: jsonb("languages").$type<string[]>(),
    /** Creator-only: "Clipper", "UGC Face", and so on. */
    creatorType: text("creator_type"),
    /** How they heard about ClipRewards. */
    referralSource: text("referral_source"),
    /** Which social platforms they said they publish on. */
    socials: jsonb("socials").$type<string[]>(),

    /** Brand-only: the company they represent. */
    companyName: text("company_name"),
    /** Which onboarding step to return them to. */
    lastStep: integer("last_step").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Interview bookings.
 *
 * ONE LIVE BOOKING PER USER, enforced by a partial unique index rather than a
 * read: two rapid submissions must not produce two slots, and an application
 * check loses that race. Cancelled rows stay for history and are excluded from
 * the constraint.
 *
 * `scheduled_at` IS AN INSTANT, not a wall-clock time. The operating hours a
 * slot was drawn from live in configuration (see
 * `src/lib/server/interview-availability.ts`) and are applied when a slot is
 * offered and re-checked when it is booked — they are not re-derivable from
 * this column alone, which is why the timezone is configuration and not a
 * column.
 *
 * `meeting_url` IS ADMIN-WRITTEN AND NULLABLE. ClipRewards staff paste a
 * Google Meet link by hand for now. There is deliberately no Calendar or Meet
 * API integration in this build, and no user-facing writer for this column.
 */
/**
 * How far Google Calendar provisioning has got for a booking.
 *
 * SEPARATE FROM THE BOOKING'S OWN STATUS on purpose: a confirmed interview
 * whose Meet room could not be created is still a confirmed interview.
 */
export const calendarProvisioningStatusEnum = pgEnum("calendar_provisioning_status", [
  "pending",
  "ready",
  "failed",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
  "scheduled",
  "cancelled",
  "completed",
  "no_show",
]);

export const interviewBookings = pgTable(
  "interview_bookings",
  {
    bookingId: uuid("booking_id").primaryKey().defaultRandom(),

    /** Whose booking. Always taken from the verified session, never a body. */
    firebaseUid: text("firebase_uid")
      .notNull()
      .references(() => users.firebaseUid),

    /** The interview slot, as an absolute instant. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    /** Slot length in minutes, captured so a later config change cannot
     *  retroactively resize a booking that was already made. */
    durationMinutes: integer("duration_minutes").notNull(),

    status: bookingStatusEnum("status").notNull().default("scheduled"),

    /**
     * The Google Meet URL for this interview.
     *
     * REUSED, NOT REPLACED. It was previously pasted by staff; it is now
     * written by calendar provisioning from the event Google returns, and
     * staff may still set one. Every reader already understands this column,
     * so the applicant and admin surfaces needed no new field.
     */
    meetingUrl: text("meeting_url"),

    /* --- Google Calendar provisioning ---------------------------------- */

    /** The event id in the ClipRewards interview calendar. */
    googleCalendarEventId: text("google_calendar_event_id"),
    /**
     * Where provisioning got to. A BOOKING IS VALID IN EVERY ONE OF THESE
     * STATES: `failed` means Google could not be reached, not that the
     * interview is off, which is why it is a separate column from `status`.
     */
    calendarProvisioningStatus: calendarProvisioningStatusEnum(
      "calendar_provisioning_status",
    ).notNull().default("pending"),
    /** Attempts made, so a poison booking cannot be retried forever. */
    calendarRetryCount: integer("calendar_retry_count").notNull().default(0),
    /** A short, safe code — never a provider body, never a token. */
    lastCalendarErrorCode: text("last_calendar_error_code"),
    /** When provisioning last changed state. */
    calendarUpdatedAt: timestamp("calendar_updated_at", { withTimezone: true }),
    /** Staff notes from the conversation. Not shown to the applicant. */
    adminNotes: text("admin_notes"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // AT MOST ONE LIVE BOOKING PER USER. Partial, so cancelled history does
    // not collide and a user can rebook after cancelling.
    uniqueIndex("uniq_bookings_active_user")
      .on(t.firebaseUid)
      .where(sql`status = 'scheduled'`),
    // No two live interviews in the same slot, whoever booked them.
    uniqueIndex("uniq_bookings_active_slot")
      .on(t.scheduledAt)
      .where(sql`status = 'scheduled'`),
    index("idx_bookings_user").on(t.firebaseUid),
    index("idx_bookings_scheduled").on(t.scheduledAt),
    index("idx_bookings_status").on(t.status),
  ],
);

/* =========================================================================
   WHOP CONNECTED ACCOUNTS — the creator's financial container.

   SEPARATE FROM `whop_connections`, DELIBERATELY. That table is identity: who
   this ClipRewards user is on Whop, proved by OAuth, holding credentials that
   are revoked the moment they disconnect. THIS table is finance: an Account
   (`biz_…`) created under the ClipRewards platform account, which outlives a
   disconnect and must never be dropped by one. Merging them would mean an
   applicant unlinking their login silently discarded the account their money
   is owed into.

   ONE ROW PER CREATOR PER ENVIRONMENT. A sandbox `biz_` and a production
   `biz_` are different objects in different worlds, and the unique indexes are
   scoped accordingly so a sandbox row can never satisfy a production lookup or
   collide with one.

   WHAT IS DELIBERATELY ABSENT: no payout account id, no verification or KYC
   state, no capabilities, no balances, no transfers. Those live on other Whop
   resources and belong to later tasks; recording them here would imply this
   row knows things it has not been told.
   ========================================================================= */

export const whopAccounts = pgTable(
  "whop_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Whose account. The only identity, taken from a verified session. */
    firebaseUid: text("firebase_uid")
      .notNull()
      .references(() => users.firebaseUid),

    /** The Whop Account id, prefixed `biz_`. */
    whopAccountId: text("whop_account_id").notNull(),

    /** The Whop `sub` this was provisioned for, from the OAuth connection. */
    whopUserId: text("whop_user_id").notNull(),

    /**
     * The platform account it hangs from, read back from the provider
     * response. NOT NULL on purpose: an Account with no parent is a STANDALONE
     * company, not a connected account, and must never be recorded as one.
     */
    parentAccountId: text("parent_account_id").notNull(),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** `active` or `suspended`, as last reported. Null when not computed. */
    status: text("status"),
    /** Whatever onboarding the account has completed. Null until it has. */
    onboardingType: text("onboarding_type"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE connected account per creator, per environment. This is what makes a
    // double-clicked button, a retried request and a concurrent race all
    // resolve to the same row instead of two provisioned accounts.
    uniqueIndex("uniq_whop_account_user_env").on(t.firebaseUid, t.environment),
    // And one row per provider account, so the same `biz_` cannot be attached
    // to two ClipRewards users.
    uniqueIndex("uniq_whop_account_id_env").on(t.whopAccountId, t.environment),
    index("idx_whop_accounts_uid").on(t.firebaseUid),
    index("idx_whop_accounts_whop_user").on(t.whopUserId),
  ],
);

/* =========================================================================
   CREATOR EARNINGS — the operational record of what each creator has earned.

   SEPARATE FROM THE ACCOUNTING JOURNAL, AND DELIBERATELY SO.

   `accounting_entries` is the financial ledger — it records amounts with
   double-entry discipline, summing to zero. It answers "is the ledger
   balanced?" It does NOT answer "which creator can I pay and how much?" in
   a form that an application can query efficiently per-creator with hold
   logic applied.

   `creator_earnings` is the operational record that answers that question.
   ONE ROW PER EARNING EVENT (typically one brand payment → one creator share).
   The amounts here must match the corresponding journal entries; they are not
   derived independently.

   THE 6 STATES a creator's money moves through:
     held        — in hold window (refund period) or frozen by open dispute
     available   — hold expired and no dispute; ready to transfer
     transferred — a creator_transfer has been initiated for this earning
     reversed    — refunded, chargeback lost, or payout reversed

   EARNED (derived) = held + available + transferred (lifetime non-reversed)
   PENDING (UI)     = sum of held earnings
   AVAILABLE (UI)   = sum of available earnings
   TRANSFERRED (UI) = sum of transferred earnings

   WITHDRAWN is Whop's domain. We track "transferred" (money sent to Whop
   account); what happens between the Whop account and the creator's bank is
   managed by Whop's own payout schedule, which the creator controls via the
   payout portal (Task #12).

   THE HOLD POLICY:
     - A new earning is `held` for CREATOR_HOLD_DAYS (default 7) from
       payment settlement date. This covers the brand refund window.
     - If a dispute opens on the payment, the earning is frozen (`held` with
       `frozen_by_dispute = true`) until the dispute resolves — win or lose.
     - The `hold_until` column is authoritative; the application never
       promotes `held` → `available` without checking it.

   FEES:
     - Platform fee (PLATFORM_FEE_BPS, default 20%) is deducted from gross
       before `net_amount_minor` is recorded here.
     - Provider fees (Whop processor fees) are a PLATFORM EXPENSE — they do
       not reduce creator earnings. The creator's share is calculated on gross.
     - Tax is not posted here; it flows through `tax_payable` in the journal.
   ========================================================================= */

export const creatorEarningStatusEnum = pgEnum("creator_earning_status", [
  "held",
  "available",
  "transferred",
  "reversed",
]);

/**
 * ONE ROW PER EARNING EVENT.
 *
 * Amounts are BIGINT minor units, never float. `currency` is always present
 * so a row can never be ambiguous about what it measures.
 *
 * ACCOUNTING LINK: `accounting_transaction_id` points to the `revenue_split`
 * transaction in `accounting_transactions` that logged the same amounts. If
 * the two ever disagree, the journal is the authority.
 */
export const creatorEarnings = pgTable(
  "creator_earnings",
  {
    earningId: uuid("earning_id").primaryKey().defaultRandom(),

    firebaseUid: text("firebase_uid")
      .notNull()
      .references(() => users.firebaseUid),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** The Whop payment that triggered this earning. Idempotency anchor. */
    whopPaymentId: text("whop_payment_id").notNull(),

    /** The ClipRewards order the payment settled, when there is one. */
    orderId: uuid("order_id").references(() => paymentOrders.orderId),

    /** What the brand actually paid, before any fees. Minor units. */
    grossAmountMinor: bigint("gross_amount_minor", { mode: "bigint" }).notNull(),
    /** Platform fee taken (PLATFORM_FEE_BPS basis points of gross). */
    platformFeeMinor: bigint("platform_fee_minor", { mode: "bigint" }).notNull(),
    /** What the creator actually receives: gross - platformFee. */
    netAmountMinor: bigint("net_amount_minor", { mode: "bigint" }).notNull(),
    /** Lowercase ISO 4217. Currently always "usd". */
    currency: char("currency", { length: 3 }).notNull(),

    /** Platform fee rate applied, in basis points. Captured so a later rate change
     *  cannot retroactively alter the calculation for this row. */
    platformFeeBps: integer("platform_fee_bps").notNull(),

    status: creatorEarningStatusEnum("status").notNull().default("held"),

    /**
     * When this earning becomes payable, absent any dispute.
     * Set to payment settlement time + CREATOR_HOLD_DAYS.
     * The application must not promote to `available` before this.
     */
    holdUntil: timestamp("hold_until", { withTimezone: true }).notNull(),

    /**
     * TRUE when there is an open dispute on `whop_payment_id`.
     * Freezes the earning regardless of `hold_until`.
     * Cleared when the dispute resolves; reversal is separate.
     */
    frozenByDispute: boolean("frozen_by_dispute").notNull().default(false),

    /** The whop_dispute_id that froze this earning, for traceability. */
    frozenByDisputeId: text("frozen_by_dispute_id"),

    /**
     * The `creator_transfers.transfer_id` that claimed this earning.
     * Set when a transfer includes this earning.
     */
    transferId: uuid("transfer_id"),

    /** The journal entry that recorded the revenue split for this earning. */
    accountingTransactionId: uuid("accounting_transaction_id"),

    /** Short free-form label. e.g. "Campaign payout — Q3 UGC". */
    description: text("description"),

    /** When the payment settled (copied from the payment, for querying). */
    paymentSettledAt: timestamp("payment_settled_at", { withTimezone: true }),

    availableAt: timestamp("available_at", { withTimezone: true }),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE earning per creator per payment. A payment may appear once per creator.
    uniqueIndex("uniq_creator_earnings_payment_creator")
      .on(t.whopPaymentId, t.firebaseUid),
    index("idx_creator_earnings_uid").on(t.firebaseUid, t.status),
    index("idx_creator_earnings_payment").on(t.whopPaymentId),
    index("idx_creator_earnings_hold_until").on(t.holdUntil, t.status),
    index("idx_creator_earnings_created").on(t.createdAt),
    index("idx_creator_earnings_transfer").on(t.transferId),
  ],
);

/* =========================================================================
   CREATOR TRANSFERS — platform-initiated payouts to creator accounts.

   ONE TABLE FOR ALL CREATOR PAYOUT ATTEMPTS.

   This table is OPERATIONAL, not financial. It tracks where each transfer
   attempt stands with the provider. The money is in `accounting_transactions`
   and `accounting_entries` — this table is what lets us ask "did we try to
   send this, and what did Whop say?"

   KEY DESIGN DECISIONS:

   LEDGER FIRST: a row here is written BEFORE the Whop API call, with status
   `pending`. This means a crash between writing and calling leaves a row that
   is clearly not `submitted`, which a sweep can detect and alert on. It is
   better to have a stuck `pending` row than to have a transfer with no record.

   IDEMPOTENCY IS A DATABASE CONSTRAINT. `idempotency_key` is UNIQUE. Two
   concurrent threads attempting the same payout converge to one row — the
   winner commits; the loser gets a unique-constraint violation and must read
   the winner's row rather than proceeding. A read-then-check loses this race;
   a unique index does not.

   PROVIDER ID IS UNIQUE WHEN PRESENT. `provider_transfer_id` has a partial
   unique index covering non-null values, so the same Whop transfer cannot
   be recorded twice even if a webhook is delivered more than once.

   NEVER AUTO-RETRY. A failed transfer requires human review before a retry.
   A retry is safe (using the same idempotency key Whop received) but must be
   explicitly triggered by an administrator, not by the application.

   AMOUNTS ARE BIGINT MINOR UNITS, never float and never a JS number at rest.
   A currency column is always present, so a row can never be ambiguous about
   what it measures.
   ========================================================================= */

export const creatorTransferStatusEnum = pgEnum("creator_transfer_status", [
  /** Written to DB. Whop call not yet made (or in progress). */
  "pending",
  /** Whop accepted the call and returned a transfer id. Funds in transit. */
  "submitted",
  /** Provider confirmed funds reached the creator. Set by webhook. */
  "completed",
  /** Whop rejected the call, or a network error occurred. Never auto-retried. */
  "failed",
  /** Provider reversed the transfer after settlement. Rare; set by webhook. */
  "reversed",
]);

/**
 * ONE ROW PER TRANSFER ATTEMPT.
 *
 * APPEND-ONLY in the sense that amounts and parties are never changed. Status,
 * provider_transfer_id and timestamps are updated as the transfer progresses.
 * A reversal does NOT modify this row — it sets `status = reversed` and the
 * accounting journal carries a separate reversal entry.
 */
export const creatorTransfers = pgTable(
  "creator_transfers",
  {
    transferId: uuid("transfer_id").primaryKey().defaultRandom(),

    firebaseUid: text("firebase_uid")
      .notNull()
      .references(() => users.firebaseUid),

    /** The Whop `biz_` account the money goes to. */
    whopAccountId: text("whop_account_id").notNull(),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** Minor units of `currency`. 1000 = $10.00 USD. BIGINT — never float. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** Lowercase ISO 4217, always present. `usd` unless we expand later. */
    currency: char("currency", { length: 3 }).notNull(),

    status: creatorTransferStatusEnum("status").notNull().default("pending"),

    /**
     * THE IDEMPOTENCY KEY sent to Whop and enforced locally.
     * Unique so a duplicate insert is refused rather than a second row created.
     * Never changes after insert.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** Set when Whop returns a transfer id on the POST response. */
    providerTransferId: text("provider_transfer_id"),
    /** Short code when Whop rejects. Never a raw provider body. */
    failureReason: text("failure_reason"),

    /** What this transfer is for — audit + reconciliation. */
    purpose: text("purpose").notNull(),
    /** The campaign this payout belongs to, when applicable. */
    campaignId: text("campaign_id"),

    /**
     * The accounting transaction that debited `creator_payable` when this
     * transfer was initiated. Null only while the accounting write is in-flight.
     */
    accountingTransactionId: uuid("accounting_transaction_id"),

    /** The administrator who initiated this. All transfers are admin-initiated. */
    initiatedByUid: text("initiated_by_uid").notNull(),

    /** Set when Whop accepted the call. */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** Set by a `payout.sent` webhook confirming the funds moved. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE idempotency constraint — database-enforced, race-proof.
    uniqueIndex("uniq_creator_transfers_idempotency").on(t.idempotencyKey),
    // The provider id must be unique when it exists.
    uniqueIndex("uniq_creator_transfers_provider_id")
      .on(t.providerTransferId)
      .where(sql`provider_transfer_id is not null`),
    index("idx_creator_transfers_uid").on(t.firebaseUid),
    index("idx_creator_transfers_account").on(t.whopAccountId),
    index("idx_creator_transfers_status").on(t.status, t.createdAt),
    index("idx_creator_transfers_campaign").on(t.campaignId),
    index("idx_creator_transfers_created").on(t.createdAt),
  ],
);

/* =========================================================================
   CREATOR WITHDRAWALS — creator-requested payouts from their available balance.

   WITHDRAWAL vs TRANSFER:
     `creator_transfers` = the platform pushes money to a creator's Whop account.
       Admin-initiated. Happens after a withdrawal is approved.
     `creator_withdrawals` = a creator says "I want to withdraw $X of my balance."
       Creator-initiated. Creates a transfer when processed by admin.

   PARTIAL WITHDRAWAL:
     A creator may request any amount ≤ their available balance. We reserve
     whole earnings (FIFO) until the total covered ≥ requested amount. If the
     last reserved earning overshoots the requested amount, the overage is
     returned as a new earning row when the withdrawal completes or fails.

   CONCURRENCY PROTECTION:
     1. UNIQUE(firebase_uid) WHERE status is active — one active withdrawal per
        creator at a time. Prevents two simultaneous requests creating two rows.
     2. UNIQUE(earning_id) in `creator_withdrawal_earnings` — an earning can
        only be in one withdrawal at a time. Prevents the same earnings being
        reserved by two concurrent withdrawal requests racing.

   STATE MACHINE:
     requested     — created, balance reserved, payout account NOT yet verified
     eligible      — payout account verified; ready for admin to process
     processing    — admin triggered the Whop transfer call
     provider_pending — Whop accepted; funds in transit
     paid          — webhook confirms funds reached creator account
     failed        — Whop rejected or webhook failure
     canceled      — canceled before processing (creator or admin)
     reversed      — reversed by Whop after payment (rare)

   IDEMPOTENCY: withdrawal is created once per request; the UNIQUE index on
   (firebase_uid) WHERE active is the database-level guard, not a check-first.
   ========================================================================= */

export const creatorWithdrawalStatusEnum = pgEnum("creator_withdrawal_status", [
  "requested",
  "eligible",
  "processing",
  "provider_pending",
  "paid",
  "failed",
  "canceled",
  "reversed",
]);

/**
 * ONE ROW PER WITHDRAWAL REQUEST.
 *
 * OPERATIONAL, NOT FINANCIAL. Amounts and parties are immutable after insert.
 * Status, transfer link, and timestamps change as the request progresses.
 * Money lives in `accounting_transactions`; this table tracks lifecycle state.
 */
export const creatorWithdrawals = pgTable(
  "creator_withdrawals",
  {
    withdrawalId: uuid("withdrawal_id").primaryKey().defaultRandom(),

    firebaseUid: text("firebase_uid")
      .notNull()
      .references(() => users.firebaseUid),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** The amount the creator requested to withdraw. Minor units, always ≥ 1. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /**
     * The total of all reserved earnings — may be > amount_minor if the last
     * reserved earning overshoots. The difference is returned as a new earning
     * on completion or cancellation.
     */
    reservedAmountMinor: bigint("reserved_amount_minor", { mode: "bigint" }).notNull(),

    currency: char("currency", { length: 3 }).notNull(),

    status: creatorWithdrawalStatusEnum("status").notNull().default("requested"),

    /**
     * The creator_transfers row that was created when admin processed this.
     * Null until processing begins.
     */
    transferId: uuid("transfer_id").references(() => creatorTransfers.transferId),

    /** Why it failed, when Whop or the application set a reason. */
    failureReason: text("failure_reason"),

    /** Why it was canceled. */
    cancelReason: text("cancel_reason"),

    /** Who processed (admin uid), set when admin triggers the transfer. */
    processedByUid: text("processed_by_uid"),

    /** When the creator submitted the request. */
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    providerPendingAt: timestamp("provider_pending_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE ACTIVE WITHDRAWAL PER CREATOR. Prevents double-submission while one
    // is in flight. Terminal states (paid/failed/canceled/reversed) are excluded
    // so a creator can withdraw again after a previous request concludes.
    uniqueIndex("uniq_withdrawal_active_creator")
      .on(t.firebaseUid)
      .where(sql`status NOT IN ('paid', 'failed', 'canceled', 'reversed')`),
    index("idx_withdrawals_uid").on(t.firebaseUid, t.status),
    index("idx_withdrawals_status").on(t.status, t.createdAt),
    index("idx_withdrawals_transfer").on(t.transferId),
    index("idx_withdrawals_created").on(t.createdAt),
  ],
);

/**
 * JUNCTION TABLE: which earnings are reserved for which withdrawal.
 *
 * UNIQUE on `earning_id` is the concurrency guard: if two concurrent withdrawal
 * requests race to reserve the same earning, only one INSERT succeeds.
 *
 * An earning stays in this table until the withdrawal reaches a terminal state
 * (paid, failed, canceled, reversed). On failure or cancellation, rows are
 * deleted and earnings returned to `available`. On payment, rows stay as an
 * audit trail (earnings are marked `transferred`).
 */
export const creatorWithdrawalEarnings = pgTable(
  "creator_withdrawal_earnings",
  {
    withdrawalId: uuid("withdrawal_id")
      .notNull()
      .references(() => creatorWithdrawals.withdrawalId),
    earningId: uuid("earning_id")
      .notNull()
      .references(() => creatorEarnings.earningId),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE CONCURRENCY GUARD. An earning in one withdrawal cannot be in another.
    uniqueIndex("uniq_withdrawal_earning").on(t.earningId),
    index("idx_withdrawal_earnings_withdrawal").on(t.withdrawalId),
  ],
);

/* =========================================================================
   GOOGLE CALENDAR — the ClipRewards interview account's connection.

   AN INTERNAL INTEGRATION, NOT A USER'S ACCOUNT. This is one dedicated Google
   account that owns every interview event, connected once by an
   administrator. There is deliberately no `firebase_uid` column: tying it to
   a person would mean their leaving, or simply signing out, silently stopped
   the company's interviews from being scheduled.

   ONE ACTIVE CONNECTION PER ENVIRONMENT, enforced by a partial unique index.
   Reconnecting revokes the previous row rather than editing it, so the
   history of which account was in use, and when, survives.

   `whop_environment` IS REUSED AS THE ENVIRONMENT TYPE. It is the single
   deployment switch this application has — the same `WHOP_ENV` that decides
   every provider host — and minting a parallel enum with identical values
   would invite the two to disagree.

   TOKENS ARE CIPHERTEXT, under the Google-specific key. See `google-crypto`.
   ========================================================================= */

export const googleCalendarConnections = pgTable(
  "google_calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    environment: whopEnvironmentEnum("environment").notNull(),

    /** The connected Google account, when it can be learned safely. */
    accountEmail: text("account_email"),

    /** AES-256-GCM envelopes. The refresh token is the durable credential. */
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    accessTokenCiphertext: text("access_token_ciphertext"),
    /** When the access token stops working; refresh is driven from this. */
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),

    /** Exactly what Google granted, so a scope change is detectable. */
    scopes: text("scopes").notNull(),

    /** Which administrator connected it. Attribution, never authorization. */
    connectedByUid: text("connected_by_uid"),

    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    /** Set on disconnect or on a refresh Google refuses. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uniq_google_calendar_active_env")
      .on(t.environment)
      .where(sql`revoked_at is null`),
    index("idx_google_calendar_env").on(t.environment),
  ],
);

/* =========================================================================
   GOOGLE OAUTH STATES — one-time, expiring, exactly like the Whop flow.

   The callback arrives as a top-level redirect with no session of its own, so
   the row written when the flow started is what says it was legitimate. It is
   consumed by `DELETE … RETURNING`: a replay, an expiry and a forgery are all
   the same refusal.
   ========================================================================= */

export const googleOauthStates = pgTable(
  "google_oauth_states",
  {
    state: text("state").primaryKey(),
    /** The administrator who began the flow. Recorded, never trusted later. */
    adminUid: text("admin_uid").notNull(),
    environment: whopEnvironmentEnum("environment").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_google_oauth_states_expires").on(t.expiresAt)],
);
