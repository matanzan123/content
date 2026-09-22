import "server-only";

import { eq, and, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { resolvePlatformConfig } from "./whop-accounts";
import { getWhopEnvironment, type WhopEnvironmentName } from "./whop-payments";
import {
  createLedgerTransfer,
  retrieveTransfer,
  type ProviderTransferStatus,
  type TransferResult,
} from "./whop-transfers";
import { reverseTransaction } from "./accounting/journal";

/* ==========================================================================
   CREATOR TRANSFER ORCHESTRATOR — server only.

   THIS IS THE HIGHEST-RISK FILE IN THE CODEBASE. It controls real money
   movement. Read every constraint before making any change.

   THE INVARIANTS:
   1. LEDGER FIRST. A `creator_transfers` row is written with status `pending`
      BEFORE the Whop call. A crash after the write but before the call leaves
      a detectable `pending` row, not a silent loss. A failed call marks it
      `failed`. Both are observable by an operator; a silent failure is not.

   2. IDEMPOTENCY IS A DB CONSTRAINT, AND THE KEY IS STABLE. The caller
      supplies a `requestId` naming ONE intended transfer; it is persisted as
      the UNIQUE `idempotency_key` before the provider is called, and the SAME
      key is sent to Whop as `idempotence_key`. A retried HTTP request
      resolves to the same row and the same provider key rather than paying
      twice. The previous code minted a fresh UUID per ATTEMPT, so the
      provider de-duplication it relied on could never fire.

   3. NEVER AUTO-RETRY. A stuck transfer is reviewed by a human. `retryTransfer`
      exists for that, and reuses the stored key rather than minting one.

   4. AMOUNTS ARE BIGINT MINOR UNITS INTERNALLY, converted to MAJOR units only
      at the provider boundary. Whop's `amount` is "in the transfer currency.
      For example 25.00" — passing minor units straight through, as the old
      code did, would move 100x the intended sum.

   5. AN AMBIGUOUS OUTCOME IS NOT A FAILURE. A timeout or 5xx may mean the
      provider accepted. Such a row stays `pending` with its key intact so a
      retry can reconcile; it is never marked failed and never compensated.
      Compensation happens only on a DEFINITE provider refusal.

   6. AMOUNT CAPS, AND PRODUCTION FAILS CLOSED. Sandbox caps at $100 in code.
      Production requires an explicit `MAX_CREATOR_TRANSFER_MINOR`; without it
      a real transfer is refused rather than inheriting a default nobody chose.

   7. DRY RUN. `dryRun: true` runs every validation and returns without writing
      to the DB or calling Whop, reporting whether a real run could proceed.

   8. NO EXTERNAL PAYOUT-READINESS GATE. This creates a `ledger` transfer —
      credit between two Whop balances. The installed SDK does not require the
      recipient to hold a bank or crypto destination to RECEIVE one; that is
      what they need to withdraw it onward (Task #11). The old gate conflated
      the two and blocked transfers the provider would have accepted.

   9. ACCOUNTING JOURNAL, LEDGER FIRST. Debit `creator_payable`, credit
      `provider_balance`, posted BEFORE the provider call. If the journal fails,
      Whop is never called. A definitive provider refusal compensates through
      the canonical `reverseTransaction`, which is idempotent and links back
      via `reversesTransactionId`.

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

export type TransferCap = {
  maxMinor: bigint;
  /**
   * Whether this ceiling was DELIBERATELY set, rather than inherited.
   *
   * Sandbox has a real hard cap in code, so it counts as configured.
   * Production does not: the old fallback was $1,000,000 with a comment
   * saying it "should be overridden", which is not a limit — it is a number
   * nobody chose sitting in front of real money. Real execution now refuses
   * when this is false; a dry run still reports so the gap is visible before
   * anyone tries to move funds.
   */
  configured: boolean;
};

