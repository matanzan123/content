import "server-only";

import { WhopError } from "@whop/sdk";
import {
  describeWhopError,
  getWhopCompanyId,
  getWhopPaymentsClient,
} from "./whop-payments";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "./money";

/* ==========================================================================
   AUTHORITATIVE REFUND FACTS — server only.

   A `refund.created` delivery is proof that WHOP sent something. It is not
   proof that a refund exists, that it belongs to us, that it names a payment
   of ours, or that its amount is what the payload says. Every one of those is
   established here by fetching the refund BACK from Whop and reading the
   fetched record.

   HOW REFUNDS ARE RETRIEVED, verified against the installed SDK:

     client.refunds.retrieve({ id })          one refund, by `rf_` id
     client.refunds.list({ payment_id })      every refund of one payment
     client.payments.retrieve({ id })         the payment, carrying the
                                              CUMULATIVE `refunded_amount`

   Refunds are their own resource, NOT a field on the payment. That is the
   whole reason multiple partial refunds work at all: three refunds of one
   payment are three `rf_` resources with three ids, three statuses and three
   amounts, and any design that tried to hold "the refund" on the payment row
   could represent only the last of them.

   TWO WIRE SHAPES, BOTH DOCUMENTED, NEITHER INVENTED. The SDK exports `Refund`
   (used by `refunds.retrieve`), whose `amount` is a `Money` object, and
   `RefundLegacy` / `RefundListItem` (used by the webhook payload), whose
   `amount` is a decimal NUMBER with a sibling `currency` string. Both are real
   published types in `@whop/sdk@1.1.0`. `readRefund` below accepts either and
   REFUSES anything that is neither — it never fills in a missing field.

   A NUMBER IS NOT AN AMOUNT WE WILL ACT ON. Where the legacy shape gives a
   JavaScript number, it is re-serialised through the exact decimal reader in
   `money.ts` rather than multiplied by 100. `10.43 * 100` is `1042.9999...`,
   and a refund is the last place a float should be allowed to decide a figure.
   ========================================================================== */

/** Whop refund ids are `rf_` plus an opaque token. Anything else is refused. */
const REFUND_ID = /^rf_[A-Za-z0-9]{1,64}$/;

export function isRefundId(value: unknown): value is string {
  return typeof value === "string" && REFUND_ID.test(value);
}

/** The narrow slice of a refund we are willing to hold in memory. */
export type AuthoritativeRefund = {
  /** `rf_...`, the economic identity of this refund. */
  refundId: string;
  /** `pay_...`, the payment this refund reverses. */
  paymentId: string;
  /** `biz_...`, the account that issued it, or null when not reported. */
  accountId: string | null;
  /** Settlement-currency minor units. Positive. */
  amountMinor: bigint;
  /** Lowercase ISO 4217, as Whop states it. */
  currency: string;
  /** The raw provider status, exactly as Whop wrote it. */
  status: string;
  /** Whop's normalised failure reason, when it reported one. */
  failureReason: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type RefundFactsResult =
  | { ok: true; refund: AuthoritativeRefund }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "invalid_resource_id"
        | "unsupported_currency"
        | "amount_unreadable"
        | "no_payment_reference"
        | "malformed_refund";
      detail?: string;
    };

/* -------------------------------------------------------------------------
   READING ONE REFUND OFF THE WIRE
   ------------------------------------------------------------------------- */

function readTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads the amount and currency, accepting either documented shape.
 *
 * SHAPE 1 — `Refund.amount: Money | null`, e.g.
 *   `{ amount: "2.00", currency: "usd", decimals: 2 }`
 *   The currency comes from inside the Money object.
 *
 * SHAPE 2 — `RefundLegacy.amount: number` with `currency: string`, e.g.
 *   `amount: 2, currency: "usd"`
 *   The currency is a sibling field.
 *
 * `Refund.amount` is explicitly nullable ("Null only when no exchange rate is
 * recorded for a legacy multi-currency payment"), and null is a REFUSAL here
 * rather than a zero. A refund whose amount Whop cannot state is a refund we
 * cannot account for, and zero would be a silent, balanced, wrong posting.
 */
function readAmount(
  source: Record<string, unknown>,
):
  | { ok: true; minor: bigint; currency: string }
  | { ok: false; reason: "unsupported_currency" | "amount_unreadable"; detail?: string } {
  const raw = source.amount;

  // Shape 1: a Money object.
  if (raw && typeof raw === "object") {
    const money = raw as Record<string, unknown>;
    const currency = normaliseCurrency(money.currency);
    if (!currency) {
      return { ok: false, reason: "unsupported_currency", detail: String(money.currency) };
    }
    const decimals = currencyDecimals(currency);
    if (decimals === null || money.decimals !== decimals) {
      return { ok: false, reason: "amount_unreadable", detail: "decimals" };
    }
    if (typeof money.amount !== "string") {
      return { ok: false, reason: "amount_unreadable", detail: "amount not a string" };
    }
    const minor = decimalToMinor(money.amount, decimals);
    if (minor === null) return { ok: false, reason: "amount_unreadable", detail: money.amount };
    return { ok: true, minor, currency };
  }

  // Shape 2: a decimal number with a sibling currency.
  if (typeof raw === "number") {
    const currency = normaliseCurrency(source.currency);
    if (!currency) {
      return { ok: false, reason: "unsupported_currency", detail: String(source.currency) };
    }
    const decimals = currencyDecimals(currency);
    if (decimals === null) return { ok: false, reason: "unsupported_currency" };
    if (!Number.isFinite(raw)) return { ok: false, reason: "amount_unreadable", detail: "not finite" };
    // `toFixed` then the exact string reader. A refund of 10.43 becomes
    // "10.43" becomes 1043n, with no multiplication by 100 anywhere.
    const minor = decimalToMinor(raw.toFixed(decimals), decimals);
    if (minor === null) return { ok: false, reason: "amount_unreadable", detail: String(raw) };
    // A number that did not survive the round trip carried more precision than
    // the currency has, and truncating it would change a refund's value.
    if (Number(minor) / 10 ** decimals !== Number(raw.toFixed(decimals))) {
      return { ok: false, reason: "amount_unreadable", detail: "precision" };
    }
    return { ok: true, minor, currency };
  }

  return { ok: false, reason: "amount_unreadable", detail: raw === null ? "null" : typeof raw };
}

/**
 * Reads the payment this refund reverses, from either shape.
 *
 * `Refund.payment_id` is a plain `pay_` string. `RefundLegacy.payment` is a
 * nested object carrying `id`, and is explicitly nullable ("Null if the
 * payment is no longer available") — which is a refusal, because a refund we
 * cannot attach to a payment is one we cannot attach to an order either.
 */
function readPaymentId(source: Record<string, unknown>): string | null {
  const direct = source.payment_id;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const nested = source.payment;
  if (nested && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Reduces a refund from either shape to the facts we will act on, refusing at
 * every step rather than guessing.
 *
 * Exported so the whole reader can be tested against both wire shapes without
 * a network, which is the only way to be sure the legacy branch works — the
 * sandbox has no refunds to observe.
 */
export function readRefund(source: unknown): RefundFactsResult {
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "malformed_refund", detail: "not an object" };
  }
  const record = source as Record<string, unknown>;

  const refundId = record.id;
  if (!isRefundId(refundId)) {
    return { ok: false, reason: "invalid_resource_id", detail: String(refundId) };
  }

  const paymentId = readPaymentId(record);
  if (paymentId === null) return { ok: false, reason: "no_payment_reference" };

  const amount = readAmount(record);
  if (!amount.ok) return { ok: false, reason: amount.reason, detail: amount.detail };

  // A negative or zero refund is not a refund. Whop has no such thing, and
  // treating one as valid would post a journal that moves money the wrong way.
  if (amount.minor <= BigInt(0)) {
    return { ok: false, reason: "amount_unreadable", detail: "not positive" };
  }

  const status = typeof record.status === "string" ? record.status : "";
  if (status.length === 0) {
    return { ok: false, reason: "malformed_refund", detail: "no status" };
  }

  const accountId = typeof record.account_id === "string" ? record.account_id : null;
  const failureReason =
    typeof record.failure_reason === "string" && record.failure_reason.length > 0
      ? record.failure_reason.slice(0, 64)
      : null;

  return {
    ok: true,
    refund: {
      refundId,
      paymentId,
      accountId,
      amountMinor: amount.minor,
      currency: amount.currency,
      status,
      failureReason,
      createdAt: readTimestamp(record.created_at),
      updatedAt: readTimestamp(record.updated_at) ?? readTimestamp(record.created_at),
    },
  };
}

/* -------------------------------------------------------------------------
   PROVIDER CALLS
   ------------------------------------------------------------------------- */

/**
 * Fetches ONE refund from Whop by its `rf_` id.
 *
 * Read-only: `refunds.retrieve` fetches, and nothing in this module creates,
 * cancels or alters a refund. Issuing one is a separate, deliberately narrow
 * primitive in `whop-refund-create.ts`.
 */
export async function retrieveRefund(refundId: unknown): Promise<RefundFactsResult> {
  if (!isRefundId(refundId)) return { ok: false, reason: "invalid_resource_id" };

  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  try {
    const refund = await client.refunds.retrieve({ id: refundId });
    return readRefund(refund);
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[whop] refund fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

export type RefundListResult =
  | { ok: true; refunds: AuthoritativeRefund[] }
  | { ok: false; reason: "unconfigured" | "provider_error" | "malformed_refund"; detail?: string };

/**
 * EVERY refund Whop holds against one payment.
 *
 * This is the authority for "how much of this payment has actually been
 * returned", and it is the reason the overflow check in the mapping is a real
 * check rather than a hope: cumulative refunded is computed by summing the
 * COMPLETED refunds Whop itself reports, not by adding up our own rows.
 *
 * Bounded rather than exhaustively paged. A single payment with more than
 * `MAX_REFUNDS_PER_PAYMENT` refunds is not a case this build has a rule for,
 * and quietly reading the first page of an unbounded set would understate the
 * cumulative total — which is exactly the direction that lets an overflow
 * through. Hitting the bound is reported as a refusal, not truncated.
 */
export const MAX_REFUNDS_PER_PAYMENT = 100;

export async function listRefundsForPayment(paymentId: string): Promise<RefundListResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  try {
    const page = await client.refunds.list({
      payment_id: paymentId,
      first: MAX_REFUNDS_PER_PAYMENT,
    });
    const rows: unknown[] = Array.isArray(page.data) ? page.data : [];

    const refunds: AuthoritativeRefund[] = [];
    for (const row of rows) {
      const read = readRefund(row);
      // ONE UNREADABLE REFUND POISONS THE WHOLE LIST, deliberately. This list
      // is used to decide whether a cumulative total has been exceeded, and a
      // total computed by skipping the entries we could not parse is an
      // understatement presented as a fact.
      if (!read.ok) {
        return { ok: false, reason: "malformed_refund", detail: read.reason };
      }
      refunds.push(read.refund);
    }
    return { ok: true, refunds };
  } catch (error) {
    console.error("[whop] refund list failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

/* -------------------------------------------------------------------------
   OWNERSHIP
   ------------------------------------------------------------------------- */

/**
 * Proves a refund belongs to us, the same way `verifyPaymentOwnership` proves
 * a payment does — and then some, because a refund has TWO things to prove.
 *
 *   1. the refund's own `account_id` is our company, when Whop reports one;
 *   2. the PAYMENT the refund names is our company's payment.
 *
 * (2) is the one that cannot be skipped. `Refund.account_id` is typed
 * `string | null` — Whop is explicit that it may be absent — and a receiver
 * that checks ownership only when the field is volunteered treats "field
 * absent" as "ownership fine". That is the exact trap the first real sandbox
 * `payment.succeeded` sprang, arriving with no `company_id` at all. So the
 * payment is fetched and its `account_id` compared, always, and the refund's
 * own account is an ADDITIONAL check rather than a substitute.
 */
export type RefundOwnershipResult =
  | { kind: "verified"; accountId: string; paymentId: string }
  | { kind: "wrong_company" }
  | { kind: "resource_not_found" }
  | { kind: "provider_error"; category: string }
  | { kind: "invalid_resource_id" }
  | { kind: "unconfigured" };

export async function verifyRefundOwnership(refundId: unknown): Promise<RefundOwnershipResult> {
  if (!isRefundId(refundId)) return { kind: "invalid_resource_id" };

  const expected = getWhopCompanyId();
  const client = getWhopPaymentsClient();
  if (!expected || !client) return { kind: "unconfigured" };

  const fetched = await retrieveRefund(refundId);
  if (!fetched.ok) {
    switch (fetched.reason) {
      case "resource_not_found":
        return { kind: "resource_not_found" };
      case "unconfigured":
        return { kind: "unconfigured" };
      case "invalid_resource_id":
        return { kind: "invalid_resource_id" };
      case "provider_error":
        return { kind: "provider_error", category: "http_unknown" };
      default:
        // A refund we cannot read is a refund we cannot attribute. Refused as
        // not-found rather than as an outage: re-asking will not make an
        // unreadable record readable.
        return { kind: "resource_not_found" };
    }
  }

  const refund = fetched.refund;

  // (1) When Whop names an account, it must be ours. A refund issued by
  // someone else's company is never ours, whatever payment it claims.
  if (refund.accountId !== null && refund.accountId !== expected) {
    return { kind: "wrong_company" };
  }

  // (2) The payment, always, whatever (1) reported.
  try {
    const payment = await client.payments.retrieve({ id: refund.paymentId });
    if (!payment.account_id || payment.account_id !== expected) {
      return { kind: "wrong_company" };
    }
    return { kind: "verified", accountId: payment.account_id, paymentId: refund.paymentId };
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { kind: "resource_not_found" };
    }
    const status =
      error instanceof WhopError && error.statusCode ? String(error.statusCode) : "unknown";
    console.error("[whop] refund payment lookup failed:", status, describeWhopError(error));
    return { kind: "provider_error", category: `http_${status}` };
  }
}
