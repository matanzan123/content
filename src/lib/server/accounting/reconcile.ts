import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  accountingEntries,
  accountingTransactions,
  paymentOrders,
  paymentRefunds,
} from "@/lib/db/schema";
import { economicKey } from "./accounts";
import { fetchSettlementFacts } from "./whop-payment-posting";
import { retrievePaymentPhase } from "../whop-resources";
import { classifyProviderStatus, isAbsorbing, targetOrderStatus } from "../payment-lifecycle";
import { classifyRefundStatus } from "../refund-lifecycle";
import { listRefundsForPayment } from "../whop-refunds";
import { listRefundsForPaymentLocal } from "../payment-refunds";
import { refundableBalance } from "../whop-refund-mapping";

/* ==========================================================================
   RECONCILIATION — four records, compared, nothing repaired.

     Whop payment  ↔  payment_orders  ↔  accounting_transactions  ↔  entries

   THIS MODULE NEVER WRITES. Not a correcting entry, not a status change,
   nothing. A discrepancy in money is a thing a person decides about, and an
   automatic repair is how one wrong number becomes two wrong numbers and an
   audit trail that agrees with both. Every function here returns findings.

   The findings are deliberately specific — "amount_mismatch" and
   "currency_mismatch" are different problems with different causes, and
   collapsing them into "mismatch" would throw away the part that tells an
   operator where to look.
   ========================================================================== */

export type DiscrepancyCode =
  /** A paid order with no accounting transaction at all. */
  | "missing_ledger"
  /** More than one transaction posted for the same economic event. */
  | "duplicate_ledger"
  /** The ledger's gross does not equal the order's amount. */
  | "amount_mismatch"
  /** Order, payment and ledger do not agree on the currency. */
  | "currency_mismatch"
  /** The transaction names a different provider resource than the order does. */
  | "provider_resource_mismatch"
  /** The transaction's legs do not sum to zero. */
  | "unbalanced_transaction"
  /** A transaction exists for an order that was never marked paid. */
  | "ledger_without_paid_order"
  /** Provider and our records disagree on what the payment is. */
  | "provider_mismatch"
  /** The provider could not be asked. Not a discrepancy — an unknown. */
  | "provider_unavailable"
  /** An order left mid-flight long enough that it will not resolve on its own. */
  | "stale_pending"
  /** Whop and our order disagree about where the payment is. */
  | "provider_status_conflict"
  /** A state that should not be reachable at all. */
  | "impossible_state";

export type Discrepancy = {
  code: DiscrepancyCode;
  orderId: string | null;
  transactionId: string | null;
  paymentId: string | null;
  detail: string;
};

export type ReconciliationReport = {
  configured: boolean;
  /** Orders examined. Zero is a real answer, not an error. */
  ordersChecked: number;
  transactionsChecked: number;
  /** True only when the provider was actually queried. */
  providerConsulted: boolean;
  discrepancies: Discrepancy[];
};

/**
 * How long an order may sit mid-flight before it is worth a human look.
 *
 * Generous on purpose. Card rails clear in seconds, but bank debits and
 * some local methods legitimately take days, and a threshold that flags
 * those produces a report nobody reads.
 */
export const STALE_PENDING_HOURS = 72;

const EMPTY: ReconciliationReport = {
  configured: false,
  ordersChecked: 0,
  transactionsChecked: 0,
  providerConsulted: false,
  discrepancies: [],
};

/**
 * Compares our own records against each other, without touching the network.
 *
 * This is the cheap half and it catches the failures that matter most: a paid
 * order that was never accounted for, an event accounted for twice, and a
 * journal that does not balance. It is safe to run on a schedule.
 */
