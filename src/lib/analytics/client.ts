"use client";

import {
  INSTRUMENTED_EVENTS,
  queryLengthBucket,
  type EventName,
  type Metadata,
} from "./schema";

/* ==========================================================================
   BROWSER EVENT EMITTER

   Deliberately small. It sends a name, a path, a locale, a rotating session id
   and a narrow metadata object — nothing else. It has no access to form state
   and cannot be handed one: `track()` accepts only the typed `Metadata` shape,
   so passing an event object or a form snapshot is a type error rather than a
   privacy incident.

   The session id lives in sessionStorage, so it dies with the tab. It is not a
   durable cross-visit identifier and is not shared with anyone.
   ========================================================================== */

const SESSION_KEY = "cr-analytics-session";
const VISITOR_KEY = "cr-analytics-visitor";
const ENDPOINT = "/api/analytics/collect";

function sessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    // Private mode or blocked storage: still emit, just without continuity.
    return "ephemeral-00000000";
  }
}

/**
 * First-party visitor id.
 *
 * Purpose: distinguish a returning browser from a new one, so "new vs
 * returning" is a real figure. Storage: localStorage on this site's origin
 * only. Lifetime: until the visitor clears site data. It is a random UUID —
 * NOT derived from IP, device characteristics or any fingerprint — and is
 * never shared with a third party. It identifies a browser, not a person, so
 * the Privacy Policy calls it pseudonymous rather than anonymous.
 */
function visitorId(): { id: string | null; isNew: boolean } {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return { id: existing, isNew: false };
    const id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
    return { id, isNew: true };
  } catch {
    // Blocked storage: still emit, just without new-vs-returning resolution.
    return { id: null, isNew: false };
  }
}

function currentLocale(): "en" | "he" {
  return document.documentElement.lang === "he" ? "he" : "en";
}

/**
 * Where this visit came from, sent ONCE per session.
 *
 * The beacon's own `Referer` header is useless for this: it names the
 * ClipRewards page that fired the request, so every session would be
 * attributed to ClipRewards itself. `document.referrer` is the only place the
 * true external source survives, and it survives only on the landing page — an
 * internal navigation replaces it with one of our own URLs.
 *
 * Sent on `session_started` alone, so no mid-session event can overwrite
 * first-touch attribution. The value is read in the same tick and never
 * written to localStorage or sessionStorage; the full URL lives in this one
 * request body and nowhere else, and the server reduces it to a hostname
 * before anything is stored.
 */
function sessionReferrer(name: EventName): string | undefined {
  if (name !== "session_started") return undefined;
  try {
    return document.referrer || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fire-and-forget. `sendBeacon` survives a navigation, which matters for the
 * click that takes the visitor away from the page. Analytics must never block
 * or delay a user action, so every failure is swallowed.
 */
export function track(name: EventName, metadata?: Metadata): void {
  if (typeof window === "undefined") return;
  if (!INSTRUMENTED_EVENTS.has(name)) return;

  const visitor = visitorId();
  const payload = JSON.stringify({
    name,
    occurred_at: new Date().toISOString(),
    session_id: sessionId(),
    visitor_id: visitor.id,
    is_new_visitor: visitor.isNew,
    locale: currentLocale(),
    path: window.location.pathname,
    referrer: sessionReferrer(name),
    metadata,
  });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let instrumentation break a page.
  }
}

/** Records that a search happened and how it performed — never what was typed. */
export function trackSearch(
  name: Extract<EventName, "discover_searched" | "faq_searched">,
  query: string,
  resultCount: number,
): void {
  track(name, { query_length: queryLengthBucket(query), result_count: resultCount });
}
