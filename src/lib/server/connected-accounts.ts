import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { whopAccounts } from "@/lib/db/schema";
import type { WhopEnvironmentName } from "./whop-payments";

/* ==========================================================================
   THE CREATOR'S CONNECTED ACCOUNT — storage side.

   ONE ROW PER CREATOR PER ENVIRONMENT, and the database says so. Every write
   here relies on `uniq_whop_account_user_env`: two simultaneous requests can
   both pass the pre-check and both attempt an insert, and exactly one wins.
   The loser does not error — it reads back the winner, so a double-clicked
   button and a retried request resolve to the same account.

   THIS TABLE IS NOT TOUCHED BY DISCONNECT. Unlinking a Whop identity clears
   credentials in `whop_connections`; the financial account survives, because
   money owed to a creator does not disappear when they sign out of an
   integration.
   ========================================================================== */

export type ConnectedAccount = {
  firebaseUid: string;
  whopAccountId: string;
  whopUserId: string;
  parentAccountId: string;
  environment: WhopEnvironmentName;
  status: string | null;
  onboardingType: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toAccount(row: typeof whopAccounts.$inferSelect): ConnectedAccount {
  return {
    firebaseUid: row.firebaseUid,
    whopAccountId: row.whopAccountId,
    whopUserId: row.whopUserId,
    parentAccountId: row.parentAccountId,
    environment: row.environment,
    status: row.status,
    onboardingType: row.onboardingType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The creator's account in one environment, or null.
 *
 * SCOPED BY ENVIRONMENT, always. A sandbox `biz_` must never answer a
 * production question: they are different objects at the provider, and a
 * lookup that ignored the environment would hand production code a test
 * account.
 */
export async function getConnectedAccount(
  firebaseUid: string,
  environment: WhopEnvironmentName,
): Promise<ConnectedAccount | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(whopAccounts)
    .where(and(eq(whopAccounts.firebaseUid, firebaseUid), eq(whopAccounts.environment, environment)));
  return row ? toAccount(row) : null;
}

export type RecordResult =
  | { ok: true; account: ConnectedAccount; created: boolean }
  | { ok: false; reason: "unconfigured" | "storage_error" };

/**
 * Records a connected account, idempotently.
 *
 * `on conflict do nothing … returning` is ONE statement, so two concurrent
 * callers cannot both insert: the unique index decides, and the loser reads
 * back the winner's row rather than failing. A `select` then `insert` could
 * not do this — both callers would see nothing and both would try.
 *
 * A REPEAT CALL CHANGES NOTHING. No column is updated on conflict, so this can
 * be called on every attempt without disturbing a row that already exists or
 * silently re-pointing a creator at a different provider account.
 */
export async function recordConnectedAccount(input: {
  firebaseUid: string;
  whopAccountId: string;
  whopUserId: string;
  parentAccountId: string;
  environment: WhopEnvironmentName;
  status: string | null;
  onboardingType: string | null;
}): Promise<RecordResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  try {
    const inserted = await db
      .insert(whopAccounts)
      .values({
        firebaseUid: input.firebaseUid,
        whopAccountId: input.whopAccountId,
        whopUserId: input.whopUserId,
        parentAccountId: input.parentAccountId,
        environment: input.environment,
        status: input.status,
        onboardingType: input.onboardingType,
      })
      .onConflictDoNothing({ target: [whopAccounts.firebaseUid, whopAccounts.environment] })
      .returning();

    if (inserted.length === 1) {
      return { ok: true, account: toAccount(inserted[0]), created: true };
    }

    // Lost the race, or already present. Either way the winner is the truth.
    const existing = await getConnectedAccount(input.firebaseUid, input.environment);
    if (!existing) return { ok: false, reason: "storage_error" };
    return { ok: true, account: existing, created: false };
  } catch {
    // A shape constraint or the second unique index rejected the row. The
    // caller is told it could not be stored rather than being handed a
    // half-truth about what exists at the provider.
    return { ok: false, reason: "storage_error" };
  }
}