function resolveMaxTransferMinor(environment: string): TransferCap {
  const envVar = process.env.MAX_CREATOR_TRANSFER_MINOR;
  if (envVar) {
    try {
      const parsed = BigInt(envVar);
      if (parsed > BigInt(0)) return { maxMinor: parsed, configured: true };
    } catch { /* fall through to the environment default */ }
  }
  if (environment === "sandbox") return { maxMinor: SANDBOX_MAX_MINOR, configured: true };
  return { maxMinor: DEFAULT_PROD_MAX_MINOR, configured: false };
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
  /**
   * STABLE IDENTITY FOR ONE INTENDED TRANSFER.
   *
   * Supplied by the caller and persisted as `idempotency_key` BEFORE the
   * provider is called. A retried HTTP request carrying the same token
   * resolves to the SAME row and the SAME provider idempotence key rather
   * than minting a second payment.
   *
   * It is an opaque token only. It cannot influence the amount, the creator,
   * the destination, the environment or any privilege — every one of those is
   * resolved server-side and compared against the stored intent.
   *
   * Required for real execution; optional for a dry run, which writes nothing.
   */
  requestId?: string;
  /** If true: run all validations but do not call Whop or write to DB. */
  dryRun?: boolean;
};

export type InitiateTransferResult =
  | {
      ok: true;
      dryRun: true;
      accountId: string;
      amountMinor: bigint;
      maxAllowed: bigint;
      /** Whether a real execution could run with the current configuration. */
      executable: boolean;
    }
  | {
      ok: true;
      dryRun: false;
      transferId: string;
      idempotencyKey: string;
      providerTransferId: string | null;
      status: CreatorTransferStatus;
      accountId: string;
      amountMinor: bigint;
      /** True when this request resolved to an existing intent, not a new one. */
      replayed: boolean;
    }
  | { ok: false; reason: TransferFailureReason };

/** The internal lifecycle, mirroring the `creator_transfer_status` enum. */
export type CreatorTransferStatus =
  | "pending" | "submitted" | "completed" | "failed" | "reversed";

