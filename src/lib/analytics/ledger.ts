/* ==========================================================================
   FINANCIAL MODEL — definitions first, data later.

   The dashboard will eventually show money, and the fastest way to publish a
   wrong number is to let two concepts share one variable. So the concepts are
   separated here, in one place, before any of them has a source.

   THE LEDGER IS NOT ANALYTICS. A browser event named `payment_completed` is a
   product signal — it says a user reached a screen. It can never be the
   authority for revenue, because anyone can send it. Every figure below must
   come from server-side records reconciled against the payment provider.
   `LEDGER_SOURCE` below is what enforces that in code review.
   ========================================================================== */

/** ISO 4217. Language and currency are independent — Hebrew does not imply ILS. */
export type CurrencyCode = "USD" | "ILS" | "EUR" | "GBP";

/**
 * Money is stored in the currency's minor unit (cents/agorot) as an integer.
 * Floating point cannot represent 0.1 exactly, and money must not drift.
 */
export type Money = {
  /** Integer minor units. 1234 in USD is $12.34. */
  amount_minor: number;
  currency: CurrencyCode;
};

/**
 * Amounts in different currencies must never be added. Any total that spans
 * currencies has to state the rate and the date it was taken, so a reported
 * figure can be reproduced later.
 */
export type ConvertedTotal = {
  total: Money;
  /** Per-currency inputs that produced the total. */
  components: Money[];
  /** The rate table used, keyed by source currency. */
  rates: Record<string, number>;
  rate_date: string;
  rate_source: string;
};

export type TransactionType =
  /** Money a brand puts into a campaign budget. */
  | "brand_funding"
  /** Money owed or paid to a creator. */
  | "creator_payout"
  /** The ClipRewards fee actually earned on an event. */
  | "platform_fee"
  /** Money returned to a brand or a user. */
  | "refund"
  /** Cost charged by the external payment provider. */
  | "processing_fee"
  /** Manual correction. Always requires an audit record. */
  | "adjustment";

export type TransactionStatus = "pending" | "completed" | "failed" | "refunded";

export type Transaction = {
  transaction_id: string;
  type: TransactionType;
  money: Money;
  status: TransactionStatus;
  campaign_id: string | null;
  brand_id: string | null;
  /** Set for creator_payout, null otherwise. */
  creator_id: string | null;
  /**
   * The provider's own id for this movement. Null until a real provider is
   * integrated — no placeholder ids are minted, because a fake reference that
   * looks real is worse than an empty field.
   */
  external_provider_reference: string | null;
  created_at: string;
  completed_at: string | null;
};

/**
 * The reported figures, defined once.
 *
 * These are DEFINITIONS, not a claim about the business model. `NET_REVENUE`
 * in particular assumes the platform fee is earned on brand spend and that
 * refunds and processing fees reduce it. If the commercial model turns out to
 * differ, change it here and every report follows.
 */
export const FINANCIAL_DEFINITIONS = {
  GROSS_CAMPAIGN_VOLUME:
    "Money funded or spent by brands through campaigns. Sum of completed brand_funding. Not revenue.",
  CREATOR_PAYOUTS:
    "Money owed or paid to creators. Sum of creator_payout, split by status into pending and completed.",
  PLATFORM_REVENUE:
    "ClipRewards fees actually earned. Sum of completed platform_fee. Never derived from gross volume by assuming a rate.",
  REFUNDS: "Money returned to brands or users. Sum of completed refund.",
  PROCESSING_FEES:
    "Cost charged by the external payment provider. Sum of completed processing_fee.",
  NET_PLATFORM_REVENUE:
    "PLATFORM_REVENUE minus refunds attributable to platform revenue, minus processing fees, minus other recorded platform costs.",
  PENDING_PAYOUTS: "creator_payout with status pending.",
  COMPLETED_PAYOUTS: "creator_payout with status completed.",
  FAILED_PAYMENTS: "Any transaction with status failed.",
  OUTSTANDING_BALANCES:
    "Amounts earned by creators and not yet paid out: completed earnings minus completed payouts.",
} as const;

/**
 * Where each figure is allowed to come from. A reviewer can check a new report
 * against this: anything sourced from `analytics_event` is a bug.
 */
export const LEDGER_SOURCE = {
  allowed: ["payment_provider_webhook", "server_transaction_record", "manual_adjustment_with_audit"],
  forbidden: ["analytics_event", "client_report", "estimated_from_gross_volume"],
} as const;

export function formatMoney(money: Money, locale: "en" | "he"): string {
  return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
    style: "currency",
    currency: money.currency,
  }).format(money.amount_minor / 100);
}

/** Adds same-currency amounts. Throws on a mixed-currency sum by design. */
export function sumMoney(items: Money[], currency: CurrencyCode): Money {
  let total = 0;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new Error(
        `refusing to add ${item.currency} into a ${currency} total — use an explicit conversion`,
      );
    }
    total += item.amount_minor;
  }
  return { amount_minor: total, currency };
}
