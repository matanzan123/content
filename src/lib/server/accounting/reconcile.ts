import "server-only";

import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  accountingEntries,
  accountingTransactions,
  disputeAlerts,
  paymentDisputes,
  paymentOrders,
  paymentRefunds,
  resolutionCenterCases,
} from "@/lib/db/schema";
import { economicKey } from "./accounts";
// The READ-ONLY provider comparison, shared with `reconcileProviderFees` so the
// drift detector and the corrector cannot disagree about what drifted.
import { inspectProviderFeeDrift } from "./whop-fee-reconciliation";
import { fetchSettlementFacts } from "./whop-payment-posting";
import { retrievePaymentPhase } from "../whop-resources";
import { classifyProviderStatus, isAbsorbing, targetOrderStatus } from "../payment-lifecycle";
import { classifyRefundStatus } from "../refund-lifecycle";
import { listRefundsForPayment } from "../whop-refunds";
import { listRefundsForPaymentLocal } from "../payment-refunds";
import { refundableBalance } from "../whop-refund-mapping";
import { describeWhopError, getWhopEnvironment, getWhopPaymentsClient } from "../whop-payments";
import { listDisputesForAccount, listLedgerMovementsForPayment } from "../whop-disputes";
import { listDisputesForPaymentLocal } from "../payment-disputes";
import {
  DISPUTE_LINE_TYPES_NOT_POSTED,
  isDisputeLineType,
  isPostableDisputeLine,
} from "./whop-dispute-posting";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "../money";

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

  /* ENVIRONMENT-SCOPED, and it has to be.
   *
   * Both tables carry an `environment` column, and migration 0011 made the
   * unique indexes environment-aware precisely so the same provider id can exist
   * once per environment. Reading both unscoped therefore compares one
   * environment's orders against the other's settlements, and the findings it
   * manufactures are FALSE ONES: a production settlement has no sandbox order,
   * so it reports `ledger_without_paid_order`, and the sandbox order it cannot
   * see reports `missing_ledger`. A reconciler that cries wolf is worse than one
   * that says nothing, because operators learn to close it.
   *
   * Fails closed: an unresolvable environment reconciles nothing rather than
   * reconciling everything. */
  const environment = getWhopEnvironment();
  if (!environment) return EMPTY;

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
    .where(eq(paymentOrders.environment, environment))
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
    .where(
      and(
        eq(accountingTransactions.economicEvent, "payment_settled"),
        eq(accountingTransactions.environment, environment),
      ),
    );

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
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    // Scoped like everything else here: an imbalance in the other environment is
    // real, but it is not this report's to raise.
    .where(eq(accountingTransactions.environment, environment))
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

  // Environment-scoped: reconciling a payment that belongs to the other
  // environment must report nothing here rather than compare our books against
  // an order we do not own in this environment.
  const reconcileEnvironment = getWhopEnvironment();
  if (!reconcileEnvironment) return [];

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.whopPaymentId, paymentId),
        eq(paymentOrders.environment, reconcileEnvironment),
      ),
    );

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

  // The sweep is environment-scoped: a sandbox lifecycle reconciliation must
  // never pick up production orders to check against the provider.
  const environment = getWhopEnvironment();
  if (!environment) return [];

  const orders = await db
    .select({ orderId: paymentOrders.orderId })
    .from(paymentOrders)
    .where(
      and(
        sql`${paymentOrders.whopPaymentId} is not null`,
        eq(paymentOrders.environment, environment),
      ),
    )
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

  /* ENVIRONMENT-SCOPED, for the same reason as `reconcileInternal`: a refund id
   * may exist once per environment after migration 0011, so an unscoped read
   * compares one environment's refunds against the other's postings. Fails
   * closed rather than reconciling across the boundary. */
  const environment = getWhopEnvironment();
  if (!environment) return EMPTY_REFUND_REPORT;

  const refunds = await db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.environment, environment))
    .limit(limit);

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

/* ==========================================================================
   DISPUTE RECONCILIATION.

   THE SAME RULE, RESTATED ONCE MORE BECAUSE IT MATTERS MOST HERE: nothing in
   this section writes. A chargeback is the most consequential thing that can
   happen to a payment, and an automatic "repair" of one is how a single wrong
   number becomes two wrong numbers and an audit trail that agrees with both.
   The one repair that exists lives in `dispute-recovery.ts`, can only ADD a
   posting the provider's own ledger says exists, and is a function an operator
   calls on purpose.

   THE CHECK THAT ONLY EXISTS HERE is the Resolution Center cross-check. A case
   carrying `refund: merchant` claims money came off OUR balance; there should
   be a real refund or dispute in our books for the same payment. A case
   carrying `refund: platform` claims WHOP paid; there should NOT be. Neither
   check can be made from the case alone, and neither posts anything — they
   name a discrepancy for a person.
   ========================================================================== */

export type DisputeDiscrepancyCode =
  /** Provider reports a dispute we hold no row for. */
  | "dispute_missing_locally"
  /** We hold a dispute the provider does not report. */
  | "dispute_missing_at_provider"
  /** Local and provider disagree on the dispute's status. */
  | "dispute_status_mismatch"
  /** Local and provider disagree on the amount. */
  | "dispute_amount_mismatch"
  /** Local and provider disagree on the currency. */
  | "dispute_currency_mismatch"
  /** The dispute is attached to a different payment or order than it should be. */
  | "dispute_mapping_mismatch"
  /** The environment on the row does not match the configured one. */
  | "dispute_environment_mismatch"
  /** The provider's ledger shows a dispute movement with no accounting. */
  | "dispute_missing_ledger"
  /** More than one transaction posted for one ledger movement. */
  | "dispute_duplicate_ledger"
  /** A dispute-family ledger line this build has no posting rule for. */
  | "dispute_unmapped_line_type"
  /** A case claims money came off our balance and nothing in our books shows it. */
  | "case_refund_unaccounted"
  /** A case claims WHOP paid, yet our books show us paying. */
  | "case_platform_refund_booked_locally"
  /** An alert points at a payment that is not the one its order settled. */
  | "alert_mapping_mismatch"
  /** Two local rows claim the same provider resource. */
  | "dispute_duplicate_resource"
  /** A transaction's legs do not sum to zero. */
  | "dispute_unbalanced_transaction"
  /** The provider could not be asked. Not a discrepancy — an unknown. */
  | "dispute_provider_unavailable"
  /** A state that should not be reachable at all. */
  | "dispute_impossible_state";

export type DisputeDiscrepancy = {
  code: DisputeDiscrepancyCode;
  disputeId: string | null;
  paymentId: string | null;
  orderId: string | null;
  transactionId: string | null;
  detail: string;
};

export type DisputeReconciliationReport = {
  configured: boolean;
  disputesChecked: number;
  alertsChecked: number;
  casesChecked: number;
  transactionsChecked: number;
  providerConsulted: boolean;
  discrepancies: DisputeDiscrepancy[];
};

