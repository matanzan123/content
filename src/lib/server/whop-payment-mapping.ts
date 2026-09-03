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
import { getPaymentOrder, markOrderPaid, recordOrderAttempt } from "./payment-orders";

/* ==========================================================================
   PAYMENT → ORDER MAPPING — server only.

   Turns a verified webhook into a decision about ONE internal order, and only
   after the provider's own record has agreed with ours on every particular.

   THE WEBHOOK BODY IS NOT THE INPUT. The payment is fetched back from Whop and
   every check below reads the fetched record: the id, the owning account, the
   metadata, the amount, the currency and the status. A browser cannot reach
   any of them, and neither can the delivery payload.

   Eight conditions, all required:

     A  the order exists
     B  the order's environment matches the configured one
     C  payment.account_id === WHOP_COMPANY_ID
     D  payment.metadata.order_id === the order we loaded
     E  the payment amount equals the order's stored amount_minor, exactly
     F  the currency matches exactly
     G  the payment status is actually settled
     H  the payment is not already attached to a different order

   H is enforced by a UNIQUE index, not by a read — see `markOrderPaid`.

   NOTHING HERE WRITES `financial_ledger`. A paid order is a fact about a
   checkout; accounting for it is a later, separate step.
   ========================================================================== */

/**
 * Whop's own settled state for a payment resource.
 *
 * Note the vocabulary difference, which is easy to get wrong: the EVENT is
 * named `payment.succeeded`, but the RESOURCE reports `ReceiptStatus.Paid`.
 * Checking for a status called "succeeded" would never match anything.
 */
const SETTLED = "paid";
const IN_FLIGHT: ReadonlySet<string> = new Set(["open", "pending", "authorized", "draft"]);

export type MappingOutcome =
  | { kind: "paid"; orderId: string; alreadyPaid: boolean }
  | { kind: "pending"; orderId: string }
  | { kind: "failed_recorded"; orderId: string }
  | { kind: "ignored"; reason: "already_paid_elsewhere" | "not_settled" }
  | {
      kind: "rejected";
      reason:
        | "invalid_payment_id"
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "wrong_company"
        | "no_order_reference"
        | "order_not_found"
        | "environment_mismatch"
        | "order_mismatch"
        | "amount_mismatch"
        | "amount_unreadable"
        | "currency_mismatch"
        | "payment_already_used"
        | "not_settleable"
        | "storage_error";
    };

/** The narrow slice of a payment we are willing to hold in memory. */
type AuthoritativePayment = {
  id: string;
  accountId: string | null;
  orderId: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  status: string;
};

function readOrderId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).order_id;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * The amount to compare against our order.
 *
 * `subtotal` is the plan price — what we authored and what the order records.
 * `total` is that plus any tax added on top, so comparing against `total`
 * would make an order fail the moment tax collection is switched on. Falls
 * back to `total` only when a payment reports no subtotal.
 */
function readAmount(payment: {
  subtotal?: { amount: string; currency: string; decimals: number } | null;
  total?: { amount: string; currency: string; decimals: number } | null;
}): { minor: bigint | null; currency: string | null } {
  const money = payment.subtotal ?? payment.total ?? null;
  if (!money) return { minor: null, currency: null };

  // The currency is read even when it is one we do not support, so a payment
  // in the wrong currency is reported as a MISMATCH rather than as an
  // unreadable amount. Those are different faults and deserve different names.
  const raw = typeof money.currency === "string" ? money.currency.trim().toLowerCase() : "";
  const currency = /^[a-z]{3}$/.test(raw) ? raw : null;

  const supported = normaliseCurrency(raw);
  if (!supported) return { minor: null, currency };

  const decimals = currencyDecimals(supported);
  if (decimals === null || money.decimals !== decimals) return { minor: null, currency };

  return { minor: decimalToMinor(money.amount, decimals), currency };
}

