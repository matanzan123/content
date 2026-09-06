import "server-only";

import { WhopError } from "@whop/sdk";
import {
  describeWhopError,
  getWhopEnvironment,
  getWhopPaymentsClient,
} from "./whop-payments";
import { getPaymentOrder, isOrderId } from "./payment-orders";
import { minorToDecimal, currencyDecimals } from "./money";
import { refundableBalance } from "./whop-refund-mapping";
import { listRefundsForPayment } from "./whop-refunds";

/* ==========================================================================
   ISSUING A REFUND — server only, and deliberately hard to misuse.

   THERE IS NO ROUTE THAT REACHES THIS FILE. No API handler imports it, no
   server action calls it, and no component can: `server-only` makes an import
   from a client component a build error. That is not an oversight to be fixed
   later — it is the deliverable. ClipRewards has no authorization model that
   says who may refund whom (there is admin/creator/brand in the analytics
   schema, but nothing that binds a person to an order), and shipping a refund
   endpoint before that exists would be shipping a way to move a stranger's
   money. The primitive is built, tested and unreachable until an owner-check
   exists to put in front of it.

   THE CALLER SUPPLIES AN ORDER ID AND AN AMOUNT. NOTHING ELSE.

   Specifically, a caller CANNOT supply:
     - the payment id       — read from the order, which is server-written
     - the currency         — read from the provider's own record of the payment
     - the mapping          — the order names its payment; no pair is accepted
     - the maximum          — computed from provider facts by
                              `refundableBalance`, never from our tables

   That is what "cannot authoritatively supply arbitrary order/payment mapping"
   means in practice: there is no parameter through which a mapping can be
   asserted, so there is nothing to forge. The worst a caller can do with a
   wrong order id is refund an order that exists — which is why an
   authorization check has to come first, and why this is not wired up.

   INTEGER MINOR UNITS ALL THE WAY IN. `amountMinor` is a bigint and every
   comparison below is exact-integer. The conversion to the float the API wants
   happens at the LAST possible moment, once, through `minorToDecimal`, and is
   verified to round-trip before the request is sent.

   IDEMPOTENCY: WHOP OFFERS NONE, AND THIS FILE DOES NOT PRETEND OTHERWISE.
   `POST /payments/{id}/refund` takes only `id` and `partial_amount` — there is
   no idempotency-key parameter in the endpoint, the SDK's
   `RefundPaymentsRequest`, or the request options. Calling it twice creates
   TWO refunds. The mitigation is a pre-flight check against the provider's own
   refundable balance plus a caller-supplied intent guard, and its limits are
   stated honestly in `RefundIntent` below rather than papered over with a key
   the provider would ignore.

   NOT PERFORMED IN THIS BUILD. Nothing here has been run against the real
   sandbox payment, by instruction. The code path is exercised by tests through
   an injected client.
   ========================================================================== */

/** Whop's own error vocabulary for this endpoint, preserved rather than flattened. */
export type RefundErrorClass =
  /** 400 — the request was malformed or the amount was not acceptable. */
  | "bad_request"
  /** 401 — the API key is missing or wrong. */
  | "unauthorized"
  /** 403 — the key is valid but may not act on this payment. */
  | "forbidden"
  /** 404 — no such payment on this environment. */
  | "not_found"
  /** 409 — Whop refused the state: already fully refunded, disputed, etc. */
  | "conflict"
  /** 422 — Whop wants a verification step completed first. */
  | "verification_required"
  /** 429 — rate limited. The one error where the same request may be retried. */
  | "rate_limited"
  /** 5xx or a transport failure. Retryable, but only with care: see below. */
  | "provider_error";

function classifyRefundError(error: unknown): RefundErrorClass {
  const status = error instanceof WhopError ? error.statusCode : undefined;
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "verification_required";
    case 429:
      return "rate_limited";
    default:
      return "provider_error";
  }
}

/**
 * WHETHER A FAILED REFUND REQUEST MAY BE RETRIED AUTOMATICALLY. Almost none
 * may.
 *
 * This is stricter than the payment-side retry rule on purpose, and the
 * asymmetry is the point: a retried READ costs a request, while a retried
 * WRITE against an endpoint with no idempotency key can issue a SECOND refund.
 * A `provider_error` in particular is NOT retryable here even though it is a
 * genuine outage class — a 500 or a timeout may mean the refund was created
 * and the response was lost, and re-sending would refund twice.
 *
 * Only `rate_limited` is safe: a 429 is refused before the refund is created.
 */
