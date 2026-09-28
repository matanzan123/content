import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import { getDb } from "@/lib/db";
import { whopWebhookReceipts } from "@/lib/db/schema";
import {
  describeWhopError,
  getWhopCompanyId,
  getWhopEnvironment,
  getWhopWebhookSecret,
} from "./whop-payments";
import { verifyPaymentOwnership } from "./whop-resources";
import { shouldRetryLookup } from "./payment-lifecycle";
import { mapPaymentToOrder, type MappingOutcome } from "./whop-payment-mapping";
import { postWhopSettlement } from "./accounting/whop-payment-posting";
import { mapRefundToOrder, type RefundMappingOutcome } from "./whop-refund-mapping";
import { postWhopRefund } from "./accounting/whop-refund-posting";
import { verifyRefundOwnership } from "./whop-refunds";
import {
  mapAlertToOrder,
  mapCaseToOrder,
  mapDisputeToOrder,
  type AlertMappingOutcome,
  type DisputeMappingOutcome,
} from "./whop-dispute-mapping";
import { postDisputeMovementsForPayment } from "./accounting/whop-dispute-posting";
import {
  verifyAlertOwnership,
  verifyCaseOwnership,
  verifyDisputeOwnership,
} from "./whop-disputes";
import { updateConnectedAccountStatus } from "./connected-accounts";
import { refreshTransferFromProvider } from "./creator-transfers";
import {
  findWithdrawalByProviderPayoutId,
  reconcileWithdrawal,
} from "./creator-withdrawals";
import { resolveChildAccount } from "./whop-child-router";
import { reverseForRefund, reverseForDispute } from "./creator-earnings";
import { fireWebhookNotifications } from "./notification-triggers";

/* ==========================================================================
   WHOP WEBHOOK RECEIVER — server only.

   Four things happen here, in this order, and the order is the security
   property:

     1. VERIFY the raw bytes against the endpoint's signing secret. Nothing
        below this line runs on an unverified body.
     2. CHECK the event belongs to the configured company.
     3. RECORD the delivery durably, keyed by the Standard Webhooks message id.
        The database decides who wins a race; the application never does.
     4. DISPATCH to a handler.

   Whop delivers AT LEAST ONCE and does not guarantee order, so step 3 is not
   optional bookkeeping — it is the only thing standing between a redelivery
   and a double effect once handlers do real work.

   ACCOUNTING ATTACHES AFTER STEP 4, NEVER INSTEAD OF IT. A verified
   `payment.succeeded` is accounted for only once `mapPaymentToOrder` has
   settled an order against the provider's own record of the payment; the
   posting itself is idempotent on the economic event, so a redelivery
   converges rather than doubling. Everything else — refunds, disputes,
   payouts — still has no mapping and says so rather than guessing.

   `financial_ledger` is not written here or anywhere else. It is superseded
   by the balanced journal in `accounting_transactions` / `accounting_entries`.
   ========================================================================== */

/* ------------------------------ event names ------------------------------ */

/**
 * The financial events this build recognises, taken verbatim from the SDK's
 * `WebhookEvent` enum — not guessed. A signed event outside this list is
 * recorded as `unsupported`, which is deterministic and cannot create money.
 */
export const SUPPORTED_EVENTS = [
  // The six payment lifecycle events, verified against BOTH the SDK's
  // `WebhookEvent` enum and docs.whop.com/llms.txt, which list exactly these.
  // `payment.completed` is NOT one of them — it appears in the SDK only as a
  // people-filter value, never as a subscribable webhook — and
  // `payment.affiliate_reward_created` and the `app_payment.*` family are
  // different subjects that would need their own resolvers.
  "payment.created",
  "payment.pending",
  "payment.authorized",
  "payment.succeeded",
  "payment.failed",
  "payment.canceled",
  "refund.created",
  "refund.updated",
  // The dispute family, verified against the SDK's `WebhookEvent` enum, which
  // carries exactly these six and no others: there is no `dispute.won`,
  // `dispute.lost` or `dispute_alert.updated`. An outcome arrives as a
  // `dispute.updated` whose fetched status says which.
  "dispute.created",
  "dispute.updated",
  "dispute_alert.created",
  "resolution_center_case.created",
  "resolution_center_case.updated",
  "resolution_center_case.decided",
  // THE SAME SUBJECT UNDER A SECOND NAME, and unlike `withdrawal.*` this one is
  // genuinely subscribable: `CreateWebhooksRequest.Events.Item` lists
  // `resolution.created`, `resolution.updated` and `resolution.decided`
  // alongside the three `resolution_center_case.*` names, with no indication of
  // which an endpoint will actually receive.
  //
  // Both are taken, routed to the same resolver. The alternative is the failure
  // this file has already had twice — an event family arriving under a name
  // nothing recognised, recorded `unsupported`, with the lifecycle behind it
  // receiving nothing. Taking a name that never fires costs a dead map entry;
  // missing the one that does costs every dispute resolution.
  "resolution.created",
  "resolution.updated",
  "resolution.decided",
  // WITHDRAWALS — creator balance out to their own bank destination.
  //
  // `payout.*` IS THE RIGHT FAMILY, and the SDK settles it. `client.payouts.create`
  // returns a `wdrl_` id, and `WebhookEvent` carries both `payout.created/updated/
  // reversed` and `withdrawal.created/updated/reversed`, which makes the naming
  // look ambiguous. It is not: `CreateWebhooksRequest.Events.Item` — the list of
  // events an endpoint can actually be SUBSCRIBED to — contains the three
  // `payout.*` names and no `withdrawal.*` name at all. An event that cannot be
  // subscribed cannot be delivered, so `withdrawal.*` was briefly added here
  // during Task #27 and removed again: dead entries that would have implied an
  // open question the contract already answers.
  "payout.created",
  "payout.updated",
  "payout.reversed",
  // TRANSFERS — platform balance to a creator's Whop balance. A different
  // resource from the above in every way: `tr_`-shaped ids, three statuses, no
  // reversal, and `creator_transfers` rather than `creator_withdrawals`.
  //
  // These are in the SDK enum too, and were not subscribed. The omission was
  // justified in `handleWhopPayoutUpdated` by the claim that transfers "have no
  // webhook of their own in the installed SDK"; the enum contradicts it, so the
  // claim has been corrected there. Until now a completed transfer only became
  // visible when an administrator ran a reconcile by hand — and there is no
  // scheduler to do it for them.
  "transfer.created",
  "transfer.completed",
  "transfer.failed",
  // Connected account KYC / onboarding status changes.
  "account.updated",
] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

