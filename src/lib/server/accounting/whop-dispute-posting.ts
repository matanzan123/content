import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { accountingTransactions } from "@/lib/db/schema";
import { getWhopEnvironment } from "../whop-payments";
import { listLedgerMovementsForPayment, type LedgerMovement } from "../whop-disputes";
import { economicKey, type EconomicEvent } from "./accounts";
import { postTransaction, type JournalLeg, type PostingInput } from "./journal";

/* ==========================================================================
   THE DISPUTE POSTING RULE — a mirror of the provider's own ledger.

   WHY THIS IS NOT DRIVEN BY THE DISPUTE RESOURCE.

   The `Dispute` object carries NO fee field and NO balance field. Verified
   against both the installed SDK type and the published reference: `amount`,
   `status`, `reason`, evidence and timestamps, and nothing whatsoever about
   money moving. `DisputeAlert` is worse — it says only WHETHER a fee was
   charged (`fee_charged: boolean`), never how much.

   So a status cannot be turned into a journal entry. `lost` does not carry an
   amount that left us, and `won` does not carry one that came back. Worse,
   `Dispute.inquiry` is documented as "moves no funds unless one escalates",
   so an inquiry can reach `lost` having moved nothing at all. Any rule of the
   form "when status becomes lost, debit X" would be inventing provider
   economics, which this build refuses to do.

   WHAT IS AUTHORITATIVE: `financialActivity.list`, documented as "every
   movement of money in or out". Each `LedgerActivity` row is ONE signed
   movement with its own id, its own `line_type` and the `payment_id` it
   belongs to. That feed is the provider's own books, and this module posts a
   faithful mirror of the dispute-related rows in it — nothing more.

   VERIFIED AGAINST OUR OWN LEDGER before being trusted: read live for the real
   sandbox payment, the feed reports +10.00 gross, -0.87 of fees and two
   refunds of -2.00 and -1.00, netting to 6.13 — exactly the `provider_balance`
   our journal computed independently from `payments.retrieve` and
   `payments.listFees`. Two different APIs, one number.

   THE LINE TYPES THIS BUILD POSTS, and what each means:

     payment_dispute            the disputed money left our balance
     payment_dispute_reversal   it came back (the dispute was won)
     payment_dispute_fee        the processor's chargeback fee
     dispute_alert_fee          the fee Whop passes on for an alert network
                                notice
     dispute_representment_fee  the fee for contesting

   THE LINE TYPES THIS BUILD DELIBERATELY REFUSES:

     dispute_hold_adjustment    a reserve movement whose direction and
                                reversal semantics are not documented
     payment_dispute_adjustment an unexplained correction
     platform_covered_dispute   Whop absorbed it — NOT our money, and booking
                                it against our balance would record someone
                                else's expense as ours

   Refusing is not a gap to be filled by guessing. Each is reported by
   reconciliation as `dispute_unmapped_line_type` so a person can decide, which
   is the correct response to a movement whose meaning we cannot state.

   THE SIGN COMES FROM THE PROVIDER, NEVER FROM THE LINE TYPE. A row's
   `amount` is already signed: negative is money leaving our balance. The
   posting mirrors it rather than re-deriving a direction from the name, so a
   reversal that Whop reports as positive is posted as positive whatever we
   assumed the word meant.

   WHAT IS NOT POSTED, ever: `platform_revenue`, `creator_payable`,
   `dispute_reserve`, and any payout, transfer or withdrawal account. The
   settlement credited the whole gross into `unallocated_customer_funds`
   because nobody has decided how it splits, and a chargeback against money
   that was never split needs no unsplitting.
   ========================================================================== */

/**
 * The dispute-related line types this build has a rule for, mapped to the
 * economic event they represent and the account that faces `provider_balance`.
 *
 * A TABLE, not a switch, so the whole rule is readable at once and the tests
 * can assert over it directly.
 */
export const DISPUTE_LINE_RULES: Record<
  string,
  { event: EconomicEvent; contraAccount: "unallocated_customer_funds" | "provider_fee_expense" }
