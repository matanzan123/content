import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { whopAccounts } from "@/lib/db/schema";
import { getWhopEnvironment, type WhopEnvironmentName } from "./whop-payments";

/* ==========================================================================
   CHILD ACCOUNT ROUTER — server only.

   Whop delivers ALL webhook events (platform and child accounts) to ONE
   platform-level endpoint. Child account events carry the child's `biz_`
   id as `company_id`, which differs from the platform `company_id`.

   This module resolves a `company_id` value to the creator it belongs to,
   so the webhook processor can allow child account events through rather
   than quarantining them as `rejected_company`.
   ========================================================================== */

export type ChildAccountContext = {
  firebaseUid: string;
  whopAccountId: string;
  environment: WhopEnvironmentName;
};

/**
 * Resolves a Whop `company_id` (a `biz_` prefix) to the creator who owns it.
 *
 * Returns null when:
 *   - the account is not in our database
 *   - the account belongs to a different environment
 *   - the database is unavailable
 *
 * In all null cases the caller should treat the event as `rejected_company`.
 */
export async function resolveChildAccount(companyId: string): Promise<ChildAccountContext | null> {
  const db = getDb();
  if (!db) return null;

  const environment = getWhopEnvironment();
  if (!environment) return null;

  const [row] = await db
    .select({
      firebaseUid: whopAccounts.firebaseUid,
      whopAccountId: whopAccounts.whopAccountId,
      environment: whopAccounts.environment,
    })
    .from(whopAccounts)
    .where(eq(whopAccounts.whopAccountId, companyId))
    .limit(1);

  if (!row) return null;

  // Reject cross-environment matches — a sandbox account must never process
  // production events and vice versa.
  if (row.environment !== environment) return null;

  return { firebaseUid: row.firebaseUid, whopAccountId: row.whopAccountId, environment };
}
