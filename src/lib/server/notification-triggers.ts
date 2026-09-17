import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { creatorEarnings, creatorTransfers, whopAccounts } from "@/lib/db/schema";
import { writeNotification } from "./notifications";

/* ==========================================================================
   NOTIFICATION TRIGGERS — maps lifecycle events to notification payloads.

   ISOLATION RULE: This file does DB lookups to resolve the `firebaseUid`, but
   it NEVER writes anything outside of `writeNotification`. Any write failure
   is swallowed. Callers must wrap these functions in a .catch(() => {}) to
   prevent a notification failure from propagating to the calling handler.

   DEDUPLICATION: Every trigger builds a stable idempotency key. A webhook
   retry that reaches the same event produces the same key → ON CONFLICT
   DO NOTHING → exactly one notification per event.

   KEY SCHEMA: "{type}:{resource_id}[:{state_discriminator}]"
   ========================================================================== */

/* --------------------------------------------------------------------------
   ACCOUNT / KYC
   -------------------------------------------------------------------------- */

/**
 * Maps a raw Whop account `status` string to a KYC state bucket.
 * Mirrors the logic in `whop-kyc.ts::classifyKycState` but does not require
 * `required_actions` (which are not in the `account.updated` payload).
 */
function classifyAccountStatus(status: string): "verified" | "action_required" | "restricted" | "other" {
  const s = status.toLowerCase();
  if (s === "active") return "verified";
  if (s === "restricted") return "restricted";
  if (s === "pending" || s === "unverified" || s === "not_started") return "action_required";
  return "other";
}

/**
 * Fires after a successful `account.updated` webhook.
 * Resolves the `firebaseUid` from `whop_accounts`, then emits the
 * appropriate KYC/payout notification.
 */
export async function notifyAccountUpdated(
  whopAccountId: string,
  environment: string,
  newStatus: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: whopAccounts.firebaseUid })
      .from(whopAccounts)
      .where(and(eq(whopAccounts.whopAccountId, whopAccountId), eq(whopAccounts.environment as never, environment as never)))
      .limit(1);
    firebaseUid = row?.firebaseUid;
  } catch {
    return;
  }

  if (!firebaseUid) return;

  const state = classifyAccountStatus(newStatus);

  if (state === "verified") {
    await writeNotification({
      firebaseUid,
      type: "kyc_approved",
      title: "Identity verified",
      body: "Your account is verified. You can now receive payouts.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: `kyc_approved:${whopAccountId}`,
    });
  } else if (state === "restricted") {
    await writeNotification({
      firebaseUid,
      type: "kyc_rejected",
      title: "Payout account restricted",
      body: "Your payout account has been restricted. Contact support for help.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: `kyc_rejected:${whopAccountId}`,
    });
  } else if (state === "action_required") {
    await writeNotification({
      firebaseUid,
      type: "kyc_required",
      title: "Action required: complete verification",
      body: "Your payout account needs additional information before you can receive funds.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: `kyc_required:${whopAccountId}:${newStatus}`,
    });
  }
}

/* --------------------------------------------------------------------------
   PAYMENT / EARNINGS
   -------------------------------------------------------------------------- */

/**
 * Fires after a successful `payment.succeeded` webhook.
 * Looks up the creator earning for this payment and notifies them that
 * funds are being held pending the release window.
 */
export async function notifyPaymentSettled(whopPaymentId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorEarnings.firebaseUid })
      .from(creatorEarnings)
      .where(eq(creatorEarnings.whopPaymentId, whopPaymentId))
      .limit(1);
    firebaseUid = row?.firebaseUid;
  } catch {
    return;
  }

  if (!firebaseUid) return;

  await writeNotification({
    firebaseUid,
    type: "earnings_held",
    title: "New earnings",
    body: "A payment has been received. Your share will be released after the hold period.",
    actionUrl: "/dashboard/earnings",
    idempotencyKey: `earnings_held:${whopPaymentId}`,
  });
}

/* --------------------------------------------------------------------------
   PAYOUTS
   -------------------------------------------------------------------------- */

/**
 * Fires after `payout.updated` is processed as completed.
 */
export async function notifyPayoutCompleted(
  providerTransferId: string,
  succeeded: boolean,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorTransfers.firebaseUid })
      .from(creatorTransfers)
      .where(eq(creatorTransfers.providerTransferId, providerTransferId))
      .limit(1);
    firebaseUid = row?.firebaseUid;
  } catch {
    return;
  }

  if (!firebaseUid) return;

  if (succeeded) {
    await writeNotification({
      firebaseUid,
      type: "payout_succeeded",
      title: "Payout sent",
      body: "Your payout has been sent and should arrive shortly.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: `payout_succeeded:${providerTransferId}`,
    });
  } else {
    await writeNotification({
      firebaseUid,
      type: "payout_failed",
      title: "Payout failed",
      body: "Your payout could not be completed. Check your payout account settings.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: `payout_failed:${providerTransferId}`,
    });
  }
}

