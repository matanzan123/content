import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { paymentRefunds } from "@/lib/db/schema";
import type { RefundStatus } from "./refund-lifecycle";

/* ==========================================================================
   INTERNAL REFUND RECORDS — server only.

   ONE ROW PER PROVIDER REFUND RESOURCE, and the row is keyed on the refund's
   own `rf_` id. That single decision is what makes every requirement in this
   task fall out:

     - a $10 payment refunded $2, $3 and $5 is THREE rows, because Whop
       created three refund resources;
     - two webhook deliveries with different message ids naming ONE refund
       converge on ONE row, because they name one `rf_` id;
     - concurrent processing of the same refund converges through Postgres,
       because `uniq_refunds_provider_refund` decides the winner and not us.

   THIS TABLE IS OPERATIONAL, NOT FINANCIAL. It is UPDATED as a refund moves;
   the journal is append-only and is not. A row here saying `completed` is a
   claim about the provider. The money is the posting keyed
   `whop:payment_refunded:<rf_id>`, and the two are reconciled against each
   other rather than one being derived from the other.

   `completed` IS A FLOOR. Whop does not order its deliveries, so a
   `refund.updated` carrying an earlier `pending` snapshot arrives after the
   one reporting `succeeded` as a matter of course. Every downgrade below is
   written with `status <> 'completed'` in its WHERE clause, so a late or
   out-of-order event cannot un-refund a completed refund — the database
   refuses it, not a code path that might be skipped.

   NOTHING HERE WRITES `accounting_transactions`, and nothing here decides an
   amount. The amount arrives already proved by `whop-refunds.ts` against the
   provider's own record.
   ========================================================================== */

export type PaymentRefund = {
  refundId: string;
  provider: string;
  whopRefundId: string;
  whopPaymentId: string;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  providerStatus: string;
  status: RefundStatus;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
};

/**
 * The facts a refund row is written from. Every one of them has already been
 * read off the provider's own record — there is no path into this module that
 * accepts a figure from a webhook body or a browser.
 */
export type RecordRefundInput = {
  whopRefundId: string;
  whopPaymentId: string;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  /** Whop's status verbatim. */
  providerStatus: string;
  /** Our reduction of it. */
  status: RefundStatus;
  failureReason: string | null;
};

export type RecordRefundResult =
  | {
      ok: true;
      refund: PaymentRefund;
      /** True when this call did not move the row: it was already there in a
       * state this update was not allowed to change. */
      unchanged: boolean;
    }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "storage_error"
        /** The row exists and names a DIFFERENT payment than the one supplied.
         * A refund cannot change which payment it reverses; something is
         * wrong upstream and nothing is written. */
        | "payment_conflict"
        /** The row exists with a different amount or currency. Same reasoning:
         * a refund's value is fixed at creation. */
        | "amount_conflict";
    };

const PROVIDER = "whop";

/**
 * Records or advances ONE refund, atomically and idempotently.
 *
 * THE UPSERT IS THE IDEMPOTENCY, not a read. `insert … on conflict
 * (provider, whop_refund_id) do update … where (still movable) … returning`
 * is one statement, so Postgres takes the row lock and evaluates the
 * eligibility test against committed state. Two concurrent deliveries for one
 * refund cannot both insert, and cannot both apply a conflicting update: one
 * wins, the other reads back what the winner committed. A `select` followed by
 * an `insert` could not do this — both callers would see nothing and both
 * would insert, and the unique index would turn the loser into an error
 * instead of a convergence.
 *
 * THE ABSORBING GUARD IS IN THE STATEMENT. `status <> 'completed'` sits in the
 * `where` of the `do update`, so a stale snapshot reaching us after a
 * completion updates nothing at all and is reported as `unchanged`. It cannot
 * be skipped by a branch, and it holds for any future writer that comes
 * through this function.
 *
 * `completed_at` uses COALESCE for the same reason `payment-orders.ts` does:
 * this statement is deliberately re-runnable by the same refund, and a plain
 * `now()` would overwrite the moment a refund actually completed with the
 * moment it was re-checked. The first completion is the true one.
 */
