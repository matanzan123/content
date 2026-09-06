import "server-only";

import { WhopError } from "@whop/sdk";
import {
  describeWhopError,
  getWhopCompanyId,
  getWhopEnvironment,
  getWhopPaymentsClient,
} from "./whop-payments";
import { isPaymentId } from "./whop-resources";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "./money";
import { getPaymentOrder } from "./payment-orders";
import { recordRefund } from "./payment-refunds";
import {
  classifyRefundStatus,
  postsAccounting,
  targetRefundStatus,
} from "./refund-lifecycle";
import {
  isRefundId,
  listRefundsForPayment,
  retrieveRefund,
  type AuthoritativeRefund,
} from "./whop-refunds";

/* ==========================================================================
   REFUND → ORDER MAPPING — server only.

   Turns a verified webhook into a decision about ONE refund, and only after
   the provider's own records have agreed with ours on every particular.

   THE WEBHOOK BODY IS NOT THE INPUT. The refund is fetched back from Whop, the
   payment it names is fetched back from Whop, and every check below reads
   those fetched records: the refund id, the payment id, the owning account,
   the metadata, the amounts, the currencies and the statuses. A browser cannot
   reach any of them, and neither can the delivery payload.

   TEN CONDITIONS, all required:

     A  the refund exists at Whop
     B  the payment it names exists at Whop
     C  payment.account_id === WHOP_COMPANY_ID
     D  refund.account_id is ours, when Whop reports one
     E  payment.metadata.order_id names an order that exists
     F  the order's environment matches the configured one
     G  the refund's currency equals the order's currency
     H  the refund's amount is positive and does not exceed the payment
     I  the CUMULATIVE completed refunds Whop reports do not exceed the
        payment's own total
     J  the provider refund status is authoritative for what happens next

   I is the one that cannot be done from a single refund. It is computed by
   listing every refund Whop holds against the payment and summing the ones
   Whop itself calls `succeeded` — never by adding up our own rows, which are
   a mirror and would happily agree with themselves while both were wrong.

   THE EVENT NAME NEVER DECIDES THE OUTCOME, and here it could not even if we
   wanted it to: Whop has exactly two refund events, `refund.created` and
   `refund.updated`, and neither names an outcome. Both route to this function
   and the answer comes from the FETCHED `refund.status`.

   NOTHING HERE POSTS MONEY. This function resolves a refund and writes the
   operational row; the accounting is a separate step that runs after it, and
   only when this one reports a completed refund. That separation is what makes
   the crash-recovery case recoverable: the two are distinct, idempotent
   operations against distinct keys.

   THE ORIGINAL ORDER IS NOT TOUCHED. There is no update path to
   `payment_orders` in this module at all — not the status, not `paid_at`, not
   `whop_payment_id`. A refund does not un-pay an order: the payment really was
   collected, and the refund is a second economic event that says money went
   back. Deleting or downgrading the order would destroy the record of the
   first one.
   ========================================================================== */

export type RefundMappingOutcome =
  | {
      kind: "completed";
      refundId: string;
      paymentId: string;
      orderId: string;
      amountMinor: bigint;
      currency: string;
      /** True when our row already said `completed` before this delivery. */
      alreadyCompleted: boolean;
    }
  | { kind: "pending"; refundId: string; orderId: string }
  | { kind: "failed_recorded"; refundId: string; orderId: string }
  | {
      kind: "rejected";
      reason:
        | "invalid_refund_id"
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "malformed_refund"
        | "invalid_payment_id"
        | "wrong_company"
        | "no_order_reference"
        | "order_not_found"
        | "environment_mismatch"
        | "order_not_paid"
        | "payment_mismatch"
        | "currency_mismatch"
        | "amount_unreadable"
        | "amount_exceeds_payment"
        | "cumulative_refund_overflow"
        | "refund_identity_conflict"
        | "storage_error";
      detail?: string;
    };

/** The slice of the underlying payment a refund has to be checked against. */
type RefundedPayment = {
  id: string;
  accountId: string | null;
  orderId: string | null;
  /** The gross the customer was charged, tax included. The refund ceiling. */
  totalMinor: bigint | null;
  currency: string | null;
};

function readOrderId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).order_id;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * The refund ceiling is the payment's TOTAL, not its subtotal.
 *
 * This differs from `whop-payment-mapping.ts` on purpose, and the difference
 * is not an inconsistency. That module compares against `subtotal` because it
 * is matching the PRICE WE AUTHORED against the order we wrote. This one is
 * bounding how much money can flow back to a buyer, and the buyer paid the
 * total — tax included. Bounding a refund by the subtotal would refuse a
 * legitimate full refund of a taxed payment.
 */
