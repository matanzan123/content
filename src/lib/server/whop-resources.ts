import "server-only";

import { WhopError } from "@whop/sdk";
import { describeWhopError, getWhopCompanyId, getWhopPaymentsClient } from "./whop-payments";

/* ==========================================================================
   AUTHORITATIVE RESOURCE OWNERSHIP — server only.

   A webhook payload is proof that WHOP sent it. It is not proof that the
   resource it names belongs to US.

   The first real sandbox `payment.succeeded` delivery carried no `company_id`
   at all, which is exactly the trap: a receiver that validates ownership only
   when the payload volunteers a company treats "field absent" as "company
   fine". Every payment ClipRewards will ever act on financially must instead
   be fetched back from Whop and checked against the configured company.

   THE AUTHORITY IS `Payment.account_id`, documented by the SDK as "The account
   that received the payment, prefixed `biz_`" — the same shape as
   WHOP_COMPANY_ID. Nothing else is consulted: not the webhook body, not a URL,
   not a checkout label, not the signed-in Firebase user.

   FAIL CLOSED. Anything short of a positive, exact match is a refusal.
   ========================================================================== */

/**
 * The outcome of proving who owns a resource. Every value is safe to store as
 * a failure category and safe to log — none can carry money, PII or a secret.
 */
export type OwnershipResult =
  | { kind: "verified"; accountId: string }
  | { kind: "wrong_company" }
  | { kind: "resource_not_found" }
  | { kind: "provider_error"; category: string }
  | { kind: "invalid_resource_id" }
  | { kind: "unconfigured" };

/** Whop payment ids are `pay_` plus an opaque token. Anything else is refused. */
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,64}$/;

export function isPaymentId(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_ID.test(value);
}

/**
 * Retrieves a payment from Whop and proves which company owns it.
 *
 * Read-only: `payments.retrieve` fetches, and nothing here creates, captures,
 * refunds or voids anything. The response is used for one field and then
 * discarded — the amount, buyer, billing address, card details and balances it
 * carries are never returned, logged or stored.
 *
 * The client comes from the canonical payments layer, so a sandbox
 * configuration reads the sandbox API and can never silently reach production.
 */
export async function verifyPaymentOwnership(paymentId: unknown): Promise<OwnershipResult> {
  if (!isPaymentId(paymentId)) return { kind: "invalid_resource_id" };

  const expected = getWhopCompanyId();
  const client = getWhopPaymentsClient();
  // No credentials means no proof. An unprovable payment is not a valid one.
  if (!expected || !client) return { kind: "unconfigured" };

  let accountId: string | null;
  try {
    const payment = await client.payments.retrieve({ id: paymentId });
    accountId = payment.account_id;
  } catch (error) {
    // 404 is its own answer: the id does not exist on the configured
    // environment — which is also what a production id looks like to a sandbox
    // key, and must never be waved through.
    if (error instanceof WhopError && error.statusCode === 404) {
      return { kind: "resource_not_found" };
    }
    const status = error instanceof WhopError && error.statusCode ? String(error.statusCode) : "unknown";
    // The message is scrubbed before it goes anywhere near a log.
    console.error("[whop] payment lookup failed:", status, describeWhopError(error));
    return { kind: "provider_error", category: `http_${status}` };
  }

  // A payment with no account cannot be attributed, so it cannot be ours.
  if (!accountId) return { kind: "wrong_company" };
  if (accountId !== expected) return { kind: "wrong_company" };

  return { kind: "verified", accountId };
}

/* -------------------------------------------------------------------------
   LIFECYCLE PHASE
   ------------------------------------------------------------------------- */

/**
 * The provider's CURRENT phase for a payment, with ownership proved in the
 * same call.
 *
 * Exists for reconciliation, which asks a different question from settlement:
 * not "may I account for this?" but "does Whop still agree with what our order
 * says?". It therefore reports a phase for payments in every state, including
 * the ones `fetchSettlementFacts` refuses, and it never touches an order or a
 * ledger.
 *
 * Ownership is still proved here rather than trusted. A reconciliation report
 * built from another company's payments would be worse than no report.
 */
export type PhaseResult =
  | { kind: "known"; status: string; accountId: string }
  | { kind: "wrong_company" }
  | { kind: "resource_not_found" }
  | { kind: "provider_error"; category: string }
  | { kind: "invalid_resource_id" }
  | { kind: "unconfigured" };

export async function retrievePaymentPhase(paymentId: unknown): Promise<PhaseResult> {
  if (!isPaymentId(paymentId)) return { kind: "invalid_resource_id" };

  const expected = getWhopCompanyId();
  const client = getWhopPaymentsClient();
  if (!expected || !client) return { kind: "unconfigured" };

  try {
    const payment = await client.payments.retrieve({ id: paymentId });
    if (!payment.account_id || payment.account_id !== expected) return { kind: "wrong_company" };
    return {
      kind: "known",
      status: typeof payment.status === "string" ? payment.status : "",
      accountId: payment.account_id,
    };
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { kind: "resource_not_found" };
    }
    const status = error instanceof WhopError && error.statusCode ? String(error.statusCode) : "unknown";
    console.error("[whop] payment phase lookup failed:", status, describeWhopError(error));
    return { kind: "provider_error", category: `http_${status}` };
  }
}