> = {
  // The disputed money leaves us and goes back to the buyer. Economically the
  // same shape as a refund: the suspense liability we owed that customer is
  // discharged, and the provider balance falls.
  payment_dispute: { event: "dispute_lost", contraAccount: "unallocated_customer_funds" },

  // ...and the reverse, when the dispute is won and the money is returned.
  payment_dispute_reversal: {
    event: "dispute_won",
    contraAccount: "unallocated_customer_funds",
  },

  // Fees are a cost of the dispute, not a movement of customer money.
  payment_dispute_fee: { event: "dispute_opened", contraAccount: "provider_fee_expense" },
  dispute_alert_fee: { event: "dispute_opened", contraAccount: "provider_fee_expense" },
  dispute_representment_fee: {
    event: "dispute_opened",
    contraAccount: "provider_fee_expense",
  },
};

/**
 * Dispute-related line types we can see but will NOT post, with the reason.
 *
 * Named explicitly rather than falling through a default, so that "we do not
 * have a rule for this" is a deliberate, greppable, testable state rather than
 * an accident of control flow.
 */
export const DISPUTE_LINE_TYPES_NOT_POSTED: Record<string, string> = {
  dispute_hold_adjustment:
    "a reserve movement; Whop documents neither its direction nor when it reverses",
  payment_dispute_adjustment: "an unexplained correction with no documented semantics",
  platform_covered_dispute:
    "Whop absorbed the loss; the money was never ours and must not be booked against our balance",
};

/** Every dispute-family line type, posted or not. Used to scope the ledger scan. */
export const ALL_DISPUTE_LINE_TYPES: readonly string[] = [
  ...Object.keys(DISPUTE_LINE_RULES),
  ...Object.keys(DISPUTE_LINE_TYPES_NOT_POSTED),
];

export function isDisputeLineType(lineType: string): boolean {
  return ALL_DISPUTE_LINE_TYPES.includes(lineType);
}

export function isPostableDisputeLine(lineType: string): boolean {
  return Object.prototype.hasOwnProperty.call(DISPUTE_LINE_RULES, lineType);
}

/* -------------------------------------------------------------------------
   THE JOURNAL
   ------------------------------------------------------------------------- */

/**
 * Turns ONE provider ledger movement into a balanced journal. Pure — no
 * database, no network — so the arithmetic can be tested exhaustively.
 *
 * TWO LEGS, ALWAYS, because a ledger row is one movement between our balance
 * and one other place:
 *
 *   provider_balance   +amount   (as the provider signed it)
 *   contra account     -amount
 *
 * It cannot fail to balance and it contains no plug. A row of -200 (money
 * left) on `payment_dispute` produces `CR provider_balance 200` and
 * `DR unallocated_customer_funds 200` — the mirror image of the settlement
 * that put it there.
 *
 * Returns null for a movement with no rule, or a zero amount. A zero-value
 * ledger row is real but moves nothing, and a journal leg of zero is refused
 * by the database anyway.
 */
export function buildDisputeLedgerPosting(
  movement: LedgerMovement,
  context: {
    environment: "sandbox" | "production";
    orderId: string | null;
    /** The dispute this movement belongs to, when one is known. Evidence only. */
    disputeId?: string | null;
    sourceWebhookId?: string | null;
  },
): PostingInput | null {
  const rule = DISPUTE_LINE_RULES[movement.lineType];
  if (!rule) return null;
  if (movement.amountMinor === BigInt(0)) return null;

  const legs: JournalLeg[] = [
    {
      // THE PROVIDER'S OWN SIGN, mirrored rather than re-derived.
      account: "provider_balance",
      amountMinor: movement.amountMinor,
      counterpartyType: "provider",
      counterpartyId: "whop",
      sourceDetail: movement.lineType,
    },
    {
      account: rule.contraAccount,
      amountMinor: -movement.amountMinor,
      counterpartyType:
        rule.contraAccount === "provider_fee_expense" ? "provider" : "customer",
      counterpartyId: rule.contraAccount === "provider_fee_expense" ? "whop" : null,
      sourceDetail: movement.lineType,
    },
  ];

  return {
    economicEvent: rule.event,
    provider: "whop",
    // THE LEDGER ROW'S OWN ID. Not the dispute id: one dispute produces
    // several movements (a fee, a withdrawal, later a reversal), and keying on
    // the dispute would collapse them into one posting and lose money.
    providerResourceId: movement.activityId,
    environment: context.environment,
    currency: movement.currency,
    idempotencyKey: economicKey("whop", rule.event, movement.activityId),
    orderId: context.orderId,
    sourceWebhookId: context.sourceWebhookId ?? null,
    description: `Whop ${movement.lineType}`,
    occurredAt: movement.postedAt,
    metadata: {
      payment_id: movement.paymentId,
      line_type: movement.lineType,
      dispute_id: context.disputeId ?? null,
    },
    legs,
  };
}