export async function reconcileInternal(limit = 500): Promise<ReconciliationReport> {
  const db = getDb();
  if (!db) return EMPTY;

  const findings: Discrepancy[] = [];

  const orders = await db
    .select({
      orderId: paymentOrders.orderId,
      amountMinor: paymentOrders.amountMinor,
      currency: paymentOrders.currency,
      status: paymentOrders.status,
      whopPaymentId: paymentOrders.whopPaymentId,
      updatedAt: paymentOrders.updatedAt,
    })
    .from(paymentOrders)
    .limit(limit);

  // Every settlement transaction, indexed by the payment it names.
  const transactions = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      economicEvent: accountingTransactions.economicEvent,
      providerResourceId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
      orderId: accountingTransactions.orderId,
      idempotencyKey: accountingTransactions.idempotencyKey,
    })
    .from(accountingTransactions)
    .where(eq(accountingTransactions.economicEvent, "payment_settled"));

  const byPayment = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const key = t.providerResourceId ?? "";
    const list = byPayment.get(key) ?? [];
    list.push(t);
    byPayment.set(key, list);
  }

  // The credit side of a settlement is the gross the customer paid: the
  // suspense leg plus any tax leg, both stored as negatives.
  const grossByTransaction = new Map<string, bigint>();
  const legSums = await db
    .select({
      transactionId: accountingEntries.transactionId,
      account: accountingEntries.account,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .groupBy(accountingEntries.transactionId, accountingEntries.account);

  const residual = new Map<string, bigint>();
  for (const row of legSums) {
    const value = BigInt(row.total ?? "0");
    residual.set(row.transactionId, (residual.get(row.transactionId) ?? BigInt(0)) + value);
    if (row.account === "unallocated_customer_funds" || row.account === "tax_payable") {
      grossByTransaction.set(
        row.transactionId,
        (grossByTransaction.get(row.transactionId) ?? BigInt(0)) - value,
      );
    }
  }

  for (const [transactionId, sum] of residual) {
    if (sum !== BigInt(0)) {
      findings.push({
        code: "unbalanced_transaction",
        orderId: null,
        transactionId,
        paymentId: null,
        detail: `legs sum to ${sum.toString()}, expected 0`,
      });
    }
  }

  const staleBefore = Date.now() - STALE_PENDING_HOURS * 3600 * 1000;

  for (const order of orders) {
    const posted = order.whopPaymentId ? (byPayment.get(order.whopPaymentId) ?? []) : [];

    // STUCK MID-FLIGHT. A charge that has neither settled nor failed after
    // this long is not still clearing — a delivery was missed, or a rail gave
    // up quietly. Reported, never resolved from here: only the provider can
    // say where the money went, and asking it is the job of the per-payment
    // pass below.
    if (
      (order.status === "payment_pending" || order.status === "checkout_created") &&
      order.updatedAt.getTime() < staleBefore
    ) {
      findings.push({
        code: "stale_pending",
        orderId: order.orderId,
        transactionId: null,
        paymentId: order.whopPaymentId,
        detail: `${order.status} since ${order.updatedAt.toISOString()}`,
      });
    }

    if (order.status === "paid") {
      if (!order.whopPaymentId) {
        findings.push({
          code: "impossible_state",
          orderId: order.orderId,
          transactionId: null,
          paymentId: null,
          detail: "order is paid but names no provider payment",
        });
        continue;
      }
      if (posted.length === 0) {
        findings.push({
          code: "missing_ledger",
          orderId: order.orderId,
          transactionId: null,
          paymentId: order.whopPaymentId,
          detail: "paid order has no payment_settled transaction",
        });
        continue;
      }
    }

    if (posted.length > 1) {
      findings.push({
        code: "duplicate_ledger",
        orderId: order.orderId,
        transactionId: posted[0].transactionId,
        paymentId: order.whopPaymentId,
        detail: `${posted.length} settlement transactions for one payment`,
      });
    }

    for (const t of posted) {
      if (order.status !== "paid") {
        findings.push({
          code: "ledger_without_paid_order",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: `order status is ${order.status}`,
        });
      }
      if (t.currency !== order.currency) {
        findings.push({
          code: "currency_mismatch",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: `ledger ${t.currency}, order ${order.currency}`,
        });
      }
      if (t.orderId !== null && t.orderId !== order.orderId) {
        findings.push({
          code: "provider_resource_mismatch",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: `transaction points at order ${t.orderId}`,
        });
      }
      const gross = grossByTransaction.get(t.transactionId);
      if (gross === undefined) {
        findings.push({
          code: "impossible_state",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: "settlement transaction has no customer-funds leg",
        });
      } else if (gross !== order.amountMinor) {
        // A legitimate difference exists the moment tax is switched on: the
        // order records the price, the gross includes tax. It is reported
        // rather than tolerated, because until tax is actually configured a
        // difference here means something else went wrong.
        findings.push({
          code: "amount_mismatch",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: `ledger gross ${gross.toString()}, order ${order.amountMinor.toString()}`,
        });
      }
      const expectedKey = economicKey("whop", "payment_settled", order.whopPaymentId ?? "");
      if (order.whopPaymentId && t.idempotencyKey !== expectedKey) {
        findings.push({
          code: "provider_resource_mismatch",
          orderId: order.orderId,
          transactionId: t.transactionId,
          paymentId: order.whopPaymentId,
          detail: "idempotency key does not describe this payment",
        });
      }
    }
  }

  return {
    configured: true,
    ordersChecked: orders.length,
    transactionsChecked: transactions.length,
    providerConsulted: false,
    discrepancies: findings,
  };
}

/**
 * Adds the provider to the comparison, for ONE payment.
 *
 * Separate from the internal pass and one payment at a time, because it costs
 * two API calls per payment and is not something to run across a whole table
 * on a timer. `provider_unavailable` is reported as its own code: not being
 * able to ask is different from asking and disagreeing, and only one of those
 * is a discrepancy.
 */
export async function reconcilePaymentAgainstProvider(
  paymentId: string,
): Promise<Discrepancy[]> {
  const db = getDb();
  if (!db) return [];

  const findings: Discrepancy[] = [];

  const facts = await fetchSettlementFacts(paymentId);
  if (!facts.ok) {
    return [
      {
        code: facts.reason === "provider_error" || facts.reason === "unconfigured"
          ? "provider_unavailable"
          : "provider_mismatch",
        orderId: null,
        transactionId: null,
        paymentId,
        detail: `${facts.reason}${facts.detail ? `: ${facts.detail}` : ""}`,
      },
    ];
  }

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.whopPaymentId, paymentId));

  const [transaction] = await db
    .select()
    .from(accountingTransactions)
    .where(
      eq(accountingTransactions.idempotencyKey, economicKey("whop", "payment_settled", paymentId)),
    );

  if (!order) {
    findings.push({
      code: "provider_mismatch",
      orderId: null,
      transactionId: transaction?.transactionId ?? null,
      paymentId,
      detail: "provider reports a settled payment with no matching order",
    });
  } else {
    if (order.currency !== facts.facts.currency) {
      findings.push({
        code: "currency_mismatch",
        orderId: order.orderId,
        transactionId: transaction?.transactionId ?? null,
        paymentId,
        detail: `provider ${facts.facts.currency}, order ${order.currency}`,
      });
    }
    if (!transaction) {
      findings.push({
        code: "missing_ledger",
        orderId: order.orderId,
        transactionId: null,
        paymentId,
        detail: "provider reports settled; nothing is accounted for",
      });
    }
  }

  if (transaction) {
    const legs = await db
      .select({
        account: accountingEntries.account,
        amountMinor: accountingEntries.amountMinor,
      })
      .from(accountingEntries)
      .where(eq(accountingEntries.transactionId, transaction.transactionId));

    const balanceLeg = legs
      .filter((l) => l.account === "provider_balance")
      .reduce((a, l) => a + l.amountMinor, BigInt(0));

    if (balanceLeg !== facts.facts.afterFeesMinor) {
      findings.push({
        code: "amount_mismatch",
        orderId: order?.orderId ?? null,
        transactionId: transaction.transactionId,
        paymentId,
        detail: `ledger net ${balanceLeg.toString()}, provider amount_after_fees ${facts.facts.afterFeesMinor.toString()}`,
      });
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------
   LIFECYCLE RECONCILIATION
   ------------------------------------------------------------------------- */

/**
 * Asks Whop where ONE payment actually is, and compares that to the order.
 *
 * This is the check that catches the failures the internal pass cannot see,
 * because both of our own records can be wrong together:
 *
 *   - Whop says `paid`, our order does not         → a missed delivery
 *   - Whop says `void`/`uncollectible`, order paid → the serious one
 *   - Whop says in flight, order says failed       → a stale failure stuck
 *
 * Still read-only. It names the conflict and the direction; deciding what to
 * do about a paid order the provider says was never collected is not a thing
 * a scheduled job should do on its own.
 *
 * `provider_unavailable` is reported as its own code and never as a conflict:
 * an outage means we do not know, and a report that turned "could not ask"
 * into "records disagree" would generate false alarms during every incident.
 */
export async function reconcileOrderLifecycle(orderId: string): Promise<Discrepancy[]> {
  const db = getDb();
  if (!db) return [];

  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.orderId, orderId));
  if (!order) return [];

  if (!order.whopPaymentId) {
    // NOTHING TO ASK ABOUT, and this is a real limitation rather than an
    // oversight: `whop_payment_id` is only written when a payment SETTLES an
    // order, so an order in `payment_pending` or `failed` holds no link to
    // the provider. Those are reachable the other way round — from a payment
    // id, which `whop_webhook_receipts.resource_id` always records — via
    // `reconcilePaymentAgainstProvider` and `convergeFromPayment`.
    //
    // An order with no payment is only wrong if it claims to be paid, and the
    // internal pass already reports that as `impossible_state`.
    return [];
  }

  const phase = await retrievePaymentPhase(order.whopPaymentId);

  if (phase.kind !== "known") {
    const unavailable = phase.kind === "provider_error" || phase.kind === "unconfigured";
    return [
      {
        code: unavailable ? "provider_unavailable" : "provider_mismatch",
        orderId: order.orderId,
        transactionId: null,
        paymentId: order.whopPaymentId,
        detail: phase.kind,
      },
    ];
  }

  const classified = classifyProviderStatus(phase.status);
  const expected = targetOrderStatus(classified);

  if (expected === order.status) return [];

  // `paid` is absorbing for a reason, and the provider agreeing that a payment
  // is still in flight does not un-pay it — an in-flight status on a settled
  // payment is normal while a later attempt or adjustment is processing. Only
  // a provider status that rules collection out is a conflict with `paid`.
  if (isAbsorbing(order.status)) {
    if (order.status === "paid" && classified === "terminal_unpaid") {
      return [
        {
          code: "provider_status_conflict",
          orderId: order.orderId,
          transactionId: null,
          paymentId: order.whopPaymentId,
          detail: `order is paid but provider reports ${phase.status} — money may never have been collected`,
        },
      ];
    }
    return [];
  }

  return [
    {
      code: "provider_status_conflict",
      orderId: order.orderId,
      transactionId: null,
      paymentId: order.whopPaymentId,
      detail: `order is ${order.status}, provider reports ${phase.status} (expected ${expected})`,
    },
  ];
}

