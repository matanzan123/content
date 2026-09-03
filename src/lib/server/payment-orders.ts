import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { paymentOrders } from "@/lib/db/schema";
import { getWhopEnvironment } from "./whop-payments";
import { isChargeableAmount, normaliseCurrency } from "./money";

/* ==========================================================================
   INTERNAL PAYMENT ORDERS — server only.

   The order is the authority for what is owed. Everything downstream — the
   checkout price, the amount a webhook is checked against — reads from here.
   Nothing a browser sends can alter an amount after the row exists: there is
   no update path for `amount_minor` or `currency` in this module at all.

   STATE TRANSITIONS are explicit and one-way where it matters:

     created ──► checkout_created ──► payment_pending ──► paid   (terminal)
        │              │                    │
        └──────────────┴────────────────────┴──► failed ──► checkout_created
                                                 (retry)
     any non-paid ──► cancelled  (terminal)

   `paid` is a FLOOR. Whop does not guarantee webhook order, so a `payment.
   failed` for an earlier attempt can arrive after the `payment.succeeded`
   that settled the order. Every downgrade below is written with
   `status <> 'paid'` in its WHERE clause, so a late or out-of-order event
   cannot un-pay an order — the database refuses it, not a code path that
   might be skipped.

   NOTHING HERE WRITES `financial_ledger`. An order being paid is a fact about
   a checkout; accounting for it is a separate step that does not exist yet.
   ========================================================================== */

export type PaymentOrderStatus =
  | "created"
  | "checkout_created"
  | "payment_pending"
  | "paid"
  | "failed"
  | "cancelled";

export type PaymentOrder = {
  orderId: string;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  status: PaymentOrderStatus;
  purpose: string;
  whopCheckoutId: string | null;
  whopPlanId: string | null;
  whopPaymentId: string | null;
  paidAt: Date | null;
};

/** Statuses from which a checkout may be created or recreated. */
const CHECKOUT_ELIGIBLE: ReadonlySet<PaymentOrderStatus> = new Set([
  "created",
  "checkout_created",
  "payment_pending",
  "failed",
]);

export function isCheckoutEligible(status: PaymentOrderStatus): boolean {
  return CHECKOUT_ELIGIBLE.has(status);
}

/** A server-generated id is the only kind we accept. Shape-check anything inbound. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export type CreateOrderInput = {
  amountMinor: bigint;
  currency: string;
  purpose: string;
};

export type CreateOrderResult =
  | { ok: true; order: PaymentOrder }
  | { ok: false; reason: "unconfigured" | "invalid_amount" | "invalid_currency" | "storage_error" };

/**
 * Creates an order. The id comes from the database, never from a caller — an
 * order id a client could choose is an order id a client could collide with
 * someone else's.
 */
export async function createPaymentOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const db = getDb();
  const environment = getWhopEnvironment();
  if (!db || !environment) return { ok: false, reason: "unconfigured" };

  const currency = normaliseCurrency(input.currency);
  if (!currency) return { ok: false, reason: "invalid_currency" };
  if (!isChargeableAmount(input.amountMinor)) return { ok: false, reason: "invalid_amount" };

  try {
    const [row] = await db
      .insert(paymentOrders)
      .values({
        environment,
        amountMinor: input.amountMinor,
        currency,
        purpose: input.purpose,
        status: "created",
      })
      .returning();
    return { ok: true, order: row as PaymentOrder };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getPaymentOrder(orderId: string): Promise<PaymentOrder | null> {
  const db = getDb();
  if (!db || !isOrderId(orderId)) return null;
  const [row] = await db.select().from(paymentOrders).where(eq(paymentOrders.orderId, orderId));
  return (row as PaymentOrder | undefined) ?? null;
}

/**
 * Records the provider checkout against the order.
 *
 * Guarded on a non-terminal status inside the UPDATE, so a checkout created
 * concurrently with a settling payment cannot overwrite a paid order.
 */
export async function attachCheckout(
  orderId: string,
  checkout: { checkoutId: string; planId: string | null },
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const updated = await db
    .update(paymentOrders)
    .set({
      status: "checkout_created",
      whopCheckoutId: checkout.checkoutId,
      whopPlanId: checkout.planId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(paymentOrders.orderId, orderId),
        sql`${paymentOrders.status} in ('created', 'checkout_created', 'payment_pending', 'failed')`,
      ),
    )
    .returning({ orderId: paymentOrders.orderId });
  return updated.length === 1;
}

export type SettleResult =
  | { ok: true; alreadyPaid: boolean }
  | { ok: false; reason: "payment_already_used" | "not_settleable" | "storage_error" };

/**
 * Marks an order paid against a specific provider payment.
 *
 * `paid_at` and `updated_at` come from the database clock, like every other
 * lifecycle timestamp in this codebase.
 *
 * Two protections, both in the database rather than in code:
 *   - the WHERE clause refuses any order that is already `paid` by a
 *     DIFFERENT payment, so a second payment cannot re-settle it;
 *   - `uniq_orders_whop_payment` refuses the same payment id on a second
 *     order, so one Whop payment can never settle two ClipRewards orders even
 *     if two deliveries race.
 *
 * Re-running with the SAME payment id is idempotent and reports
 * `alreadyPaid`, which is what a duplicate webhook must produce.
 */
export async function markOrderPaid(orderId: string, whopPaymentId: string): Promise<SettleResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "storage_error" };

  try {
    const updated = await db
      .update(paymentOrders)
      .set({
        status: "paid",
        whopPaymentId,
        paidAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(paymentOrders.orderId, orderId),
          sql`${paymentOrders.status} <> 'cancelled'`,
          // Either unsettled, or already settled by this very payment.
          sql`(${paymentOrders.whopPaymentId} is null or ${paymentOrders.whopPaymentId} = ${whopPaymentId})`,
        ),
      )
      .returning({ paymentId: paymentOrders.whopPaymentId });

    if (updated.length === 1) return { ok: true, alreadyPaid: false };

    // Nothing updated: find out whether this payment already settled it.
    const existing = await getPaymentOrder(orderId);
    if (existing?.whopPaymentId === whopPaymentId && existing.status === "paid") {
      return { ok: true, alreadyPaid: true };
    }
    return { ok: false, reason: "not_settleable" };
  } catch {
    // The unique index rejects a payment id already attached to another order.
    return { ok: false, reason: "payment_already_used" };
  }
}