const SUPPORTED = new Set<string>(SUPPORTED_EVENTS);

export function isSupportedEvent(name: unknown): name is SupportedEvent {
  return typeof name === "string" && SUPPORTED.has(name);
}

/* ------------------------------- outcomes -------------------------------- */

/**
 * What the endpoint should answer. `ack` means Whop should stop retrying;
 * `reject` means refuse the delivery; `retry` means we failed and want it
 * again. A verified event is never silently dropped: every branch produces a
 * named outcome.
 */
export type WebhookOutcome =
  | {
      ack: true;
      status:
        | "accepted"
        | "duplicate"
        | "awaiting_mapping"
        | "unsupported"
        | "rejected_company"
        /**
         * We could not prove what the event refers to, and asking again cannot
         * change that. The RECEIPT stays `failed` — nothing was handled, and
         * reconciliation must still be able to see it — but Whop is told to
         * stop redelivering an answer that will not move.
         */
        | "unresolvable";
    }
  | {
      ack: false;
      kind: "unverified" | "unconfigured" | "storage_unavailable" | "processing_failed" | "processing_in_flight";
    };

export type WebhookHeaders = Record<string, string>;

/* ---------------------------- payload reading ---------------------------- */

/**
 * Reads the few fields we keep, defensively. The payload is verified but not
 * schema-checked: Whop can add or reshape fields, and a receiver that throws
 * on an unfamiliar body would turn a harmless product change into an outage.
 */
function readString(source: unknown, ...keys: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 255) return value;
  }
  return null;
}

type Envelope = {
  eventType: string;
  resourceId: string | null;
  companyId: string | null;
};

/** Pulls the delivery envelope out of a verified body. */
export function readEnvelope(body: unknown): Envelope {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.object ?? null) as Record<string, unknown> | null;

  return {
    eventType: readString(root, "event", "type", "event_type") ?? "unknown",
    resourceId: readString(data, "id") ?? readString(root, "id"),
    companyId:
      readString(data, "company_id", "company", "biz_id") ?? readString(root, "company_id"),
  };
}

/**
 * The message id Whop signed. Case-insensitive, because header casing is not
 * guaranteed across proxies.
 */
export function readWebhookId(headers: WebhookHeaders): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "webhook-id" && typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 255);
    }
  }
  return null;
}

/* ----------------------------- verification ------------------------------ */

export type VerifyResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "no_secret" | "invalid_signature" };

/**
 * Verifies the RAW body with the official helper, which implements Standard
 * Webhooks via the `standardwebhooks` package: it reads `webhook-id`,
 * `webhook-timestamp` and `webhook-signature`, enforces the timestamp
 * tolerance window, and compares signatures in constant time. A missing or
 * malformed header, a stale timestamp, a tampered body and a wrong signature
 * all land in the same rejection, which is the point — a caller must not be
 * able to tell them apart.
 *
 * With no secret configured this returns `no_secret` and the endpoint refuses
 * every delivery. There is deliberately no unverified path.
 */
export function verifyWebhook(rawBody: string, headers: WebhookHeaders): VerifyResult {
  const secret = getWhopWebhookSecret();
  if (!secret) return { ok: false, reason: "no_secret" };

  try {
    return { ok: true, body: unwrapWebhook(rawBody, { headers, key: secret }) };
  } catch (error) {
    // Never log the error itself: a verification failure can quote the
    // signature material it was comparing.
    if (error instanceof WebhookVerificationError || error instanceof Error) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: false, reason: "invalid_signature" };
  }
}

/* ------------------------- handler boundary (no money) -------------------- */

/**
 * What a handler can report today. `business_mapping_not_implemented` is an
 * honest terminal state, not a failure: the event is understood and recorded,
 * and there is simply no ClipRewards order to attach it to yet.
 */
export type HandlerResult =
  | { kind: "business_mapping_not_implemented" }
  | { kind: "handled" }
  | { kind: "failed"; category: string };

/**
 * Settles the internal ORDER a verified payment names, and then — and only
 * then — accounts for the money.
 *
 * THE ORDER OF THESE TWO STEPS IS THE WHOLE POINT.
 *
 * `mapPaymentToOrder` re-fetches the payment and compares the provider's own
 * amount, currency, company, metadata and status against our order before any
 * state moves. A mismatch on any of them leaves the order untouched and
 * returns something other than `paid`, so the accounting call below is never
 * reached. Nothing here repeats or relaxes those checks: the accounting step
 * runs on a payment that has ALREADY been proved to be ours, against an order
 * that has ALREADY been settled.
 *
 * `alreadyPaid` still posts. It means the order was settled by an earlier
 * delivery, which tells us nothing about whether the accounting for it was
 * written — a crash between the two would leave a paid order with no journal
 * entry, and that gap is exactly what a redelivery is for. Posting is
 * idempotent on `whop:payment_settled:<payment_id>`, so a delivery that
 * arrives after a complete one converges instead of duplicating.
 *
 * A FAILED POSTING FAILS THE DELIVERY. The receipt goes back to `failed` and
 * stays retryable, because a settled payment that is not in the ledger is a
 * hole in the accounts, and acknowledging the delivery would close the only
 * door through which it can be filled.
 */
export async function handleWhopPaymentSucceeded(
  resourceId: string | null,
  webhookId: string | null,
): Promise<HandlerResult> {
  const outcome = await mapPaymentToOrder(resourceId, "succeeded");
  if (outcome.kind !== "paid") return describeMapping(outcome);

  const environment = getWhopEnvironment();
  if (!environment) return { kind: "failed", category: "accounting_unconfigured" };

  // `resourceId` is a proven payment id by this point: `mapPaymentToOrder`
  // returns `paid` only after fetching that very payment from Whop.
  const posted = await postWhopSettlement(resourceId as string, {
    environment,
    orderId: outcome.orderId,
    sourceWebhookId: webhookId,
  });

  if (!posted.ok) {
    return { kind: "failed", category: `accounting_${posted.reason}` };
  }

  return { kind: "handled" };
}

