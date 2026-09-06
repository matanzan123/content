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
import { recordAlert, recordCase, recordDispute } from "./payment-disputes";
import {
  classifyDisputeStatus,
  targetAlertStatus,
  targetCaseStatus,
  targetDisputeStatus,
} from "./dispute-lifecycle";
import {
  isDisputeAlertId,
  isDisputeId,
  isResolutionCaseId,
  retrieveDispute,
  retrieveDisputeAlert,
  retrieveResolutionCase,
} from "./whop-disputes";

/* ==========================================================================
   DISPUTE-FAMILY → ORDER MAPPING — server only.

   Turns a verified webhook into a decision about ONE resource, and only after
   the provider's own records have agreed with ours on every particular.

   THE WEBHOOK BODY IS NOT THE INPUT. The dispute, alert or case is fetched
   back from Whop, the payment it names is fetched back from Whop, and every
   check below reads those fetched records.

   THE CONDITIONS, all required:

     A  the resource exists at Whop and is readable
     B  its own account, when it reports one, is ours
     C  the payment it names exists at Whop
     D  payment.account_id === WHOP_COMPANY_ID
     E  payment.metadata.order_id names an order that exists
     F  the order's environment matches the configured one
     G  the order was actually settled by THAT payment
     H  the currency matches the order's
     I  the amount is readable and within the payment

   THE EVENT NAME NEVER DECIDES THE OUTCOME. `dispute.created` and
   `dispute.updated` both route here and the answer comes from the fetched
   `status`. The same is true of the three Resolution Center events.

   NOTHING HERE POSTS MONEY, AND NOTHING HERE TOUCHES AN ORDER. There is no
   update path to `payment_orders` in this module at all — not the status, not
   `paid_at`. A chargeback does not un-pay an order: the payment really was
   collected, and whatever the dispute does to the money is a separate, later
   economic event proved from the provider's ledger.
   ========================================================================== */

export type DisputeMappingOutcome =
  | {
      kind: "recorded";
      resourceId: string;
      paymentId: string;
      orderId: string;
      /** Our reduced status after the write. */
      status: string;
      /** True when the row was already terminal and this changed nothing. */
      unchanged: boolean;
    }
  | {
      kind: "rejected";
      reason:
        | "invalid_resource_id"
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "malformed_resource"
        | "invalid_payment_id"
        | "no_payment_reference"
        | "wrong_company"
        | "no_order_reference"
        | "order_not_found"
        | "environment_mismatch"
        | "order_not_paid"
        | "payment_mismatch"
        | "currency_mismatch"
        | "amount_unreadable"
        | "amount_exceeds_payment"
        | "resource_identity_conflict"
        | "storage_error";
      detail?: string;
    };

/** The slice of the underlying payment every mapping is checked against. */
type DisputedPayment = {
  id: string;
  accountId: string | null;
  orderId: string | null;
  totalMinor: bigint | null;
  currency: string | null;
};

function readOrderId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).order_id;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * The payment's gross, which bounds any disputed amount.
 *
 * `total` rather than `subtotal`, for the same reason the refund mapping uses
 * it: what a buyer can charge back is what the buyer paid, tax included.
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

async function fetchDisputedPayment(
  paymentId: string,
): Promise<
  { ok: true; payment: DisputedPayment } | { ok: false; outcome: DisputeMappingOutcome }
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
    console.error("[whop] disputed payment fetch failed:", describeWhopError(error));
    return { ok: false, outcome: { kind: "rejected", reason: "provider_error" } };
  }
}

/**
 * The checks every dispute-family resource shares, in one place.
 *
 * Extracted rather than repeated three times because these are the rules that
 * decide whether a stranger's chargeback can touch our books, and three copies
 * of them is three chances for one to drift.
 */
type ResolvedContext = {
  payment: DisputedPayment;
  orderId: string;
  environment: "sandbox" | "production";
};