const EMPTY_DISPUTE_REPORT: DisputeReconciliationReport = {
  configured: false,
  disputesChecked: 0,
  alertsChecked: 0,
  casesChecked: 0,
  transactionsChecked: 0,
  providerConsulted: false,
  discrepancies: [],
};

/** The three economic events a dispute movement can be posted under. */
const DISPUTE_EVENTS = ["dispute_opened", "dispute_won", "dispute_lost"] as const;

/**
 * Compares our own dispute records against our own ledger, without touching
 * the network.
 *
 * The cheap half, safe to run on a schedule. It catches the failures that do
 * not need the provider to see: a dispute row and a posting that disagree, a
 * movement posted twice, a case claiming a refund our books do not show, an
 * alert wired to the wrong order, and any unbalanced transaction.
 */
export async function reconcileDisputesInternal(
  limit = 500,
): Promise<DisputeReconciliationReport> {
  const db = getDb();
  if (!db) return EMPTY_DISPUTE_REPORT;

  const findings: DisputeDiscrepancy[] = [];
  const environment = getWhopEnvironment();
  // Fail closed. Reconciling with an unresolvable environment would sweep BOTH
  // environments into one report and compare them against one provider.
  if (!environment) return EMPTY_DISPUTE_REPORT;

  const disputes = await db
    .select().from(paymentDisputes)
    .where(eq(paymentDisputes.environment, environment)).limit(limit);
  const alerts = await db
    .select().from(disputeAlerts)
    .where(eq(disputeAlerts.environment, environment)).limit(limit);
  const cases = await db
    .select().from(resolutionCenterCases)
    .where(eq(resolutionCenterCases.environment, environment)).limit(limit);

  const transactions = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      economicEvent: accountingTransactions.economicEvent,
      providerResourceId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
      orderId: accountingTransactions.orderId,
      idempotencyKey: accountingTransactions.idempotencyKey,
      metadata: accountingTransactions.metadata,
    })
    .from(accountingTransactions)
    .where(sql`${accountingTransactions.economicEvent} in ('dispute_opened','dispute_won','dispute_lost')`);

  // Two postings naming the SAME ledger movement is double-booked money.
  const byActivity = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const key = t.providerResourceId ?? "";
    const list = byActivity.get(key) ?? [];
    list.push(t);
    byActivity.set(key, list);
  }
  for (const [activityId, list] of byActivity) {
    if (list.length > 1) {
      findings.push({
        code: "dispute_duplicate_ledger",
        disputeId: null,
        paymentId:
          typeof list[0].metadata === "object" && list[0].metadata !== null
            ? ((list[0].metadata as Record<string, unknown>).payment_id as string) ?? null
            : null,
        orderId: list[0].orderId,
        transactionId: list[0].transactionId,
        detail: `${list.length} transactions for ledger movement ${activityId}`,
      });
    }
  }

  // Every dispute transaction must balance. Checked here as well as by the
  // database trigger, because a report is where an operator looks.
  if (transactions.length > 0) {
    const residuals = await db
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
        sql`${accountingTransactions.economicEvent} in ('dispute_opened','dispute_won','dispute_lost')`,
      )
      .groupBy(accountingEntries.transactionId)
      .having(sql`sum(${accountingEntries.amountMinor}) <> 0`);

    for (const row of residuals) {
      findings.push({
        code: "dispute_unbalanced_transaction",
        disputeId: null,
        paymentId: null,
        orderId: null,
        transactionId: row.transactionId,
        detail: `legs sum to ${row.total}, expected 0`,
      });
    }
  }

  // Duplicate local rows for one provider resource. The unique indexes make
  // this unreachable, which is exactly why it is worth reporting if it ever
  // appears: it would mean a constraint was dropped.
  const seenDisputes = new Set<string>();
  for (const dispute of disputes) {
    if (seenDisputes.has(dispute.whopDisputeId)) {
      findings.push({
        code: "dispute_duplicate_resource",
        disputeId: dispute.whopDisputeId,
        paymentId: dispute.whopPaymentId,
        orderId: dispute.orderId,
        transactionId: null,
        detail: "more than one local row for one provider dispute",
      });
    }
    seenDisputes.add(dispute.whopDisputeId);

    if (environment && dispute.environment !== environment) {
      findings.push({
        code: "dispute_environment_mismatch",
        disputeId: dispute.whopDisputeId,
        paymentId: dispute.whopPaymentId,
        orderId: dispute.orderId,
        transactionId: null,
        detail: `row is ${dispute.environment}, configured is ${environment}`,
      });
    }

    // A resolved dispute with no resolution time, or the reverse, is a state
    // the database constraints forbid — so seeing one means something bypassed
    // them.
    const resolved =
      dispute.status === "won" || dispute.status === "lost" || dispute.status === "closed";
    if (resolved !== (dispute.resolvedAt !== null)) {
      findings.push({
        code: "dispute_impossible_state",
        disputeId: dispute.whopDisputeId,
        paymentId: dispute.whopPaymentId,
        orderId: dispute.orderId,
        transactionId: null,
        detail: `status ${dispute.status} with resolved_at ${dispute.resolvedAt === null ? "null" : "set"}`,
      });
    }
  }

  // An alert must point at the payment its own order was settled by. A
  // mismatch means the alert was wired to the wrong charge.
  for (const alert of alerts) {
    if (!alert.orderId || !alert.whopPaymentId) continue;
    const [order] = await db
      .select({ whopPaymentId: paymentOrders.whopPaymentId })
      .from(paymentOrders)
      .where(eq(paymentOrders.orderId, alert.orderId));
    if (order && order.whopPaymentId !== alert.whopPaymentId) {
      findings.push({
        code: "alert_mapping_mismatch",
        disputeId: alert.whopAlertId,
        paymentId: alert.whopPaymentId,
        orderId: alert.orderId,
        transactionId: null,
        detail: `alert names ${alert.whopPaymentId}, order settled by ${order.whopPaymentId}`,
      });
    }
  }

  /* --- THE RESOLUTION CENTER CROSS-CHECK --- */

  for (const rc of cases) {
    if (rc.status !== "closed" || !rc.whopPaymentId) continue;

    // Does anything in OUR books show money leaving for this payment?
    // Both counts are environment-scoped: a production refund must never
    // satisfy a sandbox case cross-check, or the finding would be a false
    // negative — "we booked something" when this environment booked nothing.
    const [localRefunds] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.whopPaymentId, rc.whopPaymentId),
          eq(paymentRefunds.environment, environment),
          eq(paymentRefunds.status, "completed"),
        ),
      );
    const [localDisputeLoss] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentDisputes)
      .where(
        and(
          eq(paymentDisputes.whopPaymentId, rc.whopPaymentId),
          eq(paymentDisputes.environment, environment),
          eq(paymentDisputes.status, "lost"),
        ),
      );
    const weBookedSomething = (localRefunds?.n ?? 0) > 0 || (localDisputeLoss?.n ?? 0) > 0;

    if (rc.refundSource === "merchant" && !weBookedSomething) {
      findings.push({
        code: "case_refund_unaccounted",
        disputeId: rc.whopCaseId,
        paymentId: rc.whopPaymentId,
        orderId: rc.orderId,
        transactionId: null,
        detail:
          "case reports a merchant refund; no completed refund or lost dispute exists for the payment",
      });
    }
    if (rc.refundSource === "platform" && weBookedSomething) {
      findings.push({
        code: "case_platform_refund_booked_locally",
        disputeId: rc.whopCaseId,
        paymentId: rc.whopPaymentId,
        orderId: rc.orderId,
        transactionId: null,
        detail:
          "case reports Whop covered the refund, yet our books show money leaving our balance",
      });
    }
  }

  return {
    configured: true,
    disputesChecked: disputes.length,
    alertsChecked: alerts.length,
    casesChecked: cases.length,
    transactionsChecked: transactions.length,
    providerConsulted: false,
    discrepancies: findings,
  };
}