export async function handleWhopPaymentFailed(resourceId: string | null): Promise<HandlerResult> {
  const outcome = await mapPaymentToOrder(resourceId, "failed");
  return describeMapping(outcome);
}

export async function handleWhopPaymentPending(resourceId: string | null): Promise<HandlerResult> {
  const outcome = await mapPaymentToOrder(resourceId, "pending");
  return describeMapping(outcome);
}

/**
 * Translates a mapping outcome into a receipt state.
 *
 * A resolved order is `handled` — the event did everything this build claims
 * to do with it. A refusal is `failed` with the reason as its category, so a
 * mismatch is visible in the receipts table rather than being swallowed as
 * "nothing to do". A payment that simply is not settled yet is neither: it is
 * recorded as awaiting the mapping that a later event will complete.
 */
function describeMapping(outcome: MappingOutcome): HandlerResult {
  switch (outcome.kind) {
    case "paid":
    case "pending":
    case "failed_recorded":
      return { kind: "handled" };
    case "ignored":
      return { kind: "business_mapping_not_implemented" };
    case "rejected":
      return { kind: "failed", category: outcome.reason };
  }
}

/**
 * Resolves the REFUND a verified delivery names, and then — and only then —
 * accounts for the money.
 *
 * THE SAME TWO-STEP SHAPE AS `handleWhopPaymentSucceeded`, for the same
 * reason. `mapRefundToOrder` re-fetches the refund AND the payment it names,
 * and compares the provider's own account, order reference, currency, amount
 * and cumulative refunded total against our order before any state moves. A
 * mismatch on any of them leaves everything untouched and returns something
 * other than `completed`, so the posting below is never reached.
 *
 * BOTH REFUND EVENTS ROUTE HERE, and that is not laziness. Whop's two refund
 * events carry no outcome in their names: a refund that succeeded and one that
 * failed both arrive as `refund.updated`. The outcome comes from the FETCHED
 * `refund.status`, so the two events genuinely have nothing to distinguish
 * them at this layer, and giving them separate handlers would only invite one
 * of them to drift.
 *
 * `alreadyCompleted` STILL POSTS, exactly as `alreadyPaid` does. It means an
 * earlier delivery already recorded the refund as completed, which says
 * nothing about whether the accounting for it was written — a crash between
 * the two leaves a completed refund with no journal entry, and a redelivery is
 * the door through which that gap gets filled. Posting is idempotent on
 * `whop:payment_refunded:<rf_id>`, so a delivery arriving after a complete one
 * converges instead of duplicating.
 *
 * A FAILED POSTING FAILS THE DELIVERY, for the same reason it does on the
 * payment side: a completed refund that is not in the ledger is a hole in the
 * accounts, and acknowledging would close the only door through which it can
 * be filled.
 */
export async function handleWhopRefund(
  resourceId: string | null,
  webhookId: string | null,
): Promise<HandlerResult> {
  const outcome = await mapRefundToOrder(resourceId);
  if (outcome.kind !== "completed") return describeRefundMapping(outcome);

  const environment = getWhopEnvironment();
  if (!environment) return { kind: "failed", category: "accounting_unconfigured" };

  const posted = await postWhopRefund(outcome.refundId, {
    environment,
    orderId: outcome.orderId,
    sourceWebhookId: webhookId,
  });

  if (!posted.ok) return { kind: "failed", category: `refund_accounting_${posted.reason}` };

  // Unwind the creator earning and its revenue-split journal. A failure here is
  // logged but does not fail the delivery — the provider-side accounting is
  // already posted and idempotent, and the earning status will be visibly wrong
  // in reconciliation until a manual fix or redelivery resolves it.
  await reverseForRefund({
    whopPaymentId: outcome.paymentId,
    refundId: outcome.refundId,
    refundAmountMinor: outcome.amountMinor,
    currency: outcome.currency,
    environment,
  });

  return { kind: "handled" };
}

/**
 * Translates a refund mapping outcome into a receipt state.
 *
 * A PENDING REFUND IS `handled`, not `awaiting_mapping`. The mapping did
 * everything there is to do: the refund was verified, recorded, and correctly
 * produced no accounting because the provider has not moved the money. A later
 * `refund.updated` brings the outcome. Filing it as awaiting-mapping would
 * imply a missing implementation rather than a refund that is simply still in
 * flight.
 */
function describeRefundMapping(outcome: RefundMappingOutcome): HandlerResult {
  switch (outcome.kind) {
    case "completed":
    case "pending":
    case "failed_recorded":
      return { kind: "handled" };
    case "rejected":
      return { kind: "failed", category: `refund_${outcome.reason}` };
  }
}

/**
 * Resolves the DISPUTE a verified delivery names, and then accounts for any
 * money the provider's own ledger says has moved because of it.
 *
 * THE SAME TWO-STEP SHAPE as payments and refunds, with one crucial
 * difference: the second step is NOT driven by the dispute's status.
 *
 * `mapDisputeToOrder` re-fetches the dispute and the payment it names and
 * compares account, order, currency and amount before any state moves. Only
 * then does `postDisputeMovementsForPayment` read the provider's
 * `financialActivity` feed and mirror whatever dispute-related rows it finds.
 *
 * WHY THE POSTING RUNS ON EVERY DELIVERY, including ones that changed nothing.
 * A dispute's money does not arrive with its status. The fee may post when it
 * opens, the withdrawal later, the reversal later still — each as its own
 * ledger row. So every delivery is an opportunity to notice a movement that
 * has appeared since the last one, and each row is idempotent on its own id,
 * so re-reading costs a request and never a duplicate.
 *
 * BOTH DISPUTE EVENTS ROUTE HERE. `dispute.created` and `dispute.updated`
 * carry no outcome in their names — a dispute that was won and one that was
 * lost both arrive as `dispute.updated` — so the fetched status is the only
 * thing that can decide, and giving them separate handlers would only invite
 * one to drift.
 *
 * A FAILED POSTING FAILS THE DELIVERY, so the receipt stays retryable: a
 * chargeback that moved money we have not booked is a hole in the accounts.
 */