async function resolveContext(
  resourceAccountId: string | null,
  paymentId: string | null,
  amountMinor: bigint,
  currency: string,
): Promise<{ ok: true; context: ResolvedContext } | { ok: false; outcome: DisputeMappingOutcome }> {
  const environment = getWhopEnvironment();
  const expectedCompany = getWhopCompanyId();
  if (!environment || !expectedCompany) {
    return { ok: false, outcome: { kind: "rejected", reason: "unconfigured" } };
  }

  // B — when the resource names an account, it must be ours.
  if (resourceAccountId !== null && resourceAccountId !== expectedCompany) {
    return {
      ok: false,
      outcome: { kind: "rejected", reason: "wrong_company", detail: "resource account" },
    };
  }

  if (paymentId === null) {
    return { ok: false, outcome: { kind: "rejected", reason: "no_payment_reference" } };
  }
  if (!isPaymentId(paymentId)) {
    return { ok: false, outcome: { kind: "rejected", reason: "invalid_payment_id" } };
  }

  // C — the payment must exist.
  const loaded = await fetchDisputedPayment(paymentId);
  if (!loaded.ok) return { ok: false, outcome: loaded.outcome };
  const payment = loaded.payment;

  // D — ownership, from the PAYMENT's own record. Never from the payload, and
  // never only from the resource's nullable account field.
  if (!payment.accountId || payment.accountId !== expectedCompany) {
    return {
      ok: false,
      outcome: { kind: "rejected", reason: "wrong_company", detail: "payment account" },
    };
  }

  // E — the correlation id must be present and must be one of ours.
  if (!payment.orderId) {
    return { ok: false, outcome: { kind: "rejected", reason: "no_order_reference" } };
  }
  const order = await getPaymentOrder(payment.orderId);
  if (!order) return { ok: false, outcome: { kind: "rejected", reason: "order_not_found" } };

  // F — sandbox and production never cross.
  if (order.environment !== environment) {
    return { ok: false, outcome: { kind: "rejected", reason: "environment_mismatch" } };
  }

  // G — the resource must concern the payment that actually settled the order.
  if (order.whopPaymentId === null) {
    return { ok: false, outcome: { kind: "rejected", reason: "order_not_paid" } };
  }
  if (order.whopPaymentId !== payment.id) {
    return {
      ok: false,
      outcome: {
        kind: "rejected",
        reason: "payment_mismatch",
        detail: `order settled by ${order.whopPaymentId}`,
      },
    };
  }

  // H — currency before amount: a number without its currency means nothing.
  if (payment.currency === null) {
    return { ok: false, outcome: { kind: "rejected", reason: "amount_unreadable" } };
  }
  if (currency !== order.currency || payment.currency !== order.currency) {
    return {
      ok: false,
      outcome: {
        kind: "rejected",
        reason: "currency_mismatch",
        detail: `resource ${currency}, payment ${payment.currency}, order ${order.currency}`,
      },
    };
  }

  // I — nothing can be disputed for more than was charged.
  if (payment.totalMinor === null) {
    return { ok: false, outcome: { kind: "rejected", reason: "amount_unreadable" } };
  }
  if (amountMinor > payment.totalMinor) {
    return {
      ok: false,
      outcome: {
        kind: "rejected",
        reason: "amount_exceeds_payment",
        detail: `${amountMinor} > ${payment.totalMinor}`,
      },
    };
  }

  return { ok: true, context: { payment, orderId: order.orderId, environment } };
}

/** Maps a resource read failure onto the mapping vocabulary. */
function rejectFromRead(reason: string): DisputeMappingOutcome {
  switch (reason) {
    case "resource_not_found":
      return { kind: "rejected", reason: "resource_not_found" };
    case "provider_error":
      return { kind: "rejected", reason: "provider_error" };
    case "unconfigured":
      return { kind: "rejected", reason: "unconfigured" };
    case "invalid_resource_id":
      return { kind: "rejected", reason: "invalid_resource_id" };
    default:
      return { kind: "rejected", reason: "malformed_resource", detail: reason };
  }
}

/* -------------------------------------------------------------------------
   DISPUTES
   ------------------------------------------------------------------------- */

export async function mapDisputeToOrder(disputeId: unknown): Promise<DisputeMappingOutcome> {
  if (!isDisputeId(disputeId)) return { kind: "rejected", reason: "invalid_resource_id" };

  const read = await retrieveDispute(disputeId);
  if (!read.ok) return rejectFromRead(read.reason);
  const dispute = read.dispute;

  const resolved = await resolveContext(
    dispute.accountId,
    dispute.paymentId,
    dispute.amountMinor,
    dispute.currency,
  );
  if (!resolved.ok) return resolved.outcome;
  const { payment, orderId, environment } = resolved.context;

  // THE PROVIDER'S STATUS DECIDES, whatever the event was called.
  const phase = classifyDisputeStatus(dispute.status);
  const status = targetDisputeStatus(phase, dispute.status);

  const recorded = await recordDispute({
    whopDisputeId: dispute.disputeId,
    whopPaymentId: payment.id,
    orderId,
    environment,
    amountMinor: dispute.amountMinor,
    currency: dispute.currency,
    providerStatus: dispute.status,
    status,
    inquiry: dispute.inquiry,
    rapidDisputeResolution: dispute.rapidDisputeResolution,
    reason: dispute.reason,
    reasonCode: dispute.reasonCode,
    evidenceDueAt: dispute.evidenceDueAt,
    evidenceSubmittedAt: dispute.evidenceSubmittedAt,
    openedAt: dispute.createdAt,
    providerUpdatedAt: dispute.updatedAt,
  });

  if (!recorded.ok) {
    if (recorded.reason === "payment_conflict") {
      return { kind: "rejected", reason: "resource_identity_conflict", detail: recorded.reason };
    }
    return { kind: "rejected", reason: "storage_error" };
  }

  return {
    kind: "recorded",
    resourceId: dispute.disputeId,
    paymentId: payment.id,
    orderId,
    status: recorded.dispute.status,
    unchanged: recorded.unchanged,
  };
}

