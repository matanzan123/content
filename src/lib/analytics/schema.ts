/* ==========================================================================
   ANALYTICS EVENT SCHEMA — first-party, no third-party trackers.

   Two rules shape this file.

   1. The event name set is CLOSED. Adding an event means adding it here, which
      is what stops the metadata object from turning into a dumping ground and
      what lets the collector reject anything it does not recognise.

   2. Only flows that EXIST are listed under INSTRUMENTED_EVENTS. The rest are
      declared so the schema is stable when those features ship, but emitting
      one today would be inventing data.

   Nothing in this file may carry personal content. See `Metadata` below.
   ========================================================================== */

/** Every event the product will ever emit, including ones not yet wired. */
export const EVENT_NAMES = [
  // --- session and navigation (instrumented) ---
  "session_started",
  "page_view",
  "language_changed",
  "creator_brand_mode_changed",
  "cta_clicked",

  // --- discover (instrumented) ---
  "discover_searched",
  "discover_filter_changed",

  // --- faq (instrumented) ---
  "faq_searched",

  // --- auth (partly instrumented) ---
  "login_started",
  "login_completed",
  "logout",

  // --- creator onboarding (instrumented) ---
  "creator_signup_started",
  "creator_onboarding_step_completed",
  "creator_signup_completed",
  "social_connect_clicked",

  // --- brand contact (instrumented) ---
  "brand_page_viewed",
  "launch_campaign_clicked",
  "brand_form_started",
  "brand_form_submitted",

  // --- declared, NOT instrumented: the features do not exist yet ---
  "campaign_viewed",
  "campaign_join_clicked",
  "social_connected",
  "campaign_created",
  "campaign_launched",
  "submission_created",
  "submission_approved",
  "submission_rejected",
  "payment_started",
  "payment_completed",
  "payment_failed",
  "payout_created",
  "payout_completed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * The subset actually emitted today. The collector accepts only these, so a
 * stale build or a crafted request cannot inject events for flows that have
 * never run.
 */
export const INSTRUMENTED_EVENTS = new Set<EventName>([
  "session_started",
  "page_view",
  "language_changed",
  "creator_brand_mode_changed",
  "cta_clicked",
  "discover_searched",
  "discover_filter_changed",
  "faq_searched",
  "login_started",
  "login_completed",
  "logout",
  "creator_signup_started",
  "creator_onboarding_step_completed",
  "creator_signup_completed",
  "social_connect_clicked",
  "brand_page_viewed",
  "launch_campaign_clicked",
  "brand_form_started",
  "brand_form_submitted",
]);

export type UserType = "anonymous" | "creator" | "brand" | "admin";
export type DeviceCategory = "mobile" | "tablet" | "desktop" | "unknown";

/**
 * Metadata is a narrow allow-list, not an open object.
 *
 * Note what is absent and must stay absent: search text, form field values,
 * names, emails, bios, URLs the visitor typed, and any token. Where a search
 * matters we record its SHAPE — how long it was, how many results it returned
 * — which answers "is search working" without keeping what anyone looked for.
 */
export type Metadata = {
  /** Stable identifier of a CTA, e.g. "hero_primary". Never free text. */
  cta_id?: string;
  /** Which realm the visitor switched to. */
  mode?: "creator" | "brand";
  /** Locale switched to. */
  to_locale?: "en" | "he";
  /** Which filter changed, from a closed set. */
  filter?: "status" | "category" | "content" | "platform";
  /** Whether a filter was set or cleared — not the value chosen. */
  filter_action?: "set" | "cleared";
  /** Length bucket of a query. Deliberately not the query itself. */
  query_length?: "empty" | "short" | "medium" | "long";
  /** How many results the query produced. */
  result_count?: number;
  /** Onboarding step index, 1-based. */
  step?: number;
  /** Social platform a connect button was pressed for. */
  platform?: "youtube" | "tiktok" | "instagram" | "x" | "facebook" | "whop";
  /** Outcome of an attempted action, from a closed set. */
  outcome?: "success" | "failure" | "cancelled";
  /** Campaign the event refers to, when one applies. */
  campaign_id?: string;
};

/** Buckets a query length so the text never leaves the browser. */
export function queryLengthBucket(query: string): NonNullable<Metadata["query_length"]> {
  const n = query.trim().length;
  if (n === 0) return "empty";
  if (n <= 3) return "short";
  if (n <= 12) return "medium";
  return "long";
}

/** What the browser sends. Everything else is derived server-side. */
export type ClientEvent = {
  name: EventName;
  /** Client clock, used only to order events within a session. */
  occurred_at: string;
  /** Rotating per-tab identifier. Not a durable cross-site ID. */
  session_id: string;
  /**
   * First-party visitor id: a random UUID in localStorage, used only to tell a
   * returning browser from a new one. It is NOT derived from an IP, a device
   * or any fingerprint, is never sent to a third party, and identifies a
   * browser rather than a person — so it is pseudonymous, not anonymous.
   */
  visitor_id: string | null;
  locale: "en" | "he";
  path: string;
  metadata?: Metadata;
};

/**
 * The stored record. Fields the browser cannot be trusted with — country,
 * device, referrer host, user identity — are filled in on the server.
 */
export type AnalyticsEvent = ClientEvent & {
  event_id: string;
  /** Server clock. This is the one used for reporting. */
  received_at: string;
  /** True when the browser had no visitor id before this session. */
  is_new_visitor: boolean;
  visitor_id: string | null;
  /** Firebase uid when the request carries a verified session, else null. */
  user_id: string | null;
  user_type: UserType;
  /** ISO 3166-1 alpha-2, from a trusted platform header. Null when unknown. */
  country: string | null;
  region: string | null;
  device_category: DeviceCategory;
  /** Browser family only — never the full user-agent string. */
  browser_family: string | null;
  /** Referrer HOST only. The full URL can carry personal data in its query. */
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}
