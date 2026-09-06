import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { disputeAlerts, paymentDisputes, resolutionCenterCases } from "@/lib/db/schema";
import type { CaseStatus, DisputeAlertStatus, DisputeStatus } from "./dispute-lifecycle";

/* ==========================================================================
   INTERNAL DISPUTE-FAMILY RECORDS — server only.

   THREE TABLES, THREE IDENTITIES, and they are kept apart on purpose. One
   payment can carry a dispute alert, then a formal dispute, and a Resolution
   Center case about the same complaint. Folding them together would either
   lose two of the three or double-count the chargeback.

   Each table is keyed on its own provider resource id, which is what makes
   every requirement fall out:

     - duplicate deliveries converge, because they name one resource;
     - two message ids for one dispute converge, for the same reason;
     - concurrent processing converges through Postgres, because the unique
       index decides the winner and not this code.

   THESE TABLES ARE OPERATIONAL, NOT FINANCIAL. They are UPDATED as a dispute
   moves; the journal is append-only and is not. A row here saying `lost` is a
   claim about the provider's ruling. The money is whatever the provider's own
   ledger feed says moved, posted separately and reconciled against this.

   RESOLVED IS A FLOOR. Whop does not order its deliveries, so a
   `dispute.updated` carrying an earlier `needs_response` snapshot arrives
   after the one reporting `won` as a matter of course. Every downgrade below
   is written with the absorbing rule in its WHERE clause, so a late or
   out-of-order event cannot reopen a resolved dispute — the database refuses
   it, not a code path that might be skipped.
   ========================================================================== */

const PROVIDER = "whop";

/* -------------------------------------------------------------------------
   DISPUTES
   ------------------------------------------------------------------------- */

export type PaymentDispute = {
  disputeId: string;
  provider: string;
  whopDisputeId: string;
  whopPaymentId: string;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  providerStatus: string;
  status: DisputeStatus;
  inquiry: boolean;
  rapidDisputeResolution: boolean;
  reason: string | null;
  reasonCode: string | null;
  evidenceDueAt: Date | null;
  evidenceSubmittedAt: Date | null;
  openedAt: Date | null;
  providerUpdatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordDisputeInput = {
  whopDisputeId: string;
  whopPaymentId: string;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  providerStatus: string;
  status: DisputeStatus;
  inquiry: boolean;
  rapidDisputeResolution: boolean;
  reason: string | null;
  reasonCode: string | null;
  evidenceDueAt: Date | null;
  evidenceSubmittedAt: Date | null;
  openedAt: Date | null;
  providerUpdatedAt: Date | null;
};

export type RecordDisputeResult =
  | { ok: true; dispute: PaymentDispute; unchanged: boolean }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "storage_error"
        /** The row exists naming a DIFFERENT payment. A dispute cannot change
         * which payment it disputes; something is wrong upstream. */
        | "payment_conflict";
    };

/**
 * Records or advances ONE dispute, atomically and idempotently.
 *
 * THE UPSERT IS THE IDEMPOTENCY, not a read. One statement, so Postgres takes
 * the row lock and evaluates eligibility against committed state. Two
 * concurrent deliveries for one dispute cannot both insert, and cannot both
 * apply a conflicting update: one wins, the other reads back what the winner
 * committed.
 *
 * THE ABSORBING GUARD IS IN THE STATEMENT. `status not in ('won','lost',
 * 'closed')` sits in the `where` of the `do update`, so a stale snapshot
 * reaching us after a resolution updates nothing and is reported as
 * `unchanged`.
 *
 * THE AMOUNT IS ALLOWED TO MOVE, unlike a refund's. A dispute's amount can
 * legitimately change as the processor revises it, so it is updated rather
 * than guarded — but the PAYMENT cannot change, and that is guarded. This
 * asymmetry is deliberate: a changed amount is provider truth, a changed
 * payment is a mapping error.
 *
 * `resolved_at` uses COALESCE for the reason `paid_at` and `completed_at` do:
 * this statement is deliberately re-runnable, and a plain `now()` would
 * overwrite the moment a dispute actually resolved with the moment it was
 * re-checked.
 */
