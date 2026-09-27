import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { creatorEarnings, creatorTransfers, whopAccounts } from "@/lib/db/schema";
import { getWhopEnvironment } from "./whop-payments";
import { FAILURE_PAYOUT_STATUSES } from "./whop-payouts";
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

   KEY SCHEMA: "{type}:{environment}:{resource_id}[:{state_discriminator}]"

   THE ENVIRONMENT IS PART OF THE KEY, and it has to be.

   Every lookup below is already environment-scoped, for a reason these very
   comments state: a Whop resource id "is not unique across environments", and
   migration 0011 made our own unique indexes environment-aware so the same id
   can legitimately exist once per environment.

   The keys did not carry that. `earnings_held:pay_ABC` was the same string in
   sandbox and production, and `idempotency_key` is globally unique — so
   whichever environment fired first won and the other creator was NEVER
   notified. Not a duplicate: a silently swallowed notification, which is the
   harder failure to notice.

   `notifyWithdrawalProcessing` is the one exception and needs no environment in
   its key, because a withdrawal id is a uuid from our own table rather than a
   provider id, and is therefore already unique across both environments.
   ========================================================================== */

/**
 * Builds an idempotency key that cannot collide across environments.
 *
 * Takes the environment as an argument rather than reading it, so the key and
 * the lookup that resolved the recipient are always derived from the same value
 * — if they could differ, a notification could be deduplicated against a key
 * from the environment it does not belong to.
 */
function notificationKey(
  type: string,
  environment: "sandbox" | "production",
  resourceId: string,
  discriminator?: string,
): string {
  return discriminator
    ? `${type}:${environment}:${resourceId}:${discriminator}`
    : `${type}:${environment}:${resourceId}`;
}

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
 *
 * THE ENVIRONMENT IS NOT A PARAMETER, DELIBERATELY.
 *
 * This used to take the environment from the caller, and the caller read it
 * out of the webhook body (`data.environment ?? root.environment`). That let
 * externally-supplied JSON choose which environment's `whop_accounts` row to
 * resolve — so a sandbox delivery carrying `"environment": "production"` would
 * look up a PRODUCTION creator and notify them about a sandbox status change.
 *
 * It now comes from `getWhopEnvironment()`, the same server-side helper the
 * real `handleWhopAccountUpdated` storage path uses, reading only
 * `process.env`. Removing the parameter is the point: with no seam, no payload,
 * query parameter or request body can reach this decision.
 *
 * Fails closed when the environment cannot be resolved — an unscoped lookup
 * would be a cross-environment read.
 */
export async function notifyAccountUpdated(
  whopAccountId: string,
  newStatus: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const environment = getWhopEnvironment();
  if (!environment) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: whopAccounts.firebaseUid })
      .from(whopAccounts)
      .where(and(eq(whopAccounts.whopAccountId, whopAccountId), eq(whopAccounts.environment, environment)))
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
      idempotencyKey: notificationKey("kyc_approved", environment, whopAccountId),
    });
  } else if (state === "restricted") {
    await writeNotification({
      firebaseUid,
      type: "kyc_rejected",
      title: "Payout account restricted",
      body: "Your payout account has been restricted. Contact support for help.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: notificationKey("kyc_rejected", environment, whopAccountId),
    });
  } else if (state === "action_required") {
    await writeNotification({
      firebaseUid,
      type: "kyc_required",
      title: "Action required: complete verification",
      body: "Your payout account needs additional information before you can receive funds.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: notificationKey("kyc_required", environment, whopAccountId, newStatus),
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

  // Same rule as the payout lookups below: `whop_payment_id` is Whop's id and
  // is not unique across environments, so an unscoped match could resolve a
  // DIFFERENT creator's earning and notify the wrong person.
  const environment = getWhopEnvironment();
  if (!environment) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorEarnings.firebaseUid })
      .from(creatorEarnings)
      .where(
        and(
          eq(creatorEarnings.whopPaymentId, whopPaymentId),
          eq(creatorEarnings.environment, environment),
        ),
      )
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
    idempotencyKey: notificationKey("earnings_held", environment, whopPaymentId),
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

  // Scoped by environment for the same reason the transfer state changes are:
  // `provider_transfer_id` is Whop's id and is not unique across environments,
  // so an id alone could resolve a transfer belonging to a DIFFERENT creator in
  // the other environment and notify the wrong person. Environment comes from
  // the server-side helper, never from the webhook payload.
  const environment = getWhopEnvironment();
  if (!environment) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorTransfers.firebaseUid })
      .from(creatorTransfers)
      .where(
        and(
          eq(creatorTransfers.providerTransferId, providerTransferId),
          eq(creatorTransfers.environment, environment),
        ),
      )
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
      idempotencyKey: notificationKey("payout_succeeded", environment, providerTransferId),
    });
  } else {
    await writeNotification({
      firebaseUid,
      type: "payout_failed",
      title: "Payout failed",
      body: "Your payout could not be completed. Check your payout account settings.",
      actionUrl: "/dashboard/payouts",
      idempotencyKey: notificationKey("payout_failed", environment, providerTransferId),
    });
  }
}