/* -------------------------------------------------------------------------
   DISPUTE ALERTS
   ------------------------------------------------------------------------- */

/**
 * An alert whose payment Whop could not match is a real, terminal state and
 * NOT an error. It is recorded with no payment and no order, and reported as
 * such, because the alternative — discarding it — loses the only record that
 * an issuer reported fraud against us at all.
 */
export type AlertMappingOutcome =
  | DisputeMappingOutcome
  | { kind: "recorded_unmatched"; resourceId: string; reason: string };

export async function mapAlertToOrder(alertId: unknown): Promise<AlertMappingOutcome> {
  if (!isDisputeAlertId(alertId)) return { kind: "rejected", reason: "invalid_resource_id" };

  const read = await retrieveDisputeAlert(alertId);
  if (!read.ok) return rejectFromRead(read.reason);
  const alert = read.alert;

  const environment = getWhopEnvironment();
  if (!environment) return { kind: "rejected", reason: "unconfigured" };

  // THE UNMATCHED CASE, handled first and on its own terms.
  if (alert.paymentId === null) {
    const stored = await recordAlert({
      whopAlertId: alert.alertId,
      whopPaymentId: null,
      orderId: null,
      environment,
      amountMinor: alert.amountMinor,
      currency: alert.currency,
      alertType: alert.alertType,
      status: targetAlertStatus(alert.actionable),
      notActionableReason: alert.notActionableReason,
      feeCharged: alert.feeCharged,
      reportedAt: alert.reportedAt,
      providerUpdatedAt: alert.updatedAt,
    });
    if (!stored.ok) return { kind: "rejected", reason: "storage_error" };
    return {
      kind: "recorded_unmatched",
      resourceId: alert.alertId,
      reason: alert.notActionableReason ?? "payment_unmatched",
    };
  }

  const resolved = await resolveContext(
    alert.accountId,
    alert.paymentId,
    // An alert's amount is what the ISSUER reported and is documented as
    // possibly differing from the payment's own. Passing zero here skips the
    // "exceeds payment" bound, which would otherwise reject a legitimate alert
    // for a discrepancy Whop itself warns about. The real amount is still
    // stored; it is simply not used as a mapping assertion.
    BigInt(0),
    alert.currency,
  );
  if (!resolved.ok) return resolved.outcome;
  const { payment, orderId, environment: env } = resolved.context;

  const stored = await recordAlert({
    whopAlertId: alert.alertId,
    whopPaymentId: payment.id,
    orderId,
    environment: env,
    amountMinor: alert.amountMinor,
    currency: alert.currency,
    alertType: alert.alertType,
    status: targetAlertStatus(alert.actionable),
    notActionableReason: alert.notActionableReason,
    feeCharged: alert.feeCharged,
    reportedAt: alert.reportedAt,
    providerUpdatedAt: alert.updatedAt,
  });
  if (!stored.ok) return { kind: "rejected", reason: "storage_error" };

  return {
    kind: "recorded",
    resourceId: alert.alertId,
    paymentId: payment.id,
    orderId,
    status: stored.alert.status,
    unchanged: false,
  };
}

/* -------------------------------------------------------------------------
   RESOLUTION CENTER CASES
   ------------------------------------------------------------------------- */

export async function mapCaseToOrder(caseId: unknown): Promise<DisputeMappingOutcome> {
  if (!isResolutionCaseId(caseId)) return { kind: "rejected", reason: "invalid_resource_id" };

  const read = await retrieveResolutionCase(caseId);
  if (!read.ok) return rejectFromRead(read.reason);
  const rc = read.case;

  const resolved = await resolveContext(
    rc.accountId,
    rc.paymentId,
    rc.amountMinor,
    rc.currency,
  );
  if (!resolved.ok) return resolved.outcome;
  const { payment, orderId, environment } = resolved.context;

  const stored = await recordCase({
    whopCaseId: rc.caseId,
    whopPaymentId: payment.id,
    orderId,
    environment,
    amountMinor: rc.amountMinor,
    currency: rc.currency,
    providerStatus: rc.status,
    status: targetCaseStatus(rc.status),
    // `outcome` is only meaningful once the case closes, and the database
    // refuses one on an open case. Dropped rather than passed through so a
    // provider that volunteers it early cannot violate the constraint.
    outcome: targetCaseStatus(rc.status) === "closed" ? rc.outcome : null,
    refundSource: rc.refundSource,
    reason: rc.reason,
    escalated: rc.escalated,
    providerUpdatedAt: rc.updatedAt,
  });
  if (!stored.ok) return { kind: "rejected", reason: "storage_error" };

  return {
    kind: "recorded",
    resourceId: rc.caseId,
    paymentId: payment.id,
    orderId,
    status: stored.case.status,
    unchanged: stored.unchanged,
  };
}