export type TransferFailureReason =
  | "unconfigured"
  | "db_unavailable"
  | "creator_not_found"        // no connected Whop account
  | "amount_below_minimum"
  | "amount_above_maximum"
  | "missing_request_id"       // real execution without a stable identity
  | "intent_conflict"          // same request id, different transfer details
  | "transfer_cap_unconfigured" // production without an explicit ceiling
  | "accounting_write_failed"
  | "amount_unrepresentable"
  | "provider_ambiguous"       // outcome unknown; record left recoverable
  | string;                    // provider failure reason passed through

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
  // 1. Trusted configuration. Environment comes from here and nowhere else.
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const { environment } = platform.config;

  // 2. Amount guards, before any network call.
  const cap = resolveMaxTransferMinor(environment);
  if (input.amountMinor < MIN_TRANSFER_MINOR) {
    return { ok: false, reason: "amount_below_minimum" };
  }
  // PRODUCTION FAILS CLOSED. An unset ceiling used to fall back to a $1M
  // default the code itself called "should be overridden" — a silent default
  // is not a limit. A dry run still reports, so the gap stays discoverable
  // without risking a transfer.
  if (!cap.configured && !input.dryRun) {
    return { ok: false, reason: "transfer_cap_unconfigured" };
  }
  if (input.amountMinor > cap.maxMinor) {
    return { ok: false, reason: "amount_above_maximum" };
  }

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  // 3. The creator's own connected account, scoped to the running environment.
  //    Never a browser-supplied id.
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

  // NO EXTERNAL PAYOUT-READINESS GATE.
  //
  // This primitive creates a `ledger` transfer, which the SDK defines as
  // moving "credit between two Whop balances". Nothing in the installed
  // contract requires the recipient to hold a bank or crypto destination —
  // that is what they need to withdraw the balance onward, which is Task #11's
  // question and a different one. Gating here conflated "can receive internal
  // credit" with "can cash out", and blocked transfers the provider would have
  // accepted.

  // 4. Dry run stops before any write.
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      accountId: whopAccountId,
      amountMinor: input.amountMinor,
      maxAllowed: cap.maxMinor,
      executable: cap.configured,
    };
  }

  // 5. REAL EXECUTION REQUIRES A STABLE IDENTITY.
  //
  //    Without one, an HTTP retry is indistinguishable from a second intended
  //    payment. The old code minted a fresh UUID per attempt, so the provider
  //    de-duplication it relied on could never fire.
  const requestId = input.requestId?.trim();
  if (!requestId || !isValidRequestId(requestId)) {
    return { ok: false, reason: "missing_request_id" };
  }
  const idempotencyKey = `admin:${requestId}`;

  // 6. Resolve the intent: reuse an existing row, or claim a new one.
  const claim = await claimTransferIntent(db, {
    idempotencyKey,
    firebaseUid: input.firebaseUid,
    whopAccountId,
    environment,
    amountMinor: input.amountMinor,
    currency: input.currency,
    purpose: input.purpose,
    campaignId: input.campaignId ?? null,
    initiatedByUid: input.initiatedByUid,
  });
  if (!claim.ok) return { ok: false, reason: claim.reason };

  const { row, created } = claim;

  // A replay that already reached a terminal state returns it unchanged. No
  // second provider call, no second journal.
  if (!created && TERMINAL_TRANSFER_STATUSES.has(row.status)) {
    return {
      ok: true,
      dryRun: false,
      transferId: row.transferId,
      idempotencyKey,
      providerTransferId: row.providerTransferId,
      status: row.status as CreatorTransferStatus,
      accountId: whopAccountId,
      amountMinor: row.amountMinor,
      replayed: true,
    };
  }

  // A replay of an in-flight transfer asks the provider what happened rather
  // than sending it again.
  if (!created && row.providerTransferId) {
    const refreshed = await reconcileTransfer(row.transferId);
    return refreshed.ok
      ? {
          ok: true,
          dryRun: false,
          transferId: row.transferId,
          idempotencyKey,
          providerTransferId: row.providerTransferId,
          status: refreshed.status,
          accountId: whopAccountId,
          amountMinor: row.amountMinor,
          replayed: true,
        }
      : { ok: false, reason: refreshed.reason };
  }

  // 7. LEDGER FIRST. The journal is posted before the provider is called, so a
  //    crash after the call still has the obligation recorded. If it cannot be
  //    written, Whop is never called at all.
  if (!row.accountingTransactionId) {
    const written = await writePayoutJournal(db, {
      transferId: row.transferId,
      whopAccountId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      environment,
      idempotencyKey,
      purpose: row.purpose,
    });
    if (!written) {
      await setTransferStatus(db, row.transferId, "failed", {
        failureReason: "accounting_write_failed",
      });
      return { ok: false, reason: "accounting_write_failed" };
    }
  }

  // 8. The provider call. The PERSISTED key is passed through unchanged.
  const notes = `ClipRewards ${row.purpose}`.slice(0, 200);
  const result = await createLedgerTransfer({
    destinationId: whopAccountId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    idempotenceKey: idempotencyKey,
    notes,
  });

  return applyProviderResult(db, {
    transferId: row.transferId,
    idempotencyKey,
    accountId: whopAccountId,
    amountMinor: row.amountMinor,
    replayed: !created,
    result,
  });
}

/* -------------------------------------------------------------------------
   Intent claiming — one row per intended transfer
   ------------------------------------------------------------------------- */

/** An opaque token. Shape only; it confers nothing. */
function isValidRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

type ClaimInput = {
  idempotencyKey: string;
  firebaseUid: string;
  whopAccountId: string;
  environment: "sandbox" | "production";
  amountMinor: bigint;
  currency: string;
  purpose: string;
  campaignId: string | null;
  initiatedByUid: string;
};

type ClaimResult =
  | { ok: true; row: typeof schema.creatorTransfers.$inferSelect; created: boolean }
  | { ok: false; reason: TransferFailureReason };

/**
 * Claims the intent for one idempotency key, atomically.
 *
 * `insert ... on conflict do nothing ... returning` is ONE statement, so two
 * concurrent requests carrying the same token cannot both create a row: the
 * unique index decides, and the loser reads back what the winner committed. A
 * select-then-insert would let both see nothing and both insert.
 *
 * A replay whose details DISAGREE with the stored intent fails closed. The
 * token names one intended payment; reusing it for a different amount or a
 * different creator is a caller bug, and guessing which one was meant is how
 * the wrong person gets paid.
 */
