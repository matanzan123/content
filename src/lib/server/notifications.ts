import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";
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
     produces the same key is a cheap no-op, not an error.
   ========================================================================== */

export type NotificationInput = {
  firebaseUid: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** Stable, writer-chosen key. Format: "{type}:{resource_id}[:{disambiguator}]" */
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
 * Returns the most recent notifications for a user, newest first.
 * `before` is an ISO timestamp for cursor-based pagination.
 */
export async function getNotifications(
  firebaseUid: string,
  options: { limit?: number; before?: Date } = {},
): Promise<Notification[]> {
  const db = getDb();
  if (!db) return [];

  const limit = Math.min(options.limit ?? 20, 100);

  try {
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
        options.before
          ? and(
              eq(notifications.firebaseUid, firebaseUid),
              lt(notifications.createdAt, options.before),
            )
          : eq(notifications.firebaseUid, firebaseUid),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      notificationId: r.notificationId,
      type: r.type,
      status: r.status,
      title: r.title,
      body: r.body,
      actionUrl: r.actionUrl,
      createdAt: r.createdAt,
      readAt: r.readAt,
    }));
  } catch {
    return [];
  }
}

/** Returns unread count capped at 99 (UI convention: "99+" badge). */
export async function getUnreadCount(firebaseUid: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;

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
    return Math.min(row?.n ?? 0, 99);
  } catch {
    return 0;
  }
}
