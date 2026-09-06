import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { WhopError } from "@whop/sdk";
import { getDb } from "@/lib/db";
import { accountingEntries, accountingTransactions } from "@/lib/db/schema";
import { describeWhopError, getWhopPaymentsClient } from "../whop-payments";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "../money";
import { classifyRefundStatus, postsAccounting } from "../refund-lifecycle";
import { retrieveRefund } from "../whop-refunds";
import { economicKey } from "./accounts";
import { postTransaction, type JournalLeg, type PostingInput } from "./journal";

/* ==========================================================================
   THE REFUND POSTING RULE.

   A REFUND IS A NEW ECONOMIC EVENT, NOT A RETRACTION. The original
   `payment_settled` transaction is never edited, never reversed and never
   deleted. The customer really did pay, and the ledger must go on saying so;
   what a refund adds is a second, later fact that some of the money went back.
   `reverseTransaction` is deliberately NOT used — it would post the exact
   opposite of the settlement, which is wrong for a partial refund and
   misleading even for a full one, because a full refund is not a statement
   that the payment never happened.

   THE JOURNAL, DERIVED ENTIRELY FROM PROVIDER FACTS:

     DR  unallocated_customer_funds   the suspense liability we no longer owe
     DR  tax_payable                  only what Whop proves it returned
     ..  provider_fee_expense         only the fee movement Whop proves
     CR  provider_balance             the balancing figure

   WHAT MAKES THIS HONEST: every number above is a provider fact or a
   difference between two provider facts. There is no percentage anywhere in
   this file, no assumption about whether Whop returns its fees, and no leg
   invented to make the journal balance.

   ---------------------------------------------------------------------------
   THE FEE QUESTION, and how it is answered without guessing.

   Whop does not document whether processing fees are returned on a refund, and
   the `PaymentFee` resource carries no `refunded` flag to read. Guessing costs
   real money in either direction: assuming fees come back overstates our
   balance, and assuming they are kept understates it.

   So we do not guess. We ASK, and we ask the only source that can answer —
   `payments.listFees`, re-fetched at posting time — and we compare it to what
   we have already booked:

       feeDelta = (fee total Whop reports NOW)
                - (fee total we have already posted for this payment)

     feeDelta  <  0   Whop RETURNED fees. Credit `provider_fee_expense` by
                      exactly that much, and no more.
     feeDelta === 0   Whop RETAINED its fees. No fee leg at all. Nothing is
                      pretended to have come back.
     feeDelta  >  0   Whop charged an ADDITIONAL fee for handling the refund.
                      Debit `provider_fee_expense`. It is a real cost and it
                      belongs in the accounts.

   The delta is computed against our own posted fee legs rather than against
   the settlement alone, so a SECOND refund on the same payment sees the fee
   movement the FIRST one already booked and does not book it twice. That is
   what makes multiple partial refunds add up.

   ---------------------------------------------------------------------------
   WHAT A RETAINED FEE LOOKS LIKE, and why the result is correct.

   The reference payment: $10.00 collected, $0.87 of fees, $9.13 credited.

     settlement:  DR provider_balance 913, DR fees 87, CR suspense 1000

   A full $10 refund with fees RETAINED posts:

     refund:      DR suspense 1000, CR provider_balance 1000

   leaving `provider_balance` at 913 - 1000 = -87. That negative is not a bug
   to be papered over: Whop kept $0.87 and returned $10.00 to the buyer, so we
   really are $0.87 out of pocket. A model that refused to show it would be
   hiding the actual cost of a refund.

   The same refund with fees fully RETURNED posts:

     refund:      DR suspense 1000, CR fees 87, CR provider_balance 913

   leaving both `provider_balance` and `provider_fee_expense` at zero — the
   clean wash that a fully reversed transaction should produce.

   ---------------------------------------------------------------------------
   WHAT IS DELIBERATELY NOT POSTED.

   No `platform_revenue`. No `creator_payable`. No loss allocation of any kind.
   The settlement credited the whole gross into `unallocated_customer_funds`
   precisely because nobody has decided how it splits, and a refund of money
   that was never split needs no unsplitting. The refund debits the same
   suspense account the settlement credited, and the arithmetic closes.

   THE OPEN BUSINESS RULE, stated rather than guessed at: once a later build
   moves money OUT of suspense into `platform_revenue` and `creator_payable`,
   a refund arriving afterwards will find less in suspense than it needs to
   debit, and SOMEONE has to absorb it — the platform, the creator, or a
   shared reserve. That is a business decision about who bears the cost of a
   refunded campaign, not an accounting one, and it is not made here. Until it
   is made, the allocation step does not exist, so the situation cannot arise.
   `refunds_payable` stays non-postable for the same reason.
   ========================================================================== */

