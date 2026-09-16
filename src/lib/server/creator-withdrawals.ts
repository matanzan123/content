import "server-only";

import { and, asc, eq, inArray, not, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { canRelease, type EarningStatus } from "./creator-earnings-policy";
import { fetchPayoutStatus } from "./whop-payout-status";
import { initiateCreatorTransfer } from "./creator-transfers";
import { getConnectedAccount } from "./connected-accounts";
import { resolvePlatformConfig } from "./whop-accounts";

/* ==========================================================================
   CREATOR WITHDRAWALS — lifecycle management for creator-requested payouts.

   WHO DOES WHAT:
     Creator  → calls requestWithdrawal() to ask for a payout
     System   → immediately validates balance and tries to mark eligible
     Admin    → calls processWithdrawal() to trigger the actual Whop transfer
     Webhooks → call markWithdrawalPaid / markWithdrawalFailed / reverseWithdrawal

   PARTIAL WITHDRAWAL:
     Creator specifies amount X (1 ≤ X ≤ available balance).
     We reserve whole earnings FIFO (oldest first) until total_reserved ≥ X.
     If total_reserved > X, the overage is returned as a new `available`
     earning when the withdrawal terminates (paid, failed, or canceled).

   CONCURRENCY PROTECTION:
     1. UNIQUE(firebase_uid) WHERE active — one active withdrawal per creator.
        Prevents double-submission. The DB constraint is the guard; the read
        check above it is for better error messages, not for safety.
     2. UNIQUE(earning_id) in creator_withdrawal_earnings — prevents two
        concurrent requests reserving the same earning.

   INVARIANTS:
     - Reserved earnings status is NOT changed on the creator_earnings table.
       "Reserved" is entirely represented by a row in creator_withdrawal_earnings.
       The earning's own status stays `available` (or `held`-but-releasable).
     - On success: reserved earnings are marked `transferred`.
     - On failure/cancel: reserved rows are deleted; earnings unchanged.
     - Overage earning (reserved_amount > requested_amount): new row inserted
       as `available` when withdrawal terminates.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

export type RequestWithdrawalInput = {
  firebaseUid: string;
  amountMinor: bigint;
  currency?: "usd";
};

export type WithdrawalStatus =
  | "requested"
  | "eligible"
  | "processing"
  | "provider_pending"
  | "paid"
  | "failed"
  | "canceled"
  | "reversed";

export type WithdrawalView = {
  withdrawalId: string;
  amountMinor: bigint;
  reservedAmountMinor: bigint;
  currency: string;
  status: WithdrawalStatus;
  transferId: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  requestedAt: Date;
  paidAt: Date | null;
  failedAt: Date | null;
  canceledAt: Date | null;
};

export type RequestWithdrawalResult =
  | { ok: true; withdrawalId: string; status: WithdrawalStatus }
  | { ok: false; reason:
      | "db_unavailable"
      | "amount_zero"
      | "amount_exceeds_balance"
      | "insufficient_available"
      | "withdrawal_already_pending"
      | "no_earnings_to_reserve"
      | "concurrent_reservation"
      | "platform_unavailable"
    };

export type ProcessWithdrawalResult =
  | { ok: true; transferId: string }
  | { ok: false; reason:
      | "db_unavailable"
      | "not_found"
      | "wrong_status"
      | "payout_not_ready"
      | "transfer_failed"
      | string
    };

/* -------------------------------------------------------------------------
   ACTIVE status helper
   ------------------------------------------------------------------------- */

const ACTIVE_STATUSES: WithdrawalStatus[] = [
  "requested",
  "eligible",
  "processing",
  "provider_pending",
];
const TERMINAL_STATUSES: WithdrawalStatus[] = ["paid", "failed", "canceled", "reversed"];

/* -------------------------------------------------------------------------
   Request a withdrawal
   ------------------------------------------------------------------------- */

/**
 * Creator requests a withdrawal of exactly `amountMinor` from their available
 * balance. Earnings are reserved immediately; if payout account is ready the
 * withdrawal is marked `eligible` for admin processing.
 */
export async function requestWithdrawal(
  input: RequestWithdrawalInput,
): Promise<RequestWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const { firebaseUid, amountMinor } = input;
  const currency = input.currency ?? "usd";

  if (amountMinor <= BigInt(0)) return { ok: false, reason: "amount_zero" };

  // Check for an existing active withdrawal (best-effort; the UNIQUE index is the real guard)
  const [active] = await db
    .select({ withdrawalId: schema.creatorWithdrawals.withdrawalId })
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.firebaseUid, firebaseUid),
        inArray(schema.creatorWithdrawals.status, ACTIVE_STATUSES as [WithdrawalStatus, ...WithdrawalStatus[]]),
      ),
    )
    .limit(1);

  if (active) return { ok: false, reason: "withdrawal_already_pending" };

  // Fetch all available earnings (including held ones that have expired their hold)
  const earningRows = await db
    .select({
      earningId: schema.creatorEarnings.earningId,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      holdUntil: schema.creatorEarnings.holdUntil,
      frozenByDispute: schema.creatorEarnings.frozenByDispute,
      status: schema.creatorEarnings.status,
      createdAt: schema.creatorEarnings.createdAt,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.firebaseUid, firebaseUid),
        eq(schema.creatorEarnings.currency, currency),
        or(
          eq(schema.creatorEarnings.status, "available"),
          eq(schema.creatorEarnings.status, "held"),
        ),
        eq(schema.creatorEarnings.frozenByDispute, false),
      ),
    )
    .orderBy(asc(schema.creatorEarnings.createdAt));

  // Dynamically compute available (held rows past hold_until count)
  const now = new Date();
  const available = earningRows.filter(
    (r) =>
      r.status === "available" ||
      (r.status === "held" && canRelease(r.holdUntil, r.frozenByDispute, now)),
  );

  const totalAvailable = available.reduce(
    (sum, r) => sum + r.netAmountMinor,
    BigInt(0),
  );

  if (totalAvailable === BigInt(0)) return { ok: false, reason: "insufficient_available" };
  if (amountMinor > totalAvailable) return { ok: false, reason: "amount_exceeds_balance" };

  // Pick earnings FIFO until total_reserved ≥ amountMinor
  let runningTotal = BigInt(0);
  const toReserve: typeof available = [];
  for (const row of available) {
    toReserve.push(row);
    runningTotal += row.netAmountMinor;
    if (runningTotal >= amountMinor) break;
  }

  if (toReserve.length === 0) return { ok: false, reason: "no_earnings_to_reserve" };

  const reservedAmountMinor = runningTotal;

  // Create the withdrawal row
  let withdrawalId: string;
  try {
    const [inserted] = await db
      .insert(schema.creatorWithdrawals)
      .values({
        firebaseUid,
        environment: "sandbox", // will be overridden below
        amountMinor,
        reservedAmountMinor,
        currency,
        status: "requested",
        requestedAt: now,
      })
      .returning({ withdrawalId: schema.creatorWithdrawals.withdrawalId });
    withdrawalId = inserted.withdrawalId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("uniq_withdrawal_active_creator")) {
      return { ok: false, reason: "withdrawal_already_pending" };
    }
    return { ok: false, reason: "db_unavailable" };
  }

  // Reserve earnings in the junction table
  try {
    await db.insert(schema.creatorWithdrawalEarnings).values(
      toReserve.map((r) => ({
        withdrawalId,
        earningId: r.earningId,
      })),
    );
  } catch (err) {
    // UNIQUE violation on earning_id means a concurrent request grabbed them
    await db
      .delete(schema.creatorWithdrawals)
      .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("uniq_withdrawal_earning")) {
      return { ok: false, reason: "concurrent_reservation" };
    }
    return { ok: false, reason: "db_unavailable" };
  }

  // Promote held earnings that are dynamically available to `available` in DB
  const heldButReleasable = toReserve
    .filter((r) => r.status === "held")
    .map((r) => r.earningId);
  if (heldButReleasable.length > 0) {
    await db
      .update(schema.creatorEarnings)
      .set({ status: "available", availableAt: now, updatedAt: now })
      .where(inArray(schema.creatorEarnings.earningId, heldButReleasable));
  }

  // Try to mark eligible (requires payout account to be ready)
  const platform = resolvePlatformConfig();
  let finalStatus: WithdrawalStatus = "requested";

  if (platform.ok) {
    // Update the environment now that we know it
    await db
      .update(schema.creatorWithdrawals)
      .set({ environment: platform.config.environment, updatedAt: now })
      .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));

    const account = await getConnectedAccount(firebaseUid, platform.config.environment);
    if (account) {
      const payoutStatus = await fetchPayoutStatus(account.whopAccountId).catch(() => null);
      if (payoutStatus?.ok && payoutStatus.status.canReceivePayout) {
        await db
          .update(schema.creatorWithdrawals)
          .set({ status: "eligible", eligibleAt: now, updatedAt: now })
          .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));
        finalStatus = "eligible";
      }
    }
  }

  return { ok: true, withdrawalId, status: finalStatus };
}