/**
 * Fires after `payout.reversed` is processed.
 */
export async function notifyPayoutReversed(providerTransferId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  // Environment-scoped for the same reason as notifyPayoutCompleted above.
  const environment = getWhopEnvironment();
  if (!environment) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorTransfers.firebaseUid })
      .from(creatorTransfers)
      .where(
        and(
          eq(creatorTransfers.providerTransferId, providerTransferId),
          eq(creatorTransfers.environment, environment),
        ),
      )
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
    idempotencyKey: notificationKey("payout_reversed", environment, providerTransferId),
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

  // Environment-scoped for the same reason as notifyPaymentSettled above.
  const environment = getWhopEnvironment();
  if (!environment) return;

  let firebaseUid: string | undefined;
  try {
    const [row] = await db
      .select({ firebaseUid: creatorEarnings.firebaseUid })
      .from(creatorEarnings)
      .where(
        and(
          eq(creatorEarnings.whopPaymentId, whopPaymentId),
          eq(creatorEarnings.environment, environment),
        ),
      )
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
    idempotencyKey: notificationKey("dispute_opened", environment, whopDisputeId),
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
    /* NO ENVIRONMENT IN THIS KEY, deliberately. `withdrawalId` is a uuid from
     * our own `creator_withdrawals` table, not a provider id, so it is already
     * unique across both environments and there is nothing to disambiguate. */
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

      /* THE PROVIDER'S OWN VOCABULARY, and only it.
       *
       * A payout has exactly eight statuses: requested, in_review, processing,
       * completed, reversed, canceled, failed, denied. This used to match
       * "paid" and "succeeded" as well — neither is a payout status, so those
       * branches could never fire, and "completed" was being reached only by
       * accident of being listed alongside them.
       *
       * NOTIFICATIONS ONLY. This decides what a creator is told, never what the
       * books say: money state comes from `payouts.retrieve` through the
       * withdrawal reconciler. Reading a payload status here is safe precisely
       * because nothing financial depends on it, and a wrong guess sends a
       * wrong email rather than moving a wrong amount.
       */
      const payloadStatus = typeof data.status === "string" ? data.status : null;
      const isReversed = eventType === "payout.reversed" || payloadStatus === "reversed";
      const isCompleted = !isReversed && payloadStatus === "completed";

      /* A PAYOUT THAT ENDED WITHOUT PAYING, which nothing told the creator about.
       *
       * `notifyPayoutCompleted(id, false)` builds a `payout_failed` notification
       * and NOTHING ever passed `false` — this dispatcher only ever passed
       * `true`, so the branch was unreachable and a creator whose payout failed,
       * was denied or was canceled simply never heard. That is the case they most
       * need to hear about: the money did not arrive and their payout account may
       * need attention.
       *
       * `FAILURE_PAYOUT_STATUSES` is the provider vocabulary `whop-payouts.ts`
       * already defines and the withdrawal reconciler already acts on, so the
       * notification and the money agree on what "failed" means instead of
       * keeping two lists that can drift. */
      const isFailed = !isReversed && !isCompleted && payloadStatus !== null &&
        FAILURE_PAYOUT_STATUSES.has(payloadStatus);

      if (isReversed) {
        await notifyPayoutReversed(payoutId);
      } else if (isCompleted) {
        await notifyPayoutCompleted(payoutId, true);
      } else if (isFailed) {
        await notifyPayoutCompleted(payoutId, false);
      }
      return;
    }

    if (eventType === "account.updated") {
      const accountId = typeof data.id === "string" ? data.id : null;
      const status = typeof data.status === "string" ? data.status : null;
      // The payload's own `environment` field is NOT read. The account id and
      // the status are facts about the resource; the environment is a fact
      // about US, and notifyAccountUpdated resolves it from server config.
      if (accountId && status) {
        await notifyAccountUpdated(accountId, status);
      }
      return;
    }
  } catch {
    // Never propagate — a notification failure must not affect the webhook receipt
  }
}