/* -------------------------------------------------------------------------
   POSTING
   ------------------------------------------------------------------------- */

export type DisputePostingOutcome = {
  activityId: string;
  lineType: string;
  result:
    | { kind: "posted"; transactionId: string }
    | { kind: "already_posted"; transactionId: string }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; reason: string };
};

export type DisputePostingReport = {
  ok: boolean;
  paymentId: string;
  /** Dispute-family rows seen in the provider's feed. */
  examined: number;
  outcomes: DisputePostingOutcome[];
  reason?: string;
};

/**
 * Posts every dispute-related movement the provider reports for ONE payment.
 *
 * IDEMPOTENT PER MOVEMENT. Each row converges on
 * `whop:<event>:<ledger_activity_id>`, so re-running posts nothing new, a
 * retry after a crash posts exactly what was missing, and two concurrent
 * callers produce one posting each — all decided by the unique index in
 * `postTransaction`, never by a read here.
 *
 * SAFE TO RUN AT ANY TIME. It is the same call whether it is driven by a
 * `dispute.updated` webhook, by reconciliation, or by an operator: the ledger
 * feed is the input, and the feed is the same regardless of what asked.
 */
export async function postDisputeMovementsForPayment(
  paymentId: string,
  context: {
    orderId: string | null;
    disputeId?: string | null;
    sourceWebhookId?: string | null;
  },
): Promise<DisputePostingReport> {
  const environment = getWhopEnvironment();
  if (!environment) {
    return { ok: false, paymentId, examined: 0, outcomes: [], reason: "unconfigured" };
  }

  const ledger = await listLedgerMovementsForPayment(paymentId);
  if (!ledger.ok) {
    // WE COULD NOT ASK. Not a clean bill of health — the caller must treat this
    // as retryable and must not record the delivery as handled.
    return { ok: false, paymentId, examined: 0, outcomes: [], reason: ledger.reason };
  }

  const disputeRows = ledger.movements.filter((m) => isDisputeLineType(m.lineType));
  const outcomes: DisputePostingOutcome[] = [];

  for (const movement of disputeRows) {
    const notPosted = DISPUTE_LINE_TYPES_NOT_POSTED[movement.lineType];
    if (notPosted) {
      outcomes.push({
        activityId: movement.activityId,
        lineType: movement.lineType,
        result: { kind: "skipped", reason: notPosted },
      });
      continue;
    }

    const posting = buildDisputeLedgerPosting(movement, {
      environment,
      orderId: context.orderId,
      disputeId: context.disputeId ?? null,
      sourceWebhookId: context.sourceWebhookId ?? null,
    });
    if (!posting) {
      outcomes.push({
        activityId: movement.activityId,
        lineType: movement.lineType,
        result: { kind: "skipped", reason: "zero amount" },
      });
      continue;
    }

    const posted = await postTransaction(posting);
    outcomes.push({
      activityId: movement.activityId,
      lineType: movement.lineType,
      result: posted.ok
        ? {
            kind: posted.alreadyPosted ? "already_posted" : "posted",
            transactionId: posted.transactionId,
          }
        : { kind: "failed", reason: posted.reason },
    });
  }

  const anyFailed = outcomes.some((o) => o.result.kind === "failed");
  return {
    ok: !anyFailed,
    paymentId,
    examined: disputeRows.length,
    outcomes,
    reason: anyFailed ? "posting_failed" : undefined,
  };
}

/**
 * Whether a given ledger movement has already been accounted for.
 *
 * Looked up by the ECONOMIC KEY rather than the resource id, because that is
 * the value the unique index is built on: any other lookup could disagree with
 * the constraint that actually decides.
 */
export async function disputePostingFor(activityId: string, event: EconomicEvent) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ transactionId: accountingTransactions.transactionId })
    .from(accountingTransactions)
    .where(eq(accountingTransactions.idempotencyKey, economicKey("whop", event, activityId)));
  return row ?? null;
}