async function claimTransferIntent(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: ClaimInput,
): Promise<ClaimResult> {
  try {
    const inserted = await db
      .insert(schema.creatorTransfers)
      .values({
        firebaseUid: input.firebaseUid,
        whopAccountId: input.whopAccountId,
        environment: input.environment,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        purpose: input.purpose,
        campaignId: input.campaignId,
        initiatedByUid: input.initiatedByUid,
      })
      .onConflictDoNothing({ target: schema.creatorTransfers.idempotencyKey })
      .returning();

    if (inserted.length === 1) return { ok: true, row: inserted[0], created: true };

    const [existing] = await db
      .select()
      .from(schema.creatorTransfers)
      .where(eq(schema.creatorTransfers.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (!existing) return { ok: false, reason: "db_unavailable" };

    const sameIntent =
      existing.firebaseUid === input.firebaseUid &&
      existing.whopAccountId === input.whopAccountId &&
      existing.environment === input.environment &&
      existing.amountMinor === input.amountMinor &&
      existing.currency === input.currency &&
      existing.purpose === input.purpose;

    if (!sameIntent) return { ok: false, reason: "intent_conflict" };
    return { ok: true, row: existing, created: false };
  } catch {
    return { ok: false, reason: "db_unavailable" };
  }
}

/* -------------------------------------------------------------------------
   Applying a provider outcome
   ------------------------------------------------------------------------- */

/** Provider truth mapped onto our lifecycle. Three statuses, no invention. */
const PROVIDER_TO_INTERNAL: Record<ProviderTransferStatus, CreatorTransferStatus> = {
  processing: "submitted",
  succeeded: "completed",
  failed: "failed",
};

async function applyProviderResult(
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: {
    transferId: string;
    idempotencyKey: string;
    accountId: string;
    amountMinor: bigint;
    replayed: boolean;
    result: TransferResult;
  },
): Promise<InitiateTransferResult> {
  const { result } = ctx;

  // AMBIGUOUS: we do not know whether the provider created it. The row stays
  // `pending` and keeps its key, so `retryTransfer` can ask again with the
  // SAME idempotence key and the provider can return the original rather than
  // move money twice. Marking this failed — as the old code did — and then
  // retrying with a fresh key is exactly how a double payment happens.
  if (!result.ok && result.outcome === "ambiguous") {
    await db
      .update(schema.creatorTransfers)
      .set({ failureReason: `ambiguous:${result.reason}`, updatedAt: new Date() })
      .where(eq(schema.creatorTransfers.transferId, ctx.transferId));
    return { ok: false, reason: "provider_ambiguous" };
  }

  // DEFINITE failure: the provider read the request and refused. Nothing
  // moved, so the ledger effect is compensated — exactly once.
  if (!result.ok) {
    await setTransferStatus(db, ctx.transferId, "failed", { failureReason: result.reason });
    await compensateFailedTransfer(db, ctx.transferId, result.reason);
    return { ok: false, reason: result.reason };
  }

  const internal = PROVIDER_TO_INTERNAL[result.transfer.status];
  await setTransferStatus(db, ctx.transferId, internal, {
    providerTransferId: result.transfer.providerTransferId,
    failureReason: result.transfer.failureCode,
  });

  // A transfer the provider refused outright still needs its journal undone.
  if (internal === "failed") {
    await compensateFailedTransfer(
      db,
      ctx.transferId,
      result.transfer.failureCode ?? "provider_failed",
    );
  }

  return {
    ok: true,
    dryRun: false,
    transferId: ctx.transferId,
    idempotencyKey: ctx.idempotencyKey,
    providerTransferId: result.transfer.providerTransferId,
    status: internal,
    accountId: ctx.accountId,
    amountMinor: ctx.amountMinor,
    replayed: ctx.replayed,
  };
}

/* -------------------------------------------------------------------------
   The state machine
   ------------------------------------------------------------------------- */

/** Once here, a stale event must not move the row. */
export const TERMINAL_TRANSFER_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "reversed",
]);

