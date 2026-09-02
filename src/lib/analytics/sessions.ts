/* ==========================================================================
   SESSIONS AND ACTIVE USERS — what the numbers will actually mean.

   "Online now" is the metric most dashboards quietly lie about. This file
   fixes the vocabulary before any figure is rendered, so the UI can label
   honestly instead of implying a live socket that does not exist.
   ========================================================================== */

/**
 * A session is a run of activity from one browser tab, ended by inactivity.
 * 30 minutes is the long-standing web-analytics convention; it is written here
 * once so every report shares it.
 */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * What the product can honestly report today, and what it cannot.
 *
 * RECENTLY_ACTIVE is derivable from stored events: count the distinct sessions
 * whose last event landed inside the window. It is a lagging figure and the UI
 * must label it as such — "active in the last 5 minutes", never "online now".
 *
 * TRUE_REALTIME needs a persistent connection per visitor (WebSocket, SSE
 * heartbeat, or a presence service). None exists in this build. Until one
 * does, a live "327 online" counter would be fabricated.
 */
export const PRESENCE_MODEL = {
  RECENTLY_ACTIVE: {
    available: true,
    window_ms: 5 * 60 * 1000,
    definition:
      "Distinct sessions whose most recent event arrived within the window. Lagging by up to the window length.",
    honest_label_key: "admin.live.recentlyActive",
  },
  TRUE_REALTIME: {
    available: false,
    definition:
      "Visitors holding an open connection right now. Requires presence infrastructure (WebSocket/SSE heartbeat) that this build does not have.",
    blocked_by: "no persistent connection layer; no realtime datastore",
  },
} as const;

export type SessionRecord = {
  session_id: string;
  /** Null while the visitor is anonymous; set once a session is signed in. */
  user_id: string | null;
  started_at: string;
  last_seen_at: string;
  /** First path of the session — the entry page. */
  entry_path: string;
  /** Most recent path — becomes the exit page once the session ends. */
  last_path: string;
  page_view_count: number;
  country: string | null;
  device_category: "mobile" | "tablet" | "desktop" | "unknown";
  locale: "en" | "he";
  referrer_host: string | null;
  utm_source: string | null;
  /** True when no earlier session is known for this visitor. */
  is_new_visitor: boolean;
};

/**
 * Active-user counts are distinct signed-in user_ids over a window. Anonymous
 * sessions are counted separately as visitors — folding them together would
 * inflate DAU with every refresh from a logged-out browser.
 */
export const ACTIVE_USER_WINDOWS = {
  DAU: 24 * 60 * 60 * 1000,
  WAU: 7 * 24 * 60 * 60 * 1000,
  MAU: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Retention categories the model supports. Cohorts are computed from first-seen
 * dates on session records, so no separate retention table is needed.
 */
export type RetentionWindow = "d1" | "d7" | "d30";