export async function handleWhopDispute(
  resourceId: string | null,
  webhookId: string | null,
): Promise<HandlerResult> {
  const outcome = await mapDisputeToOrder(resourceId);
  if (outcome.kind !== "recorded") return describeDisputeMapping(outcome);

  const posted = await postDisputeMovementsForPayment(outcome.paymentId, {
    orderId: outcome.orderId,
    disputeId: outcome.resourceId,
    sourceWebhookId: webhookId,
  });

  if (!posted.ok) {
    return { kind: "failed", category: `dispute_accounting_${posted.reason ?? "unknown"}` };
  }

  // When the dispute is lost, unwind the creator earning and its revenue-split
  // journal. Like the refund path, a failure is not fatal to the delivery (the
  // chargeback accounting already posted), but the inconsistency will surface in
  // reconciliation.
  if (outcome.status === "lost") {
    const environment = getWhopEnvironment();
    if (environment) {
      await reverseForDispute({
        whopPaymentId: outcome.paymentId,
        whopDisputeId: outcome.resourceId,
        environment,
      });
    }
  }

  return { kind: "handled" };
}

/**
 * Records the ALERT a verified delivery names. No accounting, ever.
 *
 * An alert is an issuer's early warning that a chargeback may be coming. The
 * resource reports only WHETHER a fee was charged (`fee_charged: boolean`) and
 * never how much, so there is no amount on it that could be posted. If a fee
 * really was charged it appears on the provider's ledger as a
 * `dispute_alert_fee` row against the payment, and THAT is what gets posted —
 * by the dispute handler above, from the same authoritative feed.
 *
 * An alert Whop could not match to a payment is recorded as unmatched and
 * acknowledged. It is a real state, it is terminal, and discarding it would
 * lose the only record that an issuer reported fraud against us.
 */
export async function handleWhopDisputeAlert(
  resourceId: string | null,
): Promise<HandlerResult> {
  const outcome = await mapAlertToOrder(resourceId);
  if (outcome.kind === "recorded_unmatched") return { kind: "handled" };
  return describeDisputeMapping(outcome);
}

/**
 * Records the RESOLUTION CENTER CASE a verified delivery names. No accounting,
 * ever.
 *
 * A case is Whop's mediation process, not a financial resource. It may end in
 * a refund or escalate into a chargeback, and when it does Whop emits that
 * real resource separately — so the money belongs to the `rf_` or `dspt_`,
 * which have their own handlers and their own idempotency. Posting from a case
 * as well would book the same money twice.
 *
 * The case's own `refund` field (`none` / `merchant` / `platform`) is stored
 * and used by reconciliation to check that a case claiming money came off OUR
 * balance has a real refund or dispute behind it — and that one claiming
 * `platform` does not, because that was Whop's money.
 *
 * All three case events route here: `created`, `updated` and `decided` differ
 * only in when they fire, and the fetched status and outcome say the rest.
 */
export async function handleWhopResolutionCase(
  resourceId: string | null,
): Promise<HandlerResult> {
  return describeDisputeMapping(await mapCaseToOrder(resourceId));
}

/**
 * Translates a dispute-family mapping outcome into a receipt state.
 *
 * A recorded resource is `handled` — the event did everything this build
 * claims to do with it. A refusal is `failed` with the reason as its category,
 * so a mismatch is visible in the receipts table rather than being swallowed.
 */
function describeDisputeMapping(outcome: DisputeMappingOutcome | AlertMappingOutcome): HandlerResult {
  switch (outcome.kind) {
    case "recorded":
    case "recorded_unmatched":
      return { kind: "handled" };
    case "rejected":
      return { kind: "failed", category: `dispute_${outcome.reason}` };
  }
}

/**
 * Handles payout lifecycle events from Whop:
 *   payout.created  — a payout has been initiated (already tracked by us)
 *   payout.updated  — status change; we look for "paid"/"completed" to confirm
 *   payout.reversed — the payout was reversed; write a reversal journal entry
 *
 * The provider transfer id (`tr_…` or `pay_…`) is the key. We match it
 * against `creator_transfers.provider_transfer_id`.
 *
 * A payout.created event for an id we do not recognise is silently acknowledged
 * — it may be a non-creator payout (e.g. platform-to-platform) that we do not
 * track.
 */
export async function handleWhopPayoutUpdated(
  resourceId: string | null,
  _webhookId: string,
  body: unknown,
): Promise<HandlerResult> {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.object ?? root) as Record<string, unknown>;

  // The payout id from the payload. `data.id` is the payout on every one of
  // the three payload types; the fallbacks cover older shapes.
  const payoutId =
    resourceId ??
    readString(data, "id") ??
    readString(data, "payout_id") ??
    readString(data, "transfer_id");

  if (!payoutId) return { kind: "business_mapping_not_implemented" };

  // THE PAYLOAD'S STATUS IS NOT READ, DELIBERATELY.
  //
  // This handler used to map `paid`/`completed`/`reversed` out of the event
  // body onto our money state. None of those is a Whop TRANSFER status — that
  // resource has exactly `processing`, `succeeded` and `failed` — so it was
  // writing the ledger from states the resource never emits, and `failed`
  // posted a reversal for money that had never moved.
  //
  // It also wrote money state without ownership proof: `payout.*` is not in
  // OWNERSHIP_GATED, so nothing had established the resource was ours.
  //
  // The event is only a TRIGGER. The authority is a provider retrieve, and
  // retrieving the resource with our own platform key IS the ownership proof,
  // so the gap closes without a separate gate entry. An id we do not hold
  // locally, in this environment, never reaches the provider at all.
  //
  // ROUTED TO WITHDRAWALS FIRST, AND THAT ORDER IS THE FIX.
  //
  // `payout.*` events belong to the PAYOUTS resource: their ids are `wdrl_`,
  // and that is the resource a creator withdrawal uses. They were being handed
  // to the TRANSFER reconciler, which looks the id up in
  // `creator_transfers.provider_transfer_id` — a different id space entirely.
  // The two never intersect, so every payout delivery fell through
  // unrecognised and the withdrawal lifecycle received nothing at all.
  //
  // The transfer path is still tried second, so a delivery in this family that
  // names one of our transfers is still resolved.
  //
  // CORRECTED IN TASK #27. This said transfers "have no webhook of their own in
  // the installed SDK and are reconciled by polling". The first half is false:
  // `@whop/sdk`'s `WebhookEvent` enum carries `transfer.created`,
  // `transfer.completed` and `transfer.failed`. They were simply not subscribed,
  // which made the second half true as a consequence rather than by design — and
  // with no scheduler, "reconciled by polling" meant "reconciled when an
  // administrator remembers". All three are now in SUPPORTED_EVENTS and route to
  // `handleWhopTransferUpdated` below.
  const withdrawal = await findWithdrawalByProviderPayoutId(payoutId);
  if (withdrawal) {
    const reconciled = await reconcileWithdrawal(withdrawal.withdrawalId);
    // A failed reconcile is a provider read we could not trust, not a bad
    // delivery. Reporting it as unhandled keeps the delivery retryable.
    return reconciled.ok
      ? { kind: "handled" }
      : { kind: "failed", category: "payout_reconcile_failed" };
  }

  const refreshed = await refreshTransferFromProvider(payoutId);
  if (!refreshed.ok) {
    // Neither a withdrawal nor a ledger transfer of ours: another environment,
    // another system, or a payout we did not create. Acknowledged and ignored.
    return { kind: "business_mapping_not_implemented" };
  }
  return { kind: "handled" };
}