/**
 * Every order that names a provider payment, checked against Whop.
 *
 * Bounded and sequential: this is two API calls per order, and a
 * reconciliation job that stampedes the provider during an incident is its own
 * outage.
 */
export async function reconcileLifecycleAgainstProvider(limit = 50): Promise<Discrepancy[]> {
  const db = getDb();
  if (!db) return [];

  const orders = await db
    .select({ orderId: paymentOrders.orderId })
    .from(paymentOrders)
    .where(sql`${paymentOrders.whopPaymentId} is not null`)
    .limit(limit);

  const findings: Discrepancy[] = [];
  for (const { orderId } of orders) {
    findings.push(...(await reconcileOrderLifecycle(orderId)));
  }
  return findings;
}

/* ==========================================================================
   REFUND RECONCILIATION.

   Four records again, one row further down:

     Whop refund  <->  payment_refunds  <->  accounting_transactions  <->  entries

   THE SAME RULE APPLIES AND IS WORTH RESTATING: nothing here writes. Not a
   correcting entry, not a status change, not a repair. A discrepancy in money
   is a thing a person decides about. The one repair that exists in this build
   lives in `refund-recovery.ts`, can only ADD a posting the authoritative
   pipeline agrees is owed, and is a separate function an operator calls on
   purpose — never a side effect of asking for a report.

   The refund codes are deliberately distinct from the payment ones. A refund
   missing locally and a payment missing locally have different causes and
   different fixes, and one code for both would throw away the part that says
   which.
   ========================================================================== */