function readTotal(payment: {
  total?: { amount: string; currency: string; decimals: number } | null;
  subtotal?: { amount: string; currency: string; decimals: number } | null;
}): { minor: bigint | null; currency: string | null } {
  const money = payment.total ?? payment.subtotal ?? null;
  if (!money) return { minor: null, currency: null };

  const raw = typeof money.currency === "string" ? money.currency.trim().toLowerCase() : "";
  const currency = /^[a-z]{3}$/.test(raw) ? raw : null;

  const supported = normaliseCurrency(raw);
  if (!supported) return { minor: null, currency };

  const decimals = currencyDecimals(supported);
  if (decimals === null || money.decimals !== decimals) return { minor: null, currency };

  return { minor: decimalToMinor(money.amount, decimals), currency };
}

async function fetchRefundedPayment(
  paymentId: string,
): Promise<
  { ok: true; payment: RefundedPayment } | { ok: false; outcome: RefundMappingOutcome }
> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: { kind: "rejected", reason: "unconfigured" } };

  try {
    const p = await client.payments.retrieve({ id: paymentId });
    const total = readTotal(p);
    return {
      ok: true,
      payment: {
        id: p.id,
        accountId: p.account_id,
        orderId: readOrderId(p.metadata),
        totalMinor: total.minor,
        currency: total.currency,
      },
    };
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, outcome: { kind: "rejected", reason: "resource_not_found" } };
    }
    console.error("[whop] refunded payment fetch failed:", describeWhopError(error));
    return { ok: false, outcome: { kind: "rejected", reason: "provider_error" } };
  }
}

/**
 * The cumulative amount Whop itself reports as COMPLETELY refunded against one
 * payment, INCLUDING the refund under consideration.
 *
 * Computed from `refunds.list`, filtered to `succeeded` by the same classifier
 * the rest of the build uses. `refund` is folded in explicitly rather than
 * assumed present: Whop's list is eventually consistent with a refund that has
 * only just changed status, and a total that silently omitted the very refund
 * we are about to post would make the overflow check useless in exactly the
 * case it exists for.
 */
export function cumulativeCompletedMinor(
  refunds: AuthoritativeRefund[],
  refund: AuthoritativeRefund,
): bigint {
  let total = BigInt(0);
  let sawThisOne = false;

  for (const candidate of refunds) {
    if (candidate.refundId === refund.refundId) {
      sawThisOne = true;
      // Use OUR fetched copy of this refund, not the list's, so the figure the
      // check runs on is the same one the posting will use.
      if (postsAccounting(classifyRefundStatus(refund.status))) total += refund.amountMinor;
      continue;
    }
    if (postsAccounting(classifyRefundStatus(candidate.status))) total += candidate.amountMinor;
  }

  if (!sawThisOne && postsAccounting(classifyRefundStatus(refund.status))) {
    total += refund.amountMinor;
  }
  return total;
}

/**
 * Resolves ONE refund against our orders and writes the operational row — and
 * only that row.
 *
 * The caller passes a refund id, never a body. Every figure below comes from
 * Whop.
 */