/**
 * Adds the provider to the comparison, for the disputes of ONE payment.
 *
 * Two independent questions are asked, and they need different sources:
 *
 *   1. does Whop agree with our dispute ROWS?  -> `disputes.list`
 *   2. is every dispute MOVEMENT accounted for? -> `financialActivity.list`
 *
 * A LIMITATION WORTH STATING: `disputes.list` has no `payment_id` filter — only
 * `account_id` — so the account's disputes are listed and filtered here rather
 * than server-side. That is fine at this scale and would need paging at a
 * larger one; it is called out so nobody mistakes it for a per-payment query.
 */
export async function reconcileDisputesAgainstProvider(
  paymentId: string,
): Promise<DisputeDiscrepancy[]> {
  const db = getDb();
  if (!db) return [];

  const findings: DisputeDiscrepancy[] = [];
  const local = await listDisputesForPaymentLocal(paymentId);

  /* --- (1) the dispute rows --- */

  const listed = await listDisputesForAccount();
  if (!listed.ok) {
    findings.push({
      code: "dispute_provider_unavailable",
      disputeId: null,
      paymentId,
      orderId: null,
      transactionId: null,
      detail: listed.reason,
    });
  } else {
    const remoteForPayment = listed.disputes.filter((d) => d.paymentId === paymentId);
    const localById = new Map(local.map((d) => [d.whopDisputeId, d]));
    const remoteById = new Map(remoteForPayment.map((d) => [d.disputeId, d]));

    for (const remote of remoteForPayment) {
      const mine = localById.get(remote.disputeId);
      if (!mine) {
        findings.push({
          code: "dispute_missing_locally",
          disputeId: remote.disputeId,
          paymentId,
          orderId: null,
          transactionId: null,
          detail: `provider reports a ${remote.status} dispute of ${remote.amountMinor.toString()} we have no row for`,
        });
        continue;
      }
      if (mine.providerStatus !== remote.status) {
        findings.push({
          code: "dispute_status_mismatch",
          disputeId: remote.disputeId,
          paymentId,
          orderId: mine.orderId,
          transactionId: null,
          detail: `local ${mine.providerStatus}, provider ${remote.status}`,
        });
      }
      if (mine.amountMinor !== remote.amountMinor) {
        findings.push({
          code: "dispute_amount_mismatch",
          disputeId: remote.disputeId,
          paymentId,
          orderId: mine.orderId,
          transactionId: null,
          detail: `local ${mine.amountMinor.toString()}, provider ${remote.amountMinor.toString()}`,
        });
      }
      if (mine.currency !== remote.currency) {
        findings.push({
          code: "dispute_currency_mismatch",
          disputeId: remote.disputeId,
          paymentId,
          orderId: mine.orderId,
          transactionId: null,
          detail: `local ${mine.currency}, provider ${remote.currency}`,
        });
      }
      if (remote.paymentId !== null && mine.whopPaymentId !== remote.paymentId) {
        findings.push({
          code: "dispute_mapping_mismatch",
          disputeId: remote.disputeId,
          paymentId,
          orderId: mine.orderId,
          transactionId: null,
          detail: `local payment ${mine.whopPaymentId}, provider payment ${remote.paymentId}`,
        });
      }
    }

    for (const mine of local) {
      if (remoteById.has(mine.whopDisputeId)) continue;
      findings.push({
        code: "dispute_missing_at_provider",
        disputeId: mine.whopDisputeId,
        paymentId,
        orderId: mine.orderId,
        transactionId: null,
        detail: `local ${mine.status} dispute the provider does not report against this payment`,
      });
    }
  }

  /* --- (2) the money --- */

  const ledger = await listLedgerMovementsForPayment(paymentId);
  if (!ledger.ok) {
    findings.push({
      code: "dispute_provider_unavailable",
      disputeId: null,
      paymentId,
      orderId: null,
      transactionId: null,
      detail: `ledger: ${ledger.reason}`,
    });
    return findings;
  }

  for (const movement of ledger.movements) {
    if (!isDisputeLineType(movement.lineType)) continue;

    // A line we can see but have no rule for. Reported for a human rather than
    // guessed at — see `DISPUTE_LINE_TYPES_NOT_POSTED`.
    if (!isPostableDisputeLine(movement.lineType)) {
      findings.push({
        code: "dispute_unmapped_line_type",
        disputeId: null,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: `${movement.lineType} of ${movement.amountMinor.toString()} is not posted: ${
          DISPUTE_LINE_TYPES_NOT_POSTED[movement.lineType]
        }`,
      });
      continue;
    }
    if (movement.amountMinor === BigInt(0)) continue;

    // THE CRASH-RECOVERY SIGNAL. Money the provider says moved, with nothing
    // in our journal for it.
    // `inArray`, not `= any(${keys})`. A JS array interpolated into a raw
    // `sql` template is emitted as a parenthesised tuple — `any(($1,$2,$3))` —
    // which Postgres rejects. `inArray` builds the IN list the driver expects.
    const keys = DISPUTE_EVENTS.map((event) => economicKey("whop", event, movement.activityId));
    const [posted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(accountingTransactions)
      .where(inArray(accountingTransactions.idempotencyKey, keys));

    if ((posted?.n ?? 0) === 0) {
      findings.push({
        code: "dispute_missing_ledger",
        disputeId: null,
        paymentId,
        orderId: null,
        transactionId: null,
        detail: `provider ledger row ${movement.activityId} (${movement.lineType}, ${movement.amountMinor.toString()}) has no accounting transaction`,
      });
    }
  }

  return findings;
}

/* ==========================================================================
   PAYOUT RECONCILIATION.

   THE SAME RULE, STATED ONCE MORE: nothing here writes. A payout posted in our
   ledger that the provider has no record of, or one the provider completed that
   never reached our journal, is a finding — not a fix. The operator decides.

   NOTE ON SCOPE: `payout_sent` and `payout_reversed` are declared and
   implemented events but the webhook posting rule for them does not yet exist.
   This reconciliation therefore exists to detect the moment a payout the
   provider completed has no journal entry, which is the signal that the posting
   rule needs to be implemented or that a crash left a gap.

   PAYOUT AMOUNT PARSING: the payouts API returns amounts as decimal strings
   without a `decimals` field. We derive precision from the currency code using
   the same table the rest of the build uses.
   ========================================================================== */

export type PayoutDiscrepancyCode =
  /** Provider completed a payout; no `payout_sent` posting exists for it. */
  | "payout_missing_ledger"
  /** We hold a `payout_sent` posting; provider has no matching payout. */
  | "payout_missing_at_provider"
  /** Provider and our ledger disagree on the payout amount. */
  | "payout_amount_mismatch"
  /** Provider and our ledger disagree on the payout currency. */
  | "payout_currency_mismatch"
  /** More than one `payout_sent` transaction for one provider payout. */
  | "payout_duplicate_ledger"
  /** Provider could not be asked. Not a discrepancy — an unknown. */
  | "payout_provider_unavailable"
  /** A state that should not be reachable at all. */
  | "payout_impossible_state";

export type PayoutDiscrepancy = {
  code: PayoutDiscrepancyCode;
  payoutId: string | null;
  transactionId: string | null;
  detail: string;
};

export type PayoutReconciliationReport = {
  configured: boolean;
  payoutsChecked: number;
  ledgerPayoutsChecked: number;
  providerConsulted: boolean;
  discrepancies: PayoutDiscrepancy[];
};

const EMPTY_PAYOUT_REPORT: PayoutReconciliationReport = {
  configured: false,
  payoutsChecked: 0,
  ledgerPayoutsChecked: 0,
  providerConsulted: false,
  discrepancies: [],
};

/**
 * Compares Whop's payout list against our `payout_sent` journal entries.
 *
 * `limit` caps how many provider payouts to examine in one pass. The provider
 * returns newest-first; a limit of 100 covers the most recent payouts, which
 * are the most likely to be affected by a recent incident.
 *
 * `payout_provider_unavailable` is its own code and never a conflict: an
 * outage during the call is different from asking and disagreeing.
 */
export async function reconcilePayoutsAgainstProvider(
  limit = 100,
): Promise<PayoutReconciliationReport> {
  const db = getDb();
  const environment = getWhopEnvironment();
  const client = getWhopPaymentsClient();

  if (!db || !environment || !client) return EMPTY_PAYOUT_REPORT;

  const findings: PayoutDiscrepancy[] = [];

  // --- Provider side --------------------------------------------------
  let providerPayouts: { id: string; status: string; amount: string; currency: string }[] = [];

  try {
    const page = await client.payouts.list({ first: limit } as Parameters<typeof client.payouts.list>[0]);
    const items: unknown[] = Array.isArray((page as { data?: unknown[] }).data)
      ? ((page as { data: unknown[] }).data)
      : [];
    providerPayouts = items.map((p) => {
      const row = p as { id: string; status: string; amount: string; currency: string };
      return { id: row.id, status: row.status, amount: row.amount, currency: row.currency };
    });
  } catch {
    return {
      configured: true,
      payoutsChecked: 0,
      ledgerPayoutsChecked: 0,
      providerConsulted: false,
      discrepancies: [
        {
          code: "payout_provider_unavailable",
          payoutId: null,
          transactionId: null,
          detail: "payouts.list failed",
        },
      ],
    };
  }

  // --- Ledger side ----------------------------------------------------
  const ledgerPayouts = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      providerResourceId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
      idempotencyKey: accountingTransactions.idempotencyKey,
    })
    .from(accountingTransactions)
    .where(eq(accountingTransactions.economicEvent, "payout_sent"));

  // provider_balance legs: sum per payout_sent transaction (negative = leaving).
  const ledgerAmounts = new Map<string, bigint>();
  if (ledgerPayouts.length > 0) {
    const ledgerIds = ledgerPayouts.map((t) => t.transactionId);
    const amountLegs = await db
      .select({
        transactionId: accountingEntries.transactionId,
        total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
      })
      .from(accountingEntries)
      .where(
        and(
          inArray(accountingEntries.transactionId, ledgerIds),
          eq(accountingEntries.account, "provider_balance"),
        ),
      )
      .groupBy(accountingEntries.transactionId);
    for (const row of amountLegs) {
      ledgerAmounts.set(row.transactionId, BigInt(row.total ?? "0"));
    }
  }

  // Index ledger by provider payout id (stored in providerResourceId).
  const ledgerByPayoutId = new Map<string, typeof ledgerPayouts>();
  for (const t of ledgerPayouts) {
    const key = t.providerResourceId ?? "";
    const list = ledgerByPayoutId.get(key) ?? [];
    list.push(t);
    ledgerByPayoutId.set(key, list);
  }
  const providerIdSet = new Set(providerPayouts.map((p) => p.id));

  // --- Compare provider → ledger --------------------------------------
  for (const payout of providerPayouts) {
    // Only completed payouts should have a posting.
    if (payout.status !== "completed") continue;

    const posted = ledgerByPayoutId.get(payout.id) ?? [];
    if (posted.length === 0) {
      findings.push({
        code: "payout_missing_ledger",
        payoutId: payout.id,
        transactionId: null,
        detail: `provider completed payout of ${payout.amount} ${payout.currency} has no payout_sent transaction`,
      });
      continue;
    }
    if (posted.length > 1) {
      findings.push({
        code: "payout_duplicate_ledger",
        payoutId: payout.id,
        transactionId: posted[0].transactionId,
        detail: `${posted.length} payout_sent transactions for one payout`,
      });
    }

    const t = posted[0];
    const normalised = normaliseCurrency(payout.currency);
    if (!normalised || normalised !== t.currency) {
      findings.push({
        code: "payout_currency_mismatch",
        payoutId: payout.id,
        transactionId: t.transactionId,
        detail: `provider ${payout.currency}, ledger ${t.currency}`,
      });
      continue;
    }

    const decimals = currencyDecimals(normalised);
    if (decimals === null) {
      findings.push({
        code: "payout_impossible_state",
        payoutId: payout.id,
        transactionId: t.transactionId,
        detail: `unsupported currency ${normalised}`,
      });
      continue;
    }
    const providerMinor = decimalToMinor(payout.amount, decimals);
    if (providerMinor === null) {
      findings.push({
        code: "payout_impossible_state",
        payoutId: payout.id,
        transactionId: t.transactionId,
        detail: `could not parse provider amount "${payout.amount}" for ${normalised}`,
      });
      continue;
    }
    const ledgerMinor = ledgerAmounts.get(t.transactionId);
    // provider_balance DR is negative (leaving balance) — absolute value should equal payout.
    if (ledgerMinor !== undefined && -ledgerMinor !== providerMinor) {
      findings.push({
        code: "payout_amount_mismatch",
        payoutId: payout.id,
        transactionId: t.transactionId,
        detail: `provider ${providerMinor.toString()}, ledger ${(-ledgerMinor).toString()}`,
      });
    }
  }

  // --- Compare ledger → provider --------------------------------------
  for (const [payoutId, posted] of ledgerByPayoutId) {
    if (payoutId.length > 0 && !providerIdSet.has(payoutId)) {
      findings.push({
        code: "payout_missing_at_provider",
        payoutId,
        transactionId: posted[0].transactionId,
        detail: `payout_sent posting names ${payoutId}, which the provider does not list`,
      });
    }
  }

  return {
    configured: true,
    payoutsChecked: providerPayouts.length,
    ledgerPayoutsChecked: ledgerPayouts.length,
    providerConsulted: true,
    discrepancies: findings,
  };
}