/**
 * Moves an order to `payment_pending` or `failed`.
 *
 * `status <> 'paid'` is in the WHERE clause, so an out-of-order or replayed
 * failure event physically cannot downgrade an order a verified payment has
 * already settled. It returns false in that case, which the caller reports
 * rather than treating as success.
 */
export async function recordOrderAttempt(
  orderId: string,
  status: "payment_pending" | "failed",
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const updated = await db
    .update(paymentOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(
      and(
        eq(paymentOrders.orderId, orderId),
        sql`${paymentOrders.status} <> 'paid'`,
        sql`${paymentOrders.status} <> 'cancelled'`,
        isNull(paymentOrders.paidAt),
      ),
    )
    .returning({ orderId: paymentOrders.orderId });
  return updated.length === 1;
}
/**
 * Predicate for "this sandbox test order can still be paid".
 *
 * Shared by the lookup and the tests so the two cannot drift apart.
 */
function stillPayable(match: { amountMinor: bigint; currency: string; purpose: string }) {
  return and(
    eq(paymentOrders.environment, "sandbox"),
    eq(paymentOrders.purpose, match.purpose),
    eq(paymentOrders.currency, match.currency),
    eq(paymentOrders.amountMinor, match.amountMinor),
    // Every state an order can still be paid FROM. `checkout_created` is in
    // the list deliberately: it is where an order sits after a successful
    // start, and leaving it out was what let a second click create a second
    // order and a second provider configuration for the same test.
    sql`${paymentOrders.status} in ('created', 'checkout_created', 'payment_pending', 'failed')`,
    isNull(paymentOrders.whopPaymentId),
    isNull(paymentOrders.paidAt),
  );
}

/**
 * A stable lock id for sandbox test-order creation.
 *
 * `pg_advisory_xact_lock` takes a bigint. Any constant works as long as every
 * process uses the SAME one; this is an arbitrary fixed value, not derived
 * from anything that could vary between deployments.
 */
const SANDBOX_ORDER_LOCK = BigInt("724103991001");

/**
 * Returns the one active sandbox test order, creating it only if none exists —
 * atomically, across processes.
 *
 * THE RACE THIS CLOSES: a plain "look, then insert if absent" has a window
 * between the two statements. Two requests that arrive together both see no
 * order and both insert, which is exactly how the accidental duplicates
 * appeared. A browser-side guard cannot help — the two requests may come from
 * different tabs, different people, or different Node processes behind a load
 * balancer.
 *
 * The fix is a transaction holding `pg_advisory_xact_lock`, which is held by
 * POSTGRES rather than by this process, so it serialises every caller against
 * every other regardless of where they run. The lock releases automatically
 * when the transaction ends, including on error — there is no unlock to
 * forget and no lock to leak.
 *
 * A unique index would be the stronger tool, but the condition here is
 * "at most one order in any of four states with no payment attached", which is
 * not expressible as one. That is a real limitation and the reason this is a
 * lock rather than a constraint.
 */
export async function findOrCreateSandboxOrder(match: {
  amountMinor: bigint;
  currency: string;
  purpose: string;
}): Promise<CreateOrderResult> {
  const db = getDb();
  const environment = getWhopEnvironment();
  if (!db || environment !== "sandbox") return { ok: false, reason: "unconfigured" };

  const currency = normaliseCurrency(match.currency);
  if (!currency) return { ok: false, reason: "invalid_currency" };
  if (!isChargeableAmount(match.amountMinor)) return { ok: false, reason: "invalid_amount" };

  try {
    return await db.transaction(async (tx) => {
      // Serialises every caller, in every process, for the duration of this
      // transaction only.
      await tx.execute(sql`select pg_advisory_xact_lock(${SANDBOX_ORDER_LOCK})`);

      const [existing] = await tx
        .select()
        .from(paymentOrders)
        .where(stillPayable({ ...match, currency }))
        // OLDEST first, so repeated clicks converge on the order already in
        // flight rather than leaving a trail of newer ones.
        .orderBy(asc(paymentOrders.createdAt))
        .limit(1);

      if (existing) return { ok: true, order: existing as PaymentOrder } as CreateOrderResult;

      const [created] = await tx
        .insert(paymentOrders)
        .values({
          environment,
          amountMinor: match.amountMinor,
          currency,
          purpose: match.purpose,
          status: "created",
        })
        .returning();

      return { ok: true, order: created as PaymentOrder } as CreateOrderResult;
    });
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}