export type RefundDiscrepancyCode =
  /** Whop reports a refund we have no row for at all. */
  | "refund_missing_locally"
  /** We hold a refund row Whop does not report against the payment. */
  | "refund_missing_at_provider"
  /** Our row says completed; there is no accounting transaction. */
  | "refund_missing_ledger"
  /** More than one transaction posted for one refund resource. */
  | "refund_duplicate_ledger"
  /** Our amount and the provider's disagree. */
  | "refund_amount_mismatch"
  /** Our currency and the provider's disagree. */
  | "refund_currency_mismatch"
  /** The refund is attached to a different payment or order than it should be. */
  | "refund_mapping_mismatch"
  /** Completed refunds sum to more than the payment ever collected. */
  | "refund_cumulative_overflow"
  /** We say completed; Whop says pending, failed or canceled — or the reverse. */
  | "refund_status_conflict"
  /** The ledger's refund total and the refund's own amount differ. */
  | "refund_ledger_amount_mismatch"
  /** The provider could not be asked. Not a discrepancy — an unknown. */
  | "refund_provider_unavailable"
  /** A state that should not be reachable at all. */
  | "refund_impossible_state";

export type RefundDiscrepancy = {
  code: RefundDiscrepancyCode;
  refundId: string | null;
  paymentId: string | null;
  orderId: string | null;
  transactionId: string | null;
  detail: string;
};