/* ==========================================================================
   PROVIDER FEE DRIFT SCAN.

   This is the READ-ONLY counterpart of `reconcileProviderFees` in
   `whop-fee-reconciliation.ts`. It does not correct anything; it reports which
   settlements have drifted from the provider's own fee total.

   IT NO LONGER FILTERS ON `fees_are_actual`, AND THAT WAS THE DEFECT.

   The scan used to select settlements whose `metadata.fees_are_actual` was the
   string `'false'` and report every one as a drift candidate. Three things were
   wrong with that:

     1. IT MISSED EVERY LATER FEE CHANGE. A payment that settled WITH fees has
        `fees_are_actual: true` forever — the flag records what was true AT
        settlement and is never updated. So a fee revised afterwards, revised
        again, revised down, or revised back to a figure already seen was never
        selected at all. Those are the cases `reconcileProviderFees` exists to
        correct, and nothing could find them.

     2. IT MISSED LEGACY SETTLEMENTS. The predicate matched the literal
        `'false'`, so settlements posted before the field existed — where it is
        NULL — were invisible.

     3. IT WAS NOT ENVIRONMENT-SCOPED. A sandbox pass would have reported
        production settlements and vice versa.

   And it reported CANDIDATES, not drift: a settlement flagged `false` because
   the payment genuinely had zero fees was indistinguishable from one whose fees
   arrived late, because nothing ever asked the provider.

   WHAT IT DOES NOW. It takes a bounded, deterministically ordered page of
   settlements for THIS environment, asks the provider what each payment's fees
   actually are through the shared `inspectProviderFeeDrift`, and reports only
   those where the provider disagrees with the journal. `fees_are_actual` is
   still surfaced on each finding as a hint about WHY a settlement drifted, but
   it decides nothing.
   ========================================================================== */