export async function recordDispute(
  input: RecordDisputeInput,
): Promise<RecordDisputeResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const resolved = input.status === "won" || input.status === "lost" || input.status === "closed";

  try {
    const updated = await db
      .insert(paymentDisputes)
      .values({
        provider: PROVIDER,
        whopDisputeId: input.whopDisputeId,
        whopPaymentId: input.whopPaymentId,
        orderId: input.orderId,
        environment: input.environment,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerStatus: input.providerStatus,
        status: input.status,
        inquiry: input.inquiry,
        rapidDisputeResolution: input.rapidDisputeResolution,
        reason: input.reason,
        reasonCode: input.reasonCode,
        evidenceDueAt: input.evidenceDueAt,
        evidenceSubmittedAt: input.evidenceSubmittedAt,
        openedAt: input.openedAt,
        providerUpdatedAt: input.providerUpdatedAt,
        resolvedAt: resolved ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: [paymentDisputes.provider, paymentDisputes.whopDisputeId],
        set: {
          providerStatus: input.providerStatus,
          status: input.status,
          amountMinor: input.amountMinor,
          currency: input.currency,
          inquiry: input.inquiry,
          rapidDisputeResolution: input.rapidDisputeResolution,
          reason: input.reason,
          reasonCode: input.reasonCode,
          evidenceDueAt: input.evidenceDueAt,
          evidenceSubmittedAt: input.evidenceSubmittedAt,
          // FILL ONCE, NEVER REPLACE: when a dispute was opened is decided by
          // the first record of it, and a later delivery must not move it.
          //
          // The date is passed as an ISO STRING with an explicit cast, not as
          // a `Date`. postgres.js serialises a bound `Date` fine as an ordinary
          // insert value, but a `Date` interpolated into a raw `sql` template
          // reaches the driver as an object it will not stringify, and the
          // whole statement fails with "The string argument must be of type
          // string ... Received an instance of Date".
          openedAt: sql`coalesce(${paymentDisputes.openedAt}, ${
            input.openedAt === null ? null : input.openedAt.toISOString()
          }::timestamptz)`,
          providerUpdatedAt: input.providerUpdatedAt,
          orderId: sql`coalesce(${paymentDisputes.orderId}, ${input.orderId})`,
          resolvedAt: resolved
            ? sql`coalesce(${paymentDisputes.resolvedAt}, now())`
            : sql`${paymentDisputes.resolvedAt}`,
          updatedAt: sql`now()`,
        },
        setWhere: and(
          sql`${paymentDisputes.status} not in ('won', 'lost', 'closed')`,
          eq(paymentDisputes.whopPaymentId, input.whopPaymentId),
        ),
      })
      .returning();

    if (updated.length === 1) {
      return { ok: true, dispute: updated[0] as PaymentDispute, unchanged: false };
    }

    const existing = await getDisputeByProviderId(input.whopDisputeId);
    if (!existing) return { ok: false, reason: "storage_error" };
    if (existing.whopPaymentId !== input.whopPaymentId) {
      return { ok: false, reason: "payment_conflict" };
    }
    return { ok: true, dispute: existing, unchanged: true };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getDisputeByProviderId(
  whopDisputeId: string,
): Promise<PaymentDispute | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(paymentDisputes)
    .where(
      and(
        eq(paymentDisputes.provider, PROVIDER),
        eq(paymentDisputes.whopDisputeId, whopDisputeId),
      ),
    );
  return (row as PaymentDispute | undefined) ?? null;
}

export async function listDisputesForPaymentLocal(
  whopPaymentId: string,
): Promise<PaymentDispute[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentDisputes)
    .where(eq(paymentDisputes.whopPaymentId, whopPaymentId))
    .orderBy(asc(paymentDisputes.createdAt));
  return rows as PaymentDispute[];
}

export async function listAllDisputes(limit = 500): Promise<PaymentDispute[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentDisputes)
    .orderBy(asc(paymentDisputes.createdAt))
    .limit(limit);
  return rows as PaymentDispute[];
}

/* -------------------------------------------------------------------------
   DISPUTE ALERTS
   ------------------------------------------------------------------------- */