export type RefundReconciliationReport = {
  configured: boolean;
  refundsChecked: number;
  transactionsChecked: number;
  providerConsulted: boolean;
  discrepancies: RefundDiscrepancy[];
};

const EMPTY_REFUND_REPORT: RefundReconciliationReport = {
  configured: false,
  refundsChecked: 0,
  transactionsChecked: 0,
  providerConsulted: false,
  discrepancies: [],
};

/**
 * Compares our own refund records against our own ledger, without touching the
 * network.
 *
 * The cheap half, and it catches the failures that matter most: a completed
 * refund that was never accounted for (the crash-recovery case), a refund
 * accounted for twice, a posting whose amount does not match the refund it
 * claims to be, and a refund attached to the wrong order. Safe to run on a
 * schedule.
 */
export async function reconcileRefundsInternal(limit = 500): Promise<RefundReconciliationReport> {
  const db = getDb();
  if (!db) return EMPTY_REFUND_REPORT;

  const findings: RefundDiscrepancy[] = [];

  const refunds = await db.select().from(paymentRefunds).limit(limit);

  const transactions = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      providerResourceId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
      orderId: accountingTransactions.orderId,
      idempotencyKey: accountingTransactions.idempotencyKey,
      metadata: accountingTransactions.metadata,
    })
    .from(accountingTransactions)
    .where(eq(accountingTransactions.economicEvent, "payment_refunded"));

  const byRefund = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const key = t.providerResourceId ?? "";
    const list = byRefund.get(key) ?? [];
    list.push(t);
    byRefund.set(key, list);
  }

  // The DEBIT side of a refund posting is the money that went back: the
  // suspense leg plus any tax leg, both stored as positives here — the mirror
  // of how a settlement stores them.
  const grossByTransaction = new Map<string, bigint>();
  const legSums = await db
    .select({
      transactionId: accountingEntries.transactionId,
      account: accountingEntries.account,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    .where(eq(accountingTransactions.economicEvent, "payment_refunded"))
    .groupBy(accountingEntries.transactionId, accountingEntries.account);

  for (const row of legSums) {
    if (row.account !== "unallocated_customer_funds" && row.account !== "tax_payable") continue;
    const value = BigInt(row.total ?? "0");
    grossByTransaction.set(
      row.transactionId,
      (grossByTransaction.get(row.transactionId) ?? BigInt(0)) + value,
    );
  }

  // Cumulative completed refunds per payment, from OUR rows, checked against
  // the gross the settlement posting recorded. Both sides are local, so this
  // catches an overflow without the network; the provider-backed version of
  // the same check is in the per-payment pass below.
  const completedByPayment = new Map<string, bigint>();
  for (const refund of refunds) {
    if (refund.status !== "completed") continue;
    completedByPayment.set(
      refund.whopPaymentId,
      (completedByPayment.get(refund.whopPaymentId) ?? BigInt(0)) + refund.amountMinor,
    );
  }

  const settlements = await db
    .select({
      providerResourceId: accountingTransactions.providerResourceId,
      transactionId: accountingTransactions.transactionId,
    })
    .from(accountingTransactions)
    .where(eq(accountingTransactions.economicEvent, "payment_settled"));

  const settledGross = new Map<string, bigint>();
  if (settlements.length > 0) {
    const settlementLegs = await db
      .select({
        transactionId: accountingEntries.transactionId,
        total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
      })
      .from(accountingEntries)
      .innerJoin(
        accountingTransactions,
        eq(accountingEntries.transactionId, accountingTransactions.transactionId),
      )
      .where(
        and(
          eq(accountingTransactions.economicEvent, "payment_settled"),
          sql`${accountingEntries.account} in ('unallocated_customer_funds', 'tax_payable')`,
        ),
      )
      .groupBy(accountingEntries.transactionId);

    const grossByTxn = new Map(
      settlementLegs.map((l) => [l.transactionId, -BigInt(l.total ?? "0")]),
    );
    for (const s of settlements) {
      if (!s.providerResourceId) continue;
      settledGross.set(s.providerResourceId, grossByTxn.get(s.transactionId) ?? BigInt(0));
    }
  }

  for (const [paymentId, refunded] of completedByPayment) {
    const gross = settledGross.get(paymentId);
    if (gross !== undefined && refunded > gross) {
      findings.push({
        code: "refund_cumulative_overflow",
        refundId: null,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: `completed refunds ${refunded.toString()} exceed settled gross ${gross.toString()}`,
      });
    }
  }

  for (const refund of refunds) {
    const posted = byRefund.get(refund.whopRefundId) ?? [];

    // THE CRASH-RECOVERY SIGNAL. A completed refund with no posting is money
    // that left and is not in the accounts.
    if (refund.status === "completed") {
      if (posted.length === 0) {
        findings.push({
          code: "refund_missing_ledger",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: null,
          detail: "completed refund has no payment_refunded transaction",
        });
      }
      if (refund.completedAt === null) {
        findings.push({
          code: "refund_impossible_state",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: null,
          detail: "refund is completed but carries no completed_at",
        });
      }
    }

    // The other direction: money posted for a refund we do not call completed.
    if (refund.status !== "completed" && posted.length > 0) {
      findings.push({
        code: "refund_impossible_state",
        refundId: refund.whopRefundId,
        paymentId: refund.whopPaymentId,
        orderId: refund.orderId,
        transactionId: posted[0].transactionId,
        detail: `refund is ${refund.status} but money has been posted for it`,
      });
    }

    if (posted.length > 1) {
      findings.push({
        code: "refund_duplicate_ledger",
        refundId: refund.whopRefundId,
        paymentId: refund.whopPaymentId,
        orderId: refund.orderId,
        transactionId: posted[0].transactionId,
        detail: `${posted.length} refund transactions for one refund resource`,
      });
    }

    for (const t of posted) {
      if (t.currency !== refund.currency) {
        findings.push({
          code: "refund_currency_mismatch",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: `ledger ${t.currency}, refund ${refund.currency}`,
        });
      }
      if (t.orderId !== null && refund.orderId !== null && t.orderId !== refund.orderId) {
        findings.push({
          code: "refund_mapping_mismatch",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: `transaction points at order ${t.orderId}`,
        });
      }
      const metaPayment =
        t.metadata && typeof t.metadata === "object"
          ? (t.metadata as Record<string, unknown>).payment_id
          : null;
      if (typeof metaPayment === "string" && metaPayment !== refund.whopPaymentId) {
        findings.push({
          code: "refund_mapping_mismatch",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: `transaction names payment ${metaPayment}`,
        });
      }
      const gross = grossByTransaction.get(t.transactionId);
      if (gross === undefined) {
        findings.push({
          code: "refund_impossible_state",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: "refund transaction has no customer-funds leg",
        });
      } else if (gross !== refund.amountMinor) {
        findings.push({
          code: "refund_ledger_amount_mismatch",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: `ledger returned ${gross.toString()}, refund says ${refund.amountMinor.toString()}`,
        });
      }
      const expectedKey = economicKey("whop", "payment_refunded", refund.whopRefundId);
      if (t.idempotencyKey !== expectedKey) {
        findings.push({
          code: "refund_mapping_mismatch",
          refundId: refund.whopRefundId,
          paymentId: refund.whopPaymentId,
          orderId: refund.orderId,
          transactionId: t.transactionId,
          detail: "idempotency key does not describe this refund",
        });
      }
    }
  }

  // A refund posting that names a refund resource we hold no row for. Rare and
  // serious: money accounted for with no operational record behind it.
  for (const [resourceId, list] of byRefund) {
    if (refunds.some((r) => r.whopRefundId === resourceId)) continue;
    findings.push({
      code: "refund_impossible_state",
      refundId: resourceId.length > 0 ? resourceId : null,
      paymentId: null,
      orderId: list[0].orderId,
      transactionId: list[0].transactionId,
      detail: "refund transaction with no payment_refunds row",
    });
  }

  return {
    configured: true,
    refundsChecked: refunds.length,
    transactionsChecked: transactions.length,
    providerConsulted: false,
    discrepancies: findings,
  };
}

/**
 * Adds the provider to the comparison, for every refund of ONE payment.
 *
 * Separate from the internal pass and one payment at a time, because it costs
 * a list call plus a payment fetch and is not something to run across a whole
 * table on a timer.
 *
 * `refund_provider_unavailable` is its own code and never a conflict: not being
 * able to ask is different from asking and disagreeing, and a report that
 * turned "could not ask" into "records disagree" would generate false alarms
 * during every incident.
 */
export async function reconcileRefundsAgainstProvider(
  paymentId: string,
): Promise<RefundDiscrepancy[]> {
  const db = getDb();
  if (!db) return [];

  const findings: RefundDiscrepancy[] = [];

  const listed = await listRefundsForPayment(paymentId);
  if (!listed.ok) {
    return [
      {
        code: "refund_provider_unavailable",
        refundId: null,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: listed.reason,
      },
    ];
  }

  const local = await listRefundsForPaymentLocal(paymentId);
  const localById = new Map(local.map((r) => [r.whopRefundId, r]));
  const providerById = new Map(listed.refunds.map((r) => [r.refundId, r]));

  // What the provider has and we do not — a missed delivery.
  for (const remote of listed.refunds) {
    const mine = localById.get(remote.refundId);
    const remotePhase = classifyRefundStatus(remote.status);

    if (!mine) {
      findings.push({
        code: "refund_missing_locally",
        refundId: remote.refundId,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: `provider reports a ${remote.status} refund of ${remote.amountMinor.toString()} we have no row for`,
      });
      continue;
    }

    if (mine.amountMinor !== remote.amountMinor) {
      findings.push({
        code: "refund_amount_mismatch",
        refundId: remote.refundId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `local ${mine.amountMinor.toString()}, provider ${remote.amountMinor.toString()}`,
      });
    }
    if (mine.currency !== remote.currency) {
      findings.push({
        code: "refund_currency_mismatch",
        refundId: remote.refundId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `local ${mine.currency}, provider ${remote.currency}`,
      });
    }
    if (mine.whopPaymentId !== remote.paymentId) {
      findings.push({
        code: "refund_mapping_mismatch",
        refundId: remote.refundId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `local payment ${mine.whopPaymentId}, provider payment ${remote.paymentId}`,
      });
    }

    // THE SERIOUS ONE. We have posted money for a refund the provider does not
    // agree has completed.
    if (mine.status === "completed" && remotePhase !== "completed") {
      findings.push({
        code: "refund_status_conflict",
        refundId: remote.refundId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `local completed, provider reports ${remote.status} — money may never have moved`,
      });
    }

    // The reverse: the provider completed it and we have not caught up. Not an
    // error in the ledger, but it is WHY a posting is missing, so it earns a
    // finding of its own rather than being inferred from one.
    if (mine.status !== "completed" && remotePhase === "completed") {
      findings.push({
        code: "refund_status_conflict",
        refundId: remote.refundId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `provider reports succeeded, local is ${mine.status}`,
      });
    }
  }

  // What we have and the provider does not.
  for (const mine of local) {
    if (providerById.has(mine.whopRefundId)) continue;
    findings.push({
      code: "refund_missing_at_provider",
      refundId: mine.whopRefundId,
      paymentId,
      orderId: mine.orderId,
      transactionId: null,
      detail: `local ${mine.status} refund the provider does not report against this payment`,
    });
  }

  // CUMULATIVE OVERFLOW, with both sides taken from the provider.
  const balance = await refundableBalance(paymentId);
  if (!balance.ok) {
    findings.push({
      code: "refund_provider_unavailable",
      refundId: null,
      paymentId,
      orderId: null,
      transactionId: null,
      detail: balance.reason,
    });
  } else {
    let providerCompleted = BigInt(0);
    for (const remote of listed.refunds) {
      if (classifyRefundStatus(remote.status) === "completed") {
        providerCompleted += remote.amountMinor;
      }
    }
    if (providerCompleted > balance.totalMinor) {
      findings.push({
        code: "refund_cumulative_overflow",
        refundId: null,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: `provider completed refunds ${providerCompleted.toString()} exceed payment total ${balance.totalMinor.toString()}`,
      });
    }
  }

  return findings;
}
