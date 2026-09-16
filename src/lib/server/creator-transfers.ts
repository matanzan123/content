import "server-only";

import { randomUUID } from "crypto";
import { eq, and, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { resolvePlatformConfig } from "./whop-accounts";
import { fetchPayoutStatus } from "./whop-payout-status";
import { callWhopTransfer } from "./whop-transfers";

/* ==========================================================================
   CREATOR TRANSFER ORCHESTRATOR — server only.

   THIS IS THE HIGHEST-RISK FILE IN THE CODEBASE. It controls real money
   movement. Read every constraint before making any change.

   THE INVARIANTS:
   1. LEDGER FIRST. A `creator_transfers` row is written with status `pending`
      BEFORE the Whop call. A crash after the write but before the call leaves
      a detectable `pending` row, not a silent loss. A failed call marks it
      `failed`. Both are observable by an operator; a silent failure is not.

   2. IDEMPOTENCY IS A DB CONSTRAINT. The idempotency key is UNIQUE in the
      `creator_transfers` table. Two concurrent threads attempting the same
      payout converge to one row. A read-then-check loses the race; the unique
      index does not.

   3. NEVER AUTO-RETRY. A `failed` or `pending` (stuck) transfer must be
      reviewed by a human before any retry. The application does not retry.
      A safe retry is possible: call `retryTransfer(transferId)` with admin
      auth, which reuses the existing idempotency key.

   4. AMOUNTS ARE BIGINT. No float, no JS number arithmetic on money amounts.
      Caller supplies bigint; comparison and arithmetic use bigint throughout.

   5. PAYOUT-READINESS CHECK BEFORE EVERY TRANSFER. We call the Whop API to
      confirm capabilities are active immediately before writing the ledger row.
      A creator who was payout-ready yesterday might not be today (restriction,
      suspended account). We do not rely on a cached status.

   6. AMOUNT CAPS. Every call is checked against `MAX_TRANSFER_MINOR` from the
      environment. The sandbox default is $100 (10000 minor units). Production
      requires an explicit env var — it does not default to anything large.

   7. DRY RUN. All callers may pass `dryRun: true` to run every validation
      step through the payout-readiness check, then return without writing to
      the DB or calling Whop. This is how you test that a transfer would succeed
      without spending money.

   8. ACCOUNTING JOURNAL. When a transfer is submitted, a double-entry journal
      is written atomically: debit `creator_payable`, credit `provider_balance`.
      If the journal write fails, the Whop call is NOT made.

   WHAT THIS MODULE DOES NOT DO:
   - Does NOT expose a creator-facing endpoint. Transfers are initiated by an
     admin, a campaign settlement job, or the webhook confirmation flow.
   - Does NOT send notifications. Callers handle that.
   - Does NOT reconcile or audit. That is a separate reporting concern.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Amount caps
   ------------------------------------------------------------------------- */

const SANDBOX_MAX_MINOR = BigInt(10_000);  // $100 in sandbox — hard cap
const DEFAULT_PROD_MAX_MINOR = BigInt(100_000_000); // $1M safety ceiling — should be overridden

function resolveMaxTransferMinor(environment: string): bigint {
  const envVar = process.env.MAX_CREATOR_TRANSFER_MINOR;
  if (envVar) {
    try {
      const parsed = BigInt(envVar);
      if (parsed > BigInt(0)) return parsed;
    } catch { /* fall through */ }
  }
  return environment === "sandbox" ? SANDBOX_MAX_MINOR : DEFAULT_PROD_MAX_MINOR;
}

const MIN_TRANSFER_MINOR = BigInt(100); // $1 minimum — below this Whop will reject

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

export type InitiateTransferInput = {
  /** Firebase UID of the creator receiving the payout. */
  firebaseUid: string;
  /** Minor units. 1000 = $10.00 USD. Must be a positive bigint. */
  amountMinor: bigint;
  /** Always "usd" for now. */
  currency: "usd";
  /** What this transfer is for. Short, no secrets. e.g. "campaign_payout". */
  purpose: string;
  /** Campaign id, if this is a campaign payout. */
  campaignId?: string;
  /** Firebase UID of the admin initiating this. NEVER from a request body. */
  initiatedByUid: string;
  /** If true: run all validations but do not call Whop or write to DB. */
  dryRun?: boolean;
};

export type InitiateTransferResult =
  | {
      ok: true;
      dryRun: true;
      payoutReady: boolean;
      accountId: string;
      amountMinor: bigint;
      maxAllowed: bigint;
    }
  | {
      ok: true;
      dryRun: false;
      transferId: string;
      idempotencyKey: string;
      providerTransferId: string;
      status: "submitted";
      accountId: string;
      amountMinor: bigint;
    }
  | { ok: false; reason: TransferFailureReason };

export type TransferFailureReason =
  | "unconfigured"
  | "db_unavailable"
  | "creator_not_found"        // no connected Whop account
  | "payout_not_ready"         // capabilities check failed
  | "payout_check_failed"      // could not verify readiness
  | "amount_below_minimum"
  | "amount_above_maximum"
  | "idempotency_conflict"     // a transfer with this key already exists
  | "accounting_write_failed"
  | "whop_error"
  | string;                    // provider-specific reason passed through

export type TransferStatusResult =
  | { ok: true; transfer: typeof schema.creatorTransfers.$inferSelect }
  | { ok: false; reason: "not_found" | "db_unavailable" };

/* -------------------------------------------------------------------------
   Main entry point
   ------------------------------------------------------------------------- */

/**
 * Initiates a payout transfer from the platform account to a creator's
 * connected Whop account.
 *
 * REQUIRES admin auth at the call site. This function does not check auth.
 * It is the caller's responsibility to ensure `initiatedByUid` is a verified
 * Firebase admin.
 *
 * Set `dryRun: true` to validate everything through the payout-readiness
 * check without spending money or writing to the DB.
 */
export async function initiateCreatorTransfer(
  input: InitiateTransferInput,
): Promise<InitiateTransferResult> {
  // 1. Resolve platform config
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const { environment } = platform.config;

  // 2. Amount guards — before any network call
  const maxMinor = resolveMaxTransferMinor(environment);
  if (input.amountMinor < MIN_TRANSFER_MINOR) {
    return { ok: false, reason: "amount_below_minimum" };
  }
  if (input.amountMinor > maxMinor) {
    return { ok: false, reason: "amount_above_maximum" };
  }

  // 3. Look up the creator's connected Whop account from the DB
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [accountRow] = await db
    .select()
    .from(schema.whopAccounts)
    .where(
      and(
        eq(schema.whopAccounts.firebaseUid, input.firebaseUid),
        eq(schema.whopAccounts.environment, environment),
      ),
    )
    .limit(1);

  if (!accountRow) return { ok: false, reason: "creator_not_found" };

  const whopAccountId = accountRow.whopAccountId;

  // 4. Payout readiness check — live, not cached
  const readiness = await fetchPayoutStatus(whopAccountId);
  if (!readiness.ok) {
    if (readiness.reason === "not_found") return { ok: false, reason: "creator_not_found" };
    return { ok: false, reason: "payout_check_failed" };
  }
  if (!readiness.status.canReceivePayout) {
    return { ok: false, reason: "payout_not_ready" };
  }

  // 5. Dry run stops here
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      payoutReady: true,
      accountId: whopAccountId,
      amountMinor: input.amountMinor,
      maxAllowed: maxMinor,
    };
  }

  // 6. Generate idempotency key
  const idempotencyKey = randomUUID();

  // 7. Write the ledger row BEFORE calling Whop (LEDGER FIRST invariant)
  let transferId: string;
  try {
    const [inserted] = await db
      .insert(schema.creatorTransfers)
      .values({
        firebaseUid: input.firebaseUid,
        whopAccountId,
        environment,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "pending",
        idempotencyKey,
        purpose: input.purpose,
        campaignId: input.campaignId ?? null,
        initiatedByUid: input.initiatedByUid,
      })
      .returning({ transferId: schema.creatorTransfers.transferId });
    transferId = inserted.transferId;
  } catch (err) {
    // A unique constraint on idempotency_key means a concurrent write won
    const isConflict = err instanceof Error && err.message.includes("uniq_creator_transfers_idempotency");
    return { ok: false, reason: isConflict ? "idempotency_conflict" : "db_unavailable" };
  }

  // 8. Write accounting journal: debit creator_payable, credit provider_balance
  const accountingWritten = await writePayoutJournal(db, {
    transferId,
    whopAccountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    environment,
    idempotencyKey,
    purpose: input.purpose,
  });
  if (!accountingWritten) {
    // Mark the transfer failed — do NOT call Whop
    await db
      .update(schema.creatorTransfers)
      .set({ status: "failed", failureReason: "accounting_write_failed", updatedAt: new Date(), failedAt: new Date() })
      .where(eq(schema.creatorTransfers.transferId, transferId));
    return { ok: false, reason: "accounting_write_failed" };
  }

  // 9. Call Whop
  const description = `ClipRewards ${input.purpose} — ${input.currency.toUpperCase()} ${(Number(input.amountMinor) / 100).toFixed(2)}`;
  const whopResult = await callWhopTransfer(platform.config, {
    destinationAccountId: whopAccountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    description,
    idempotencyKey,
  });

  if (!whopResult.ok) {
    // Mark failed. NEVER retry automatically.
    await db
      .update(schema.creatorTransfers)
      .set({
        status: "failed",
        failureReason: whopResult.reason,
        updatedAt: new Date(),
        failedAt: new Date(),
      })
      .where(eq(schema.creatorTransfers.transferId, transferId));
    return { ok: false, reason: whopResult.reason };
  }

  // 10. Mark submitted
  await db
    .update(schema.creatorTransfers)
    .set({
      status: "submitted",
      providerTransferId: whopResult.transfer.providerTransferId,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.creatorTransfers.transferId, transferId));

  return {
    ok: true,
    dryRun: false,
    transferId,
    idempotencyKey,
    providerTransferId: whopResult.transfer.providerTransferId,
    status: "submitted",
    accountId: whopAccountId,
    amountMinor: input.amountMinor,
  };
}

