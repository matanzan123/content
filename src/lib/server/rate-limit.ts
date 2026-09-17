import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { rateLimitCounters } from "@/lib/db/schema";

export type RateLimitResult = { ok: boolean; remaining: number };

/**
 * Extracts the real client IP from Next.js request headers.
 * Priority: x-forwarded-for (first hop) → x-real-ip → "local".
 */
export function getClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() ?? "local";
}

/** Returns a 429 Response ready to be returned from a route handler. */
export function rateLimitResponse(): Response {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "retry-after": "3600", "cache-control": "no-store" } },
  );
}

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * Window = 1 UTC hour. The counter is atomically incremented via UPSERT so
 * concurrent requests on separate connections never race. Fail-soft: if the
 * DB is unavailable, always returns ok:true so a rate-limiter outage never
 * blocks legitimate traffic.
 *
 * Key format: "{route_slug}:{identifier}"
 *   identifier = client IP for unauthenticated endpoints, firebaseUid elsewhere.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  const db = getDb();
  if (!db) return { ok: true, remaining: limit };

  try {
    const windowKey = Math.floor(Date.now() / 3_600_000).toString();
    const [row] = await db
      .insert(rateLimitCounters)
      .values({ key, windowKey, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitCounters.key, rateLimitCounters.windowKey],
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .returning({ count: rateLimitCounters.count });

    const count = row?.count ?? 1;
    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    return { ok: true, remaining: 0 };
  }
}