/**
 * A `transfer.*` delivery: platform balance to a creator's Whop balance.
 *
 * THE MIRROR OF `handleWhopPayoutUpdated`, and it shares that handler's two
 * rules because they are the ones that make either safe.
 *
 * THE PAYLOAD'S STATUS IS NOT READ. A transfer has exactly `processing`,
 * `succeeded` and `failed`, and the event name already claims an outcome —
 * `transfer.completed` — which is precisely the sort of claim that must not
 * become a ledger write on its own. `refreshTransferFromProvider` retrieves the
 * resource and reconciles from what the provider says, so a redelivery, a
 * late-arriving event and an out-of-order pair all converge on the same state.
 * That is also what makes a stale event harmless: it cannot regress anything,
 * because it contributes no state of its own.
 *
 * OWNERSHIP IS PROVED BY LOCAL POSSESSION, in this environment, before the
 * provider is contacted at all — `refreshTransferFromProvider` resolves the id
 * against `creator_transfers` scoped to the active environment and stops if it
 * finds nothing. So a sandbox delivery cannot reach a production transfer, and an
 * id belonging to somebody else never becomes a request. That is why `transfer.*`
 * is not in OWNERSHIP_GATED: the gate would be a second, weaker copy of a check
 * the reconciler already does better.
 *
 * An id we do not hold is acknowledged and ignored rather than retried — it
 * belongs to another environment or another system, and no number of
 * redeliveries will change that. A provider read we could not complete IS
 * retried, because a later attempt can genuinely succeed.
 */
export async function handleWhopTransferUpdated(
  resourceId: string | null,
  _webhookId: string,
  body: unknown,
): Promise<HandlerResult> {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.object ?? root) as Record<string, unknown>;

  const transferId =
    resourceId ??
    readString(data, "id") ??
    readString(data, "transfer_id");

  if (!transferId) return { kind: "business_mapping_not_implemented" };

  const refreshed = await refreshTransferFromProvider(transferId);
  if (refreshed.ok) return { kind: "handled" };

  /* NOT OURS, OR NOT READABLE — and the two must never be conflated.
   *
   * Acknowledging an unreadable provider as "unmapped" is the one outcome that
   * silently loses an event: the receipt reaches a terminal status and Whop stops
   * redelivering, while the transfer's real state was never learned. So the
   * reconciler reports which it was, and only a genuinely foreign id is
   * acknowledged. */
  return refreshed.reason === "not_ours"
    ? { kind: "business_mapping_not_implemented" }
    : { kind: "failed", category: "transfer_reconcile_failed" };
}

/**
 * Updates the local status of a connected account when Whop reports a KYC or
 * onboarding status change.
 *
 * The account `id` and `status` come from the webhook payload. We only update
 * rows that already exist in our DB — this handler never creates new rows.
 * An account we do not recognise is acknowledged and ignored: it belongs to
 * another ClipRewards environment or predates the current DB.
 */
export async function handleWhopAccountUpdated(
  body: unknown,
): Promise<HandlerResult> {
  const environment = getWhopEnvironment();
  if (!environment) return { kind: "failed", category: "unconfigured" };

  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.object ?? root) as Record<string, unknown>;

  const accountId = readString(data, "id");
  const status = readString(data, "status");

  if (!accountId || !status) return { kind: "business_mapping_not_implemented" };
  if (!/^biz_[A-Za-z0-9]{4,}$/.test(accountId)) return { kind: "business_mapping_not_implemented" };

  /* THE TWO ACCOUNT IDENTITIES IN THIS PAYLOAD MUST AGREE.
   *
   * `PostAccountUpdatedPayload` carries the account twice, in two different
   * roles: a TOP-LEVEL `account_id` — "the account ID that this webhook event
   * is associated with" — and `data`, the `Account` resource itself, whose
   * `id` says which account the body describes.
   *
   * NOTE WHAT THE ENVELOPE GATE DOES *NOT* DO HERE. `readEnvelope` looks for
   * `company_id`, and this payload has none: `Account` does not carry that
   * field and the root carries `account_id` instead. So `companyId` is null
   * for this family, `wrongCompany` is false, and the delivery passes the gate
   * WITHOUT any child ever being resolved. The gate cannot be the thing that
   * establishes account identity for `account.updated`; this check is.
   *
   * A MISMATCH IS REFUSED, NOT RECONCILED. A signed delivery proves Whop sent
   * the body. It does not license us to decide which of two disagreeing
   * identifiers inside that body is the real subject. If the event is
   * attributed to account A and the resource describes account B, then one of
   * our two readings is wrong — and picking either would write a status onto an
   * account the payload does not unambiguously name. Neither A nor B is
   * touched, and nothing is written at all.
   *
   * ABSENT IS NOT A MISMATCH. `account_id` is optional and nullable in the
   * contract, and an early sandbox delivery omitted the analogous field on the
   * payment family entirely. When it is absent there is no second identity to
   * disagree with, so the rule below still applies on its own: `data.id` must
   * resolve to a connected account we know, in this environment.
   */
  const attributedTo = readString(root, "account_id");
  if (attributedTo && attributedTo !== accountId) {
    return { kind: "business_mapping_not_implemented" };
  }

  /* THE ACCOUNT IS PROVED AGAINST OUR OWN RECORDS BEFORE ANYTHING IS WRITTEN.
   *
   * `data.id` is NOT the field the envelope gate checked. The gate resolves
   * the envelope's `company_id`; this is a separate, unverified field of the
   * payload, and an event that passed the gate can still name a different
   * account here — including one we have never heard of.
   *
   * Until now the only thing between an arbitrary `biz_` id and a write was
   * the UPDATE's own WHERE clause. That failed closed in effect, but it
   * reported `handled` whether or not a row matched, so a delivery naming an
   * account we do not know was recorded as `processed` and became
   * indistinguishable from a real update.
   *
   * `resolveChildAccount` is the same helper the envelope gate uses for the
   * families that DO carry a `company_id` — the `whop_accounts` table, scoped
   * to the current environment. No second mapping and no new identity system.
   * For this family it is not a repeat of the gate but the ONLY place account
   * identity is established, because the gate resolves nothing here (see
   * above). An account we do not know, or one belonging to the other
   * environment, is reported as unmapped rather than handled.
   */
  const known = await resolveChildAccount(accountId);
  if (!known) return { kind: "business_mapping_not_implemented" };

  /* THE STATUS IS INFORMATIONAL, AND IS NOT TRUSTED FOR MONEY.
   *
   * It is copied from the payload deliberately. Nothing financial reads this
   * column: payout readiness is decided by `fetchPayoutStatus`, which
   * retrieves the account from the provider and reads the provider's own
   * `status` and `required_actions`. If that ever changes — if a money path
   * starts consulting `whop_accounts.status` — this write must become a
   * provider retrieve instead, because a payload field cannot gate a payout.
   */
  const result = await updateConnectedAccountStatus(known.whopAccountId, environment, status);
  if (!result.ok) return { kind: "failed", category: result.reason };

  // The row was proved to exist a moment ago, so a miss here means it was
  // removed concurrently. Unmapped is the honest answer, not handled.
  if (!result.updated) return { kind: "business_mapping_not_implemented" };

  return { kind: "handled" };
}