/** The narrow slice of a refund and its payment that a posting needs. */
export type RefundFacts = {
  refundId: string;
  paymentId: string;
  currency: string;
  /** The amount returned to the buyer, in minor units. Positive. */
  amountMinor: bigint;
  /**
   * The part of `amountMinor` that is returned TAX, proved by the difference
   * between the payment's cumulative `tax_refunded_amount` and the tax we have
   * already booked back. Zero when the payment carried no tax.
   */
  taxRefundedMinor: bigint;
  /**
   * Signed fee movement. Negative means Whop returned fees, positive means it
   * charged more, zero means it kept what it had. See the header.
   */
  feeDeltaMinor: bigint;
  /** The individual fee lines behind a non-zero delta, for the journal. */
  feeLines: { origin: string; amountMinor: bigint }[];
  occurredAt: Date | null;
};

export type RefundFactsResult =
  | { ok: true; facts: RefundFacts }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "provider_error"
        | "resource_not_found"
        | "not_completed"
        | "unsupported_currency"
        | "currency_mismatch"
        | "amount_unreadable"
        | "malformed_refund"
        | "tax_exceeds_refund"
        | "storage_error";
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

/* -------------------------------------------------------------------------
   WHAT WE HAVE ALREADY BOOKED
   ------------------------------------------------------------------------- */

export type PostedTotals = {
  /** Net `provider_fee_expense` across every transaction naming this payment. */
  feeMinor: bigint;
  /** Net `tax_payable`, sign-flipped so a collected tax reads positive. */
  taxMinor: bigint;
};

/**
 * Sums the legs already posted for one payment, across the settlement AND
 * every refund transaction that named it.
 *
 * THE JOIN IS ON `order_id` PLUS THE PAYMENT, not on the provider resource id
 * alone — a settlement transaction names `pay_...` while a refund transaction
 * names `rf_...`, so keying on the resource id would find only one of them.
 * The `metadata.payment_id` written on every refund posting is what ties them
 * back together, and it is written by this module for exactly this purpose.
 *
 * Reading our own ledger here is safe in a way that reading it for an AMOUNT
 * would not be: this figure is only ever used to compute a DIFFERENCE against
 * a provider fact. A corrupted ledger cannot make this post the wrong money —
 * it can only make the delta wrong, and the reconciliation pass compares the
 * posted total against the provider's own fee report independently.
 */
export async function postedTotalsForPayment(paymentId: string): Promise<PostedTotals | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      account: accountingEntries.account,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    .where(
      and(
        eq(accountingTransactions.provider, "whop"),
        // The settlement names the payment directly; a refund names the
        // payment in its metadata. Both are matched.
        sql`(
          ${accountingTransactions.providerResourceId} = ${paymentId}
          or ${accountingTransactions.metadata}->>'payment_id' = ${paymentId}
        )`,
      ),
    )
    .groupBy(accountingEntries.account);

  let feeMinor = BigInt(0);
  let taxMinor = BigInt(0);
  for (const row of rows) {
    const value = BigInt(row.total ?? "0");
    if (row.account === "provider_fee_expense") feeMinor += value;
    // Tax is credited on settlement (negative) and debited on refund
    // (positive). Flipped so "tax still owed onwards" reads positive.
    if (row.account === "tax_payable") taxMinor -= value;
  }
  return { feeMinor, taxMinor };
}

/* -------------------------------------------------------------------------
   FACTS
   ------------------------------------------------------------------------- */

/**
 * Fetches the refund, its payment and the payment's fees, and reduces them to
 * the facts a posting needs — refusing rather than guessing at every step.
 *
 * THREE CALLS, all required. The refund gives the amount and the status; the
 * payment gives the cumulative tax refunded; `listFees` gives the only
 * evidence that exists about whether fees moved.
 */