/* -------------------------------------------------------------------------
   Process a withdrawal (admin-only)
   ------------------------------------------------------------------------- */

/**
 * Admin triggers the Whop transfer for an eligible withdrawal.
 * Sets status to `processing`, calls `initiateCreatorTransfer`, then
 * `provider_pending` on success or `failed` on rejection.
 */
export async function processWithdrawal(
  withdrawalId: string,
  adminUid: string,
): Promise<ProcessWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [withdrawal] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId))
    .limit(1);

  if (!withdrawal) return { ok: false, reason: "not_found" };

  // Allow processing from either `eligible` or `requested` (admin override)
  if (
    withdrawal.status !== "eligible" &&
    withdrawal.status !== "requested"
  ) {
    return { ok: false, reason: "wrong_status" };
  }

  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({ status: "processing", processingAt: now, processedByUid: adminUid, updatedAt: now })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));

  const platform = resolvePlatformConfig();
  if (!platform.ok) {
    await markFailedInternal(withdrawalId, "platform_unavailable", db);
    return { ok: false, reason: "platform_unavailable" };
  }

  // Initiate the Whop transfer (resolves connected account internally)
  const transferResult = await initiateCreatorTransfer({
    firebaseUid: withdrawal.firebaseUid,
    amountMinor: withdrawal.amountMinor,
    currency: withdrawal.currency as "usd",
    purpose: `withdrawal:${withdrawalId}`,
    initiatedByUid: adminUid,
    dryRun: false,
  });

  if (!transferResult.ok) {
    await markFailedInternal(withdrawalId, transferResult.reason ?? "transfer_failed", db);
    return { ok: false, reason: transferResult.reason ?? "transfer_failed" };
  }

  // dryRun: false is guaranteed — narrow the type
  if (transferResult.dryRun) {
    await markFailedInternal(withdrawalId, "unexpected_dry_run", db);
    return { ok: false, reason: "unexpected_dry_run" };
  }

  // Transfer submitted — link it and set provider_pending
  await db
    .update(schema.creatorWithdrawals)
    .set({
      status: "provider_pending",
      providerPendingAt: now,
      transferId: transferResult.transferId,
      updatedAt: now,
    })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));

  return { ok: true, transferId: transferResult.transferId };
}