export function isRetryableRefundError(kind: RefundErrorClass): boolean {
  return kind === "rate_limited";
}

export type CreateRefundResult =
  | {
      ok: true;
      paymentId: string;
      orderId: string;
      /** What we asked Whop to return, in minor units. */
      requestedMinor: bigint;
      currency: string;
      /**
       * The refund resources Whop reports against the payment after the call,
       * newest first. The `rf_` id of the refund just created is normally the
       * first of these — but see `newRefundId`.
       */
      refundIds: string[];
      /**
       * The id of the refund this call created, when it can be identified
       * unambiguously: exactly one refund id exists now that did not exist
       * before. Null when it cannot be — which is honest rather than a guess,
       * and is why `payments.refund` returning a Payment instead of a Refund
       * is a real limitation of the API and not a detail.
       */
      newRefundId: string | null;
    }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "invalid_order_id"
        | "order_not_found"
        | "order_not_paid"
        | "environment_mismatch"
        | "invalid_amount"
        | "exceeds_refundable"
        | "not_refundable"
        | "amount_unrepresentable"
        | "intent_precondition_failed"
        | RefundErrorClass;
      detail?: string;
    };

/**
 * A caller's declaration of what it believes it is doing.
 *
 * WHY THIS EXISTS. Whop's refund endpoint has no idempotency key, so nothing
 * the provider offers can stop a double-submit. What CAN stop one is a
 * precondition the caller states in advance and the server checks against
 * provider truth immediately before acting: "refund $2, and only if $10 is
 * still refundable". A retry of that same request arrives to find $8
 * refundable, the precondition fails, and no second refund is created.
 *
 * ITS LIMITS, STATED PLAINLY. This narrows the race window; it does not close
 * it. Two requests that both check before either acts will both pass. It is a
 * guard against a repeated click and a retried job, not against genuine
 * concurrency — that needs either an idempotency key from Whop or a local lock
 * around the mutation, and the honest thing is to say so rather than to imply
 * a guarantee this cannot give.
 */
export type RefundIntent = {
  /** Refuse unless the provider reports exactly this much still refundable. */
  expectedRemainingMinor?: bigint;
};

/**
 * Issues a refund against the payment that settled ONE of our orders.
 *
 * `client` is injectable so the whole path — the bounds, the conversion, the
 * error classification — can be tested without a network and without ever
 * touching the real sandbox payment.
 */