/**
 * Events whose resource must be proved to belong to us BEFORE any handler
 * runs. These are the ones that move money.
 *
 * A MAP AND NOT A SET, because the resource kinds differ. A `payment.*` event
 * names a `pay_` id and is proved by `verifyPaymentOwnership`; a `refund.*`
 * event names an `rf_` id and is proved by `verifyRefundOwnership`, which
 * checks the refund's own account AND the account of the payment it reverses.
 * Passing an `rf_` id to the payment verifier would fail its shape check and
 * quarantine every refund as unresolvable — which is safe, but wrong.
 *
 * The remaining supported events name disputes and payouts. Those are
 * different subjects with their own lookups, are NOT in this map, and their
 * handlers cannot write money — each will join as its own resolver is written.
 */
const OWNERSHIP_GATED: Record<string, (id: string | null) => Promise<OwnershipOutcome>> = {
  "payment.created": verifyPaymentOwnership,
  "payment.pending": verifyPaymentOwnership,
  "payment.authorized": verifyPaymentOwnership,
  "payment.succeeded": verifyPaymentOwnership,
  "payment.failed": verifyPaymentOwnership,
  "payment.canceled": verifyPaymentOwnership,
  "refund.created": verifyRefundOwnership,
  "refund.updated": verifyRefundOwnership,
  // Each dispute-family resource has its own id shape and its own verifier.
  // All three prove ownership through the PAYMENT they name, because all three
  // declare their own account field nullable — "field absent" must never read
  // as "ownership fine".
  "dispute.created": verifyDisputeOwnership,
  "dispute.updated": verifyDisputeOwnership,
  "dispute_alert.created": verifyAlertOwnership,
  "resolution_center_case.created": verifyCaseOwnership,
  "resolution_center_case.updated": verifyCaseOwnership,
  "resolution_center_case.decided": verifyCaseOwnership,
  // The alias family is gated identically. A second name for a resource must not
  // become a second, weaker path to it.
  "resolution.created": verifyCaseOwnership,
  "resolution.updated": verifyCaseOwnership,
  "resolution.decided": verifyCaseOwnership,
};

/**
 * The shape both verifiers share. Only `kind` is read at the gate — the
 * account and payment ids the refund verifier additionally returns are proved
 * again by the mapping, which is where they are actually used.
 */
type OwnershipOutcome =
  | { kind: "verified" }
  /**
   * Alerts only: readable, not another company's, but Whop matched it to no
   * payment. A PASS — there is nothing to own and nothing that can post — and
   * a distinct kind so it can never be confused with a proven-owned resource.
   */
  | { kind: "verified_unmatched" }
  | { kind: "wrong_company" }
  | { kind: "resource_not_found" }
  | { kind: "provider_error"; category: string }
  | { kind: "invalid_resource_id" }
  | { kind: "unconfigured" }
  /** Disputes and cases: readable, but names no payment. A refusal. */
  | { kind: "no_payment_reference" };

type Handler = (resourceId: string | null, webhookId: string, body?: unknown) => Promise<HandlerResult>;