/* -------------------------------------------------------------------------
   Cancel a withdrawal
   ------------------------------------------------------------------------- */

/**
 * Cancels a withdrawal that hasn't reached `provider_pending` yet.
 * Unreserves earnings (deletes junction rows; earnings remain `available`).
 */
export async function cancelWithdrawal(
  withdrawalId: string,
  reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [withdrawal] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId))
    .limit(1);

  if (!withdrawal) return { ok: false, reason: "not_found" };

  const cancellable: WithdrawalStatus[] = ["requested", "eligible"];
  if (!cancellable.includes(withdrawal.status as WithdrawalStatus)) {
    return { ok: false, reason: "wrong_status" };
  }

  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({ status: "canceled", canceledAt: now, cancelReason: reason ?? null, updatedAt: now })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));

  // Return any overage earning if reserved > requested
  await returnOverage(withdrawal, db);

  // Delete junction rows (earnings themselves stay `available`)
  await db
    .delete(schema.creatorWithdrawalEarnings)
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawalId));

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Webhook handlers
   ------------------------------------------------------------------------- */

/** Called when a Whop payout webhook confirms the transfer paid. */
export async function markWithdrawalPaid(transferId: string): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  const [withdrawal] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.transferId, transferId))
    .limit(1);

  if (!withdrawal) return { ok: true }; // no withdrawal for this transfer — ok

  if (withdrawal.status === "paid") return { ok: true }; // idempotent

  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({ status: "paid", paidAt: now, updatedAt: now })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawal.withdrawalId));

  // Mark all reserved earnings as transferred
  const reserved = await db
    .select({ earningId: schema.creatorWithdrawalEarnings.earningId })
    .from(schema.creatorWithdrawalEarnings)
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawal.withdrawalId));

  if (reserved.length > 0) {
    await db
      .update(schema.creatorEarnings)
      .set({ status: "transferred", transferId: transferId, transferredAt: now, updatedAt: now })
      .where(inArray(schema.creatorEarnings.earningId, reserved.map((r) => r.earningId)));
  }

  // Return overage if reserved > requested
  await returnOverage(withdrawal, db);

  return { ok: true };
}

/** Called when a Whop payout webhook signals a failure or reversal. */
export async function markWithdrawalFailed(
  transferId: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  const [withdrawal] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.transferId, transferId))
    .limit(1);

  if (!withdrawal) return { ok: true };
  if (TERMINAL_STATUSES.includes(withdrawal.status as WithdrawalStatus)) return { ok: true };

  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({
      status: "failed",
      failedAt: now,
      failureReason: reason ?? null,
      updatedAt: now,
    })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawal.withdrawalId));

  // Return overage and unreserve
  await returnOverage(withdrawal, db);
  await db
    .delete(schema.creatorWithdrawalEarnings)
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawal.withdrawalId));

  return { ok: true };
}