/**
 * The only transitions the lifecycle permits.
 *
 * Whop does not order its deliveries, so a `processing` snapshot arriving
 * after `succeeded` is normal. Without this table a stale event would regress
 * a completed transfer to `submitted` and the record would stop meaning
 * anything. `reversed` is reachable only from `completed`: money must have
 * arrived before it can come back.
 */
export const ALLOWED_TRANSFER_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["pending", "submitted", "completed", "failed"],
  submitted: ["submitted", "completed", "failed"],
  completed: ["completed", "reversed"],
  failed: ["failed"],
  reversed: ["reversed"],
};

export function isAllowedTransferTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Moves a transfer to a new status, refusing a regression.
 *
 * The guard is in the WHERE clause, not in a branch: Postgres evaluates it
 * against committed state under a row lock, so two deliveries racing on the
 * same row cannot both win.
 */
async function setTransferStatus(
  db: NonNullable<ReturnType<typeof getDb>>,
  transferId: string,
  next: CreatorTransferStatus,
  extra: { providerTransferId?: string | null; failureReason?: string | null } = {},
): Promise<boolean> {
  const allowedFrom = Object.entries(ALLOWED_TRANSFER_TRANSITIONS)
    .filter(([, targets]) => targets.includes(next))
    .map(([from]) => from as CreatorTransferStatus);
  if (allowedFrom.length === 0) return false;

  const now = new Date();
  const stamps: Record<string, Date> = {};
  if (next === "submitted") stamps.submittedAt = now;
  if (next === "completed") stamps.completedAt = now;
  if (next === "failed") stamps.failedAt = now;
  if (next === "reversed") stamps.reversedAt = now;

  try {
    const updated = await db
      .update(schema.creatorTransfers)
      .set({
        status: next,
        updatedAt: now,
        ...stamps,
        ...(extra.providerTransferId ? { providerTransferId: extra.providerTransferId } : {}),
        ...(extra.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      })
      .where(
        and(
          eq(schema.creatorTransfers.transferId, transferId),
          inArray(schema.creatorTransfers.status, allowedFrom as CreatorTransferStatus[]),
        ),
      )
      .returning({ transferId: schema.creatorTransfers.transferId });
    return updated.length === 1;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
   Compensation
   ------------------------------------------------------------------------- */

/**
 * Undoes the ledger effect of a transfer that definitively did not happen.
 *
 * Uses the repository's canonical `reverseTransaction`, which posts the exact
 * opposite legs, links back through `reversesTransactionId`, leaves the
 * original immutable, and keys itself `internal:reversal:<id>` — so a replay
 * returns the existing reversal instead of compensating twice.
 *
 * Only ever called for a DEFINITE failure. An ambiguous outcome must not reach
 * here: crediting the payable back for money that may actually have left is
 * the mirror image of paying twice.
 */
async function compensateFailedTransfer(
  db: NonNullable<ReturnType<typeof getDb>>,
  transferId: string,
  reason: string,
): Promise<void> {
  const [row] = await db
    .select({ accountingTransactionId: schema.creatorTransfers.accountingTransactionId })
    .from(schema.creatorTransfers)
    .where(eq(schema.creatorTransfers.transferId, transferId))
    .limit(1);

  if (!row?.accountingTransactionId) return;

  await reverseTransaction(row.accountingTransactionId, {
    reason: `Transfer ${transferId} failed at provider: ${reason}`.slice(0, 200),
  });
}

/* -------------------------------------------------------------------------
   Retry and reconciliation
   ------------------------------------------------------------------------- */

export type RetryResult =
  | { ok: true; status: CreatorTransferStatus; providerTransferId: string | null }
  | { ok: false; reason: TransferFailureReason };

/**
 * Re-attempts ONE existing transfer using its STORED idempotency key.
 *
 * This is the documented safe recovery path, and the only one. It never mints
 * a new key, never creates a second row, and never changes the amount, the
 * creator or the destination — every value comes from the stored row. Whop
 * returns the original transfer for a repeated key, so a retry after an
 * ambiguous timeout reconciles rather than pays again.
 *
 * A terminal row is returned untouched.
 */
export async function retryTransfer(transferId: string): Promise<RetryResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const [row] = await db
    .select()
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.transferId, transferId),
        eq(schema.creatorTransfers.environment, platform.config.environment),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "creator_not_found" };

  if (TERMINAL_TRANSFER_STATUSES.has(row.status)) {
    return {
      ok: true,
      status: row.status as CreatorTransferStatus,
      providerTransferId: row.providerTransferId,
    };
  }

  // Already has a provider id: ask what happened rather than sending again.
  if (row.providerTransferId) {
    const reconciled = await reconcileTransfer(transferId);
    return reconciled.ok
      ? { ok: true, status: reconciled.status, providerTransferId: row.providerTransferId }
      : { ok: false, reason: reconciled.reason };
  }

  const result = await createLedgerTransfer({
    destinationId: row.whopAccountId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    // THE STORED KEY. Not a new one — this is the whole point of the retry.
    idempotenceKey: row.idempotencyKey,
    notes: `ClipRewards ${row.purpose}`.slice(0, 200),
  });

  const applied = await applyProviderResult(db, {
    transferId: row.transferId,
    idempotencyKey: row.idempotencyKey,
    accountId: row.whopAccountId,
    amountMinor: row.amountMinor,
    replayed: true,
    result,
  });

  if (!applied.ok) return { ok: false, reason: applied.reason };
  return {
    ok: true,
    status: applied.dryRun === false ? applied.status : "pending",
    providerTransferId: applied.dryRun === false ? applied.providerTransferId : null,
  };
}

