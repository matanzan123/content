import "server-only";

import type { AnalyticsEvent } from "./schema";

/* ==========================================================================
   EVENT SINK — where a validated event goes.

   There is no database in this build, so there is nowhere durable to put an
   event. Rather than inventing a store, the sink is an explicit seam with one
   implementation: a development logger. Production is a deliberate no-op, so
   nothing is silently half-collected and no figure can be built on partial
   data that nobody knows is partial.

   Wiring a real store means implementing `EventSink` once, here. Nothing else
   changes. See ANALYTICS_STATUS for what that unblocks.
   ========================================================================== */

export interface EventSink {
  readonly name: string;
  readonly durable: boolean;
  write(event: AnalyticsEvent): Promise<void>;
}

/** Ring buffer so `/api/analytics/debug` can show recent events in dev. */
const RECENT_LIMIT = 200;
const recent: AnalyticsEvent[] = [];

const devSink: EventSink = {
  name: "dev-memory",
  durable: false,
  async write(event) {
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();
    console.log(
      `[analytics] ${event.name} ${event.path} ${event.locale} ${event.country ?? "??"}`,
      event.metadata ?? {},
    );
  },
};

/**
 * Production writes nowhere on purpose. Returning a no-op that reports
 * `durable: false` is what lets the admin surface say "collection is not
 * enabled" truthfully instead of showing an empty chart that looks like zero
 * traffic.
 */
const noopSink: EventSink = {
  name: "none",
  durable: false,
  async write() {},
};

export function getEventSink(): EventSink {
  return process.env.NODE_ENV === "development" ? devSink : noopSink;
}

/** Dev only. The debug route refuses to serve outside development. */
export function readRecentEvents(): AnalyticsEvent[] {
  return process.env.NODE_ENV === "development" ? [...recent].reverse() : [];
}

/**
 * The honest state of analytics, surfaced to the admin shell so the dashboard
 * never implies it has data it does not have.
 */
export const ANALYTICS_STATUS = {
  collecting: process.env.NODE_ENV === "development",
  durable: false,
  blocked_by: [
    "No database is provisioned — see the storage recommendation in the pass report.",
    "The Privacy Policy currently states that this build contains no analytics SDK and no tracking. It must be updated before collection is enabled in production.",
  ],
} as const;