/** Called when a Whop payout reversal webhook fires after the withdrawal was paid. */
export async function reverseWithdrawal(transferId: string): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };

  const [withdrawal] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.transferId, transferId))
    .limit(1);

  if (!withdrawal) return { ok: true };
  if (withdrawal.status === "reversed") return { ok: true };

  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({ status: "reversed", reversedAt: now, updatedAt: now })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawal.withdrawalId));

  // Mark earnings as reversed (they were transferred but now reversed)
  const reserved = await db
    .select({ earningId: schema.creatorWithdrawalEarnings.earningId })
    .from(schema.creatorWithdrawalEarnings)
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawal.withdrawalId));

  if (reserved.length > 0) {
    await db
      .update(schema.creatorEarnings)
      .set({ status: "reversed", reversedAt: now, updatedAt: now })
      .where(inArray(schema.creatorEarnings.earningId, reserved.map((r) => r.earningId)));
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Query
   ------------------------------------------------------------------------- */

export async function getWithdrawal(withdrawalId: string): Promise<WithdrawalView | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId))
    .limit(1);
  if (!row) return null;
  return toView(row);
}

export async function getActiveWithdrawal(firebaseUid: string): Promise<WithdrawalView | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.firebaseUid, firebaseUid),
        not(inArray(schema.creatorWithdrawals.status, TERMINAL_STATUSES as ["paid", "failed", "canceled", "reversed"])),
      ),
    )
    .limit(1);
  if (!row) return null;
  return toView(row);
}

export async function listWithdrawals(firebaseUid: string): Promise<WithdrawalView[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(eq(schema.creatorWithdrawals.firebaseUid, firebaseUid))
    .orderBy(asc(schema.creatorWithdrawals.createdAt));
  return rows.map(toView);
}

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

function toView(row: typeof schema.creatorWithdrawals.$inferSelect): WithdrawalView {
  return {
    withdrawalId: row.withdrawalId,
    amountMinor: row.amountMinor,
    reservedAmountMinor: row.reservedAmountMinor,
    currency: row.currency,
    status: row.status as WithdrawalStatus,
    transferId: row.transferId ?? null,
    failureReason: row.failureReason ?? null,
    cancelReason: row.cancelReason ?? null,
    requestedAt: row.requestedAt,
    paidAt: row.paidAt ?? null,
    failedAt: row.failedAt ?? null,
    canceledAt: row.canceledAt ?? null,
  };
}

async function markFailedInternal(
  withdrawalId: string,
  reason: string,
  db: ReturnType<typeof getDb>,
) {
  if (!db) return;
  const now = new Date();
  await db
    .update(schema.creatorWithdrawals)
    .set({ status: "failed", failedAt: now, failureReason: reason, updatedAt: now })
    .where(eq(schema.creatorWithdrawals.withdrawalId, withdrawalId));
  await db
    .delete(schema.creatorWithdrawalEarnings)
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawalId));
}

/**
 * If reserved_amount > requested_amount, insert a new `available` earning for
 * the difference so the creator doesn't lose it.
 *
 * This only creates a new earnings row — it does NOT post a journal entry for
 * now (the overage is a bookkeeping adjustment; adding journal support is the
 * next step).
 */
async function returnOverage(
  withdrawal: typeof schema.creatorWithdrawals.$inferSelect,
  db: ReturnType<typeof getDb>,
) {
  if (!db) return;
  const overage = withdrawal.reservedAmountMinor - withdrawal.amountMinor;
  if (overage <= BigInt(0)) return;

  // Find the last reserved earning to copy metadata from
  const [lastEarning] = await db
    .select()
    .from(schema.creatorWithdrawalEarnings)
    .innerJoin(
      schema.creatorEarnings,
      eq(schema.creatorWithdrawalEarnings.earningId, schema.creatorEarnings.earningId),
    )
    .where(eq(schema.creatorWithdrawalEarnings.withdrawalId, withdrawal.withdrawalId))
    .orderBy(asc(schema.creatorEarnings.createdAt))
    .limit(1);

  if (!lastEarning) return;

  const src = lastEarning.creator_earnings;
  const now = new Date();
  await db.insert(schema.creatorEarnings).values({
    firebaseUid: src.firebaseUid,
    environment: src.environment,
    whopPaymentId: `overage:${withdrawal.withdrawalId}`,
    grossAmountMinor: overage,
    platformFeeMinor: BigInt(0),
    netAmountMinor: overage,
    currency: src.currency,
    platformFeeBps: 0,
    status: "available",
    holdUntil: now,
    frozenByDispute: false,
    paymentSettledAt: now,
    availableAt: now,
    description: `Overage returned from withdrawal ${withdrawal.withdrawalId}`,
  }).onConflictDoNothing();
}
