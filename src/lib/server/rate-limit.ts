import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { rateLimitCounters } from "@/lib/db/schema";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the current window ends. Never negative, never zero. */
  retryAfterSeconds: number;
};

/** The fixed window, in milliseconds. One UTC hour. */
const WINDOW_MS = 3_600_000;

/**
 * How many proxy hops in front of this server may be trusted to have appended
 * an accurate `x-forwarded-for` entry.
 *
 * DEFAULT ZERO, MEANING TRUST NOTHING. `x-forwarded-for` is a request header
 * like any other: proxies APPEND to it, so the FIRST entry is whatever the
 * original client claimed and a direct caller controls it completely. Reading
 * that first entry as an identity — which this file used to do — gives an
 * attacker two things at once:
 *
 *   1. BYPASS: rotate the header and every request lands in a fresh bucket, so
 *      the limit bounds nothing.
 *   2. TARGETED LOCKOUT: send a victim's address and spend THEIR budget, so a
 *      login limit becomes a denial-of-service tool aimed at one person.
 *
 * The trustworthy entry is the one the innermost trusted proxy appended, which
 * is `hops` from the END — and how many proxies there are is a deployment fact
 * this code cannot discover. So it is configuration, it defaults to zero, and at
 * zero `clientIdentity` reports that it has no trustworthy identity rather than
 * inventing one. Set `TRUSTED_PROXY_HOPS` only to a number you can justify from
 * how the app is actually deployed.
 */
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

export type ClientIdentity = {
  /** The value to key a limit on. Never empty. */
  key: string;
  /**
   * False when the value came from a header the caller could have forged. A
   * limit keyed on an untrusted identity is a speed bump, not a boundary, and
   * callers that care should say so in their own comments.
   */
  trusted: boolean;
};

/**
 * Resolves a client identity for rate limiting, and says whether to trust it.
 *
 * `x-real-ip` is set by a proxy and is not part of the appended chain, so it is
 * preferred when present. Otherwise `x-forwarded-for` is read from the END,
 * skipping `TRUSTED_PROXY_HOPS - 1` entries, because that is where a trusted
 * proxy's own observation sits. With no trusted hops configured, nothing here is
 * trustworthy and the shared `"untrusted"` bucket is returned — a coarse global
 * guard that cannot be aimed at a particular victim, which an attacker-chosen
 * key can.
 */
export function clientIdentity(headers: Headers): ClientIdentity {
  const hops = trustedProxyHops();

  if (hops > 0) {
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return { key: realIp, trusted: true };

    const chain = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    // The entry the innermost trusted proxy appended.
    const candidate = chain[chain.length - hops];
    if (candidate) return { key: candidate, trusted: true };
  }

  /* NO TRUSTWORTHY IDENTITY. One shared bucket, deliberately: it still bounds
   * total unauthenticated volume, and unlike an attacker-supplied key it cannot
   * be pointed at someone else's budget. */
  return { key: "untrusted", trusted: false };
}

/**
 * The legacy helper, kept for call sites that only want a coarse bucket.
 *
 * @deprecated Prefer `clientIdentity`, which also reports whether the value can
 * be trusted. This returns the same key and drops that information.
 */
export function getClientIp(headers: Headers): string {
  return clientIdentity(headers).key;
}

/** Seconds remaining in the current fixed window. At least 1. */
export function windowRetryAfterSeconds(now: number = Date.now()): number {
  const elapsed = now % WINDOW_MS;
  return Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000));
}

/**
 * Returns a 429 Response ready to be returned from a route handler.
 *
 * `Retry-After` is the time until the window actually resets, not a flat hour.
 * A fixed 3600 told a client to wait an hour when the window had twelve seconds
 * left — honest about the limit, wrong about the wait, and the reason a retrying
 * client backs off far longer than it needs to.
 */
export function rateLimitResponse(retryAfterSeconds?: number): Response {
  const retryAfter = retryAfterSeconds ?? windowRetryAfterSeconds();
  return Response.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfter),
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * Window = 1 UTC hour. The counter is atomically incremented via UPSERT so
 * concurrent requests on separate connections never race.
 *
 * FAIL-SOFT, and that is safe here rather than merely convenient: every route
 * that guards money also needs this same database to read a balance or write a
 * row, so a database outage fails the operation itself. The limiter opening does
 * not open anything the outage has not already closed.
 *
 * Key format: "{action}:{identifier}"
 *   identifier = an authenticated uid wherever one exists, and only otherwise a
 *   client identity — see `clientIdentity` for why that is the weaker option.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  const retryAfterSeconds = windowRetryAfterSeconds();

  /* A KEY MUST IDENTIFY SOMETHING. An empty or whitespace key would put every
   * caller that produced one into a single bucket, so unrelated users would
   * exhaust each other's budget — and a caller whose identity resolution
   * silently returned "" would look rate-limited for no reason anyone could
   * trace. Refused loudly in the only way a pure function can: a distinct,
   * obviously-wrong bucket rather than a shared blank one. */
  const safeKey = key.trim() ? key.trim() : "__malformed_key__";

  const db = getDb();
  if (!db) return { ok: true, remaining: limit, retryAfterSeconds };

  try {
    const windowKey = Math.floor(Date.now() / WINDOW_MS).toString();
    const [row] = await db
      .insert(rateLimitCounters)
      .values({ key: safeKey, windowKey, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitCounters.key, rateLimitCounters.windowKey],
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .returning({ count: rateLimitCounters.count });

    const count = row?.count ?? 1;
    return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
  } catch {
    return { ok: true, remaining: 0, retryAfterSeconds };
  }
}