export async function fetchRefundFacts(refundId: string): Promise<RefundFactsResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  const fetched = await retrieveRefund(refundId);
  if (!fetched.ok) {
    switch (fetched.reason) {
      case "resource_not_found":
      case "provider_error":
      case "unconfigured":
        return { ok: false, reason: fetched.reason };
      case "unsupported_currency":
      case "amount_unreadable":
        return { ok: false, reason: fetched.reason, detail: fetched.detail };
      default:
        return { ok: false, reason: "malformed_refund", detail: fetched.reason };
    }
  }
  const refund = fetched.refund;

  // ONLY A COMPLETED REFUND IS AN ECONOMIC EVENT. A pending one may still be
  // declined and a failed one returned nothing; posting either would take
  // money out of the ledger that never left the provider.
  if (!postsAccounting(classifyRefundStatus(refund.status))) {
    return { ok: false, reason: "not_completed", detail: refund.status };
  }

  const currency = normaliseCurrency(refund.currency);
  if (!currency) return { ok: false, reason: "unsupported_currency", detail: refund.currency };

  let payment;
  try {
    payment = await client.payments.retrieve({ id: refund.paymentId });
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found", detail: "payment" };
    }
    console.error("[accounting] refund payment fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error", detail: "payment" };
  }

  const paymentCurrency = normaliseCurrency(payment.currency);
  if (!paymentCurrency) {
    return { ok: false, reason: "unsupported_currency", detail: "payment currency" };
  }
  if (paymentCurrency !== currency) {
    return { ok: false, reason: "currency_mismatch", detail: "refund vs payment" };
  }

  // What we have already booked, so both deltas are against a real baseline.
  const posted = await postedTotalsForPayment(refund.paymentId);
  if (posted === null) return { ok: false, reason: "storage_error" };

  /* --- TAX: cumulative provider figure minus what we have already put back -- */

  let cumulativeTaxRefunded = BigInt(0);
  if (payment.tax_refunded_amount) {
    const parsed = money(payment.tax_refunded_amount, currency);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: "tax_refunded_amount" };
    cumulativeTaxRefunded = parsed.minor;
  }

  // The settlement credited `tax_payable` with the tax collected; each refund
  // debits back the part returned. `posted.taxMinor` is therefore "tax still
  // owed onwards", and the tax collected originally is that plus everything
  // already returned. The portion belonging to THIS refund is the cumulative
  // figure minus the part already booked back.
  let taxAlreadyReturned = BigInt(0);
  if (payment.tax_amount) {
    const collected = money(payment.tax_amount, currency);
    if (!collected.ok) return { ok: false, reason: collected.reason, detail: "tax_amount" };
    taxAlreadyReturned = collected.minor - posted.taxMinor;
  }

  let taxRefundedMinor = cumulativeTaxRefunded - taxAlreadyReturned;
  // A negative delta would mean the provider's cumulative tax refunded went
  // DOWN, which cannot happen. Treated as zero rather than posted as a credit,
  // and left for reconciliation to report.
  if (taxRefundedMinor < BigInt(0)) taxRefundedMinor = BigInt(0);

  // Tax returned cannot exceed the refund it is part of.
  if (taxRefundedMinor > refund.amountMinor) {
    return {
      ok: false,
      reason: "tax_exceeds_refund",
      detail: `${taxRefundedMinor} > ${refund.amountMinor}`,
    };
  }

  /* --- FEES: the provider's report now, minus what we have already posted --- */

  let feeLines;
  try {
    feeLines = (await client.payments.listFees({ id: refund.paymentId })).data;
  } catch (error) {
    console.error("[accounting] refund fee fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error", detail: "listFees" };
  }

  const lines: RefundFacts["feeLines"] = [];
  let feeTotalNow = BigInt(0);
  for (const line of feeLines) {
    // `settlement_amount`, not `amount`: only the settlement figure can be
    // totalled against the payment, which is what we are doing.
    const parsed = money(line.settlement_amount, currency);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: `fee:${line.origin}` };
    if (parsed.minor === BigInt(0)) continue;
    lines.push({ origin: String(line.origin), amountMinor: parsed.minor });
    feeTotalNow += parsed.minor;
  }

  const feeDeltaMinor = feeTotalNow - posted.feeMinor;

  return {
    ok: true,
    facts: {
      refundId: refund.refundId,
      paymentId: refund.paymentId,
      currency,
      amountMinor: refund.amountMinor,
      taxRefundedMinor,
      feeDeltaMinor,
      feeLines: lines,
      occurredAt: refund.updatedAt ?? refund.createdAt,
    },
  };
}

/* -------------------------------------------------------------------------
   THE JOURNAL
   ------------------------------------------------------------------------- */

