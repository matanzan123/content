import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { accountingEntries, accountingTransactions } from "@/lib/db/schema";
import { normaliseCurrency } from "../money";
import {
  ACCOUNTS,
  isLedgerAccount,
  isPostable,
  type EconomicEvent,
  type LedgerAccount,
} from "./accounts";

/* ==========================================================================
   THE JOURNAL — the only way money is written down.

   Nothing else in this codebase inserts into `accounting_transactions` or
   `accounting_entries`, and there is NO update path and NO delete path in
   this module. That is the append-only guarantee, and it is a guarantee about
   the API surface: `postTransaction` and `reverseTransaction` are the two
   exported writers, both insert-only.

   THE FOUR RULES A POSTING MUST SATISFY, all checked before any row is
   written and the last of them re-checked by the database at COMMIT:

     1. at least two legs, because one leg cannot balance
     2. every leg is an integer number of minor units, never zero
     3. one currency across the whole transaction
     4. the legs sum to EXACTLY zero

   Rule 4 exists twice on purpose. Here it catches a bad posting with a clear
   error; the DEFERRABLE constraint trigger in migration 0004 catches anything
   that reaches the database by another route, including a future code path
   nobody remembered to run through this function.

   NOTHING IS PLUGGED. If a posting does not balance, it is refused. A journal
   that balances itself by inventing a rounding leg reports numbers nobody can
   trace, which is worse than a posting that fails loudly.
   ========================================================================== */

/** One leg, as a caller supplies it. Signed: debit positive, credit negative. */
export type JournalLeg = {
  account: LedgerAccount;
  /** Signed minor units. Never zero. */
  amountMinor: bigint;
  counterpartyType?: string | null;
  counterpartyId?: string | null;
  /** The provider's own name for this line, when there is one. */
  sourceDetail?: string | null;
};

export type PostingInput = {
  economicEvent: EconomicEvent;
  /** "whop", or "internal" for a correction we originated. */
  provider: string;
  providerResourceId?: string | null;
  environment: "sandbox" | "production";
  currency: string;
  /** Built by `economicKey`. Must describe the EVENT, not the delivery. */
  idempotencyKey: string;
  orderId?: string | null;
  /** Evidence only. Never used to deduplicate. */
  sourceWebhookId?: string | null;
  description?: string | null;
  occurredAt?: Date | null;
  metadata?: Record<string, string | number | boolean | null> | null;
  legs: JournalLeg[];
};

export type PostingResult =
  | { ok: true; transactionId: string; alreadyPosted: boolean }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "invalid_currency"
        | "invalid_account"
        | "account_not_postable"
        | "invalid_amount"
        | "too_few_legs"
        | "unbalanced"
        | "invalid_idempotency_key"
        | "storage_error";
      detail?: string;
    };

const MAX_LEGS = 64;

/**
 * Validates a posting without touching the database.
 *
 * Exported so the rules can be tested directly, and so a caller that is
 * building a posting from provider data can find out it does not balance
 * before it opens a transaction.
 */
export type ValidationFailure = Exclude<
  Extract<PostingResult, { ok: false }>["reason"],
  "unconfigured" | "storage_error"
>;

export function validatePosting(
  input: PostingInput,
): { ok: true; currency: string } | { ok: false; reason: ValidationFailure; detail?: string } {
  const currency = normaliseCurrency(input.currency);
  if (!currency) return { ok: false, reason: "invalid_currency", detail: String(input.currency) };

  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length < 8) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }

  if (!Array.isArray(input.legs) || input.legs.length < 2) {
    return { ok: false, reason: "too_few_legs" };
  }
  if (input.legs.length > MAX_LEGS) {
    return { ok: false, reason: "too_few_legs", detail: "too many legs" };
  }

  let sum = BigInt(0);
  for (const leg of input.legs) {
    if (!isLedgerAccount(leg.account)) {
      return { ok: false, reason: "invalid_account", detail: String(leg.account) };
    }
    // The gate that keeps a future change from booking platform revenue or a
    // creator liability before anyone has decided what those amounts are.
    if (!isPostable(leg.account)) {
      return { ok: false, reason: "account_not_postable", detail: leg.account };
    }
    if (typeof leg.amountMinor !== "bigint" || leg.amountMinor === BigInt(0)) {
      return { ok: false, reason: "invalid_amount", detail: leg.account };
    }
    sum += leg.amountMinor;
  }

  if (sum !== BigInt(0)) {
    return { ok: false, reason: "unbalanced", detail: sum.toString() };
  }

  return { ok: true, currency };
}

