import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { accountingEntries, accountingTransactions } from "@/lib/db/schema";
import { normaliseCurrency } from "../money";

/* ==========================================================================
   WHAT A SETTLED PAYMENT MAKES ALLOCATABLE, AND IN WHICH CURRENCY.

   The revenue split moves money OUT of suspense into `platform_revenue` and
   `creator_payable`. Until now the amount it moved came from an admin request
   body, and the currency was the literal `"usd"`. Neither is a fact about the
   payment: an admin could allocate any number, in the only currency the route
   would accept, against a settlement that said something else entirely.

   THE SETTLEMENT POSTING IS THE AUTHORITY, and it already holds both figures:

     unallocated_customer_funds   credited with (total - tax) at settlement
     transaction.currency         the provider's settlement currency

   So this reads them back rather than asking anybody. It is the same data the
   reconciliation sweeps in `reconcile.ts` reconstruct — the difference is that
   they rebuild GROSS (suspense + tax) to compare against an order, while an
   allocation needs the SUSPENSE ALONE. Those are different numbers whenever tax
   exists, and allocating the gross would pay creator and platform out of money
   that belongs to a tax authority.

   TAX NEVER REACHES THIS FIGURE, by construction rather than by subtraction
   here: the settlement already split tax onto `tax_payable`, so the suspense
   leg it credited is net of tax and this function has no tax arithmetic in it
   at all. Nothing to get wrong, and nothing to keep in step with the tax rules.

   ONE CURRENCY, PROVEN. The journal enforces one currency per transaction, and
   every leg repeats it. Both are checked anyway: a settlement whose suspense leg
   disagrees with its own header is a corruption, and the right response to it is
   to refuse to allocate, not to pick one of the two.

   READ-ONLY. Nothing here writes, and it deliberately cannot.
   ========================================================================== */

export type SettlementAllocation = {
  /** The `payment_settled` transaction this was read from. */
  transactionId: string;
  paymentId: string;
  /** The order the settlement was posted against, when it named one. */
  orderId: string | null;
  /**
   * What the settlement put into suspense: economically `total - tax`, and the
   * exact amount a revenue split may move out. Positive.
   */
  allocatableMinor: bigint;
  /** The provider's settlement currency, normalised and supported. */
  currency: string;
};

export type SettlementAllocationFailure =
  /** No database. */
  | "db_unavailable"
  /** Nothing has been settled for this payment in this environment. */
  | "settlement_not_found"
  /** More than one settlement transaction names this payment. */
  | "ambiguous_settlement"
  /** The settlement's currency is not one this build can do exact minor units in. */
  | "unsupported_currency"
  /** A leg's currency disagrees with its transaction header. */
  | "currency_mismatch"
  /** No suspense leg, or one that is not a credit. Nothing safe to allocate. */
  | "suspense_unreadable"
  /** A revenue split has already moved this settlement's suspense. */
  | "already_allocated";

export type SettlementAllocationResult =
  | { ok: true; allocation: SettlementAllocation }
  | { ok: false; reason: SettlementAllocationFailure; detail?: string };

/**
 * Reads the allocatable amount and currency for one settled payment.
 *
 * FAILS CLOSED AT EVERY STEP. Each refusal below is a state in which no honest
 * allocation exists, and inventing one would post real money against a guess:
 *
 *   settlement_not_found   allocating before settling would credit a creator
 *                          from a payment that may never have been collected
 *   ambiguous_settlement   two settlements for one payment means one of them is
 *                          wrong, and there is no way to tell which
 *   unsupported_currency   an amount whose minor units cannot be scaled exactly
 *   currency_mismatch      the transaction and its own legs disagree
 *   suspense_unreadable    no credit to move, or a debit where a credit belongs
 *   already_allocated      the suspense has already been moved; a second split
 *                          would move it again and drive suspense negative
 *
 * `environment` is a server-resolved value, never request input — the same
 * contract every other read in this domain keeps.
 */
export async function readSettlementAllocation(
  paymentId: string,
  environment: "sandbox" | "production",
): Promise<SettlementAllocationResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  /* THE SETTLEMENT ITSELF. Matched on the provider resource id, which is what
   * `buildSettlementPosting` puts the payment id in, and scoped to this
   * environment so a sandbox allocation can never read a production
   * settlement. */
  const settlements = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      currency: accountingTransactions.currency,
      orderId: accountingTransactions.orderId,
    })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "payment_settled"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
        eq(accountingTransactions.providerResourceId, paymentId),
      ),
    );

  if (settlements.length === 0) return { ok: false, reason: "settlement_not_found" };
  if (settlements.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_settlement",
      detail: `${settlements.length} settlements for ${paymentId}`,
    };
  }

  const settlement = settlements[0];

  const currency = normaliseCurrency(settlement.currency);
  if (!currency) {
    return { ok: false, reason: "unsupported_currency", detail: String(settlement.currency) };
  }

  /* ALREADY ALLOCATED? The split is documented as written once per settlement,
   * and the enum comment in the schema says so too. Checked across EVERY
   * creator, not just the one being recorded: the earning row's uniqueness is
   * per (payment, creator), so a second creator would pass that check and post
   * a second full-suspense debit. */
  const existingSplits = await db
    .select({ transactionId: accountingTransactions.transactionId })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "revenue_split"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
        eq(accountingTransactions.providerResourceId, paymentId),
      ),
    )
    .limit(1);

  if (existingSplits.length > 0) {
    return {
      ok: false,
      reason: "already_allocated",
      detail: existingSplits[0].transactionId,
    };
  }

  /* THE SUSPENSE LEG, and its own currency alongside it. Grouped by currency so
   * a transaction carrying legs in two currencies cannot be flattened into one
   * total — the journal forbids that, and this refuses to paper over it if the
   * constraint were ever bypassed. */
  const suspense = await db
    .select({
      currency: accountingEntries.currency,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.transactionId, settlement.transactionId),
        eq(accountingEntries.account, "unallocated_customer_funds"),
      ),
    )
    .groupBy(accountingEntries.currency);

  if (suspense.length === 0) return { ok: false, reason: "suspense_unreadable", detail: "no leg" };
  if (suspense.length > 1) {
    return { ok: false, reason: "currency_mismatch", detail: "suspense legs in several currencies" };
  }

  const legCurrency = normaliseCurrency(suspense[0].currency);
  if (!legCurrency || legCurrency !== currency) {
    return {
      ok: false,
      reason: "currency_mismatch",
      detail: `leg ${String(suspense[0].currency)} vs transaction ${currency}`,
    };
  }

  /* SIGNS. Suspense is a LIABILITY credited at settlement, so the stored sum is
   * negative and the allocatable amount is its negation. A non-negative sum
   * means there is no credit to move — either no money or an already-cleared
   * suspense — and neither is something to allocate against. */
  const allocatableMinor = -BigInt(suspense[0].total ?? "0");
  if (allocatableMinor <= BigInt(0)) {
    return {
      ok: false,
      reason: "suspense_unreadable",
      detail: `suspense ${allocatableMinor.toString()}`,
    };
  }

  return {
    ok: true,
    allocation: {
      transactionId: settlement.transactionId,
      paymentId,
      orderId: settlement.orderId ?? null,
      allocatableMinor,
      currency,
    },
  };
}
