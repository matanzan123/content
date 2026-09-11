import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { adminAuditLog } from "@/lib/db/schema";

/* ==========================================================================
   ADMIN AUDIT WRITER — the first real writer of `admin_audit_log`.

   `src/lib/admin/audit.ts` has defined the shape since the analytics build and
   says plainly that "no records are written yet". Approving or rejecting an
   applicant is the first privileged action that genuinely changes someone's
   standing, so it is the right thing to make the trail real for.

   THE TRAIL RECORDS WHAT CHANGED, NOT THE WHOLE RECORD. An approval logs the
   decision, the prior status and the target uid — never a profile, never an
   email address belonging to the applicant, never anything that would make the
   audit log a second copy of the user table.

   `action` IS A TEXT COLUMN, so these values need no migration. The names are
   added to `AUDIT_ACTIONS` in the data model file so the vocabulary stays in
   one place.

   A FAILED WRITE NEVER FAILS THE ACTION. An audit row is evidence, and losing
   the evidence must not roll back a decision an administrator has made and
   been told succeeded — that would be worse for the applicant and for the
   trail. Failures are logged and reported to the caller, which is what lets
   the review endpoint tell the operator the decision stood but was not logged.
   ========================================================================== */

export type AuditWrite = {
  adminUid: string;
  /** Snapshot at the time, so a later read needs no live lookup. */
  adminEmail: string | null;
  action: string;
  targetType: "user";
  targetId: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export async function writeAudit(entry: AuditWrite): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  try {
    await db.insert(adminAuditLog).values({
      adminUid: entry.adminUid,
      adminEmailAtTime: entry.adminEmail,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? null,
      createdAt: sql`now()`,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