export type ReconcileResult =
  | { ok: true; status: CreatorTransferStatus; changed: boolean }
  | { ok: false; reason: TransferFailureReason };

/**
 * Refreshes one transfer from the PROVIDER, which is the authority.
 *
 * The SDK says `processing` means the leg is still executing and to poll until
 * it resolves, so status comes from `transfers.retrieve` and not from a
 * webhook whose relationship to this resource is unproven.
 *
 * A malformed or unreadable answer leaves the row alone and reports a
 * controlled error: not knowing is a state worth preserving.
 */
export async function reconcileTransfer(transferId: string): Promise<ReconcileResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const [row] = await db
    .select()
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.transferId, transferId),
        eq(schema.creatorTransfers.environment, platform.config.environment),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "creator_not_found" };
  if (!row.providerTransferId) return { ok: false, reason: "provider_ambiguous" };
  if (TERMINAL_TRANSFER_STATUSES.has(row.status)) {
    return { ok: true, status: row.status as CreatorTransferStatus, changed: false };
  }

  const result = await retrieveTransfer(row.providerTransferId);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.outcome === "ambiguous" ? "provider_ambiguous" : result.reason,
    };
  }

  const internal = PROVIDER_TO_INTERNAL[result.transfer.status];
  const changed = await setTransferStatus(db, transferId, internal, {
    failureReason: result.transfer.failureCode,
  });

  if (changed && internal === "failed") {
    await compensateFailedTransfer(
      db,
      transferId,
      result.transfer.failureCode ?? "provider_failed",
    );
  }

  return { ok: true, status: internal, changed };
}


/* -------------------------------------------------------------------------
   Accounting journal
   ------------------------------------------------------------------------- */

