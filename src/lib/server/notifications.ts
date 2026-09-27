import "server-only";

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

/* ==========================================================================
   NOTIFICATION SERVICE — append-only, per-user, idempotent.

   WRITE CONTRACT:
     Every `writeNotification` call is a best-effort fire-and-forget.
     Callers must never await this in a way that propagates the failure
     upward — a missed notification must not fail the event that caused it.

   READ CONTRACT:
     Reads are always scoped to the requesting user's `firebaseUid`. There
     is no way to read another user's notifications through this module.

   DEDUPLICATION:
     The unique constraint on `idempotency_key` is the only deduplication
     mechanism. INSERT … ON CONFLICT DO NOTHING means a webhook retry that
     produces the same key is a cheap no-op, not an error. The key itself is
     built by `notification-triggers.ts`, which puts the ENVIRONMENT in it —
     see that file for why a provider resource id alone is not safe.

   UNAVAILABLE IS NOT EMPTY:
     A read that fails says so. These functions used to return `[]` and `0` on
     a database error, which no caller could tell from "this creator has
     nothing" — so an outage rendered as an empty inbox with a cleared badge,
     and the API reported `ok: true` alongside it.
   ========================================================================== */

/** The bound on one page, and the default. Exported so the route clamps to the
 *  SAME maximum rather than declaring a second one that could drift from it. */
export const NOTIFICATIONS_MAX_LIMIT = 100;
export const NOTIFICATIONS_DEFAULT_LIMIT = 20;

export type NotificationInput = {
  firebaseUid: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** Stable, writer-chosen key. Format: "{type}:{environment}:{resource_id}[:{disambiguator}]" */
  idempotencyKey: string;
};

export type Notification = {
  notificationId: string;
  type: string;
  status: "unread" | "read";
  title: string;
  body: string;
  actionUrl: string | null;
  createdAt: Date;
  readAt: Date | null;
};

/**
 * A pagination cursor. COMPOUND, because `created_at` is not unique.
 *
 * Paging on the timestamp alone loses rows: several triggers can write inside
 * one webhook handler and land on the same `created_at`, and a plain
 * `created_at < before` then skips every row sharing the boundary instant.
 * Carrying the id as a tiebreaker makes the order total and the boundary exact.
 */
export type NotificationCursor = { createdAt: Date; notificationId: string };

/** A page of notifications, or an explicit failure. Never a silent empty. */
export type NotificationPage =
  | { ok: true; items: Notification[]; nextCursor: NotificationCursor | null }
  | { ok: false; reason: "db_unavailable" };

/**
 * Inserts a notification row. Returns `{ ok: true, created: boolean }` where
 * `created: false` means the idempotency key already existed (duplicate — no
 * error, no double notification). Swallows all DB errors rather than throwing.
 */
