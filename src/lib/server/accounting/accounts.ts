import "server-only";

/* ==========================================================================
   THE CHART OF ACCOUNTS.

   One list, in one file, so an account can never be invented at a call site.
   `postTransaction` accepts nothing that is not named here, and the database
   enum in migration 0004 carries exactly these values — a leg posted to an
   account that does not exist is a type error and a constraint violation, not
   a row nobody notices.

   SIGN CONVENTION, stated once and used everywhere:

       amount_minor > 0  is a DEBIT
       amount_minor < 0  is a CREDIT
       every transaction's legs sum to EXACTLY ZERO

   A signed integer rather than a `direction` column plus a positive amount:
   the two would be redundant, and redundant money representations drift. With
   one signed column "is this journal balanced" is `sum(amount_minor) = 0`,
   which the database can enforce on its own.

   NORMAL BALANCE below is documentation and a sanity check, not a rule. A
   liability legitimately goes into debit while a refund is in flight, so the
   journal does NOT refuse a leg that runs against its account's normal side.

   ACCOUNTS DECLARED BUT NOT YET POSTED TO. Several accounts below have no
   writer anywhere in this codebase, and that is deliberate: `platform_revenue`
   and `creator_payable` cannot be posted until the fee model and the revenue
   split are decided. They are named here so the model is complete and so the
   later work is a new posting rule rather than a schema change — but nothing
   assigns them an amount, because any amount would be invented.
   ========================================================================== */

/** What kind of thing an account measures. Drives the normal balance. */
export type AccountKind = "asset" | "liability" | "revenue" | "expense";

export type AccountDefinition = {
  kind: AccountKind;
  /** Which side increases this account. Documentation; never enforced. */
  normalBalance: "debit" | "credit";
  /** Whether anything in this build is allowed to post to it yet. */
  postable: boolean;
  description: string;
};

export const ACCOUNTS = {
  /* ------------------------------- assets ------------------------------- */

  provider_balance: {
    kind: "asset",
    normalBalance: "debit",
    postable: true,
    description:
      "Money held for us at Whop. Increased by the net a payment settles for, decreased by refunds, dispute losses and payouts. This is not a bank balance — it becomes one only when a payout lands.",
  },

  payout_clearing: {
    kind: "asset",
    normalBalance: "debit",
    postable: false,
    description:
      "Money that has left the provider balance for a bank account but is not yet confirmed received. Declared for the payout task; nothing posts to it yet.",
  },

  /* ----------------------------- liabilities ---------------------------- */

  unallocated_customer_funds: {
    kind: "liability",
    normalBalance: "credit",
    postable: true,
    description:
      "SUSPENSE. The gross a customer paid, before anyone has decided what it is economically. Every settled payment is credited here and stays here until a product rule says how it splits between platform revenue, creator liability and campaign funds. It is a liability on purpose: until that rule exists, the safe assumption is that the money is owed to someone, not earned.",
  },

  tax_payable: {
    kind: "liability",
    normalBalance: "credit",
    postable: true,
    description:
      "Sales tax or VAT collected from a customer and owed onwards. Posted only from the provider's own `tax_amount`; never derived from a rate.",
  },

  creator_payable: {
    kind: "liability",
    normalBalance: "credit",
    postable: false,
    description:
      "What a creator has earned and not been paid. BLOCKED: the revenue split does not exist yet, so no amount can be assigned without inventing it.",
  },

  campaign_funds: {
    kind: "liability",
    normalBalance: "credit",
    postable: false,
    description:
      "Brand money held against a campaign budget and not yet spent. BLOCKED: campaigns do not exist yet.",
  },

  refunds_payable: {
    kind: "liability",
    normalBalance: "credit",
    postable: false,
    description:
      "A refund agreed and not yet moved. Declared for the refund task; refunds are not implemented.",
  },

  dispute_reserve: {
    kind: "liability",
    normalBalance: "credit",
    postable: false,
    description:
      "Funds withheld against an open chargeback. Declared for the dispute task; disputes are not implemented.",
  },

  /* ------------------------------ revenue ------------------------------- */

  platform_revenue: {
    kind: "revenue",
    normalBalance: "credit",
    postable: false,
    description:
      "ClipRewards fees actually earned. BLOCKED: the platform fee has not been decided. Never derived from gross volume by assuming a rate.",
  },

  /* ------------------------------ expenses ------------------------------ */

  provider_fee_expense: {
    kind: "expense",
    normalBalance: "debit",
    postable: true,
    description:
      "What Whop and its processors charged on a payment. Posted ONLY from `payments.listFees`, line by line, never from a percentage.",
  },

  fx_adjustment: {
    kind: "expense",
    normalBalance: "debit",
    postable: false,
    description:
      "Difference arising when a movement settles in a currency other than the one it was charged in. Declared so a multi-currency posting has somewhere honest to go; nothing posts to it, and no posting is ever forced to balance through it.",
  },
} as const satisfies Record<string, AccountDefinition>;

export type LedgerAccount = keyof typeof ACCOUNTS;

/** Exactly the values the `ledger_account` database enum carries. */
export const LEDGER_ACCOUNTS = Object.keys(ACCOUNTS) as LedgerAccount[];

export function isLedgerAccount(value: unknown): value is LedgerAccount {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACCOUNTS, value);
}

/**
 * Whether this build has a rule that may write to the account.
 *
 * The journal refuses a leg on a non-postable account. That is what stops a
 * future change from quietly starting to book platform revenue before anyone
 * has decided what the platform fee is.
 */
export function isPostable(account: LedgerAccount): boolean {
  return ACCOUNTS[account].postable;
}

/* ==========================================================================
   ECONOMIC EVENTS — what happened in the world, not what a provider sent.

   A webhook delivery is not an economic event: three deliveries of the same
   `payment.succeeded` are one settlement. A refund and the payment it refunds
   are two economic events that share one provider resource id. That is why
   idempotency is keyed on (provider, event type, resource) and never on a
   delivery id — see `economicKey`.
   ========================================================================== */

export const ECONOMIC_EVENTS = [
  /** A customer's charge collected and the net credited to our provider balance. */
  "payment_settled",
  /** Money returned to a customer, in whole or in part. */
  "payment_refunded",
  /** A chargeback opened; funds withheld pending the outcome. */
  "dispute_opened",
  /** A chargeback decided in our favour. */
  "dispute_won",
  /** A chargeback decided against us; the withheld funds are gone. */
  "dispute_lost",
  /** Provider balance paid out towards a bank account. */
  "payout_sent",
  /** A payout that failed or was clawed back. */
  "payout_reversed",
  /** A human correction, which always carries an audit record. */
  "manual_adjustment",
  /** The exact opposite of an earlier transaction. See `reverseTransaction`. */
  "reversal",
] as const;

export type EconomicEvent = (typeof ECONOMIC_EVENTS)[number];

/** Only these produce a posting today. The rest are declared, not implemented. */
export const IMPLEMENTED_EVENTS: ReadonlySet<EconomicEvent> = new Set<EconomicEvent>([
  "payment_settled",
  "reversal",
]);

/**
 * THE ECONOMIC IDEMPOTENCY KEY.
 *
 * Deliberately built from what happened rather than from how we heard about
 * it. Two different webhook message ids describing the same settlement produce
 * the same key and therefore one posting; a refund on the same payment
 * produces a different key and therefore its own posting.
 */
export function economicKey(
  provider: string,
  event: EconomicEvent,
  resourceId: string,
): string {
  return `${provider}:${event}:${resourceId}`;
}