export type FeeDriftFinding = {
  paymentId: string;
  transactionId: string;
  grossMinor: bigint;
  currency: string;
  /** Net `provider_fee_expense` the journal holds for this payment. */
  postedFeeMinor: bigint;
  /** The provider's own current fee total. */
  actualFeeMinor: bigint;
  /** `actual - posted` for FEES. May be zero when only tax drifted. */
  deltaMinor: bigint;
  /** Tax principal already booked as remitted for this payment. */
  taxRemittancePostedMinor: bigint;
  /** The provider's current tax-remittance total. */
  taxRemittanceActualMinor: bigint;
  /**
   * `actual - posted` for TAX PRINCIPAL. Non-zero means the provider has
   * remitted (or reversed) sales tax the journal has not booked yet.
   */
  taxRemittanceDeltaMinor: bigint;
  /**
   * What `fees_are_actual` said at settlement. A HINT ONLY — it explains why a
   * settlement is likely to have drifted and decides nothing. `null` means the
   * settlement predates the field.
   */
  feesWereActualAtSettlement: boolean | null;
};

/** A candidate the provider could not be asked about. Never silently dropped. */
export type FeeDriftUnresolved = {
  paymentId: string;
  transactionId: string;
  reason: string;
  detail?: string;
};

export type FeeDriftReport = {
  configured: boolean;
  settlementsScanned: number;
  /**
   * Settlements where the provider disagrees with the journal on FEES, on TAX
   * REMITTANCE, or on both. A finding may carry a zero fee delta and a non-zero
   * tax delta: tax is remitted when the provider files, long after settlement.
   */
  driftCandidates: FeeDriftFinding[];
  /**
   * Candidates whose provider lookup failed. Reported rather than dropped: a
   * provider outage must not read as "no drift".
   */
  unresolved: FeeDriftUnresolved[];
};

/**
 * The largest page of settlements one scan will examine.
 *
 * WHY A BOUNDED PAGE AND NOT A TIME WINDOW. Each candidate costs one
 * `listFees` call, so the only thing that matters is how many candidates a run
 * can produce. "The latest N settlements" bounds that by construction: a run
 * makes at most N provider calls no matter how much history exists or how busy
 * the period was. A time window ("everything from the last 30 days") bounds
 * nothing — in a high-volume week it is unbounded in exactly the dimension that
 * costs — and it needs an arbitrary constant to justify. This needs no constant
 * about time at all.
 *
 * THE TRADE, STATED PLAINLY. A single run only looks at the newest N
 * settlements, so an older drifted settlement is not examined until an operator
 * pages back to it with `offset`. That is acceptable because fee revisions
 * cluster near settlement, and because paging is available rather than
 * theoretical. It is eventual reconciliation, and recency-biased on purpose.
 *
 * Exported so the admin repair runner clamps to the SAME maximum rather than
 * declaring a second one that could drift from this.
 */
export const FEE_DRIFT_MAX_PAGE = 200;

/** One settlement that may have drifted. No provider call has been made yet. */
export type FeeDriftCandidate = {
  transactionId: string;
  paymentId: string;
  currency: string;
  grossMinor: bigint;
  /** `fees_are_actual` at settlement. A hint only; `null` predates the field. */
  feesWereActualAtSettlement: boolean | null;
};

export type FeeDriftCandidatePage = {
  configured: boolean;
  candidates: FeeDriftCandidate[];
};

/**
 * Selects a bounded, environment-scoped page of settlements to examine.
 *
 * SHARED ON PURPOSE. Both the read-only drift scan and the admin repair runner
 * need exactly this set, and a second copy of the predicate is how a detector
 * and a repairer come to disagree about which payments are even in scope. The
 * provider is not contacted here at all — this only decides WHICH payments to
 * ask about, so a caller can then ask once, in whichever mode it needs.
 *
 * THERE IS NO `fees_are_actual` PREDICATE, deliberately. That flag records what
 * was true AT settlement and is never updated, so filtering on it can only find
 * fees that were missing originally — never fees that changed afterwards, which
 * is most of what this exists for.
 *
 * ORDERED NEWEST FIRST with the transaction id as a tiebreaker, so the order is
 * TOTAL: `posted_at` alone is not unique, and without a tiebreaker two rows
 * sharing a timestamp could swap between pages and a candidate be seen twice or
 * skipped.
 *
 * PAGING IS LIMIT/OFFSET AND IS NOT SNAPSHOT-SAFE. A settlement posted between
 * two pages shifts the window, so a concurrent insert can cause a row to be
 * seen twice or missed across pages. Acceptable for an operator-driven pass
 * over recent history — every operation it feeds is idempotent, so seeing a row
 * twice costs nothing — but it is not a guarantee, and a scheduled crawl over
 * deep history would want a cursor instead.
 */