type JournalInput = {
  transferId: string;
  whopAccountId: string;
  amountMinor: bigint;
  currency: string;
  environment: WhopEnvironmentName;
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
          environment: input.environment,
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
 * ENVIRONMENT SCOPING FOR THE WEBHOOK-DRIVEN STATE CHANGES.
 *
 * `provider_transfer_id` is Whop's identifier, not ours, and nothing about it
 * guarantees it is unique ACROSS environments — sandbox and production are
 * separate id spaces that may legitimately reuse a value. Matching on it alone
 * would let a sandbox `payout.*` delivery settle or reverse a production
 * transfer, which is exactly the isolation rule the rest of this codebase
 * holds to (`whop_accounts`, `whop_connections`, `creator_withdrawals` and
 * `payment_orders` all scope every read by environment).
 *
 * The environment comes from `getWhopEnvironment()` — the same server-side
 * helper those paths use, reading only from `process.env`. It is NEVER taken
 * from the webhook payload, a query parameter, a request body or any other
 * caller-supplied value: an attacker who could name the environment could pick
 * which ledger to move.
 *
 * With the environment unresolvable we cannot prove which row is meant, so
 * both functions fail closed rather than updating an unscoped match.
 */
function resolveTransferEnvironment(): "sandbox" | "production" | null {
  return getWhopEnvironment();
}

/**
 * Refreshes a transfer named by an inbound provider event.
 *
 * WHY THIS REPLACED `markTransferCompleted` / `markTransferReversed`.
 *
 * Those two took a `payout.*` webhook's `status` string and wrote our money
 * state from it directly. Three things were wrong with that:
 *
 *   1. THE STATUSES WERE NOT REAL. They matched `paid`, `completed` and
 *      `reversed`. A Whop transfer has exactly three statuses — `processing`,
 *      `succeeded`, `failed` — so the handler was acting on states this
 *      resource never emits, and ignoring the one it does.
 *
 *   2. `failed` POSTED A REVERSAL. A failed transfer never moved money, but
 *      the handler credited `creator_payable` back as though it had, on top of
 *      a transfer the SDK says "may be retried under the same ID and later
 *      resolve to succeeded".
 *
 *   3. IT WAS NOT OWNERSHIP-GATED. `payout.*` is not in `OWNERSHIP_GATED`, so
 *      the resource was never fetched back from Whop to prove it was ours,
 *      yet the handler wrote to the ledger. That is the repository's stated
 *      invariant being broken by the handler that reverses money.
 *
 * The fix is to stop trusting the event's contents at all. The event becomes a
 * TRIGGER — the same shape as the KYC return url — and the authority is
 * `transfers.retrieve`, which the SDK documents as the way to follow a
 * `processing` transfer to resolution.
 *
 * That also closes the ownership gap without a separate gate: retrieving the
 * transfer by id with our own platform key IS the proof that it is ours. An id
 * belonging to someone else is not readable, and an id we do not hold locally
 * never reaches the provider at all.
 */
export async function refreshTransferFromProvider(
  providerTransferId: string,
): Promise<{ ok: boolean; status?: CreatorTransferStatus }> {
  const db = getDb();
  if (!db) return { ok: false };

  const environment = resolveTransferEnvironment();
  if (!environment) return { ok: false };

  // Ours, in THIS environment, or not ours at all. A provider id is Whop's
  // namespace and is not unique across environments, so the id alone could
  // otherwise resolve a production row from a sandbox delivery.
  const [row] = await db
    .select({ transferId: schema.creatorTransfers.transferId })
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.providerTransferId, providerTransferId),
        eq(schema.creatorTransfers.environment, environment),
      ),
    )
    .limit(1);

  // Not a transfer we created. Acknowledged and ignored — it belongs to
  // another environment, another system, or is a payout resource that is not
  // a ledger transfer at all.
  if (!row) return { ok: false };

  const reconciled = await reconcileTransfer(row.transferId);
  return reconciled.ok ? { ok: true, status: reconciled.status } : { ok: false };
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

/**
 * Pending transfers older than `minutes`, for a reconciliation sweep.
 *
 * SCOPED TO THE RUNNING ENVIRONMENT. Without the scope a sandbox sweep would
 * see production transfers and vice versa, which is the same isolation rule
 * `markTransferCompleted` and `markTransferReversed` hold to — and this one is
 * the more dangerous shape, because a sweep's whole job is to act on what it
 * finds. The environment comes from `resolveTransferEnvironment()`, never from
 * a parameter: a caller that could name the environment could aim the sweep.
 *
 * Fails closed to an empty list when the environment cannot be resolved. An
 * unscoped sweep is worse than no sweep.
 */
export async function getPendingTransfersOlderThanMinutes(
  minutes: number,
): Promise<typeof schema.creatorTransfers.$inferSelect[]> {
  const db = getDb();
  if (!db) return [];

  const environment = resolveTransferEnvironment();
  if (!environment) return [];

  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  return db
    .select()
    .from(schema.creatorTransfers)
    .where(
      and(
        eq(schema.creatorTransfers.status, "pending"),
        eq(schema.creatorTransfers.environment, environment),
        sql`${schema.creatorTransfers.createdAt} < ${cutoff}`,
      ),
    );
}