export type StoredAlert = {
  alertId: string;
  provider: string;
  whopAlertId: string;
  whopPaymentId: string | null;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  alertType: string;
  status: DisputeAlertStatus;
  notActionableReason: string | null;
  feeCharged: boolean;
  reportedAt: Date | null;
  providerUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordAlertInput = Omit<
  StoredAlert,
  "alertId" | "provider" | "createdAt" | "updatedAt"
>;

/**
 * Records or advances ONE alert.
 *
 * NO ABSORBING GUARD, and that is deliberate rather than an omission. An
 * alert has no terminal financial state to protect: `actionable` flipping to
 * `not_actionable` is the normal, expected direction (the payment got refunded
 * or disputed), and the reverse cannot happen at the provider. There is
 * nothing here a stale event could corrupt, because nothing here decides
 * money — see the module header on why an alert never posts.
 *
 * The PAYMENT link is still fill-once-never-replace: an alert that starts
 * unmatched and is later matched should gain its payment, and one already
 * matched must not have it swapped.
 */
export async function recordAlert(
  input: RecordAlertInput,
): Promise<{ ok: true; alert: StoredAlert } | { ok: false; reason: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  try {
    const [row] = await db
      .insert(disputeAlerts)
      .values({ provider: PROVIDER, ...input })
      .onConflictDoUpdate({
        target: [disputeAlerts.provider, disputeAlerts.whopAlertId],
        set: {
          status: input.status,
          notActionableReason: input.notActionableReason,
          feeCharged: input.feeCharged,
          amountMinor: input.amountMinor,
          currency: input.currency,
          alertType: input.alertType,
          providerUpdatedAt: input.providerUpdatedAt,
          whopPaymentId: sql`coalesce(${disputeAlerts.whopPaymentId}, ${input.whopPaymentId})`,
          orderId: sql`coalesce(${disputeAlerts.orderId}, ${input.orderId})`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return { ok: true, alert: row as StoredAlert };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getAlertByProviderId(whopAlertId: string): Promise<StoredAlert | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(disputeAlerts)
    .where(
      and(eq(disputeAlerts.provider, PROVIDER), eq(disputeAlerts.whopAlertId, whopAlertId)),
    );
  return (row as StoredAlert | undefined) ?? null;
}

export async function listAllAlerts(limit = 500): Promise<StoredAlert[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(disputeAlerts)
    .orderBy(asc(disputeAlerts.createdAt))
    .limit(limit);
  return rows as StoredAlert[];
}

/* -------------------------------------------------------------------------
   RESOLUTION CENTER CASES
   ------------------------------------------------------------------------- */

export type StoredCase = {
  caseId: string;
  provider: string;
  whopCaseId: string;
  whopPaymentId: string | null;
  orderId: string | null;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  providerStatus: string;
  status: CaseStatus;
  outcome: string | null;
  refundSource: string | null;
  reason: string | null;
  escalated: boolean;
  providerUpdatedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordCaseInput = Omit<
  StoredCase,
  "caseId" | "provider" | "createdAt" | "updatedAt" | "closedAt"
>;

/**
 * Records or advances ONE Resolution Center case.
 *
 * `closed` ABSORBS, for the same out-of-order reason a dispute's resolution
 * does: a `resolution_center_case.updated` carrying an earlier
 * `awaiting_merchant` snapshot can arrive after the `.decided` that closed it,
 * and reopening a settled case would put it back in a queue nobody needs to
 * work.
 */
export async function recordCase(
  input: RecordCaseInput,
): Promise<{ ok: true; case: StoredCase; unchanged: boolean } | { ok: false; reason: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const closed = input.status === "closed";

  try {
    const updated = await db
      .insert(resolutionCenterCases)
      .values({ provider: PROVIDER, ...input, closedAt: closed ? sql`now()` : null })
      .onConflictDoUpdate({
        target: [resolutionCenterCases.provider, resolutionCenterCases.whopCaseId],
        set: {
          providerStatus: input.providerStatus,
          status: input.status,
          outcome: input.outcome,
          refundSource: input.refundSource,
          reason: input.reason,
          escalated: input.escalated,
          amountMinor: input.amountMinor,
          currency: input.currency,
          providerUpdatedAt: input.providerUpdatedAt,
          whopPaymentId: sql`coalesce(${resolutionCenterCases.whopPaymentId}, ${input.whopPaymentId})`,
          orderId: sql`coalesce(${resolutionCenterCases.orderId}, ${input.orderId})`,
          closedAt: closed
            ? sql`coalesce(${resolutionCenterCases.closedAt}, now())`
            : sql`${resolutionCenterCases.closedAt}`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${resolutionCenterCases.status} <> 'closed'`,
      })
      .returning();

    if (updated.length === 1) {
      return { ok: true, case: updated[0] as StoredCase, unchanged: false };
    }
    const existing = await getCaseByProviderId(input.whopCaseId);
    if (!existing) return { ok: false, reason: "storage_error" };
    return { ok: true, case: existing, unchanged: true };
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

export async function getCaseByProviderId(whopCaseId: string): Promise<StoredCase | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(resolutionCenterCases)
    .where(
      and(
        eq(resolutionCenterCases.provider, PROVIDER),
        eq(resolutionCenterCases.whopCaseId, whopCaseId),
      ),
    );
  return (row as StoredCase | undefined) ?? null;
}

export async function listAllCases(limit = 500): Promise<StoredCase[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(resolutionCenterCases)
    .orderBy(asc(resolutionCenterCases.createdAt))
    .limit(limit);
  return rows as StoredCase[];
}