/**
 * POSTS ONE ECONOMIC EVENT, atomically and idempotently.
 *
 * The header and every leg are written inside ONE database transaction, so a
 * crash between them leaves nothing at all — there is no state in which a
 * transaction exists with half its legs, and therefore no state in which the
 * ledger is out of balance.
 *
 * IDEMPOTENCY IS THE UNIQUE INDEX, not a read. The insert is
 * `on conflict (idempotency_key) do nothing … returning`: if it returns a row
 * this caller won, and if it returns nothing another caller already posted the
 * same economic event and we report `alreadyPosted` with the id it won with.
 * Two concurrent deliveries therefore produce exactly one posting and two
 * successful, identical answers. A `select` followed by an `insert` could not
 * do this — both callers would see nothing and both would insert.
 *
 * A retry after a crash converges the same way: either the transaction never
 * committed and the retry posts it, or it did and the retry finds the key
 * taken.
 */
export async function postTransaction(input: PostingInput): Promise<PostingResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const validated = validatePosting(input);
  if (!validated.ok) return { ok: false, reason: validated.reason, detail: validated.detail };
  const currency = validated.currency;

  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(accountingTransactions)
        .values({
          economicEvent: input.economicEvent,
          provider: input.provider,
          providerResourceId: input.providerResourceId ?? null,
          environment: input.environment,
          currency,
          idempotencyKey: input.idempotencyKey,
          orderId: input.orderId ?? null,
          sourceWebhookId: input.sourceWebhookId ?? null,
          description: input.description ?? null,
          occurredAt: input.occurredAt ?? null,
          metadata: input.metadata ?? null,
          postedAt: sql`now()`,
        })
        .onConflictDoNothing({ target: accountingTransactions.idempotencyKey })
        .returning({ transactionId: accountingTransactions.transactionId });

      if (inserted.length === 0) {
        // Someone else posted this exact economic event. Report theirs.
        const [existing] = await tx
          .select({ transactionId: accountingTransactions.transactionId })
          .from(accountingTransactions)
          .where(eq(accountingTransactions.idempotencyKey, input.idempotencyKey));
        if (!existing) throw new Error("idempotency conflict with no row");
        return { ok: true, transactionId: existing.transactionId, alreadyPosted: true };
      }

      const transactionId = inserted[0].transactionId;

      await tx.insert(accountingEntries).values(
        input.legs.map((leg, i) => ({
          transactionId,
          leg: i + 1,
          account: leg.account,
          amountMinor: leg.amountMinor,
          currency,
          counterpartyType: leg.counterpartyType ?? null,
          counterpartyId: leg.counterpartyId ?? null,
          sourceDetail: leg.sourceDetail ?? null,
          createdAt: sql`now()`,
        })),
      );

      return { ok: true, transactionId, alreadyPosted: false };
    });
  } catch (error) {
    // The deferred balance trigger raises at COMMIT; surface it as what it is
    // rather than as a generic storage failure.
    const message = error instanceof Error ? error.message : "";
    if (/does not balance|unbalanced/i.test(message)) {
      return { ok: false, reason: "unbalanced", detail: "rejected by database" };
    }
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   REVERSAL
   ------------------------------------------------------------------------- */

export type ReversalResult =
  | { ok: true; transactionId: string; alreadyReversed: boolean }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "original_not_found"
        | "original_is_a_reversal"
        | "no_entries"
        | "storage_error";
    };

/**
 * REVERSES A TRANSACTION IN FULL, by posting its exact opposite.
 *
 * The original is never touched. Nothing is updated, nothing is deleted, and
 * the original's legs stay readable forever — what changes is that a second
 * transaction now carries the same legs with the sign flipped, so the two
 * together have no net effect on any account. That is what makes the history
 * reconstructible: the ledger says both that the money moved and that it was
 * put back, and when each happened.
 *
 * IDEMPOTENT AND SINGLE-SHOT, enforced twice by the database:
 *   - `uniq_accounting_reversal` allows at most one reversal per original, so
 *     a second attempt cannot double the correction even under a race;
 *   - the reversal's own idempotency key is derived from the original's id, so
 *     a retry of the same reversal converges on the same row.
 *
 * PARTIAL REVERSALS ARE DELIBERATELY NOT THIS FUNCTION. A partial refund is
 * not a retraction of the settlement — the settlement really happened — so it
 * is posted as its own `payment_refunded` transaction keyed on the refund's
 * own provider id, using `postTransaction` directly. The architecture is
 * already in place for it; only the posting rule is missing, and that rule
 * needs the refund-loss allocation decision.
 */
