import "server-only";

import {
  describeWhopError,
  getWhopCompanyId,
  getWhopEnvironment,
  getWhopPaymentsClient,
} from "./whop-payments";
import { currencyDecimals, minorToDecimal } from "./money";
import { buildCheckoutReturnUrl } from "./app-url";
import {
  attachCheckout,
  getPaymentOrder,
  isCheckoutEligible,
  isOrderId,
  type PaymentOrder,
} from "./payment-orders";

/* ==========================================================================
   WHOP CHECKOUT CREATION — server only.

   A checkout is built FROM an internal order. The price is read out of the
   database, converted exactly, and handed to Whop; it is never taken from the
   request that asked for the checkout. A browser can say "pay for order X" and
   nothing else — not how much, not in what currency, not for whose company.

   `metadata.order_id` is a CORRELATION identifier only. It travels to the
   payment so a webhook can find its way back to this order, and the webhook
   still re-checks amount, currency, company and status against the provider's
   own record. Metadata is a hint, never evidence.
   ========================================================================== */

export type CheckoutSession = {
  orderId: string;
  checkoutId: string;
  planId: string | null;
  /** Safe to render: the amount already agreed, for display only. */
  amountMinor: string;
  currency: string;
  environment: "sandbox" | "production";
};

export type CheckoutResult =
  | { ok: true; session: CheckoutSession; reused: boolean }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "invalid_order_id"
        | "order_not_found"
        | "already_paid"
        | "not_eligible"
        | "environment_mismatch"
        | "unsupported_currency"
        | "invalid_amount"
        | "missing_public_url"
        | "provider_error";
    };

/**
 * Creates — or safely reuses — a Whop checkout for an internal order.
 *
 * IDEMPOTENCY, on two levels:
 *
 *   1. An order that already carries a checkout id reuses it. Pressing the
 *      button twice does not accumulate provider objects, and the second press
 *      returns the first checkout.
 *   2. When one must be created, the request carries an idempotency key
 *      derived from the order id, so two concurrent requests that both get
 *      past step 1 still produce ONE checkout configuration at Whop rather
 *      than two.
 *
 * A `paid` order is refused outright: there is nothing left to pay, and
 * handing out a second checkout for it is how an order gets charged twice.
 */
export async function createWhopCheckoutForOrder(
  orderId: unknown,
  locale = "en",
): Promise<CheckoutResult> {
  if (!isOrderId(orderId)) return { ok: false, reason: "invalid_order_id" };

  const environment = getWhopEnvironment();
  const companyId = getWhopCompanyId();
  const client = getWhopPaymentsClient();
  if (!environment || !companyId || !client) return { ok: false, reason: "unconfigured" };

  const order = await getPaymentOrder(orderId);
  if (!order) return { ok: false, reason: "order_not_found" };

  // An order created in one environment must never be charged in the other.
  if (order.environment !== environment) return { ok: false, reason: "environment_mismatch" };
  if (order.status === "paid") return { ok: false, reason: "already_paid" };
  if (!isCheckoutEligible(order.status)) return { ok: false, reason: "not_eligible" };

  // Reuse. The checkout already exists and still describes the same amount,
  // because the amount cannot change once an order exists.
  if (order.whopCheckoutId) {
    return { ok: true, session: toSession(order, order.whopCheckoutId, order.whopPlanId), reused: true };
  }

  const decimals = currencyDecimals(order.currency);
  if (decimals === null) return { ok: false, reason: "unsupported_currency" };

  // Exact string conversion — no float touches a price on its way to Whop.
  const price = minorToDecimal(order.amountMinor, decimals);
  if (price === null) return { ok: false, reason: "invalid_amount" };

  // A redirect-based payment method has nowhere to return a buyer without
  // this, and a buyer stranded after paying is the worst outcome available.
  // Refused BEFORE the provider object is created, so a broken configuration
  // cannot leave a dangling checkout behind.
  const redirectUrl = buildCheckoutReturnUrl(order.orderId, locale);
  if (!redirectUrl) return { ok: false, reason: "missing_public_url" };

  try {
    const configuration = await client.checkoutConfigurations.create(
      {
        account_id: companyId,
        mode: "payment",
        currency: order.currency,
        metadata: { order_id: order.orderId },
        plan: {
          account_id: companyId,
          plan_type: "one_time",
          currency: order.currency,
          initial_price: Number(price),
          // Whop caps a plan title at 30 characters and rejects the whole
          // create with a 400 beyond it.
          title: "ClipRewards test payment",
          visibility: "hidden",
          metadata: { order_id: order.orderId },
        },
        redirect_url: redirectUrl,
      },
      // Two concurrent requests for one order create one configuration.
      { idempotencyKey: `order-${order.orderId}` },
    );

    const checkoutId = configuration.id;
    const planId = configuration.plan?.id ?? null;

    const attached = await attachCheckout(order.orderId, { checkoutId, planId });
    if (!attached) {
      // The order moved underneath us — most likely it settled. Refuse rather
      // than hand back a checkout for an order that no longer wants one.
      return { ok: false, reason: "not_eligible" };
    }

    return { ok: true, session: toSession(order, checkoutId, planId), reused: false };
  } catch (error) {
    // Never surfaced verbatim: a provider error can quote a request, and a
    // request carries credentials.
    console.error("[whop] checkout creation failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

function toSession(order: PaymentOrder, checkoutId: string, planId: string | null): CheckoutSession {
  return {
    orderId: order.orderId,
    checkoutId,
    planId,
    // A string, so a bigint amount never becomes a float on its way to a page.
    amountMinor: order.amountMinor.toString(),
    currency: order.currency,
    environment: order.environment,
  };
}