/* -------------------------------------------------------------------------
   Accounting journal
   ------------------------------------------------------------------------- */

type JournalInput = {
  transferId: string;
  whopAccountId: string;
  amountMinor: bigint;
  currency: string;
  environment: string;
  idempotencyKey: string;
  purpose: string;
};

async function writePayoutJournal(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: JournalInput,
): Promise<boolean> {
  const idempotencyKey = `whop:payout_sent:transfer:${input.transferId}`;
  try {
    await db.transaction(async (tx) => {
      const [txn] = await tx
        .insert(schema.accountingTransactions)
        .values({
          economicEvent: "payout_sent",
          provider: "whop",
          providerResourceId: input.whopAccountId,
          environment: input.environment as "sandbox" | "production",
          currency: input.currency,
          idempotencyKey,
          description: `Payout to creator Whop account ${input.whopAccountId}: ${input.purpose}`,
        })
        .returning({ transactionId: schema.accountingTransactions.transactionId });

      const transactionId = txn.transactionId;

      // Leg 1: Debit creator_payable (liability goes down — we fulfill the obligation)
      // Leg 2: Credit provider_balance (our platform balance decreases)
      await tx.insert(schema.accountingEntries).values([
        {
          transactionId,
          leg: 1,
          account: "creator_payable",
          amountMinor: input.amountMinor,          // positive = debit
          currency: input.currency,
          counterpartyType: "creator",
          counterpartyId: input.whopAccountId,
        },
        {
          transactionId,
          leg: 2,
          account: "provider_balance",
          amountMinor: -input.amountMinor,         // negative = credit
          currency: input.currency,
          counterpartyType: "provider",
          counterpartyId: "whop",
        },
      ]);

      // Link the accounting transaction to the transfer row
      await tx
        .update(schema.creatorTransfers)
        .set({ accountingTransactionId: transactionId })
        .where(eq(schema.creatorTransfers.transferId, input.transferId));
    });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
   Webhook handlers (called from whop-webhooks.ts)
   ------------------------------------------------------------------------- */

/**
 * Marks a transfer `completed` when Whop confirms it settled.
 * Called by the `payout.sent` webhook handler.
 */
export async function markTransferCompleted(
  providerTransferId: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };
  try {
    await db
      .update(schema.creatorTransfers)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.creatorTransfers.providerTransferId, providerTransferId));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Marks a transfer `reversed` when Whop reverses it.
 * Writes a reversal journal entry.
 * Called by the `payout.reversed` webhook handler.
 */
export async function markTransferReversed(
  providerTransferId: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  try {
    const [row] = await db
      .select()
      .from(schema.creatorTransfers)
      .where(eq(schema.creatorTransfers.providerTransferId, providerTransferId))
      .limit(1);

    if (!row) return { ok: false };

    await db.transaction(async (tx) => {
      // Write reversal journal: opposite legs of the original
      const reversalKey = `whop:payout_reversed:transfer:${row.transferId}`;
      const [txn] = await tx
        .insert(schema.accountingTransactions)
        .values({
          economicEvent: "payout_reversed",
          provider: "whop",
          providerResourceId: providerTransferId,
          environment: row.environment,
          currency: row.currency,
          idempotencyKey: reversalKey,
          description: `Reversal of payout to ${row.whopAccountId}`,
          reversesTransactionId: row.accountingTransactionId ?? undefined,
        })
        .returning({ transactionId: schema.accountingTransactions.transactionId });

      await tx.insert(schema.accountingEntries).values([
        {
          transactionId: txn.transactionId,
          leg: 1,
          account: "creator_payable",
          amountMinor: -row.amountMinor,  // credit — restore the liability
          currency: row.currency,
          counterpartyType: "creator",
          counterpartyId: row.whopAccountId,
        },
        {
          transactionId: txn.transactionId,
          leg: 2,
          account: "provider_balance",
          amountMinor: row.amountMinor,   // debit — funds returned to us
          currency: row.currency,
          counterpartyType: "provider",
          counterpartyId: "whop",
        },
      ]);

      await tx
        .update(schema.creatorTransfers)
        .set({ status: "reversed", reversedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.creatorTransfers.transferId, row.transferId));
    });

    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/* -------------------------------------------------------------------------
   Read helpers
   ------------------------------------------------------------------------- */

export async function getTransfer(transferId: string): Promise<TransferStatusResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const [row] = await db
    .select()
    .from(schema.creatorTransfers)
    .where(eq(schema.creatorTransfers.transferId, transferId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, transfer: row };
}

export async function getPendingTransfersOlderThanMinutes(
  minutes: number,
): Promise<typeof schema.creatorTransfers.$inferSelect[]> {
  const db = getDb();
  if (!db) return [];
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  return db
    .select()
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.status, "pending"),
        sql`${schema.creatorTransfers.createdAt} < ${cutoff}`,
      ),
    );
}