export async function selectFeeDriftCandidates(
  limit = FEE_DRIFT_MAX_PAGE,
  offset = 0,
): Promise<FeeDriftCandidatePage> {
  const db = getDb();
  if (!db) return { configured: false, candidates: [] };

  /* ENVIRONMENT-SCOPED, like every other sweep in this file. A scan that mixed
   * environments would compare this environment's provider against the other
   * environment's books. Fails closed when it cannot be resolved: an unscoped
   * scan is worse than no scan. */
  const environment = getWhopEnvironment();
  if (!environment) return { configured: false, candidates: [] };

  const pageSize = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, FEE_DRIFT_MAX_PAGE)
    : FEE_DRIFT_MAX_PAGE;
  const pageOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;

  const settlements = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      providerResourceId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
      feesWereActual: sql<string | null>`${accountingTransactions.metadata}->>'fees_are_actual'`,
    })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "payment_settled"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
      ),
    )
    .orderBy(desc(accountingTransactions.postedAt), desc(accountingTransactions.transactionId))
    .limit(pageSize)
    .offset(pageOffset);

  if (settlements.length === 0) return { configured: true, candidates: [] };

  // Gross per settlement, for reporting only. One grouped query, not one per row.
  const txnIds = settlements.map((s) => s.transactionId);
  const grossRows = await db
    .select({
      transactionId: accountingEntries.transactionId,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .where(
      and(
        inArray(accountingEntries.transactionId, txnIds),
        sql`${accountingEntries.account} in ('unallocated_customer_funds', 'tax_payable')`,
      ),
    )
    .groupBy(accountingEntries.transactionId);

  const grossByTxn = new Map(grossRows.map((r) => [r.transactionId, -BigInt(r.total ?? "0")]));

  return {
    configured: true,
    candidates: settlements.map((s) => ({
      transactionId: s.transactionId,
      paymentId: s.providerResourceId ?? "",
      currency: s.currency,
      grossMinor: grossByTxn.get(s.transactionId) ?? BigInt(0),
      // `null` for a settlement predating the field — carried through as null
      // rather than coerced to false, which would assert something untrue.
      feesWereActualAtSettlement:
        s.feesWereActual === null || s.feesWereActual === undefined
          ? null
          : s.feesWereActual === "true",
    })),
  };
}

/**
 * Reports settlements whose provider fee total no longer matches the journal.
 *
 * READ-ONLY. It posts nothing; `reconcileProviderFees` does the correcting, and
 * this function deliberately cannot.
 */
export async function reconcileFeeDrift(
  limit = FEE_DRIFT_MAX_PAGE,
  offset = 0,
): Promise<FeeDriftReport> {
  const page = await selectFeeDriftCandidates(limit, offset);
  if (!page.configured) {
    return { configured: false, settlementsScanned: 0, driftCandidates: [], unresolved: [] };
  }

  const driftCandidates: FeeDriftFinding[] = [];
  const unresolved: FeeDriftUnresolved[] = [];

  for (const candidate of page.candidates) {
    // A settlement with no payment id cannot be asked about. Reported, not
    // silently skipped.
    if (!candidate.paymentId) {
      unresolved.push({
        paymentId: "",
        transactionId: candidate.transactionId,
        reason: "missing_payment_id",
      });
      continue;
    }

    /* THE PROVIDER IS ASKED, THROUGH THE SHARED COMPARISON. Same function
     * `reconcileProviderFees` uses, so the detector and the corrector cannot
     * disagree about whether this payment drifted or by how much.
     *
     * PER-CANDIDATE ISOLATION: one payment's provider failure is recorded and
     * the loop continues, so it cannot make the rest of the page invisible. */
    let inspection;
    try {
      inspection = await inspectProviderFeeDrift(candidate.paymentId);
    } catch (error) {
      unresolved.push({
        paymentId: candidate.paymentId,
        transactionId: candidate.transactionId,
        reason: "inspection_threw",
        detail: describeWhopError(error),
      });
      continue;
    }

    if (!inspection.ok) {
      unresolved.push({
        paymentId: candidate.paymentId,
        transactionId: candidate.transactionId,
        reason: inspection.reason,
        detail: inspection.detail,
      });
      continue;
    }

    /* IN AGREEMENT ON BOTH CLASSES, OR IT IS DRIFT.
     *
     * Checking the fee delta alone made this scan blind to exactly the case
     * Task #19 introduced and the corrector already handles: Whop remits sales
     * tax when it FILES, days or weeks after settlement, so a payment routinely
     * has a tax-remittance delta with no fee movement at all. The detector said
     * "no drift" while `reconcileProviderFees` would have posted a correction —
     * a detector and a corrector disagreeing about what drift means, which is
     * the failure this whole pairing exists to prevent. */
    if (
      inspection.deltaMinor === BigInt(0) &&
      inspection.taxRemittanceDeltaMinor === BigInt(0)
    ) {
      continue;
    }

    driftCandidates.push({
      paymentId: candidate.paymentId,
      transactionId: candidate.transactionId,
      grossMinor: candidate.grossMinor,
      currency: candidate.currency,
      postedFeeMinor: inspection.postedMinor,
      actualFeeMinor: inspection.actualMinor,
      deltaMinor: inspection.deltaMinor,
      taxRemittancePostedMinor: inspection.taxRemittancePostedMinor,
      taxRemittanceActualMinor: inspection.taxRemittanceActualMinor,
      taxRemittanceDeltaMinor: inspection.taxRemittanceDeltaMinor,
      feesWereActualAtSettlement: candidate.feesWereActualAtSettlement,
    });
  }

  return {
    configured: true,
    settlementsScanned: page.candidates.length,
    driftCandidates,
    unresolved,
  };
}


/* ==========================================================================
   ALLOCATION AND REVERSAL RECONCILIATION.

   Tasks #17, #18 and #19 established money rules that nothing watched:

     #19 P1-4  a revenue split may move ONLY the suspense credit its settlement
               created — economically `total - tax`
     #19 P1-2  after a refund and its reversal, suspense must return to zero;
               the retained processing fee belongs in `refund_absorbed_cost`
     #19 P1-1  a sales-tax remittance belongs on `tax_payable`, never in fees
     schema    a revenue split is "written once per payment settlement"

   Each of those is an invariant the postings maintain. None had a detector, so
   a violation — a double allocation, a split that moved more than it should, a
   suspense balance stranded by a bad reversal — would sit in the ledger
   indefinitely with every individual transaction balancing perfectly.

   READ-ONLY. It posts nothing and repairs nothing; it names what is wrong.

   TYING REVERSALS TO PAYMENTS. A settlement names its payment. A refund posting
   names the REFUND and carries `metadata.payment_id`. A reversal names the
   refund or dispute and carries no payment metadata at all — so no single
   predicate reaches every transaction belonging to one payment. The operational
   tables are what close that gap: `payment_refunds` and `payment_disputes` both
   carry `whop_payment_id` alongside their own id. Resolved that way rather than
   by adding metadata to new postings, because this has to work on the rows that
   already exist, not only on future ones.
   ========================================================================== */

export type AllocationDiscrepancyCode =
  /** More than one revenue_split posted for one payment. Double allocation. */
  | "allocation_duplicate"
  /** The split moved an amount the settlement's suspense credit does not justify. */
  | "allocation_amount_mismatch"
  /** The split was posted in a different currency than the settlement. */
  | "allocation_currency_mismatch"
  /** Suspense did not return to zero once every event for this payment landed. */
  | "suspense_residual"
  /** A refund_absorbed_cost leg outside a revenue_split_reversed transaction. */
  | "absorbed_cost_misplaced"
  /** An allocated payment whose settlement cannot be found at all. */
  | "allocation_without_settlement";

export type AllocationDiscrepancy = {
  code: AllocationDiscrepancyCode;
  paymentId: string;
  transactionId: string | null;
  detail: string;
};

export type AllocationReconciliationReport = {
  configured: boolean;
  environment: string | null;
  paymentsChecked: number;
  discrepancies: AllocationDiscrepancy[];
};

/**
 * Checks the settlement → allocation → reversal chain for recent payments.
 *
 * Bounded by `limit` settlements, newest first, for the same reason the fee
 * drift scan is bounded: a reconciliation pass must cost a predictable amount.
 * Unlike that scan this one makes NO provider calls, so the bound is about query
 * size rather than API spend.
 */
export async function reconcileAllocationInternal(
  limit = 500,
): Promise<AllocationReconciliationReport> {
  const db = getDb();
  if (!db) {
    return { configured: false, environment: null, paymentsChecked: 0, discrepancies: [] };
  }

  /* ENVIRONMENT-SCOPED, and fails closed. Every query below carries it. */
  const environment = getWhopEnvironment();
  if (!environment) {
    return { configured: false, environment: null, paymentsChecked: 0, discrepancies: [] };
  }

  const findings: AllocationDiscrepancy[] = [];

  /* THE SETTLEMENTS IN SCOPE, newest first. */
  const settlements = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      paymentId: accountingTransactions.providerResourceId,
      currency: accountingTransactions.currency,
    })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "payment_settled"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
      ),
    )
    .orderBy(desc(accountingTransactions.postedAt), desc(accountingTransactions.transactionId))
    .limit(limit);

  const payments = settlements
    .map((s) => s.paymentId)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (payments.length === 0) {
    return { configured: true, environment, paymentsChecked: 0, discrepancies: [] };
  }

  /* EVERY RESOURCE ID BELONGING TO THESE PAYMENTS: the payment itself, plus the
   * refunds and disputes whose reversals are keyed by their own ids. */
  const [refundRows, disputeRows] = await Promise.all([
    db
      .select({
        paymentId: paymentRefunds.whopPaymentId,
        resourceId: paymentRefunds.whopRefundId,
      })
      .from(paymentRefunds)
      .where(
        and(
          inArray(paymentRefunds.whopPaymentId, payments),
          eq(paymentRefunds.environment, environment),
        ),
      ),
    db
      .select({
        paymentId: paymentDisputes.whopPaymentId,
        resourceId: paymentDisputes.whopDisputeId,
      })
      .from(paymentDisputes)
      .where(
        and(
          inArray(paymentDisputes.whopPaymentId, payments),
          eq(paymentDisputes.environment, environment),
        ),
      ),
  ]);

  /** resource id → the payment it belongs to. */
  const ownerOf = new Map<string, string>();
  for (const p of payments) ownerOf.set(p, p);
  for (const r of [...refundRows, ...disputeRows]) {
    if (r.resourceId && r.paymentId) ownerOf.set(r.resourceId, r.paymentId);
  }

  /* EVERY LEG OF EVERY TRANSACTION NAMING ANY OF THOSE RESOURCES. One query,
   * not one per payment. `metadata.payment_id` is matched too, which is how a
   * refund posting attaches itself to its payment. */
  const resourceIds = [...ownerOf.keys()];
  const legs = await db
    .select({
      transactionId: accountingTransactions.transactionId,
      economicEvent: accountingTransactions.economicEvent,
      providerResourceId: accountingTransactions.providerResourceId,
      metadataPaymentId: sql<string | null>`${accountingTransactions.metadata}->>'payment_id'`,
      currency: accountingTransactions.currency,
      account: accountingEntries.account,
      amountMinor: accountingEntries.amountMinor,
    })
    .from(accountingEntries)
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    .where(
      and(
        eq(accountingTransactions.environment, environment),
        /* MATCHED BY LIST, NOT BY `= any(...)`. Passing a JS array into a raw
         * `sql` fragment does not bind as a Postgres array through this driver;
         * `inArray` is what the rest of this file uses and it builds a real IN
         * list. A settlement names its payment directly, while a refund posting
         * names the refund and points at the payment through its metadata — so
         * both routes have to be matched. */
        or(
          inArray(accountingTransactions.providerResourceId, resourceIds),
          inArray(sql`${accountingTransactions.metadata}->>'payment_id'`, resourceIds),
        ),
      ),
    );

  type PerPayment = {
    settlementSuspense: bigint;
    settlementCurrency: string | null;
    splitTransactions: Set<string>;
    splitSuspense: bigint;
    splitCurrencies: Set<string>;
    suspenseNet: bigint;
  };
  const byPayment = new Map<string, PerPayment>();
  const blank = (): PerPayment => ({
    settlementSuspense: BigInt(0),
    settlementCurrency: null,
    splitTransactions: new Set(),
    splitSuspense: BigInt(0),
    splitCurrencies: new Set(),
    suspenseNet: BigInt(0),
  });

  for (const leg of legs) {
    // Which payment this leg belongs to: the resource it names, or the payment
    // its metadata points at.
    const owner =
      (leg.providerResourceId && ownerOf.get(leg.providerResourceId)) ??
      (leg.metadataPaymentId && ownerOf.get(leg.metadataPaymentId)) ??
      null;
    if (!owner) continue;

    const state = byPayment.get(owner) ?? blank();

    if (leg.account === "unallocated_customer_funds") {
      state.suspenseNet += leg.amountMinor;
      if (leg.economicEvent === "payment_settled") {
        // Stored as a credit (negative); the allocatable amount is its negation.
        state.settlementSuspense += -leg.amountMinor;
        state.settlementCurrency = leg.currency;
      }
      if (leg.economicEvent === "revenue_split") {
        state.splitSuspense += leg.amountMinor;
        state.splitCurrencies.add(leg.currency);
      }
    }

    if (leg.economicEvent === "revenue_split") state.splitTransactions.add(leg.transactionId);

    /* `refund_absorbed_cost` HAS EXACTLY ONE LEGITIMATE HOME. It is the cost of
     * a reversal, posted inside the reversal itself; anywhere else means some
     * other code path started using an expense account it has no business in. */
    if (leg.account === "refund_absorbed_cost" && leg.economicEvent !== "revenue_split_reversed") {
      findings.push({
        code: "absorbed_cost_misplaced",
        paymentId: owner,
        transactionId: leg.transactionId,
        detail: `refund_absorbed_cost posted by ${leg.economicEvent}`,
      });
    }

    byPayment.set(owner, state);
  }

  for (const paymentId of payments) {
    const state = byPayment.get(paymentId);
    if (!state) continue;

    /* ONE SPLIT PER SETTLEMENT — the invariant the schema's own enum comment
     * states. Two means the suspense was moved out twice. */
    if (state.splitTransactions.size > 1) {
      findings.push({
        code: "allocation_duplicate",
        paymentId,
        transactionId: [...state.splitTransactions][0],
        detail: `${state.splitTransactions.size} revenue_split transactions`,
      });
    }

    if (state.splitTransactions.size > 0) {
      if (state.settlementCurrency === null) {
        findings.push({
          code: "allocation_without_settlement",
          paymentId,
          transactionId: [...state.splitTransactions][0],
          detail: "revenue_split with no settlement suspense credit",
        });
      } else {
        /* THE SPLIT MOVED EXACTLY WHAT THE SETTLEMENT PUT THERE. Task #19 P1-4
         * made the allocatable amount authoritative; this is the check that it
         * stayed that way. A split debit larger than the credit is money taken
         * out of suspense that no payment put in. */
        if (state.splitSuspense !== state.settlementSuspense) {
          findings.push({
            code: "allocation_amount_mismatch",
            paymentId,
            transactionId: [...state.splitTransactions][0],
            detail:
              `split moved ${state.splitSuspense.toString()}, ` +
              `settlement made ${state.settlementSuspense.toString()} allocatable`,
          });
        }

        for (const c of state.splitCurrencies) {
          if (c !== state.settlementCurrency) {
            findings.push({
              code: "allocation_currency_mismatch",
              paymentId,
              transactionId: [...state.splitTransactions][0],
              detail: `split in ${c}, settlement in ${state.settlementCurrency}`,
            });
          }
        }
      }
    }

    /* SUSPENSE MUST CLOSE. Settlement credits it, the split clears it, a refund
     * debits it and the reversal credits it back — including the absorbed cost
     * (Task #19 P1-2). Anything left is money the books cannot explain, and
     * before that fix the retained processing fee sat here as a debit.
     *
     * A payment that has settled but not yet been allocated legitimately holds
     * its whole credit, so only an allocated payment is checked. */
    if (state.splitTransactions.size > 0 && state.suspenseNet !== BigInt(0)) {
      findings.push({
        code: "suspense_residual",
        paymentId,
        transactionId: null,
        detail: `unallocated_customer_funds nets to ${state.suspenseNet.toString()}`,
      });
    }
  }

  return {
    configured: true,
    environment,
    paymentsChecked: payments.length,
    discrepancies: findings,
  };
}

