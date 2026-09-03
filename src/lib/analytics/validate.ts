import {
  INSTRUMENTED_EVENTS,
  isEventName,
  type ClientEvent,
  type Metadata,
} from "./schema";

/* ==========================================================================
   COLLECTOR VALIDATION

   Extracted from the route so it can be tested directly. This is the boundary
   that decides what is allowed to reach the database, and the most important
   privacy guarantee in the system lives here: metadata is REBUILT field by
   field from an allow-list, so a key the schema does not know about cannot
   survive no matter what a browser sends.
   ========================================================================== */

export const MAX_BODY_BYTES = 4096;
export const MAX_BATCH = 20;

/** Rebuilds metadata field by field. Unknown keys never survive. */
export function sanitiseMetadata(raw: unknown): Metadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: Metadata = {};

  const str = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

  if (typeof input.cta_id === "string" && /^[a-z0-9_]{1,48}$/.test(input.cta_id)) {
    out.cta_id = input.cta_id;
  }
  out.mode = str(input.mode, ["creator", "brand"] as const);
  out.to_locale = str(input.to_locale, ["en", "he"] as const);
  out.filter = str(input.filter, ["status", "category", "content", "platform"] as const);
  out.filter_action = str(input.filter_action, ["set", "cleared"] as const);
  out.query_length = str(input.query_length, ["empty", "short", "medium", "long"] as const);
  out.outcome = str(input.outcome, ["success", "failure", "cancelled"] as const);
  out.platform = str(input.platform, [
    "youtube",
    "tiktok",
    "instagram",
    "x",
    "facebook",
    "whop",
  ] as const);

  if (typeof input.result_count === "number" && Number.isInteger(input.result_count)) {
    out.result_count = Math.max(0, Math.min(input.result_count, 100_000));
  }
  if (typeof input.step === "number" && Number.isInteger(input.step)) {
    out.step = Math.max(1, Math.min(input.step, 20));
  }
  if (typeof input.campaign_id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(input.campaign_id)) {
    out.campaign_id = input.campaign_id;
  }

  for (const key of Object.keys(out) as (keyof Metadata)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reduces a referring URL to its HOSTNAME, or null.
 *
 * A referring URL's path, query and fragment can carry someone else's personal
 * data — a search term, an email in a link — and we have no use for any of it.
 * Reduction happens here, at the boundary, so the full URL never reaches
 * enrichment, storage or a report. Credentials in a `user:pass@host` URL are
 * discarded by the same step, because `URL.hostname` excludes them.
 *
 * Anything unparseable is null rather than a guess: an unattributed session is
 * correct, an invented source is not.
 */
export function referrerHost(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

export function parseEvent(raw: unknown): ClientEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;

  if (!isEventName(input.name) || !INSTRUMENTED_EVENTS.has(input.name)) return null;
  if (input.locale !== "en" && input.locale !== "he") return null;
  if (typeof input.session_id !== "string" || !/^[a-z0-9-]{8,64}$/.test(input.session_id)) {
    return null;
  }
  // Path only — a full URL could carry a query string with personal data.
  if (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.length > 512) {
    return null;
  }
  const occurredAt =
    typeof input.occurred_at === "string" && !Number.isNaN(Date.parse(input.occurred_at))
      ? input.occurred_at
      : new Date().toISOString();

  const visitorId =
    typeof input.visitor_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.visitor_id)
      ? input.visitor_id
      : null;

  // First-touch attribution is a property of the SESSION, so the referrer is
  // read from the one event that opens it. Accepting it on a later event would
  // let an internal page overwrite where the visitor actually came from.
  const referrer = input.name === "session_started" ? referrerHost(input.referrer) : null;

  return {
    name: input.name,
    occurred_at: occurredAt,
    session_id: input.session_id,
    visitor_id: visitorId,
    locale: input.locale,
    path: input.path.split("?")[0],
    referrer_host: referrer,
    metadata: sanitiseMetadata(input.metadata),
  };
}