export async function writeNotification(
  input: NotificationInput,
): Promise<{ ok: boolean; created: boolean }> {
  const db = getDb();
  if (!db) return { ok: false, created: false };

  try {
    const result = await db
      .insert(notifications)
      .values({
        firebaseUid: input.firebaseUid,
        type: input.type,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        metadata: input.metadata ?? null,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning({ notificationId: notifications.notificationId });

    return { ok: true, created: result.length > 0 };
  } catch {
    return { ok: false, created: false };
  }
}

/**
 * Marks one notification `read`. Scoped to `firebaseUid` — a user cannot
 * mark someone else's notification.
 *
 * IDEMPOTENT, and deliberately silent about what it matched. The `unread`
 * predicate means a second call updates nothing, and an id belonging to another
 * creator updates nothing either — while still answering `ok`, so the endpoint
 * never becomes a way to discover whether some other creator's id exists.
 */
export async function markRead(
  notificationId: string,
  firebaseUid: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  try {
    await db
      .update(notifications)
      .set({ status: "read", readAt: sql`now()` })
      .where(
        and(
          eq(notifications.notificationId, notificationId),
          eq(notifications.firebaseUid, firebaseUid),
          eq(notifications.status, "unread"),
        ),
      );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Marks ALL of a user's notifications `read`. Used by "mark all read" UI.
 */
export async function markAllRead(firebaseUid: string): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  try {
    await db
      .update(notifications)
      .set({ status: "read", readAt: sql`now()` })
      .where(
        and(
          eq(notifications.firebaseUid, firebaseUid),
          eq(notifications.status, "unread"),
        ),
      );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Clamps a requested page size into range.
 *
 * A negative or non-numeric limit used to pass straight through: `parseInt("-5")`
 * is `-5`, which is truthy, so the route's `|| 20` never fired and
 * `Math.min(-5, 100)` kept it. Postgres rejects `LIMIT -5`, the error was
 * swallowed, and the creator saw an empty inbox — an invalid request rendered as
 * "you have nothing".
 */
export function clampNotificationLimit(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return NOTIFICATIONS_DEFAULT_LIMIT;
  return Math.min(n, NOTIFICATIONS_MAX_LIMIT);
}

/**
 * Returns the most recent notifications for a user, newest first.
 *
 * Ordered by `(created_at, notification_id)` descending, which is a TOTAL order:
 * `created_at` alone is not unique, and without the tiebreaker two reads of the
 * same page could return the rows in different orders.
 */
export async function getNotifications(
  firebaseUid: string,
  options: { limit?: number; before?: NotificationCursor } = {},
): Promise<NotificationPage> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const limit = clampNotificationLimit(options.limit);
  const cursor = options.before;

  try {
    /* ONE ROW MORE THAN ASKED FOR, so the caller learns whether another page
     * exists without a second count query. The extra row is dropped below. */
    const rows = await db
      .select({
        notificationId: notifications.notificationId,
        type: notifications.type,
        status: notifications.status,
        title: notifications.title,
        body: notifications.body,
        actionUrl: notifications.actionUrl,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(
        cursor
          ? and(
              eq(notifications.firebaseUid, firebaseUid),
              /* THE COMPOUND BOUNDARY: strictly older, OR the same instant with a
               * smaller id. That is exactly "before this row" under the total
               * order below, which is what stops rows sharing a timestamp from
               * being skipped or repeated across pages.
               *
               * WRITTEN AS AN EXPLICIT `or`, not as a row comparison. A
               * `(timestamptz, uuid) < ($1, $2)` row constructor gives Postgres
               * nothing to infer the parameter types from, and the error it
               * raises is swallowed by the catch below — so the whole page came
               * back as "unavailable" and paging silently stopped after one page.
               * Two plain comparisons each infer from their own column. */
              or(
                lt(notifications.createdAt, cursor.createdAt),
                and(
                  eq(notifications.createdAt, cursor.createdAt),
                  lt(notifications.notificationId, cursor.notificationId),
                ),
              ),
            )
          : eq(notifications.firebaseUid, firebaseUid),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.notificationId))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? { createdAt: last.createdAt, notificationId: last.notificationId }
        : null;

    return {
      ok: true,
      items: page.map((r) => ({
        notificationId: r.notificationId,
        type: r.type,
        status: r.status,
        title: r.title,
        body: r.body,
        actionUrl: r.actionUrl,
        createdAt: r.createdAt,
        readAt: r.readAt,
      })),
      nextCursor,
    };
  } catch {
    return { ok: false, reason: "db_unavailable" };
  }
}

/**
 * The creator's unread count, or `null` when it could not be read.
 *
 * NULL IS NOT ZERO. This returned `0` on a database error, so an outage looked
 * like a fully-read inbox and the badge a creator relies on to notice a failed
 * payout quietly disappeared. The "99+" cap belongs to the badge, not to the
 * count, so the true number is returned and the presentation abbreviates it.
 */
export async function getUnreadCount(firebaseUid: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.firebaseUid, firebaseUid),
          eq(notifications.status, "unread"),
        ),
      );
    if (!row) return null;
    return row.n;
  } catch {
    return null;
  }
}