export async function mapRefundToOrder(refundId: unknown): Promise<RefundMappingOutcome> {
  if (!isRefundId(refundId)) return { kind: "rejected", reason: "invalid_refund_id" };

  const environment = getWhopEnvironment();
  const expectedCompany = getWhopCompanyId();
  if (!environment || !expectedCompany) return { kind: "rejected", reason: "unconfigured" };

  // A — the refund must exist and be readable.
  const fetched = await retrieveRefund(refundId);
  if (!fetched.ok) {
    switch (fetched.reason) {
      case "resource_not_found":
        return { kind: "rejected", reason: "resource_not_found" };
      case "provider_error":
        return { kind: "rejected", reason: "provider_error" };
      case "unconfigured":
        return { kind: "rejected", reason: "unconfigured" };
      case "invalid_resource_id":
        return { kind: "rejected", reason: "invalid_refund_id" };
      default:
        return { kind: "rejected", reason: "malformed_refund", detail: fetched.reason };
    }
  }
  const refund = fetched.refund;

  // D — when Whop names an account on the refund, it must be ours.
  if (refund.accountId !== null && refund.accountId !== expectedCompany) {
    return { kind: "rejected", reason: "wrong_company", detail: "refund account" };
  }

  // The payment id must at least be shaped like one before we spend a call.
  if (!isPaymentId(refund.paymentId)) {
    return { kind: "rejected", reason: "invalid_payment_id" };
  }

  // B — the payment must exist.
  const loaded = await fetchRefundedPayment(refund.paymentId);
  if (!loaded.ok) return loaded.outcome;
  const payment = loaded.payment;

  // C — ownership, from the provider's record of the PAYMENT, not the payload
  // and not the refund's optional account field.
  if (!payment.accountId || payment.accountId !== expectedCompany) {
    return { kind: "rejected", reason: "wrong_company", detail: "payment account" };
  }

  // E — the correlation id must be present and must be one of ours.
  if (!payment.orderId) return { kind: "rejected", reason: "no_order_reference" };

  const order = await getPaymentOrder(payment.orderId);
  if (!order) return { kind: "rejected", reason: "order_not_found" };

  // F — sandbox money never refunds a production order, or the reverse.
  if (order.environment !== environment) {
    return { kind: "rejected", reason: "environment_mismatch" };
  }

  // THE REFUND MUST BE OF THE PAYMENT THAT SETTLED THIS ORDER.
  //
  // Both directions, and this is the check that catches a refund mapped to the
  // wrong payment. The order names a payment; the refund names a payment; if
  // those differ, the refund reverses a charge that did not settle this order,
  // whatever the metadata says.
  if (order.whopPaymentId === null) {
    // An order that was never settled cannot have money returned from it. This
    // is not a mismatch — it is an impossible refund, and saying so precisely
    // is what tells an operator to look at the ORDER rather than at the refund.
    return { kind: "rejected", reason: "order_not_paid" };
  }
  if (order.whopPaymentId !== payment.id) {
    return {
      kind: "rejected",
      reason: "payment_mismatch",
      detail: `order settled by ${order.whopPaymentId}`,
    };
  }

  // G — currency before amount: a number without its currency means nothing.
  if (payment.currency === null) return { kind: "rejected", reason: "amount_unreadable" };
  if (refund.currency !== order.currency || payment.currency !== order.currency) {
    return {
      kind: "rejected",
      reason: "currency_mismatch",
      detail: `refund ${refund.currency}, payment ${payment.currency}, order ${order.currency}`,
    };
  }

  if (payment.totalMinor === null) return { kind: "rejected", reason: "amount_unreadable" };

  // H — a single refund can never exceed the payment it reverses. Exact
  // integers, no tolerance, no rounding.
  if (refund.amountMinor > payment.totalMinor) {
    return {
      kind: "rejected",
      reason: "amount_exceeds_payment",
      detail: `${refund.amountMinor} > ${payment.totalMinor}`,
    };
  }

  // J — THE PROVIDER'S STATUS DECIDES, whatever the event was called.
  const phase = classifyRefundStatus(refund.status);
  const target = targetRefundStatus(phase);

  // I — CUMULATIVE OVERFLOW, and only for a refund that is actually going to
  // count. A pending refund does not consume the refundable balance yet, and
  // refusing one for an overflow that has not happened would block a refund
  // the provider may still decline anyway.
  if (postsAccounting(phase)) {
    const listed = await listRefundsForPayment(payment.id);
    if (!listed.ok) {
      // WE COULD NOT ASK. That is an outage, not a clean bill of health, and
      // the fail-safe direction is to write nothing: posting a refund whose
      // cumulative total we could not verify is how a payment gets refunded
      // twice. The delivery stays retryable.
      return { kind: "rejected", reason: "provider_error", detail: "refund list unavailable" };
    }

    const cumulative = cumulativeCompletedMinor(listed.refunds, refund);
    if (cumulative > payment.totalMinor) {
      // AN IMPOSSIBLE STATE, reported and not absorbed. Whop should not permit
      // this, and if it has happened the right response is to stop and have a
      // person look — not to post a journal that takes more money out of the
      // ledger than ever went into it.
      return {
        kind: "rejected",
        reason: "cumulative_refund_overflow",
        detail: `completed refunds ${cumulative} exceed payment ${payment.totalMinor}`,
      };
    }
  }

  // The operational row. Idempotent on the refund's own id, and guarded in SQL
  // so a stale snapshot cannot downgrade a completed refund.
  const recorded = await recordRefund({
    whopRefundId: refund.refundId,
    whopPaymentId: payment.id,
    orderId: order.orderId,
    environment,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    providerStatus: refund.status,
    status: target,
    failureReason: refund.failureReason,
  });

  if (!recorded.ok) {
    if (recorded.reason === "payment_conflict" || recorded.reason === "amount_conflict") {
      return { kind: "rejected", reason: "refund_identity_conflict", detail: recorded.reason };
    }
    return { kind: "rejected", reason: "storage_error" };
  }

  if (target === "completed") {
    return {
      kind: "completed",
      refundId: refund.refundId,
      paymentId: payment.id,
      orderId: order.orderId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      // `unchanged` here means the row was already `completed` and the update
      // was refused by the absorbing guard — which is exactly "we had already
      // completed this". It does NOT mean the accounting exists; that is a
      // separate key, and the caller posts regardless.
      alreadyCompleted: recorded.unchanged,
    };
  }

  return target === "failed"
    ? { kind: "failed_recorded", refundId: refund.refundId, orderId: order.orderId }
    : { kind: "pending", refundId: refund.refundId, orderId: order.orderId };
}