/** Fetches the payment and reduces it to the fields we will act on. */
async function fetchPayment(
  paymentId: string,
): Promise<{ ok: true; payment: AuthoritativePayment } | { ok: false; outcome: MappingOutcome }> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: { kind: "rejected", reason: "unconfigured" } };

  try {
    const p = await client.payments.retrieve({ id: paymentId });
    const amount = readAmount(p);
    return {
      ok: true,
      payment: {
        id: p.id,
        accountId: p.account_id,
        orderId: readOrderId(p.metadata),
        amountMinor: amount.minor,
        currency: amount.currency,
        status: typeof p.status === "string" ? p.status : "",
      },
    };
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, outcome: { kind: "rejected", reason: "resource_not_found" } };
    }
    console.error("[whop] payment fetch failed:", describeWhopError(error));
    return { ok: false, outcome: { kind: "rejected", reason: "provider_error" } };
  }
}

/**
 * Resolves ONE payment against our orders and updates the order — and only the
 * order.
 *
 * `intent` says what the delivery claimed. It never overrides the provider's
 * own status: a `payment.succeeded` for a payment Whop does not report as paid
 * settles nothing.
 */
export async function mapPaymentToOrder(
  paymentId: unknown,
  intent: "succeeded" | "failed" | "pending",
): Promise<MappingOutcome> {
  if (!isPaymentId(paymentId)) return { kind: "rejected", reason: "invalid_payment_id" };

  const environment = getWhopEnvironment();
  const expectedCompany = getWhopCompanyId();
  if (!environment || !expectedCompany) return { kind: "rejected", reason: "unconfigured" };

  const fetched = await fetchPayment(paymentId);
  if (!fetched.ok) return fetched.outcome;
  const payment = fetched.payment;

  // C — ownership, from the provider's record, not the payload.
  if (!payment.accountId || payment.accountId !== expectedCompany) {
    return { kind: "rejected", reason: "wrong_company" };
  }

  // D — the correlation id must be present and must be one of ours.
  if (!payment.orderId) return { kind: "rejected", reason: "no_order_reference" };

  // A — the order must exist.
  const order = await getPaymentOrder(payment.orderId);
  if (!order) return { kind: "rejected", reason: "order_not_found" };

  // D again, the other direction: the row we loaded is the row named.
  if (order.orderId !== payment.orderId) return { kind: "rejected", reason: "order_mismatch" };

  // B — sandbox money never settles a production order, or the reverse.
  if (order.environment !== environment) return { kind: "rejected", reason: "environment_mismatch" };

  // A payment we cannot read a price off is not one we can match. Reported
  // separately so an unparseable or unsupported amount is not mistaken for a
  // genuine currency disagreement.
  // No currency at all: nothing here can be compared.
  if (payment.currency === null) return { kind: "rejected", reason: "amount_unreadable" };

  // F — currency before amount: a number without its currency means nothing.
  if (payment.currency !== order.currency) {
    return { kind: "rejected", reason: "currency_mismatch" };
  }

  // The currency matches but the amount would not parse exactly.
  if (payment.amountMinor === null) return { kind: "rejected", reason: "amount_unreadable" };

  // E — exact equality on integers. No tolerance, no rounding.
  if (payment.amountMinor !== order.amountMinor) {
    return { kind: "rejected", reason: "amount_mismatch" };
  }

  // G — the provider's status decides, whatever the event was called.
  if (payment.status !== SETTLED) {
    if (intent === "succeeded") return { kind: "ignored", reason: "not_settled" };

    // A late failure must never un-pay a settled order. The guard lives in the
    // UPDATE, so this is enforced by the database rather than by this branch.
    if (order.status === "paid") return { kind: "ignored", reason: "already_paid_elsewhere" };

    const next = intent === "failed" && !IN_FLIGHT.has(payment.status) ? "failed" : "payment_pending";
    const moved = await recordOrderAttempt(order.orderId, next);
    if (!moved) return { kind: "ignored", reason: "already_paid_elsewhere" };
    return next === "failed"
      ? { kind: "failed_recorded", orderId: order.orderId }
      : { kind: "pending", orderId: order.orderId };
  }

  // H — the unique index refuses a payment already attached elsewhere.
  const settled = await markOrderPaid(order.orderId, payment.id);
  if (!settled.ok) return { kind: "rejected", reason: settled.reason };

  return { kind: "paid", orderId: order.orderId, alreadyPaid: settled.alreadyPaid };
}