/* ==========================================================================
   LEDGER TRIAL BALANCE.

   Sums every journal entry per account. The result is the ledger's own view
   of how much each account holds — not the provider's, not the database row's,
   but what the accounting entries themselves add up to.

   SIGN CONVENTION carries through: asset accounts should show a positive total
   (debit normal balance), liability and revenue accounts a negative total
   (credit normal balance). A reversed sign on an asset is not a balance check
   failure, but it is a useful signal.

   THIS FUNCTION NEVER TOUCHES THE PROVIDER. It is pure arithmetic on the local
   journal and is safe to run at any time with no API cost.
   ========================================================================== */

export type TrialBalanceLine = {
  account: string;
  /**
   * THE DENOMINATION, and the line is meaningless without it. One account can
   * hold balances in several currencies, and minor units from different
   * currencies cannot be added — 1000 EUR-cents plus 1000 USD-cents is not 2000
   * of anything.
   */
  currency: string;
  totalMinor: bigint;
  entryCount: number;
};

export type TrialBalance = {
  configured: boolean;
  /** The environment these lines describe. Never mixed. */
  environment: string | null;
  /**
   * The sum of ALL entry legs, per currency. Each must be zero if the journal
   * is balanced. Reported per currency rather than as one figure because a
   * single total would be a sum across denominations — the exact arithmetic this
   * type now refuses to do.
   */
  grandTotals: { currency: string; totalMinor: bigint }[];
  lines: TrialBalanceLine[];
  /** True when EVERY currency's grand total is exactly zero. */
  balanced: boolean;
};