/**
 * Fires after `payout.reversed` is processed.
 */
export async function notifyPayoutReversed(providerTransferId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorTransfers.firebaseUid })
      .from(creatorTransfers)
      .where(eq(creatorTransfers.providerTransferId, providerTransferId))
      .limit(1);
    firebaseUid = row?.firebaseUid;
  } catch {
    return;
  }

  if (!firebaseUid) return;

  await writeNotification({
    firebaseUid,
    type: "payout_reversed",
    title: "Payout reversed",
    body: "A previous payout was reversed. Please check your payout account.",
    actionUrl: "/dashboard/payouts",
    idempotencyKey: `payout_reversed:${providerTransferId}`,
  });
}

/* --------------------------------------------------------------------------
   DISPUTES
   -------------------------------------------------------------------------- */

/**
 * Fires when a dispute is opened for a payment that a creator earned from.
 */
export async function notifyDisputeOpened(whopPaymentId: string, whopDisputeId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorEarnings.firebaseUid })
      .from(creatorEarnings)
      .where(eq(creatorEarnings.whopPaymentId, whopPaymentId))
      .limit(1);
    firebaseUid = row?.firebaseUid;
  } catch {
    return;
  }

  if (!firebaseUid) return;

  await writeNotification({
    firebaseUid,
    type: "dispute_opened",
    title: "Dispute opened on a payment",
    body: "A customer has opened a dispute on a payment you earned from. Your earnings may be affected.",
    actionUrl: "/dashboard/earnings",
    idempotencyKey: `dispute_opened:${whopDisputeId}`,
    metadata: { whopPaymentId, whopDisputeId },
  });
}

/* --------------------------------------------------------------------------
   WITHDRAWALS — triggered by admin actions, not webhooks
   -------------------------------------------------------------------------- */

/**
 * Fires when an admin begins processing a withdrawal request.
 */
export async function notifyWithdrawalProcessing(
  firebaseUid: string,
  withdrawalId: string,
): Promise<void> {
  await writeNotification({
    firebaseUid,
    type: "withdrawal_processing",
    title: "Withdrawal in progress",
    body: "Your withdrawal request is being processed. Funds will be sent to your payout account.",
    actionUrl: "/dashboard/payouts",
    idempotencyKey: `withdrawal_processing:${withdrawalId}`,
  });
}

/* --------------------------------------------------------------------------
   WEBHOOK DISPATCHER — called by whop-webhooks.ts after successful dispatch
   -------------------------------------------------------------------------- */

/**
 * Maps a successfully handled webhook event to the appropriate notification
 * triggers. This function NEVER throws — all errors are caught internally.
 * Callers must still wrap in .catch(() => {}) as a belt-and-suspenders guard.
 */
export async function fireWebhookNotifications(
  eventType: string,
  resourceId: string | null,
  body: unknown,
): Promise<void> {
  try {
    const root = (body ?? {}) as Record<string, unknown>;
    const data = (root.data ?? root.object ?? root) as Record<string, unknown>;

    if (eventType === "payment.succeeded" && resourceId) {
      await notifyPaymentSettled(resourceId);
      return;
    }

    if ((eventType === "dispute.created" || eventType === "dispute.updated") && resourceId) {
      const resource = typeof data.resource === "object" && data.resource !== null
        ? data.resource as Record<string, unknown>
        : null;
      const paymentId =
        typeof data.payment_id === "string" ? data.payment_id :
        typeof resource?.payment_id === "string" ? resource.payment_id as string :
        null;
      if (paymentId) {
        await notifyDisputeOpened(paymentId, resourceId);
      }
      return;
    }

    if (eventType === "payout.updated" || eventType === "payout.reversed") {
      const payoutId = resourceId ?? (typeof data.id === "string" ? data.id : null);
      if (!payoutId) return;

      const isReversed =
        eventType === "payout.reversed" ||
        (typeof data.status === "string" && (data.status === "reversed" || data.status === "failed"));
      const isCompleted =
        !isReversed &&
        typeof data.status === "string" &&
        (data.status === "paid" || data.status === "completed" || data.status === "succeeded");

      if (isReversed) {
        await notifyPayoutReversed(payoutId);
      } else if (isCompleted) {
        await notifyPayoutCompleted(payoutId, true);
      }
      return;
    }

    if (eventType === "account.updated") {
      const accountId = typeof data.id === "string" ? data.id : null;
      const status = typeof data.status === "string" ? data.status : null;
      const environment =
        typeof data.environment === "string" ? data.environment :
        typeof root.environment === "string" ? root.environment :
        null;
      if (accountId && status && environment) {
        await notifyAccountUpdated(accountId, environment, status);
      }
      return;
    }
  } catch {
    // Never propagate — a notification failure must not affect the webhook receipt
  }
}