export async function createRefundForOrder(
  orderId: unknown,
  amountMinor: bigint | null,
  intent: RefundIntent = {},
  client = getWhopPaymentsClient(),
): Promise<CreateRefundResult> {
  const environment = getWhopEnvironment();
  if (!client || !environment) return { ok: false, reason: "unconfigured" };

  if (!isOrderId(orderId)) return { ok: false, reason: "invalid_order_id" };

  // THE MAPPING COMES FROM THE ORDER, NOT FROM THE CALLER.
  const order = await getPaymentOrder(orderId);
  if (!order) return { ok: false, reason: "order_not_found" };
  if (order.environment !== environment) return { ok: false, reason: "environment_mismatch" };
  if (order.status !== "paid" || !order.whopPaymentId) {
    return { ok: false, reason: "order_not_paid" };
  }

  const paymentId = order.whopPaymentId;

  // THE CEILING COMES FROM WHOP, NOT FROM OUR TABLES. A corrupted order row
  // could make this ask about the wrong payment; it could not make it refund
  // more than that payment has left.
  const balance = await refundableBalance(paymentId);
  if (!balance.ok) {
    return {
      ok: false,
      reason: balance.reason === "provider_error" ? "provider_error" : "not_refundable",
      detail: balance.detail ?? balance.reason,
    };
  }

  // The currency is the PROVIDER'S, verified against the order rather than
  // taken from it — and never from a caller, who has no parameter for it.
  if (balance.currency !== order.currency) {
    return {
      ok: false,
      reason: "not_refundable",
      detail: `provider ${balance.currency}, order ${order.currency}`,
    };
  }

  if (!balance.providerRefundable) {
    return { ok: false, reason: "not_refundable", detail: "provider says not refundable" };
  }

  // The caller's precondition, checked against what Whop just told us.
  if (
    intent.expectedRemainingMinor !== undefined &&
    intent.expectedRemainingMinor !== balance.remainingMinor
  ) {
    return {
      ok: false,
      reason: "intent_precondition_failed",
      detail: `expected ${intent.expectedRemainingMinor}, provider says ${balance.remainingMinor}`,
    };
  }

  // `null` means a FULL refund of what remains — computed, not assumed to be
  // the payment total, because an earlier partial refund may already have gone.
  const requestedMinor = amountMinor ?? balance.remainingMinor;

  if (typeof requestedMinor !== "bigint" || requestedMinor <= BigInt(0)) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (requestedMinor > balance.remainingMinor) {
    return {
      ok: false,
      reason: "exceeds_refundable",
      detail: `${requestedMinor} > ${balance.remainingMinor}`,
    };
  }

  // WHAT EXISTED BEFORE, so the new refund can be identified afterwards.
  // Taken before the mutation for the obvious reason.
  const before = await listRefundsForPayment(paymentId);
  const knownIds = new Set(before.ok ? before.refunds.map((r) => r.refundId) : []);

  /* --- the one place a bigint becomes the number the API wants --- */

  const decimals = currencyDecimals(balance.currency);
  if (decimals === null) return { ok: false, reason: "amount_unrepresentable" };

  const decimal = minorToDecimal(requestedMinor, decimals);
  if (decimal === null) return { ok: false, reason: "amount_unrepresentable" };

  const partialAmount = Number(decimal);
  // ROUND-TRIP OR REFUSE. `partial_amount` is typed `number`, and a value that
  // does not survive the conversion exactly would refund an amount other than
  // the one that passed every check above. Refusing is the only safe answer:
  // there is no correct way to refund "approximately" a figure.
  if (!Number.isFinite(partialAmount) || partialAmount.toFixed(decimals) !== decimal) {
    return { ok: false, reason: "amount_unrepresentable", detail: decimal };
  }

  /* --- the mutation --- */

  try {
    // A FULL refund omits `partial_amount` entirely, as Whop documents. Sending
    // the computed total instead would be equivalent only while nothing else
    // has been refunded, and would drift from Whop's own idea of "full" the
    // moment a partial refund exists.
    const isFullRemaining = requestedMinor === balance.remainingMinor;
    await client.payments.refund(
      isFullRemaining && amountMinor === null
        ? { id: paymentId }
        : { id: paymentId, partial_amount: partialAmount },
    );
  } catch (error) {
    const kind = classifyRefundError(error);
    console.error("[whop] refund creation failed:", kind, describeWhopError(error));
    return { ok: false, reason: kind };
  }

  /* --- what the mutation produced --- */

  // `payments.refund` returns the updated PAYMENT, not the refund it created,
  // so the `rf_` id has to be discovered. This is a documented shape of the
  // API rather than a shortcoming of the call.
  const after = await listRefundsForPayment(paymentId);
  if (!after.ok) {
    // THE REFUND WAS ISSUED. Failing to enumerate it afterwards does not undo
    // it, and reporting failure here would invite a caller to retry a mutation
    // that already succeeded. The webhook and the reconciliation pass will both
    // find it; this call simply cannot name it.
    return {
      ok: true,
      paymentId,
      orderId: order.orderId,
      requestedMinor,
      currency: balance.currency,
      refundIds: [],
      newRefundId: null,
    };
  }

  const refundIds = after.refunds.map((r) => r.refundId);
  const appeared = refundIds.filter((id) => !knownIds.has(id));

  return {
    ok: true,
    paymentId,
    orderId: order.orderId,
    requestedMinor,
    currency: balance.currency,
    refundIds,
    // Exactly one new id is an identification. Zero or several is not, and is
    // reported as "unknown" rather than resolved by picking the newest — a
    // guess here would attach the wrong `rf_` id to an operator's record of
    // what they just did.
    newRefundId: appeared.length === 1 ? appeared[0] : null,
  };
}