/**
 * Turns refund facts into a balanced journal. Pure — no database, no network —
 * so the arithmetic can be tested exhaustively without either.
 *
 * THE BALANCE, algebraically:
 *
 *   suspense  = +(amount - taxRefunded)
 *   tax       = +taxRefunded
 *   fees      = +feeDelta
 *   balance   = -(amount + feeDelta)
 *   ------------------------------------------------------------------
 *   sum       = amount - taxRefunded + taxRefunded + feeDelta
 *               - amount - feeDelta
 *             = 0                                          for every input
 *
 * It cannot fail to balance, and it contains no plug: the `provider_balance`
 * leg is a real quantity — the change in what Whop holds for us — that happens
 * also to be the balancing figure. That is what a correct double entry looks
 * like, as opposed to one closed with an adjustment account.
 */
export function buildRefundPosting(
  facts: RefundFacts,
  context: {
    environment: "sandbox" | "production";
    orderId: string | null;
    sourceWebhookId?: string | null;
  },
): PostingInput {
  const legs: JournalLeg[] = [];

  // The suspense liability we no longer owe. Net of any tax portion, which is
  // owed to a different party and tracked separately.
  const suspenseMinor = facts.amountMinor - facts.taxRefundedMinor;
  if (suspenseMinor !== BigInt(0)) {
    legs.push({
      account: "unallocated_customer_funds",
      amountMinor: suspenseMinor,
      counterpartyType: "customer",
    });
  }

  // Tax handed back. ONLY what the provider's own cumulative figure proves.
  if (facts.taxRefundedMinor !== BigInt(0)) {
    legs.push({
      account: "tax_payable",
      amountMinor: facts.taxRefundedMinor,
      counterpartyType: "tax_authority",
    });
  }

  // THE FEE MOVEMENT, and only if there was one.
  //
  // A single net leg rather than one per fee line, because a delta is a
  // difference between two totals and cannot honestly be attributed to
  // individual origins: Whop reports the fee lines as they now stand, not
  // which of them it reversed. `source_detail` says exactly that, so the
  // journal never implies an attribution it does not have. The line-level
  // detail that IS provider-proven stays on the settlement transaction, where
  // it came from a real per-line report.
  if (facts.feeDeltaMinor !== BigInt(0)) {
    legs.push({
      account: "provider_fee_expense",
      amountMinor: facts.feeDeltaMinor,
      counterpartyType: "provider",
      counterpartyId: "whop",
      sourceDetail:
        facts.feeDeltaMinor < BigInt(0) ? "refund_fee_returned" : "refund_fee_charged",
    });
  }

  // What Whop no longer holds for us: the money that went back to the buyer,
  // plus or minus whatever the fee report moved.
  legs.push({
    account: "provider_balance",
    amountMinor: -(facts.amountMinor + facts.feeDeltaMinor),
    counterpartyType: "provider",
    counterpartyId: "whop",
  });

  return {
    economicEvent: "payment_refunded",
    provider: "whop",
    // THE REFUND'S OWN ID, never the payment's. This is what makes three
    // partial refunds three postings, and two deliveries of one refund one
    // posting.
    providerResourceId: facts.refundId,
    environment: context.environment,
    currency: facts.currency,
    idempotencyKey: economicKey("whop", "payment_refunded", facts.refundId),
    orderId: context.orderId,
    sourceWebhookId: context.sourceWebhookId ?? null,
    description: "Whop refund completed",
    occurredAt: facts.occurredAt,
    // The payment is carried in metadata rather than in `provider_resource_id`
    // because that column holds the resource the transaction IS — the refund.
    // `postedTotalsForPayment` reads this back to tie a payment's settlement
    // and all its refunds together.
    metadata: { payment_id: facts.paymentId },
    legs,
  };
}

/**
 * Fetch, build, post. The whole refund rule in one call.
 *
 * ATTACHES AFTER VERIFICATION, never instead of it. The caller must already
 * have run the refund through `mapRefundToOrder` — refund fetched, payment
 * fetched, company ownership checked, order matched, currency compared,
 * cumulative overflow ruled out. This function accounts for a refund that has
 * ALREADY been proved to be ours; it re-fetches because it needs fields the
 * mapping does not carry, not because it re-decides ownership.
 *
 * IDEMPOTENT on `whop:payment_refunded:<rf_id>`. A redelivery converges, a
 * retry after a crash posts the missing transaction, and two concurrent
 * callers produce exactly one posting — all decided by the unique index in
 * `postTransaction`, never by a read here.
 */
export async function postWhopRefund(
  refundId: string,
  context: {
    environment: "sandbox" | "production";
    orderId: string | null;
    sourceWebhookId?: string | null;
  },
) {
  const facts = await fetchRefundFacts(refundId);
  if (!facts.ok) return { ok: false as const, reason: facts.reason, detail: facts.detail };
  return await postTransaction(buildRefundPosting(facts.facts, context));
}