export async function recordRefund(input: RecordRefundInput): Promise<RecordRefundResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  try {
    const updated = await db
      .insert(paymentRefunds)
      .values({
        provider: PROVIDER,
        whopRefundId: input.whopRefundId,
        whopPaymentId: input.whopPaymentId,
        orderId: input.orderId,
        environment: input.environment,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerStatus: input.providerStatus,
        status: input.status,
        failureReason: input.failureReason,
        completedAt: input.status === "completed" ? sql`now()` : null,
        failedAt: input.status === "failed" ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: [paymentRefunds.provider, paymentRefunds.whopRefundId],
        set: {
          providerStatus: input.providerStatus,
          status: input.status,
          failureReason: input.failureReason,
          // The order link is filled in if it was missing and never replaced:
          // a refund's order is decided once, by the payment it reverses.
          orderId: sql`coalesce(${paymentRefunds.orderId}, ${input.orderId})`,
          completedAt:
            input.status === "completed"
              ? sql`coalesce(${paymentRefunds.completedAt}, now())`
              : sql`${paymentRefunds.completedAt}`,
          failedAt:
            input.status === "failed"
              ? sql`coalesce(${paymentRefunds.failedAt}, now())`
              : sql`${paymentRefunds.failedAt}`,
          updatedAt: sql`now()`,
        },
        // THE ABSORBING GUARD, and the two identity guards, all in SQL.
        //
        // A refund cannot change the payment it reverses, its amount or its
        // currency — those are fixed when the processor creates it. If a later
        // delivery disagrees about any of them, this update matches nothing,
        // and the read-back below reports the conflict rather than quietly
        // overwriting a figure the ledger has already been posted from.
        setWhere: and(
          sql`${paymentRefunds.status} <> 'completed'`,
          eq(paymentRefunds.whopPaymentId, input.whopPaymentId),
          eq(paymentRefunds.amountMinor, input.amountMinor),
          eq(paymentRefunds.currency, input.currency),
        ),
      })
      .returning();

    if (updated.length === 1) {
      return { ok: true, refund: updated[0] as PaymentRefund, unchanged: false };
    }

    // Nothing moved. Either the row is already `completed` — the normal,
    // correct outcome for a redelivery after completion — or one of the
    // identity guards refused it. Read the row and say which.
    const existing = await getRefundByProviderId(input.whopRefundId);
    if (!existing) return { ok: false, reason: "storage_error" };

    if (existing.whopPaymentId !== input.whopPaymentId) {
      return { ok: false, reason: "payment_conflict" };
    }
    if (existing.amountMinor !== input.amountMinor || existing.currency !== input.currency) {
      return { ok: false, reason: "amount_conflict" };
    }

    return { ok: true, refund: existing, unchanged: true };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   READING
   ------------------------------------------------------------------------- */

export async function getRefundByProviderId(whopRefundId: string): Promise<PaymentRefund | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(paymentRefunds)
    .where(
      and(eq(paymentRefunds.provider, PROVIDER), eq(paymentRefunds.whopRefundId, whopRefundId)),
    );
  return (row as PaymentRefund | undefined) ?? null;
}

/** Every refund we hold against one payment, oldest first. */
export async function listRefundsForPaymentLocal(
  whopPaymentId: string,
): Promise<PaymentRefund[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.whopPaymentId, whopPaymentId))
    .orderBy(asc(paymentRefunds.createdAt));
  return rows as PaymentRefund[];
}

/**
 * The total our own records say has been COMPLETELY refunded against one
 * payment.
 *
 * Note what this is not: it is not the number the overflow check runs on. That
 * one is computed from the refunds WHOP reports, in
 * `whop-refund-mapping.ts` — our own table is a mirror, and a mirror is the
 * wrong thing to validate a provider fact against. This exists for
 * reconciliation, where comparing the two IS the point.
 */
export async function localCompletedRefundTotal(whopPaymentId: string): Promise<bigint> {
  const db = getDb();
  if (!db) return BigInt(0);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${paymentRefunds.amountMinor}), 0)::text` })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.whopPaymentId, whopPaymentId),
        eq(paymentRefunds.status, "completed"),
      ),
    );
  return BigInt(row?.total ?? "0");
}

/**
 * Refunds our records call `completed`, for the reconciliation and crash-
 * recovery passes.
 *
 * Bounded: a repair job that pulls an unbounded table into memory is its own
 * outage, and the callers page through rather than asking for everything.
 */
export async function listCompletedRefunds(limit = 500): Promise<PaymentRefund[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.status, "completed"))
    .orderBy(asc(paymentRefunds.createdAt))
    .limit(limit);
  return rows as PaymentRefund[];
}

export async function listAllRefunds(limit = 500): Promise<PaymentRefund[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentRefunds)
    .orderBy(asc(paymentRefunds.createdAt))
    .limit(limit);
  return rows as PaymentRefund[];
}