const HANDLERS: Record<SupportedEvent, Handler> = {
  // Five of the six route to the same resolver. That is deliberate: the
  // order's next state comes from the payment's own status, so a
  // `payment.created` for a payment Whop already reports as `paid` settles
  // the order exactly as a `payment.succeeded` would. Only
  // `payment.succeeded` carries a distinct `intent`, and only because a
  // succeeded event for an unsettled payment should stay retryable.
  "payment.created": handleWhopPaymentPending,
  "payment.pending": handleWhopPaymentPending,
  "payment.authorized": handleWhopPaymentPending,
  "payment.succeeded": handleWhopPaymentSucceeded,
  "payment.failed": handleWhopPaymentFailed,
  "payment.canceled": handleWhopPaymentFailed,
  // Both refund events route to one resolver: neither name carries an
  // outcome, so the fetched `refund.status` is the only thing that can decide.
  "refund.created": handleWhopRefund,
  "refund.updated": handleWhopRefund,
  // Both dispute events route to one resolver: neither name carries an
  // outcome, so the fetched `dispute.status` is the only thing that decides.
  "dispute.created": handleWhopDispute,
  "dispute.updated": handleWhopDispute,
  // Alerts and cases are separate subjects with separate resolvers, and
  // NEITHER posts money — see their handlers for why.
  "dispute_alert.created": handleWhopDisputeAlert,
  "resolution_center_case.created": handleWhopResolutionCase,
  "resolution_center_case.updated": handleWhopResolutionCase,
  "resolution_center_case.decided": handleWhopResolutionCase,
  // The second name for the same subject — see SUPPORTED_EVENTS.
  "resolution.created": handleWhopResolutionCase,
  "resolution.updated": handleWhopResolutionCase,
  "resolution.decided": handleWhopResolutionCase,
  // Both withdrawal families route to the same resolver. Neither name is trusted
  // to carry an outcome — the resolver looks the id up among our own withdrawals
  // for this environment and then asks the provider.
  "payout.created": (id, wid, body) => handleWhopPayoutUpdated(id, wid, body),
  "payout.updated": (id, wid, body) => handleWhopPayoutUpdated(id, wid, body),
  "payout.reversed": (id, wid, body) => handleWhopPayoutUpdated(id, wid, body),
  // Transfers are the other resource and get the mirror resolver. All three
  // route to one handler for the same reason the refund and dispute families do:
  // the event name is a trigger, and the provider's own status decides.
  "transfer.created": (id, wid, body) => handleWhopTransferUpdated(id, wid, body),
  "transfer.completed": (id, wid, body) => handleWhopTransferUpdated(id, wid, body),
  "transfer.failed": (id, wid, body) => handleWhopTransferUpdated(id, wid, body),
  "account.updated": (_id, _wid, body) => handleWhopAccountUpdated(body),
};

/* ------------------------------ processing -------------------------------- */

/**
 * States a delivery never needs to be processed from again. Reaching one of
 * these is what releases the processing lease.
 */
export const TERMINAL_STATUSES = [
  "processed",
  "awaiting_mapping",
  "unsupported",
  "rejected_company",
] as const;

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/**
 * How long an instance may hold a delivery before another may take it over.
 *
 * A serverless function that has not finished in this long is dead, not slow:
 * platform execution limits are far shorter. The window only has to exceed the
 * longest legitimate handler run, and every value below it trades a stuck
 * webhook for a possible double execution — so it is deliberately generous.
 */
export const PROCESSING_LEASE_SECONDS = 5 * 60;

/**
 * EVERY receipt timestamp comes from Postgres, never from this process.
 *
 * `received_at` already defaulted to the database's `now()`. When
 * `processed_at` was stamped with a JS `Date`, the two came from different
 * clocks — the first real delivery recorded a receipt processed 229ms BEFORE
 * it arrived, purely from skew between this machine and Neon. A lifecycle that
 * can run backwards is not one anybody can reason about, and the lease
 * comparison inherited the same flaw: a local clock running fast would expire
 * a lease that was still live.
 */
const dbNow = sql`now()`;

/**
 * Records and dispatches ONE verified delivery.
 *
 * ACQUISITION IS ATOMIC, IN TWO SHAPES, AND NEVER A READ-THEN-DECIDE:
 *
 *   1. `insert … on conflict (webhook_id) do nothing … returning` — a first
 *      delivery. A returned row means we own it; nothing returned means the
 *      row already exists.
 *   2. `update … where webhook_id = $1 and (retryable) … returning` — a
 *      redelivery. The eligibility test lives in the WHERE clause, so Postgres
 *      takes a row lock and evaluates it against the committed state. Two
 *      instances racing on the same `failed` receipt cannot both match: the
 *      loser re-reads the row the winner just committed, sees `received` with
 *      a fresh lease, and its WHERE no longer holds.
 *
 * A row only reaches a terminal status after its handler has actually
 * returned. `failed` is not terminal, so a redelivery may retry it. Neither is
 * a `received` row whose lease has expired — that is an instance that died
 * mid-handler, and without that rule a verified payment would be stuck in
 * `received` forever.
 *
 * A delivery that arrives while another instance holds a LIVE lease is not
 * acknowledged. Answering 2xx there would let Whop stop retrying an event
 * whose owner may still crash; a non-2xx brings it back after the lease has
 * either been released or gone stale.
 */