export async function reverseTransaction(
  originalTransactionId: string,
  options: { reason: string; sourceWebhookId?: string | null },
): Promise<ReversalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  try {
    return await db.transaction(async (tx) => {
      const [original] = await tx
        .select()
        .from(accountingTransactions)
        .where(eq(accountingTransactions.transactionId, originalTransactionId));

      if (!original) return { ok: false, reason: "original_not_found" } as ReversalResult;
      // Reversing a reversal would be a re-posting of the original by a name
      // that hides what it is. Post a fresh correction instead.
      if (original.reversesTransactionId !== null) {
        return { ok: false, reason: "original_is_a_reversal" } as ReversalResult;
      }

      const legs = await tx
        .select()
        .from(accountingEntries)
        .where(eq(accountingEntries.transactionId, originalTransactionId))
        .orderBy(asc(accountingEntries.leg));

      if (legs.length === 0) return { ok: false, reason: "no_entries" } as ReversalResult;

      const idempotencyKey = `internal:reversal:${originalTransactionId}`;

      const inserted = await tx
        .insert(accountingTransactions)
        .values({
          economicEvent: "reversal",
          provider: "internal",
          providerResourceId: original.providerResourceId,
          environment: original.environment,
          currency: original.currency,
          idempotencyKey,
          orderId: original.orderId,
          reversesTransactionId: originalTransactionId,
          sourceWebhookId: options.sourceWebhookId ?? null,
          description: options.reason.slice(0, 200),
          postedAt: sql`now()`,
        })
        .onConflictDoNothing({ target: accountingTransactions.idempotencyKey })
        .returning({ transactionId: accountingTransactions.transactionId });

      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ transactionId: accountingTransactions.transactionId })
          .from(accountingTransactions)
          .where(eq(accountingTransactions.idempotencyKey, idempotencyKey));
        if (!existing) throw new Error("reversal conflict with no row");
        return { ok: true, transactionId: existing.transactionId, alreadyReversed: true };
      }

      const transactionId = inserted[0].transactionId;

      // Same legs, opposite signs. Because the original balanced, this does
      // too — a reversal cannot be the thing that unbalances the ledger.
      await tx.insert(accountingEntries).values(
        legs.map((leg, i) => ({
          transactionId,
          leg: i + 1,
          account: leg.account,
          amountMinor: -leg.amountMinor,
          currency: leg.currency,
          counterpartyType: leg.counterpartyType,
          counterpartyId: leg.counterpartyId,
          sourceDetail: leg.sourceDetail,
          createdAt: sql`now()`,
        })),
      );

      return { ok: true, transactionId, alreadyReversed: false };
    });
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

/* -------------------------------------------------------------------------
   READING
   ------------------------------------------------------------------------- */

export type AccountBalance = {
  account: LedgerAccount;
  currency: string;
  /** Signed minor units, as a string so no JS number can round it. */
  balanceMinor: string;
  entryCount: number;
};

/**
 * Balances per account, ALWAYS GROUPED BY CURRENCY.
 *
 * There is no variant of this that returns a single total. Two currencies
 * cannot be added without a rate and a date, and a function that quietly
 * returned one number would be the exact place a wrong figure gets published.
 * A caller that wants one number has to pick a currency, and then it is
 * obvious in the code which one it picked.
 */
export async function getAccountBalances(): Promise<AccountBalance[] | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      account: accountingEntries.account,
      currency: accountingEntries.currency,
      balanceMinor: sql<string>`sum(${accountingEntries.amountMinor})::text`,
      entryCount: sql<number>`count(*)::int`,
    })
    .from(accountingEntries)
    .groupBy(accountingEntries.account, accountingEntries.currency)
    .orderBy(asc(accountingEntries.account), asc(accountingEntries.currency));

  return rows.map((r) => ({
    account: r.account as LedgerAccount,
    currency: r.currency,
    balanceMinor: r.balanceMinor ?? "0",
    entryCount: r.entryCount,
  }));
}

/**
 * The whole-ledger integrity check: every transaction's legs must sum to zero.
 *
 * Returns the offenders, not a boolean. On a healthy ledger it is empty; if it
 * is ever not, the ids are what an operator needs, and nothing here tries to
 * repair them.
 */
export async function findUnbalancedTransactions(): Promise<
  { transactionId: string; residualMinor: string }[] | null
> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      transactionId: accountingEntries.transactionId,
      residualMinor: sql<string>`sum(${accountingEntries.amountMinor})::text`,
    })
    .from(accountingEntries)
    .groupBy(accountingEntries.transactionId)
    .having(sql`sum(${accountingEntries.amountMinor}) <> 0`);

  return rows.map((r) => ({ transactionId: r.transactionId, residualMinor: r.residualMinor }));
}

export async function getTransactionByKey(idempotencyKey: string) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(accountingTransactions)
    .where(eq(accountingTransactions.idempotencyKey, idempotencyKey));
  return row ?? null;
}

export async function getTransactionForOrder(orderId: string, event: EconomicEvent) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.orderId, orderId),
        eq(accountingTransactions.economicEvent, event),
      ),
    );
  return row ?? null;
}

/** Re-exported so a report can label an account without importing two modules. */
export { ACCOUNTS };
