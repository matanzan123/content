import "server-only";

import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { accountingEntries, accountingTransactions, paymentOrders } from "@/lib/db/schema";
import { economicKey } from "./accounts";
import { fetchSettlementFacts } from "./whop-payment-posting";

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

  for (const order of orders) {
    const posted = order.whopPaymentId ? (byPayment.get(order.whopPaymentId) ?? []) : [];

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
