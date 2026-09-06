import "server-only";

import { WhopError } from "@whop/sdk";
import { describeWhopError, getWhopPaymentsClient } from "../whop-payments";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "../money";
import { economicKey } from "./accounts";
import { postTransaction, type JournalLeg, type PostingInput } from "./journal";

/* ==========================================================================
   THE ONE POSTING RULE THIS BUILD HAS: a settled Whop payment.

   WHAT IS AUTHORITATIVE, verified against the real sandbox payment rather
   than assumed from documentation:

     total               Whop.Money   what the account is credited for, tax in
     subtotal            Whop.Money   the price before tax
     tax_amount          Whop.Money   tax collected, "0.00" when none
     amount_after_fees   Whop.Money   what Whop actually keeps for us
     currency            string       lowercase ISO 4217; every field above is
                                      stated in it
     payments.listFees   PaymentFee[] each fee as its own line, with an
                                      `origin` naming exactly which fee it is

   FEES ARE NEVER CALCULATED. There is no percentage anywhere in this file.
   Every fee leg comes from a line Whop returned, labelled with Whop's own
   `origin`, so the ledger can be read back against the provider's fee report
   line for line. On the reference payment those lines are:

     payment_processing_fixed_fee        0.30
     payment_processing_percentage_fee   0.27
     cross_border_percentage_fee         0.15
     orchestration_percentage_fee        0.08
     stripe_radar_fee                    0.07
                                        -----
                                         0.87   and 10.00 - 0.87 = 9.13
                                                = amount_after_fees exactly

   THE PROVIDER'S OWN ARITHMETIC IS CHECKED, not trusted blindly:
   `amount_after_fees + sum(fees) == total` must hold exactly. If it does not,
   the posting is REFUSED. It is not balanced by inventing an adjustment leg —
   a mismatch means we have misunderstood the fee report, and the right
   response is to stop and look, not to publish a number that adds up because
   we made it add up.

   WHAT IS NOT DECIDED, and therefore not posted:
   the gross goes to `unallocated_customer_funds`, a suspense liability. NOT to
   platform revenue, NOT split with a creator. Those require the fee model and
   the revenue split, which do not exist. When they do, the rule is a second
   transaction that moves money OUT of suspense — the settlement posting below
   does not change.

   THE RESULTING JOURNAL, for the reference payment:

     DR  provider_balance            9.13     what Whop holds for us
     DR  provider_fee_expense        0.87     five legs, one per fee line
     CR  unallocated_customer_funds 10.00     owed to someone, not yet earned
                                    ------
                                     0.00
   ========================================================================== */

/** The narrow slice of a payment this module is willing to hold. */
export type SettlementFacts = {
  paymentId: string;
  accountId: string;
  currency: string;
  /** Gross the account is credited for, tax included. */
  totalMinor: bigint;
  /** Tax portion of the total. Zero when no tax applied. */
  taxMinor: bigint;
  /** What Whop keeps for us after its fees. */
  afterFeesMinor: bigint;
  /** One entry per fee line Whop reported. */
  fees: { origin: string; label: string; amountMinor: bigint }[];
  paidAt: Date | null;
};

export type FactsResult =
  | { ok: true; facts: SettlementFacts }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "not_settled"
        | "unsupported_currency"
        | "currency_mismatch"
        | "amount_unreadable"
        | "fees_do_not_reconcile";
      detail?: string;
    };

/** Reads one Whop.Money, refusing anything that is not exact. */
function money(
  value: { amount: string; currency: string; decimals: number } | null | undefined,
  expectedCurrency: string,
): { ok: true; minor: bigint } | { ok: false; reason: "currency_mismatch" | "amount_unreadable" } {
  if (!value) return { ok: false, reason: "amount_unreadable" };

  const currency = typeof value.currency === "string" ? value.currency.trim().toLowerCase() : "";
  if (currency !== expectedCurrency) return { ok: false, reason: "currency_mismatch" };

  const decimals = currencyDecimals(currency);
  if (decimals === null || value.decimals !== decimals) {
    return { ok: false, reason: "amount_unreadable" };
  }

  const minor = decimalToMinor(value.amount, decimals);
  if (minor === null) return { ok: false, reason: "amount_unreadable" };
  return { ok: true, minor };
}

/**
 * Fetches the payment AND its fees, and reduces them to the facts a posting
 * needs — refusing rather than guessing at every step.
 *
 * TWO CALLS, both required. `payments.retrieve` does not carry the fee
 * breakdown at all (there is no `application_fee` on the retrieve response;
 * that field belongs to the legacy webhook payload), so `payments.listFees`
 * is a hard dependency of exact fee accounting, not an optimisation. Without
 * it the only fee figure available is the difference between `total` and
 * `amount_after_fees`, which is a single opaque number that cannot be
 * attributed to processing, cross-border, risk or revenue share.
 */