export async function processVerifiedWebhook(
  webhookId: string,
  body: unknown,
): Promise<WebhookOutcome> {
  const db = getDb();
  // Fail closed: with no database we cannot deduplicate, and processing an
  // event we cannot record is how a redelivery becomes a double effect.
  if (!db) return { ack: false, kind: "storage_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ack: false, kind: "unconfigured" };

  const { eventType, resourceId, companyId } = readEnvelope(body);

  // A verified event for someone else's company is quarantined, not processed —
  // UNLESS it originates from a known child (connected) account. Whop delivers
  // ALL events (platform + child) to the platform endpoint; child events carry
  // the child's `biz_` id as `company_id`. We check the DB before quarantining
  // so that payout and account events from creators flow through normally.
  const expectedCompany = getWhopCompanyId();
  const wrongCompany = Boolean(companyId && expectedCompany && companyId !== expectedCompany);
  const isChildAccount = wrongCompany && companyId
    ? (await resolveChildAccount(companyId)) !== null
    : false;

  const supported = isSupportedEvent(eventType);
  const initialStatus = (wrongCompany && !isChildAccount) ? "rejected_company" : supported ? "received" : "unsupported";

  // (1) First delivery. The primary key decides the winner, not the caller.
  const claimed = await db
    .insert(whopWebhookReceipts)
    .values({
      webhookId,
      eventType,
      resourceId,
      companyId,
      environment,
      status: initialStatus,
      claimedAt: initialStatus === "received" ? dbNow : null,
      processedAt: initialStatus === "received" ? null : dbNow,
    })
    .onConflictDoNothing({ target: whopWebhookReceipts.webhookId })
    .returning({ webhookId: whopWebhookReceipts.webhookId });

  if (claimed.length === 0) {
    // (2) Redelivery. One statement decides ownership AND counts the delivery:
    // eligible only when the previous attempt failed, or when it claimed the
    // row and then died without releasing it.
    const reclaimed = await db
      .update(whopWebhookReceipts)
      .set({
        status: "received",
        claimedAt: dbNow,
        failureCategory: null,
        deliveryCount: sql`${whopWebhookReceipts.deliveryCount} + 1`,
      })
      .where(
        and(
          eq(whopWebhookReceipts.webhookId, webhookId),
          or(
            eq(whopWebhookReceipts.status, "failed"),
            and(
              eq(whopWebhookReceipts.status, "received"),
              or(
                isNull(whopWebhookReceipts.claimedAt),
                // Compared entirely inside Postgres, so the lease window is
                // measured against the same clock that stamped it.
                sql`${whopWebhookReceipts.claimedAt} < now() - make_interval(secs => ${PROCESSING_LEASE_SECONDS})`,
              ),
            ),
          ),
        ),
      )
      .returning({ webhookId: whopWebhookReceipts.webhookId });

    if (reclaimed.length === 0) {
      // Not eligible: either already terminal, or someone holds a live lease.
      // Count the delivery and read the status in the SAME statement, so the
      // answer cannot be stale by the time it is used.
      const [current] = await db
        .update(whopWebhookReceipts)
        .set({ deliveryCount: sql`${whopWebhookReceipts.deliveryCount} + 1` })
        .where(eq(whopWebhookReceipts.webhookId, webhookId))
        .returning({ status: whopWebhookReceipts.status });

      // Terminal: the work is done, and repeating it is exactly what must not
      // happen. Acknowledge so Whop stops.
      if (current && TERMINAL.has(current.status)) return { ack: true, status: "duplicate" };

      // In flight elsewhere, or the row vanished under us. Do NOT acknowledge:
      // ask for the delivery again once the lease has resolved either way.
      return { ack: false, kind: "processing_in_flight" };
    }
    // Reclaimed: we now own a previously failed or abandoned delivery.
  }

  if (wrongCompany && !isChildAccount) return { ack: true, status: "rejected_company" };
  if (!supported) return { ack: true, status: "unsupported" };

  // AUTHORITATIVE OWNERSHIP, before any handler.
  //
  // The payload's own `company_id` is a courtesy, not evidence — the first
  // real sandbox delivery omitted it entirely. For every event that will one
  // day move money, the resource is fetched back from Whop and its owning
  // account compared to ours. This sits between the receipt and the dispatch
  // so a future handler cannot run without it having passed: the only route to
  // `HANDLERS` is through this gate.
  const verifyOwnership = OWNERSHIP_GATED[eventType];
  if (verifyOwnership) {
    const ownership = await verifyOwnership(resourceId);

    // `verified_unmatched` passes with `verified`: an alert Whop matched to no
    // payment is readable, is not another company's, and can never post — see
    // the type. Every other kind stops the dispatch.
    if (ownership.kind !== "verified" && ownership.kind !== "verified_unmatched") {
      // Whop signed it, but it is not ours: quarantine terminally. Retrying
      // would reach the same answer.
      if (ownership.kind === "wrong_company") {
        await db
          .update(whopWebhookReceipts)
          .set({
            status: "rejected_company",
            failureCategory: "ownership_mismatch",
            processedAt: dbNow,
            claimedAt: null,
          })
          .where(eq(whopWebhookReceipts.webhookId, webhookId));
        return { ack: true, status: "rejected_company" };
      }

      // Could not PROVE ownership. Fail closed either way — an unprovable
      // payment never reaches a money handler — but the ANSWER to Whop
      // depends on whether asking again could change anything.
      //
      // An OUTAGE (timeout, 429, 5xx, no credentials) is a reason to be asked
      // again: nothing was decided, and acknowledging would let Whop stop
      // retrying an event we never resolved.
      //
      // A DEFINITIVE answer is not. A malformed id can never become
      // well-formed, and a 404 that has already survived several deliveries is
      // an id that does not exist on this environment — a production id
      // reaching a sandbox key looks exactly like this. Retrying those forever
      // buries the real signal and never converges. `delivery_count` is read
      // back from the row so the bound is measured against actual deliveries,
      // not against anything this process is holding.
      const [{ deliveryCount }] = await db
        .update(whopWebhookReceipts)
        .set({ status: "failed", failureCategory: ownership.kind, claimedAt: null })
        .where(eq(whopWebhookReceipts.webhookId, webhookId))
        .returning({ deliveryCount: whopWebhookReceipts.deliveryCount });

      // A resource that names no payment is DEFINITIVE and never retried. A
      // dispute or case will not grow a payment reference on redelivery, and
      // asking again would churn a receipt forever over an answer that cannot
      // change. It is not in `LookupFailure` for exactly that reason: it is a
      // shape problem with the resource, not a failure to look it up.
      const retryable =
        ownership.kind !== "no_payment_reference" &&
        shouldRetryLookup(ownership.kind, deliveryCount);

      if (retryable) return { ack: false, kind: "processing_failed" };

      // Exhausted. The receipt stays `failed` rather than being dressed up as
      // processed — nothing was handled, and reconciliation can still see it —
      // but we stop asking Whop to repeat an answer that will not change.
      return { ack: true, status: "unresolvable" };
    }
  }

  try {
    const result = await HANDLERS[eventType](resourceId, webhookId, body);

    if (result.kind === "failed") {
      await db
        .update(whopWebhookReceipts)
        .set({ status: "failed", failureCategory: result.category, claimedAt: null })
        .where(eq(whopWebhookReceipts.webhookId, webhookId));
      return { ack: false, kind: "processing_failed" };
    }

    const status = result.kind === "handled" ? "processed" : "awaiting_mapping";

    // Best-effort notifications: fire after the handler succeeds but before
    // the receipt is committed. A notification failure NEVER fails the delivery.
    if (status === "processed") {
      await fireWebhookNotifications(eventType, resourceId, body).catch(() => {});
    }

    await db
      .update(whopWebhookReceipts)
      .set({ status, processedAt: dbNow, failureCategory: null, claimedAt: null })
      .where(eq(whopWebhookReceipts.webhookId, webhookId));

    return { ack: true, status: status === "processed" ? "accepted" : "awaiting_mapping" };
  } catch (error) {
    // The category is a label, never the message — an SDK or driver error can
    // quote a request, and a request carries credentials.
    await db
      .update(whopWebhookReceipts)
      .set({ status: "failed", failureCategory: "handler_exception", claimedAt: null })
      .where(eq(whopWebhookReceipts.webhookId, webhookId));
    console.error("[whop] webhook handler failed:", describeWhopError(error));
    return { ack: false, kind: "processing_failed" };
  }
}