/**
 * Returns the running balance for every account in the journal.
 *
 * The grand total should always be zero: every transaction's legs sum to zero,
 * and the sum of all transactions is therefore also zero. A non-zero grand
 * total means a posting violated the double-entry constraint.
 */
export async function ledgerTrialBalance(): Promise<TrialBalance> {
  const db = getDb();
  if (!db) {
    return { configured: false, environment: null, grandTotals: [], lines: [], balanced: false };
  }

  /* ENVIRONMENT-SCOPED. This is the figure an operator reads to answer "what
   * does the ledger hold", and one that silently added sandbox test money to
   * production balances would answer it wrongly in the most consequential place
   * in the report. The environment lives on the transaction, so the join is not
   * optional. Fails closed. */
  const environment = getWhopEnvironment();
  if (!environment) {
    return { configured: false, environment: null, grandTotals: [], lines: [], balanced: false };
  }

  /* GROUPED BY CURRENCY AS WELL AS ACCOUNT. `getAccountBalances` in the journal
   * already did this; this function did not, and produced one `totalMinor` per
   * account by adding every denomination together. With non-USD settlements now
   * allocatable (Task #19) that is a wrong number, not a theoretical one. */
  const rows = await db
    .select({
      account: accountingEntries.account,
      currency: accountingEntries.currency,
      total: sql<string>`sum(${accountingEntries.amountMinor})::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(accountingEntries)
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    .where(eq(accountingTransactions.environment, environment))
    .groupBy(accountingEntries.account, accountingEntries.currency)
    .orderBy(asc(accountingEntries.account), asc(accountingEntries.currency));

  const lines: TrialBalanceLine[] = rows.map((r) => ({
    account: r.account,
    currency: r.currency,
    totalMinor: BigInt(r.total ?? "0"),
    entryCount: r.count,
  }));

  // One grand total per currency. Every one of them must be zero.
  const byCurrency = new Map<string, bigint>();
  for (const line of lines) {
    byCurrency.set(line.currency, (byCurrency.get(line.currency) ?? BigInt(0)) + line.totalMinor);
  }
  const grandTotals = [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, totalMinor]) => ({ currency, totalMinor }));

  return {
    configured: true,
    environment,
    grandTotals,
    lines,
    balanced: grandTotals.every((g) => g.totalMinor === BigInt(0)),
  };
}