export async function fetchSettlementFacts(paymentId: string): Promise<FactsResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  let payment;
  try {
    payment = await client.payments.retrieve({ id: paymentId });
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[accounting] payment fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }

  // Only a payment Whop itself reports as collected is an economic event.
  if (payment.status !== "paid") return { ok: false, reason: "not_settled", detail: payment.status };

  const currency = normaliseCurrency(payment.currency);
  if (!currency) return { ok: false, reason: "unsupported_currency", detail: String(payment.currency) };

  const total = money(payment.total, currency);
  if (!total.ok) return { ok: false, reason: total.reason, detail: "total" };

  const afterFees = money(payment.amount_after_fees, currency);
  if (!afterFees.ok) return { ok: false, reason: afterFees.reason, detail: "amount_after_fees" };

  // Tax is absent rather than zero on some payments; absent means no tax.
  let taxMinor = BigInt(0);
  if (payment.tax_amount) {
    const tax = money(payment.tax_amount, currency);
    if (!tax.ok) return { ok: false, reason: tax.reason, detail: "tax_amount" };
    taxMinor = tax.minor;
  }

  let feeLines;
  try {
    feeLines = (await client.payments.listFees({ id: paymentId })).data;
  } catch (error) {
    console.error("[accounting] fee fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error", detail: "listFees" };
  }

  const fees: SettlementFacts["fees"] = [];
  let feeTotal = BigInt(0);
  for (const line of feeLines) {
    // `settlement_amount` is the line converted into the payment's own
    // currency; `amount` is the currency it was collected in. Only the former
    // can be totalled against the payment, which is what we are doing.
    const amount = money(line.settlement_amount, currency);
    if (!amount.ok) return { ok: false, reason: amount.reason, detail: `fee:${line.origin}` };
    // A zero-value fee line is real but posts nothing; skipping it keeps the
    // journal free of legs that cannot affect a balance.
    if (amount.minor === BigInt(0)) continue;
    fees.push({ origin: String(line.origin), label: String(line.label ?? line.origin), amountMinor: amount.minor });
    feeTotal += amount.minor;
  }

  // THE PROVIDER'S ARITHMETIC, checked. Exact integers, no tolerance.
  if (afterFees.minor + feeTotal !== total.minor) {
    return {
      ok: false,
      reason: "fees_do_not_reconcile",
      detail: `after_fees=${afterFees.minor} fees=${feeTotal} total=${total.minor}`,
    };
  }

  return {
    ok: true,
    facts: {
      paymentId: payment.id,
      accountId: payment.account_id ?? "",
      currency,
      totalMinor: total.minor,
      taxMinor,
      afterFeesMinor: afterFees.minor,
      fees,
      paidAt: payment.paid_at ? new Date(payment.paid_at) : null,
    },
  };
}

/**
 * Turns settlement facts into a balanced journal. Pure — no database, no
 * network — so the arithmetic can be tested exhaustively without either.
 */
export function buildSettlementPosting(
  facts: SettlementFacts,
  context: {
    environment: "sandbox" | "production";
    orderId: string | null;
    sourceWebhookId?: string | null;
  },
): PostingInput {
  const legs: JournalLeg[] = [
    {
      // What Whop now holds for us.
      account: "provider_balance",
      amountMinor: facts.afterFeesMinor,
      counterpartyType: "provider",
      counterpartyId: facts.accountId || null,
    },
  ];

  // One leg per fee line, labelled with Whop's own name for it.
  for (const fee of facts.fees) {
    legs.push({
      account: "provider_fee_expense",
      amountMinor: fee.amountMinor,
      counterpartyType: "provider",
      counterpartyId: "whop",
      sourceDetail: fee.origin,
    });
  }

  // Tax collected is owed onwards, not ours. Split out of the gross so the
  // suspense balance is money that might one day be earned, and the tax
  // balance is money that never can be.
  if (facts.taxMinor !== BigInt(0)) {
    legs.push({
      account: "tax_payable",
      amountMinor: -facts.taxMinor,
      counterpartyType: "tax_authority",
    });
  }

  legs.push({
    account: "unallocated_customer_funds",
    amountMinor: -(facts.totalMinor - facts.taxMinor),
    counterpartyType: "customer",
  });

  return {
    economicEvent: "payment_settled",
    provider: "whop",
    providerResourceId: facts.paymentId,
    environment: context.environment,
    currency: facts.currency,
    idempotencyKey: economicKey("whop", "payment_settled", facts.paymentId),
    orderId: context.orderId,
    sourceWebhookId: context.sourceWebhookId ?? null,
    description: "Whop payment settled",
    occurredAt: facts.paidAt,
    legs,
  };
}

/**
 * Fetch, build, post. The whole settlement rule in one call.
 *
 * ATTACHES AFTER VERIFICATION, never instead of it. The caller must already
 * have run the payment through `mapPaymentToOrder` — signature verified,
 * company ownership checked, `metadata.order_id` matched, amount and currency
 * compared, order marked paid. This function accounts for a payment that has
 * ALREADY been proven to be ours; it re-fetches the payment because it needs
 * fields the mapping does not carry, not because it re-decides ownership.
 */
export async function postWhopSettlement(
  paymentId: string,
  context: {
    environment: "sandbox" | "production";
    orderId: string | null;
    sourceWebhookId?: string | null;
  },
) {
  const facts = await fetchSettlementFacts(paymentId);
  if (!facts.ok) return { ok: false as const, reason: facts.reason, detail: facts.detail };
  return await postTransaction(buildSettlementPosting(facts.facts, context));
}