/* -------------------------------------------------------------------------
   REFUNDABLE BALANCE
   ------------------------------------------------------------------------- */

export type RefundableResult =
  | {
      ok: true;
      paymentId: string;
      currency: string;
      /** The payment's gross, tax included. */
      totalMinor: bigint;
      /** Sum of the refunds Whop reports as `succeeded`. */
      refundedMinor: bigint;
      /** `total - refunded`, floored at zero. */
      remainingMinor: bigint;
      /** Whop's own read on whether it would accept a refund at all. */
      providerRefundable: boolean;
    }
  | {
      ok: false;
      reason: "unconfigured" | "provider_error" | "resource_not_found" | "amount_unreadable";
      detail?: string;
    };

/**
 * How much of a payment could still be refunded, from provider facts alone.
 *
 * The maximum a refund may be created for, and the figure the creation
 * primitive bounds itself by. It reads nothing from our database: a caller
 * must not be able to widen the ceiling by writing to a row.
 *
 * TWO INDEPENDENT SOURCES, and the stricter wins. `payment.refunded_amount` is
 * Whop's own cumulative figure; the sum over `refunds.list` is the same fact
 * computed from the individual resources. They should agree, and when they do
 * not the LARGER refunded total is used — that is the direction that refuses a
 * refund rather than allowing one too many.
 */
export async function refundableBalance(paymentId: unknown): Promise<RefundableResult> {
  if (!isPaymentId(paymentId)) {
    return { ok: false, reason: "resource_not_found", detail: "invalid payment id" };
  }

  const client = getWhopPaymentsClient();
  const expectedCompany = getWhopCompanyId();
  if (!client || !expectedCompany) return { ok: false, reason: "unconfigured" };

  let payment;
  try {
    payment = await client.payments.retrieve({ id: paymentId });
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[whop] refundable lookup failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }

  if (!payment.account_id || payment.account_id !== expectedCompany) {
    return { ok: false, reason: "resource_not_found", detail: "not this company" };
  }

  const total = readTotal(payment);
  if (total.minor === null || total.currency === null) {
    return { ok: false, reason: "amount_unreadable", detail: "total" };
  }
  const currency = normaliseCurrency(total.currency);
  if (!currency) return { ok: false, reason: "amount_unreadable", detail: "currency" };
  const decimals = currencyDecimals(currency);
  if (decimals === null) return { ok: false, reason: "amount_unreadable", detail: "decimals" };

  // Source 1: Whop's cumulative figure on the payment.
  let reportedRefunded = BigInt(0);
  if (payment.refunded_amount) {
    const money = payment.refunded_amount;
    const sameCurrency =
      typeof money.currency === "string" && money.currency.trim().toLowerCase() === currency;
    if (!sameCurrency || money.decimals !== decimals) {
      return { ok: false, reason: "amount_unreadable", detail: "refunded_amount" };
    }
    const parsed = decimalToMinor(money.amount, decimals);
    if (parsed === null) return { ok: false, reason: "amount_unreadable", detail: "refunded_amount" };
    reportedRefunded = parsed;
  }

  // Source 2: the individual refund resources.
  const listed = await listRefundsForPayment(payment.id);
  if (!listed.ok) return { ok: false, reason: "provider_error", detail: "refund list" };

  let summedRefunded = BigInt(0);
  for (const refund of listed.refunds) {
    if (!postsAccounting(classifyRefundStatus(refund.status))) continue;
    if (refund.currency !== currency) {
      return { ok: false, reason: "amount_unreadable", detail: "refund currency" };
    }
    summedRefunded += refund.amountMinor;
  }

  // The stricter of the two. Disagreement is reported by reconciliation; here
  // it simply must not widen the ceiling.
  const refunded = summedRefunded > reportedRefunded ? summedRefunded : reportedRefunded;
  const remaining = total.minor > refunded ? total.minor - refunded : BigInt(0);

  return {
    ok: true,
    paymentId: payment.id,
    currency,
    totalMinor: total.minor,
    refundedMinor: refunded,
    remainingMinor: remaining,
    providerRefundable: payment.refundable === true,
  };
}
