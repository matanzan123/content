import "server-only";

import { getWhopEnvironment } from "./whop-payments";
import { getPaymentOrder, isOrderId, type PaymentOrder } from "./payment-orders";
import { buildCheckoutReturnUrl } from "./app-url";

/* ==========================================================================
   CHECKOUT SESSION DTO — the only shape that crosses to the browser.

   Everything here is assembled field by field from an order row. A provider
   object is never spread into a response: a Whop payment or configuration
   carries balances, buyer records and billing addresses, and one careless
   `...response` would put all of it in a page's hydration data.

   The plan id is deliberately NOT here. The embed mounts by session, so the
   browser has no use for it, and a provider identifier the browser does not
   need is one it should not be given. It stays in the database for
   reconciliation.

   THE BROWSER NAMES AN ORDER AND NOTHING ELSE. The session id, plan id,
   amount and currency in this DTO are read from the DATABASE for that order.
   A `ch_`, `plan_`, `pay_` or `biz_` value in a request is never used for
   anything — there is no code path that accepts one.
   ========================================================================== */

/** Provider identifier shapes. A stored value that fails these is not usable. */
const CHECKOUT_ID = /^ch_[A-Za-z0-9]{1,64}$/;
const PLAN_ID = /^plan_[A-Za-z0-9]{1,64}$/;

export function isCheckoutId(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_ID.test(value);
}

export function isPlanId(value: unknown): value is string {
  return typeof value === "string" && PLAN_ID.test(value);
}

/**
 * What the embed needs, and nothing more.
 *
 * `sessionId` is the checkout configuration the server created and stored. It
 * is what carries `metadata.order_id` through to the payment, which is the
 * whole reason the webhook can find its way back to this order.
 */
export type CheckoutSessionDto = {
  order_id: string;
  /** The stored `ch_` configuration id. Mounting by plan alone loses metadata. */
  session_id: string;
  environment: "sandbox" | "production";
  status: string;
  /** Minor units as a string, so a bigint never becomes a float in JSON. */
  amount_minor: string;
  currency: string;
  /** Where the provider returns the buyer. Server-generated, never accepted. */
  return_url: string;
};

export type SessionResult =
  | { ok: true; session: CheckoutSessionDto }
  | {
      ok: false;
      reason:
        | "invalid_order_id"
        | "order_not_found"
        | "unconfigured"
        | "environment_mismatch"
        | "already_paid"
        | "order_closed"
        | "no_checkout"
        | "malformed_provider_reference"
        | "missing_return_url";
    };

/**
 * Builds the DTO for an order that ALREADY has a checkout.
 *
 * Deliberately does not create anything. It validates that the stored state is
 * usable and refuses otherwise: a malformed provider id in the database is a
 * fault to surface, not something to pass to a payment form and hope.
 *
 * No provider read happens here. The identifiers were written by our own
 * server from a verified provider response, and re-fetching Whop on every
 * render would add a network dependency to a page load without adding a
 * guarantee — the checks that matter for money all run again, against the
 * provider, when the webhook arrives.
 */
export function buildCheckoutSession(order: PaymentOrder, locale: string): SessionResult {
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "unconfigured" };

  // An order from the other environment must never be rendered here.
  if (order.environment !== environment) return { ok: false, reason: "environment_mismatch" };

  if (order.status === "paid") return { ok: false, reason: "already_paid" };
  if (order.status === "cancelled") return { ok: false, reason: "order_closed" };

  if (!order.whopCheckoutId || !order.whopPlanId) return { ok: false, reason: "no_checkout" };

  // Stale or corrupt database state is refused rather than handed to the embed.
  if (!isCheckoutId(order.whopCheckoutId) || !isPlanId(order.whopPlanId)) {
    return { ok: false, reason: "malformed_provider_reference" };
  }

  const returnUrl = buildCheckoutReturnUrl(order.orderId, locale);
  if (!returnUrl) return { ok: false, reason: "missing_return_url" };

  return {
    ok: true,
    session: {
      order_id: order.orderId,
      session_id: order.whopCheckoutId,
      environment,
      status: order.status,
      amount_minor: order.amountMinor.toString(),
      currency: order.currency,
      return_url: returnUrl,
    },
  };
}

/** Loads an order by id and builds its session DTO. */
export async function getCheckoutSession(orderId: unknown, locale: string): Promise<SessionResult> {
  if (!isOrderId(orderId)) return { ok: false, reason: "invalid_order_id" };
  const order = await getPaymentOrder(orderId);
  if (!order) return { ok: false, reason: "order_not_found" };
  return buildCheckoutSession(order, locale);
}
