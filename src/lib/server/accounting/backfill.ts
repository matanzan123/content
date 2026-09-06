import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { paymentOrders } from "@/lib/db/schema";
import { getWhopEnvironment } from "../whop-payments";
import { mapPaymentToOrder } from "../whop-payment-mapping";
import { postWhopSettlement } from "./whop-payment-posting";

/* ==========================================================================
   ACCOUNTING BACKFILL — for payments that settled before the ledger existed.

   WHY THIS IS NOT A WEBHOOK REPLAY. The delivery ledger is doing its job: the
   sandbox `payment.succeeded` for the payment below is already recorded as
   `processed`, and re-sending it would be refused as a duplicate. That refusal
   is correct and must not be bypassed — deleting or rewriting a receipt to
   force a handler to run again would corrupt the one record that proves what
   we have and have not acted on.

   So this takes the other door into the SAME authoritative code. It calls
   `mapPaymentToOrder` — the identical function the webhook handler calls, with
   the identical eight checks against the provider's own record of the payment
   — and then `postWhopSettlement`, the identical posting rule. It skips only
   the parts that are specific to an inbound HTTP delivery: the signature
   check, which exists to establish that a payload came from Whop, and the
   receipt row, which exists to deduplicate deliveries.

   NOTHING IS TRUSTED FROM OUR OWN DATABASE except which payment id to ask
   about. Every amount, every fee, the currency, the company and the status are
   fetched from Whop and re-verified. A row we corrupted ourselves could not
   make this post the wrong money; it could only make it ask about the wrong
   payment, and `mapPaymentToOrder` would then refuse the mismatch.

   SAFE TO RUN REPEATEDLY. Both steps are idempotent: the order is already
   `paid` and stays so, and the posting converges on
   `whop:payment_settled:<payment_id>`. A second run reports `already_posted`
   and writes nothing.
   ========================================================================== */

export type BackfillOutcome = {
  orderId: string;
  paymentId: string;
  /** What happened to the accounting posting for this order. */
  result:
    | { kind: "posted"; transactionId: string }
    | { kind: "already_posted"; transactionId: string }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; reason: string };
};

export type BackfillReport = {
  configured: boolean;
  /** Orders considered. Zero is a real answer. */
  examined: number;
  outcomes: BackfillOutcome[];
};

/**
 * Accounts for ONE already-settled order.
 *
 * Runs the full provider verification again rather than assuming the order's
 * `paid` status is enough. If the payment no longer verifies — refunded to a
 * non-settled status, moved to another company, amount changed — this refuses
 * to post, which is the whole reason it re-checks.
 */
export async function backfillOrder(orderId: string): Promise<BackfillOutcome | null> {
  const db = getDb();
  const environment = getWhopEnvironment();
  if (!db || !environment) return null;

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.orderId, orderId));

  if (!order || !order.whopPaymentId) return null;

  const base = { orderId: order.orderId, paymentId: order.whopPaymentId };

  // THE SAME AUTHORITATIVE CHECK THE WEBHOOK RUNS. Not a lighter version of
  // it, and not skipped because the order already says `paid`.
  const mapped = await mapPaymentToOrder(order.whopPaymentId, "succeeded");
  if (mapped.kind !== "paid") {
    const reason = mapped.kind === "rejected" ? mapped.reason : mapped.kind;
    return { ...base, result: { kind: "skipped", reason } };
  }

  const posted = await postWhopSettlement(order.whopPaymentId, {
    environment,
    orderId: order.orderId,
    // No delivery caused this posting, and recording a webhook id that did not
    // is worse than recording nothing.
    sourceWebhookId: null,
  });

  if (!posted.ok) return { ...base, result: { kind: "failed", reason: posted.reason } };

  return {
    ...base,
    result: posted.alreadyPosted
      ? { kind: "already_posted", transactionId: posted.transactionId }
      : { kind: "posted", transactionId: posted.transactionId },
  };
}

/**
 * Every paid order in the configured environment, oldest first.
 *
 * Bounded, and it never invents work: an order with no provider payment is not
 * examined at all, because there is nothing authoritative to ask about.
 */
export async function backfillSettledOrders(limit = 100): Promise<BackfillReport> {
  const db = getDb();
  const environment = getWhopEnvironment();
  if (!db || !environment) return { configured: false, examined: 0, outcomes: [] };

  const orders = await db
    .select({ orderId: paymentOrders.orderId })
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.environment, environment),
        eq(paymentOrders.status, "paid"),
        isNotNull(paymentOrders.whopPaymentId),
      ),
    )
    .limit(limit);

  const outcomes: BackfillOutcome[] = [];
  for (const { orderId } of orders) {
    const outcome = await backfillOrder(orderId);
    if (outcome) outcomes.push(outcome);
  }

  return { configured: true, examined: orders.length, outcomes };
}
