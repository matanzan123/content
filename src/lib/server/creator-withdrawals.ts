import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { fetchPayoutStatus } from "./whop-payout-status";
import { getConnectedAccount } from "./connected-accounts";
import { getWhopEnvironment, type WhopEnvironmentName } from "./whop-payments";
import { notifyWithdrawalProcessing } from "./notification-triggers";
import {
  createPayout,
  createPayoutQuote,
  findPayoutByWithdrawalId,
  listEligiblePayoutMethods,
  readQuoteRequirement,
  readWithdrawableBalance,
  retrievePayout,
  selectPayoutMethod,
  FAILURE_PAYOUT_STATUSES,
  NONTERMINAL_PAYOUT_STATUSES,
  REVERSAL_PAYOUT_STATUS,
  SUCCESS_PAYOUT_STATUS,
  type ProviderPayoutStatus,
} from "./whop-payouts";

/* ==========================================================================
   CREATOR WITHDRAWALS — money leaving Whop for a creator's own bank.

   A WITHDRAWAL IS NOT A TRANSFER. This file used to execute one by calling
   `initiateCreatorTransfer`, which is Task #13: an INTERNAL Whop ledger
   transfer from the ClipRewards platform balance to the creator's connected
   Whop balance. The money never left Whop. Recording that as a withdrawal told
   the creator their earnings had reached their bank when they had not.

   A withdrawal is `payouts.create`: the creator's OWN balance to their OWN
   external destination. See `whop-payouts.ts` for why that is a different
   provider resource in every respect that matters.

   WHO DOES WHAT:
     Creator  → requestWithdrawal()   validated against the provider balance
     Admin    → executeWithdrawal()   readiness, destination, quote, payout
     Provider → reconcileWithdrawal() the ONLY source of a money state change
     Webhook  → a trigger for the reconciler, never a source of truth

   THIS FILE POSTS NOTHING TO THE LEDGER, AND THAT IS THE CORRECTION.

   An earlier version debited `creator_payable` when a payout executed and
   credited it back on failure. That was a double-debit. Task #13 ALREADY
   discharges the obligation: it moves the money into the creator's own Whop
   account, after which ClipRewards owes them nothing and `creator_payable` is
   correctly zero. A withdrawal then moves THE CREATOR'S OWN FUNDS out of that
   account, which is not our liability and never was.

   Two things followed from the mistake, both fatal. The balance went negative
   the first time a withdrawal ran, and the cap read the very figure that
   Task #13 had just zeroed — so a creator whose money had reached their Whop
   account could never withdraw a cent of it.

   THE FOUR INVARIANTS:

   1. NO INTERNAL JOURNAL. No `creator_payable`, no `payout_clearing`, no
      reversal. A payout's history lives in `creator_withdrawals` and at the
      provider. Nothing here touches the ClipRewards liability ledger.

   2. THE PROVIDER'S WITHDRAWABLE BALANCE IS THE CAP. Read from the creator's
      own ledger account, and re-read immediately before the payout so a stale
      figure cannot overspend. Not `creator_payable`, not earning rows, not
      anything a browser sent us.

   3. AMBIGUITY IS NOT FAILURE, AND IS NEVER RETRIED BLINDLY. A timeout or a
      409 may mean the payout exists. Such a withdrawal stays recoverable and
      is resolved by asking the provider — first by id, and when we never got
      an id, by searching for our own `withdrawal_id` metadata.

   4. PROVIDER TRUTH ONLY. Every state change comes from `payouts.retrieve`.
      A webhook says which payout to look at, and nothing more.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Amount bounds
   ------------------------------------------------------------------------- */

/**
 * $1.00. AN APPLICATION MINIMUM, NOT A CLAIMED PROVIDER ONE.
 *
 * The installed SDK expresses no minimum payout amount, so this is a product
 * floor chosen to match the Task #13 transfer minimum rather than something
 * Whop has told us. A payout smaller than its own fee is not a service to
 * anyone.
 */
const MIN_WITHDRAWAL_MINOR = BigInt(100);

/**
 * $50,000. A CEILING, NOT A POLICY.
 *
 * The provider expresses no maximum either. This exists so a single malformed
 * or hostile request cannot attempt to move an unbounded sum, and it sits far
 * above any legitimate creator withdrawal. The canonical available balance is
 * the real limit; this is the backstop for when that calculation is wrong.
 */
const MAX_WITHDRAWAL_MINOR = BigInt(5_000_000);

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

export type RequestWithdrawalInput = {
  firebaseUid: string;
  amountMinor: bigint;
  currency?: "usd";
  /**
   * THE LOGICAL IDENTITY OF ONE INTENDED WITHDRAWAL.
   *
   * Required. Supplied by the client, persisted before the reservation, and
   * reused verbatim on every retry of the same user intent. A retried POST
   * resolves to the SAME row rather than reserving the creator's balance
   * twice.
   *
   * Opaque only: it cannot influence the amount, the destination, the
   * environment or any privilege.
   */
  requestId: string;
  /**
   * The destination the creator chose, when they were asked to choose. Never
   * trusted on its own — it must appear in the company-scoped eligible list.
   */
  payoutMethodId?: string;
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
  failureReason: string | null;
  cancelReason: string | null;
  requestedAt: Date;
  paidAt: Date | null;
  failedAt: Date | null;
  canceledAt: Date | null;
  reversedAt: Date | null;
};

export type WithdrawalRefusalReason =
  | "db_unavailable"
  | "creator_not_found"
  /** The provider's withdrawable balance could not be read. Fails closed. */
  | "balance_unavailable"
  | "amount_zero"
  | "amount_below_minimum"
  | "amount_above_maximum"
  | "amount_exceeds_balance"
  | "insufficient_available"
  | "missing_request_id"
  | "request_conflict"
  | "withdrawal_already_pending"
  | "platform_unavailable";

export type RequestWithdrawalResult =
  | { ok: true; withdrawalId: string; status: WithdrawalStatus; replayed: boolean }
  | { ok: false; reason: WithdrawalRefusalReason };

export type ExecuteWithdrawalResult =
  | { ok: true; providerPayoutId: string; status: WithdrawalStatus }
  | {
      ok: false;
      reason:
        | "db_unavailable"
        | "not_found"
        | "wrong_status"
        | "platform_unavailable"
        | "creator_not_found"
        | "payout_not_ready"
        | "payout_destination_required"
        | "payout_method_selection_required"
        | "payout_method_not_owned"
        | "quote_unavailable"
        | "quote_rejected"
        | "balance_unavailable"
        | "insufficient_available"
        | "payout_ambiguous"
        /** The payout may exist and we have no id. A human resolves it. */
        | "payout_needs_recovery"
        | string;
    };

/* -------------------------------------------------------------------------
   The withdrawal state machine
   ------------------------------------------------------------------------- */

/**
 * The only transitions a withdrawal may make.
 *
 * ENFORCED IN SQL, not in a branch. Every status write puts the permitted
 * source states into the WHERE clause, so Postgres evaluates the guard against
 * committed state. An application-side `if` between a SELECT and an UPDATE
 * loses that race — and the deliveries that drive this lifecycle arrive
 * concurrently and out of order, so the race is the normal case, not the edge.
 *
 * SELF-TRANSITIONS ARE PERMITTED AND INERT. A redelivered `completed` event on
 * an already-`paid` withdrawal must be harmless, not an error.
 *
 * `provider_pending` HAS THREE PROVIDER SOURCES. `requested`, `in_review` and
 * `processing` all mean the same thing to us: the provider has it and has not
 * finished. Collapsing them here is why `provider_status` is stored separately
 * — the provider's own word survives even though our lifecycle does not
 * distinguish the three.
 *
 * `paid` → `reversed` IS THE ONLY EXIT FROM SUCCESS, because it is the only one
 * the provider models: a settled payout the bank later returned.
 */
export const ALLOWED_WITHDRAWAL_TRANSITIONS: Record<
  WithdrawalStatus,
  readonly WithdrawalStatus[]
> = {
  requested: ["requested", "eligible", "processing", "canceled", "failed"],
  eligible: ["eligible", "processing", "canceled", "failed"],
  // `processing` may reach `paid` directly: a fast provider can answer
  // `completed` on the create call itself.
  processing: ["processing", "provider_pending", "paid", "failed", "canceled"],
  provider_pending: ["provider_pending", "paid", "failed", "canceled", "reversed"],
  paid: ["paid", "reversed"],
  failed: ["failed"],
  canceled: ["canceled"],
  reversed: ["reversed"],
};

/** Nothing leaves these. A terminal withdrawal is never resurrected. */
export const TERMINAL_WITHDRAWAL_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "canceled",
  "reversed",
]);

/**
 * Statuses that still hold a claim on the creator's balance.
 *
 * `paid` is absent on purpose: its money is already debited from the ledger,
 * so counting it as a reservation would subtract it twice.
 */
const ACTIVE_STATUSES: readonly [WithdrawalStatus, ...WithdrawalStatus[]] = [
  "requested",
  "eligible",
  "processing",
  "provider_pending",
];

const TERMINAL_STATUSES: readonly [WithdrawalStatus, ...WithdrawalStatus[]] = [
  "paid",
  "failed",
  "canceled",
  "reversed",
];

/** The states an update to `next` may legally start from, excluding itself. */
export function withdrawalSourceStatuses(next: WithdrawalStatus): WithdrawalStatus[] {
  return (Object.keys(ALLOWED_WITHDRAWAL_TRANSITIONS) as WithdrawalStatus[]).filter(
    (from) => from !== next && ALLOWED_WITHDRAWAL_TRANSITIONS[from].includes(next),
  );
}

export function isAllowedWithdrawalTransition(from: string, to: string): boolean {
  return (ALLOWED_WITHDRAWAL_TRANSITIONS[from as WithdrawalStatus] ?? []).includes(
    to as WithdrawalStatus,
  );
}

/**
 * Moves a withdrawal to `next`, guarded in SQL and scoped to the environment.
 *
 * Returns false when nothing matched — the row was already terminal, already
 * there, or belongs to another environment. A false is the guard working, not
 * an error.
 */
async function setWithdrawalStatus(
  db: NonNullable<ReturnType<typeof getDb>>,
  withdrawalId: string,
  environment: WhopEnvironmentName,
  next: WithdrawalStatus,
  extra: Partial<typeof schema.creatorWithdrawals.$inferInsert> = {},
): Promise<boolean> {
  const sources = withdrawalSourceStatuses(next);
  if (sources.length === 0) return false;

  const now = new Date();
  const stamps: Partial<typeof schema.creatorWithdrawals.$inferInsert> = {};
  if (next === "eligible") stamps.eligibleAt = now;
  if (next === "processing") stamps.processingAt = now;
  if (next === "provider_pending") stamps.providerPendingAt = now;
  if (next === "paid") stamps.paidAt = now;
  if (next === "failed") stamps.failedAt = now;
  if (next === "canceled") stamps.canceledAt = now;
  if (next === "reversed") stamps.reversedAt = now;

  const updated = await db
    .update(schema.creatorWithdrawals)
    .set({ status: next, updatedAt: now, ...stamps, ...extra })
    .where(
      and(
        eq(schema.creatorWithdrawals.withdrawalId, withdrawalId),
        eq(schema.creatorWithdrawals.environment, environment),
        inArray(
          schema.creatorWithdrawals.status,
          sources as [WithdrawalStatus, ...WithdrawalStatus[]],
        ),
      ),
    )
    .returning({ id: schema.creatorWithdrawals.withdrawalId });

  return updated.length > 0;
}

/* -------------------------------------------------------------------------
   Request identity
   ------------------------------------------------------------------------- */

/** An opaque token. Shape only; it confers nothing. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidWithdrawalRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/* -------------------------------------------------------------------------
   Request a withdrawal
   ------------------------------------------------------------------------- */

/**
 * Creator asks to withdraw `amountMinor` from their own Whop balance.
 *
 * IDEMPOTENT BY `requestId`. A replay carrying the same token resolves to the
 * existing row. A replay carrying the same token with a DIFFERENT amount or
 * destination is a `request_conflict` — two intents cannot share one identity,
 * and guessing which the creator meant would move the wrong sum or move it
 * somewhere else.
 *
 * THE CAP IS THE PROVIDER'S WITHDRAWABLE BALANCE. Not `creator_payable`, which
 * Task #13 has already discharged and which would read zero exactly when a
 * withdrawal becomes possible. Not the earning rows, which are audit history.
 * Not the figure the browser displayed, which is a convenience and can be
 * stale or forged.
 *
 * NOTHING IS RESERVED AND NOTHING IS POSTED. The row records an intent; the
 * money stays entirely at the provider until the payout executes, and the
 * provider's own balance is what stops an overspend. `uniq_withdrawal_active_creator`
 * keeps one attempt in flight per creator per environment, which is the only
 * local concurrency guard this design needs.
 */
export async function requestWithdrawal(
  input: RequestWithdrawalInput,
): Promise<RequestWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const { firebaseUid, amountMinor } = input;
  const currency = input.currency ?? "usd";

  if (!isValidWithdrawalRequestId(input.requestId)) {
    return { ok: false, reason: "missing_request_id" };
  }
  const requestId = input.requestId;

  if (amountMinor <= BigInt(0)) return { ok: false, reason: "amount_zero" };
  if (amountMinor < MIN_WITHDRAWAL_MINOR) return { ok: false, reason: "amount_below_minimum" };
  if (amountMinor > MAX_WITHDRAWAL_MINOR) return { ok: false, reason: "amount_above_maximum" };

  // RESOLVED UP FRONT from server config only. A withdrawal must do no work at
  // all if we cannot say which environment it belongs to.
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "db_unavailable" };

  // IDEMPOTENT REPLAY, BEFORE ANY PROVIDER CALL. An existing row for this
  // (creator, environment, request_id) is this same intent returning, so it
  // costs neither a balance read nor a new row.
  const existing = await findWithdrawalByRequestId(db, firebaseUid, environment, requestId);
  if (existing) {
    const sameIntent =
      existing.amountMinor === amountMinor &&
      existing.currency === currency &&
      (input.payoutMethodId === undefined ||
        existing.payoutMethodId === null ||
        existing.payoutMethodId === input.payoutMethodId);

    if (!sameIntent) return { ok: false, reason: "request_conflict" };
    return {
      ok: true,
      withdrawalId: existing.withdrawalId,
      status: existing.status as WithdrawalStatus,
      replayed: true,
    };
  }

  /* THE CREATOR'S ACCOUNT AND THEIR BALANCE, BOTH RESOLVED SERVER-SIDE.
   *
   * The account comes from the stored uid and the trusted environment, never
   * from a request body — a supplied `account_id` would read, and later pay
   * out of, someone else's balance. */
  const account = await getConnectedAccount(firebaseUid, environment);
  if (!account) return { ok: false, reason: "creator_not_found" };

  const balance = await readWithdrawableBalance(account.whopAccountId, currency);
  if (!balance.ok) return { ok: false, reason: "balance_unavailable" };
  if (balance.withdrawableMinor === BigInt(0)) {
    return { ok: false, reason: "insufficient_available" };
  }
  if (amountMinor > balance.withdrawableMinor) {
    return { ok: false, reason: "amount_exceeds_balance" };
  }

  const now = new Date();
  let withdrawalId: string;

  try {
    const [inserted] = await db
      .insert(schema.creatorWithdrawals)
      .values({
        firebaseUid,
        environment,
        requestId,
        amountMinor,
        // Kept equal to the requested amount. It once held a FIFO overshoot
        // across earning rows; that allocation no longer exists.
        reservedAmountMinor: amountMinor,
        currency,
        status: "requested",
        requestedAt: now,
        payoutMethodId: input.payoutMethodId ?? null,
      })
      .returning({ withdrawalId: schema.creatorWithdrawals.withdrawalId });
    withdrawalId = inserted.withdrawalId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("uniq_withdrawal_active_creator")) {
      return { ok: false, reason: "withdrawal_already_pending" };
    }
    if (msg.includes("uniq_withdrawal_request_creator_env")) {
      // A concurrent request with the same token won. Both describe the same
      // intent, so this is a successful replay rather than a failure.
      const raced = await findWithdrawalByRequestId(db, firebaseUid, environment, requestId);
      if (raced) {
        return {
          ok: true,
          withdrawalId: raced.withdrawalId,
          status: raced.status as WithdrawalStatus,
          replayed: true,
        };
      }
      return { ok: false, reason: "request_conflict" };
    }
    return { ok: false, reason: "db_unavailable" };
  }

  // READINESS IS ADVISORY HERE AND ENFORCED AT EXECUTION. Probing now gives the
  // creator an immediate answer; it is not the gate.
  const payoutStatus = await fetchPayoutStatus(account.whopAccountId).catch(() => null);
  if (payoutStatus?.ok && payoutStatus.status.canReceivePayout) {
    await setWithdrawalStatus(db, withdrawalId, environment, "eligible");
    return { ok: true, withdrawalId, status: "eligible", replayed: false };
  }

  return { ok: true, withdrawalId, status: "requested", replayed: false };
}

/* -------------------------------------------------------------------------
   Execute — the provider payout
   ------------------------------------------------------------------------- */

/**
 * Admin triggers the external payout for a requested or eligible withdrawal.
 *
 * THE ORDER OF OPERATIONS IS THE SAFETY MODEL:
 *
 *   1. readiness, destination and quote — all reads, all refusable for free
 *   2. journal + reservation-consumed marker, in ONE committed transaction
 *   3. THEN the provider call
 *
 * Nothing in step 1 moves money, so a refusal there costs nothing and leaves
 * the reservation intact. Step 2 makes the obligation reduction durable before
 * the payout is attempted, so a crash after the provider call still has the
 * debit recorded and the payout discoverable. Reversing that order would allow
 * a payout with no ledger entry behind it.
 */
export async function executeWithdrawal(
  withdrawalId: string,
  adminUid: string,
): Promise<ExecuteWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "platform_unavailable" };

  const withdrawal = await loadWithdrawal(db, withdrawalId, environment);
  if (!withdrawal) return { ok: false, reason: "not_found" };

  // ALREADY EXECUTED. A replay reconciles instead of paying again.
  if (withdrawal.providerPayoutId) {
    const reconciled = await reconcileWithdrawal(withdrawalId);
    return reconciled.ok
      ? { ok: true, providerPayoutId: withdrawal.providerPayoutId, status: reconciled.status }
      : { ok: false, reason: reconciled.reason };
  }

  if (withdrawal.status !== "requested" && withdrawal.status !== "eligible") {
    return { ok: false, reason: "wrong_status" };
  }

  /* THE CREATOR'S ACCOUNT, RESOLVED SERVER-SIDE from the stored uid and the
   * trusted environment. Never from a request body: an attacker-supplied
   * `account_id` would pay out of someone else's balance. */
  const account = await getConnectedAccount(withdrawal.firebaseUid, environment);
  if (!account) return { ok: false, reason: "creator_not_found" };
  const accountId = account.whopAccountId;

  /* READINESS IS MANDATORY, unlike the Task #13 internal transfer. A ledger
   * transfer needs no destination; a payout to a bank does. `canReceivePayout`
   * is true only for `ready`, which already requires a configured destination,
   * an active payout capability, no blocking action and no suspension. */
  const readiness = await fetchPayoutStatus(accountId).catch(() => null);
  if (!readiness?.ok || !readiness.status.canReceivePayout) {
    // The reservation is deliberately preserved: the creator's intent is still
    // valid and becomes executable once they finish onboarding.
    return { ok: false, reason: "payout_not_ready" };
  }

  /* THE DESTINATION. Company-scoped at the provider, so list membership is the
   * ownership proof for any id the creator supplied. */
  const methods = await listEligiblePayoutMethods(accountId, withdrawal.currency);
  if (!methods.ok) return { ok: false, reason: "payout_not_ready" };

  const selection = selectPayoutMethod(methods.methods, withdrawal.payoutMethodId);
  if (!selection.ok) return { ok: false, reason: selection.reason };
  const payoutMethodId = selection.method.payoutMethodId;

  /* THE QUOTE, only when the account demands one. Minted outside any
   * transaction and never persisted — it is a short-lived signed secret used
   * within this request. */
  let quoteToken: string | undefined;
  const quoteReq = await readQuoteRequirement(accountId);
  if (!quoteReq.ok) return { ok: false, reason: "quote_unavailable" };
  if (quoteReq.required) {
    const quote = await createPayoutQuote({
      accountId,
      payoutMethodId,
      amountMinor: withdrawal.amountMinor,
      currency: "usd",
      idempotencyKey: `wdq:${withdrawalId}`,
    });
    if (!quote.ok) return { ok: false, reason: quote.reason };
    quoteToken = quote.quoteToken;
  }

  /* THE BALANCE, RE-READ IMMEDIATELY BEFORE THE PAYOUT.
   *
   * The figure checked at request time can be minutes or days old, and the
   * creator's Whop balance moves without us: a prior payout settles, a
   * chargeback claws funds back, they withdraw from Whop's own dashboard.
   * Executing against the stale number would let a withdrawal overspend a
   * balance that no longer exists, and the provider would refuse it after the
   * fact rather than before.
   *
   * There is no lock to take here and none is needed: the provider's balance
   * is the authority, so this narrows the window rather than closing it, and
   * the provider itself refuses an overdraft. */
  const fresh = await readWithdrawableBalance(accountId, withdrawal.currency);
  if (!fresh.ok) return { ok: false, reason: "balance_unavailable" };
  if (withdrawal.amountMinor > fresh.withdrawableMinor) {
    return { ok: false, reason: "insufficient_available" };
  }

  // Claim the row so a second admin cannot execute it concurrently.
  const claimed = await setWithdrawalStatus(db, withdrawalId, environment, "processing", {
    processedByUid: adminUid,
    payoutMethodId,
    // Recorded BEFORE the provider call, so orphan discovery has a lower bound
    // to search from even if the response never arrives.
    providerSubmittedAt: new Date(),
  });
  if (!claimed) return { ok: false, reason: "wrong_status" };

  /* THE PROVIDER CALL. After the commit, never inside it.
   *
   * `amount` is the GROSS the creator asked for — the same figure the ledger
   * just debited. `net_amount` in the response may be lower once provider fees
   * are taken, but the creator's obligation is discharged by what left their
   * balance, not by what survived the fees. Provider fee booking belongs to
   * Task #18. */
  const result = await createPayout({
    accountId,
    payoutMethodId,
    amountMinor: withdrawal.amountMinor,
    currency: "usd",
    // STABLE, DERIVED FROM THE WITHDRAWAL. Reused byte-for-byte on every retry
    // of this withdrawal; a fresh key per attempt is how a retry becomes a
    // second payment.
    idempotencyKey: `wdr:${withdrawalId}`,
    quoteToken,
    withdrawalId,
  });

  if (!result.ok) {
    if (result.outcome === "ambiguous") {
      /* AMBIGUOUS. The payout may exist — a timeout, a 5xx, or a 409 whose
       * meaning the provider does not expose.
       *
       * The status stays non-terminal and the withdrawal keeps its identity.
       * Nothing is restored, because nothing was ever posted: the creator's
       * money is at the provider and the provider's balance is the truth about
       * where it is. Resolution is by asking, never by assuming. */
      await setWithdrawalStatus(db, withdrawalId, environment, "provider_pending", {
        failureReason: result.reason,
      });
      return { ok: false, reason: "payout_ambiguous" };
    }

    /* DEFINITE. The provider did nothing.
     *
     * NO INTERNAL RESTORATION IS NEEDED OR POSSIBLE. No journal was written,
     * and the money never left the creator's Whop balance — so it is still
     * theirs, still withdrawable, and the next attempt will see it.
     *
     * A 403 lands here: write authorization for a child account's payouts is
     * unproven, and this handles it cleanly rather than retrying into a wall. */
    await setWithdrawalStatus(db, withdrawalId, environment, "failed", {
      failureReason: result.reason,
    });
    return { ok: false, reason: result.reason };
  }

  const payout = result.payout;
  const next = mapProviderStatus(payout.status);

  await setWithdrawalStatus(db, withdrawalId, environment, next, {
    providerPayoutId: payout.providerPayoutId,
    providerStatus: payout.status,
    providerSubmittedAt: new Date(),
    failureReason: null,
  });

  notifyWithdrawalProcessing(withdrawal.firebaseUid, withdrawalId).catch(() => {});

  // A provider that answered a terminal status on the create call is settled
  // here rather than waiting for a webhook that may never come.
  if (next === "paid" || FAILURE_PAYOUT_STATUSES.has(payout.status)) {
    await applyProviderTruth(db, withdrawalId, environment, payout.status, payout.failureCode);
  }

  return { ok: true, providerPayoutId: payout.providerPayoutId, status: next };
}

/* -------------------------------------------------------------------------
   Status mapping
   ------------------------------------------------------------------------- */

/**
 * The provider's eight statuses onto our lifecycle.
 *
 * `requested`, `in_review` and `processing` all collapse to
 * `provider_pending`: the provider has it and has not finished, which is the
 * only distinction our lifecycle draws. The raw value is stored alongside in
 * `provider_status`, so nothing the provider said is lost.
 *
 * `canceled` maps to `canceled`, not `failed` — the creator or an operator
 * stopped it, which is a different fact from the provider refusing it.
 */
export function mapProviderStatus(status: ProviderPayoutStatus): WithdrawalStatus {
  if (status === SUCCESS_PAYOUT_STATUS) return "paid";
  if (status === REVERSAL_PAYOUT_STATUS) return "reversed";
  if (status === "canceled") return "canceled";
  if (FAILURE_PAYOUT_STATUSES.has(status)) return "failed";
  if (NONTERMINAL_PAYOUT_STATUSES.has(status)) return "provider_pending";
  return "provider_pending";
}

/* -------------------------------------------------------------------------
   Reconciliation — the only authority
   ------------------------------------------------------------------------- */

export type ReconcileWithdrawalResult =
  | { ok: true; status: WithdrawalStatus; changed: boolean }
  | { ok: false; reason: string };

/**
 * Asks the provider what happened, and applies that.
 *
 * THIS IS THE ONLY FUNCTION THAT MAY CHANGE MONEY STATE from provider input. A
 * webhook payload carries a status, but Task #13 already learned where that
 * leads: the handler wrote money state from values the resource never emits.
 * The payload names a payout; this reads it.
 *
 * `payouts.retrieve` IS SCOPED BY `account_id`, which makes it an ownership
 * proof as well as a read — a payout belonging to someone else is not readable
 * against our creator's account, so an id we do not own cannot move our money.
 */
export async function reconcileWithdrawal(
  withdrawalId: string,
): Promise<ReconcileWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "platform_unavailable" };

  const withdrawal = await loadWithdrawal(db, withdrawalId, environment);
  if (!withdrawal) return { ok: false, reason: "not_found" };
  if (!withdrawal.providerPayoutId) return { ok: false, reason: "no_provider_payout" };

  // A withdrawal that already reached a terminal state is reported unchanged.
  // `paid` is NOT terminal — a settled payout can still be reversed.
  if (TERMINAL_WITHDRAWAL_STATUSES.has(withdrawal.status)) {
    return { ok: true, status: withdrawal.status as WithdrawalStatus, changed: false };
  }

  const account = await getConnectedAccount(withdrawal.firebaseUid, environment);
  if (!account) return { ok: false, reason: "creator_not_found" };

  const result = await retrievePayout(withdrawal.providerPayoutId, account.whopAccountId);
  if (!result.ok) {
    // Not knowing is a state worth preserving. The row is left exactly as it
    // was, and a later sweep tries again.
    return { ok: false, reason: result.reason };
  }

  const changed = await applyProviderTruth(
    db,
    withdrawalId,
    environment,
    result.payout.status,
    result.payout.failureCode,
  );

  return { ok: true, status: mapProviderStatus(result.payout.status), changed };
}

/**
 * Applies one provider status, restoring the obligation where the money did
 * not stay gone.
 *
 * IDEMPOTENT THROUGH TWO MECHANISMS, not one. The status write is guarded in
 * SQL so a redelivery matches no row, and `reverseTransaction` is
 * single-shot at the database level via `uniq_accounting_reversal`. Either
 * alone would leave a gap; together, a webhook delivered five times credits
 * the creator once.
 */
async function applyProviderTruth(
  db: NonNullable<ReturnType<typeof getDb>>,
  withdrawalId: string,
  environment: WhopEnvironmentName,
  providerStatus: ProviderPayoutStatus,
  failureCode: string | null,
): Promise<boolean> {
  const extra = {
    providerStatus,
    providerFailureCode: failureCode,
    reconciledAt: new Date(),
  };

  if (NONTERMINAL_PAYOUT_STATUSES.has(providerStatus)) {
    return setWithdrawalStatus(db, withdrawalId, environment, "provider_pending", extra);
  }

  if (providerStatus === SUCCESS_PAYOUT_STATUS) {
    /* SUCCESS. The money reached the creator's destination.
     *
     * NO LEDGER EFFECT, because none is owed. Task #13 already discharged
     * `creator_payable` when the money entered the creator's Whop account;
     * this withdrawal moved their own funds out of it. No earning row is
     * touched either — a payout is not an earning event. */
    return setWithdrawalStatus(db, withdrawalId, environment, "paid", extra);
  }

  /* EVERYTHING BELOW MEANS THE MONEY DID NOT STAY GONE — and in every case it
   * went back to where it came from, the creator's own Whop balance. There is
   * nothing for us to restore: we never held it and never recorded owing it. */

  if (providerStatus === REVERSAL_PAYOUT_STATUS) {
    /* POST-SUCCESS REVERSAL. The payout settled and the bank returned it.
     *
     * THE FUNDS ARE BACK IN THE CREATOR'S WHOP BALANCE, which is the only
     * place they ever were. The next `readWithdrawableBalance` sees them
     * again, so a fresh withdrawal — a new request id, a new row — can spend
     * them with no bookkeeping on our side at all.
     *
     * NO `creator_payable` CREDIT. Crediting it would invent a ClipRewards
     * liability for money we do not hold, and drive the balance positive
     * against nothing.
     *
     * NO `creator_earnings.reversed`. That status means the creator was never
     * entitled to the money — a refund, a lost dispute — and the dashboard
     * renders it as cancelled. Writing it because DELIVERY failed would cancel
     * a valid earning and drop it out of their lifetime total. `transferred`
     * is terminal in the earning machine precisely so this cannot happen. */
    return setWithdrawalStatus(db, withdrawalId, environment, "reversed", extra);
  }

  // failed | denied | canceled — it ended without paying, so the money never
  // left the creator's balance in the first place.
  const next: WithdrawalStatus = providerStatus === "canceled" ? "canceled" : "failed";
  return setWithdrawalStatus(db, withdrawalId, environment, next, {
    ...extra,
    failureReason: failureCode ?? providerStatus,
  });
}


/* -------------------------------------------------------------------------
   Orphan recovery — a payout we may have made but have no id for
   ------------------------------------------------------------------------- */

export type OrphanRecoveryResult =
  | { ok: true; adopted: true; status: WithdrawalStatus }
  /** Searched, found nothing. NOT proof no payout exists — see below. */
  | { ok: true; adopted: false }
  | {
      ok: false;
      reason:
        | "db_unavailable"
        | "platform_unavailable"
        | "not_found"
        | "creator_not_found"
        | "already_has_payout"
        | "not_recoverable"
        | "ambiguous_matches"
        | "provider_unavailable";
    };

/**
 * Resolves a withdrawal that may have been paid but has no `provider_payout_id`.
 *
 * THE STATE THIS EXISTS FOR. `payouts.create` can reach Whop, create the
 * payout, and have its response lost to a timeout. The withdrawal is then in
 * flight with no id — and `payouts.retrieve` needs exactly that id, so without
 * this the row could never be resolved by any means at all. It was the one
 * state in the lifecycle with no path out.
 *
 * THE SEARCH IS BY OUR OWN METADATA. `metadata.withdrawal_id` is written at
 * creation and echoed on every read, so it names OUR payout exactly; the
 * amount and currency are verified too, because metadata alone would adopt a
 * payout that differs from the one we meant.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO: create the payout again.
 *
 * An empty result is not proof that no payout exists. The provider may be
 * eventually consistent, and the installed SDK nowhere guarantees that reusing
 * an `Idempotency-Key` replays the original rather than creating a second
 * payout. Retrying on "I looked and saw nothing" is precisely how one
 * withdrawal becomes two payments. So a fruitless search leaves the row
 * exactly as it was, to be tried again later or resolved by a human.
 *
 * Safety over automation: the cost of waiting is a delayed withdrawal, and the
 * cost of guessing is paying a creator twice.
 */
export async function recoverOrphanedWithdrawal(
  withdrawalId: string,
): Promise<OrphanRecoveryResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "platform_unavailable" };

  const withdrawal = await loadWithdrawal(db, withdrawalId, environment);
  if (!withdrawal) return { ok: false, reason: "not_found" };

  // Already has an id: ordinary reconciliation, not recovery.
  if (withdrawal.providerPayoutId) return { ok: false, reason: "already_has_payout" };

  // Only a row that actually reached the provider call can have orphaned a
  // payout. One that never got that far has nothing to find.
  if (withdrawal.status !== "processing" && withdrawal.status !== "provider_pending") {
    return { ok: false, reason: "not_recoverable" };
  }
  if (!withdrawal.providerSubmittedAt) return { ok: false, reason: "not_recoverable" };

  const account = await getConnectedAccount(withdrawal.firebaseUid, environment);
  if (!account) return { ok: false, reason: "creator_not_found" };

  const search = await findPayoutByWithdrawalId({
    accountId: account.whopAccountId,
    withdrawalId,
    amountMinor: withdrawal.amountMinor,
    currency: withdrawal.currency,
    // A minute before the attempt, to absorb clock skew between us and Whop
    // without widening the scan into unrelated history.
    createdAfter: new Date(withdrawal.providerSubmittedAt.getTime() - 60_000),
    payoutMethodId: withdrawal.payoutMethodId,
  });

  if (!search.ok) return { ok: false, reason: search.reason };

  if (!search.found) {
    // Left untouched on purpose. See the note above: an empty answer is not
    // permission to pay again.
    return { ok: true, adopted: false };
  }

  /* ADOPT THE ID, then let provider truth decide the state.
   *
   * The write is guarded on `provider_payout_id IS NULL` so two concurrent
   * recoveries cannot point the same withdrawal at two payouts; the loser
   * updates nothing and re-reads what the winner stored. */
  const adopted = await db
    .update(schema.creatorWithdrawals)
    .set({
      providerPayoutId: search.payout.providerPayoutId,
      providerStatus: search.payout.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.creatorWithdrawals.withdrawalId, withdrawalId),
        eq(schema.creatorWithdrawals.environment, environment),
        isNull(schema.creatorWithdrawals.providerPayoutId),
      ),
    )
    .returning({ id: schema.creatorWithdrawals.withdrawalId });

  // Whether we won the adoption or another caller did, provider truth decides
  // the resulting state — so both paths reconcile.
  const reconciled = await reconcileWithdrawal(withdrawalId);
  if (adopted.length === 0 && !reconciled.ok) {
    return { ok: false, reason: "provider_unavailable" };
  }
  return reconciled.ok
    ? { ok: true, adopted: true, status: reconciled.status }
    : { ok: false, reason: "provider_unavailable" };
}

/* -------------------------------------------------------------------------
   The reconciliation sweep
   ------------------------------------------------------------------------- */

export type SweepResult = {
  scanned: number;
  reconciled: number;
  adopted: number;
  unresolved: number;
};

/**
 * Walks the withdrawals the provider has not finished with.
 *
 * WHY THIS HAS TO EXIST. Every other path into the lifecycle is triggered by
 * something arriving — an admin click, a webhook. A withdrawal whose response
 * was lost produces neither, so without a sweep the rows that most need
 * attention are exactly the ones nothing would ever look at.
 *
 * READ-ONLY AT THE PROVIDER. It retrieves and it lists; it never creates a
 * payout, and `recoverOrphanedWithdrawal` will not either.
 *
 * Bounded and environment-scoped. An unbounded sweep against a provider is a
 * way to get rate-limited into the ambiguity it is meant to resolve.
 */
export async function sweepPendingWithdrawals(limit = 25): Promise<SweepResult> {
  const rows = await getWithdrawalsAwaitingProvider(limit);
  const result: SweepResult = { scanned: rows.length, reconciled: 0, adopted: 0, unresolved: 0 };

  const db = getDb();
  const environment = getWhopEnvironment();
  if (!db || !environment) return result;

  for (const { withdrawalId } of rows) {
    const row = await loadWithdrawal(db, withdrawalId, environment);
    if (!row) continue;

    if (row.providerPayoutId) {
      const reconciled = await reconcileWithdrawal(withdrawalId);
      if (reconciled.ok) result.reconciled += 1;
      else result.unresolved += 1;
      continue;
    }

    const recovered = await recoverOrphanedWithdrawal(withdrawalId);
    if (recovered.ok && recovered.adopted) result.adopted += 1;
    else result.unresolved += 1;
  }

  return result;
}

/* -------------------------------------------------------------------------
   Cancellation
   ------------------------------------------------------------------------- */

export type CancelWithdrawalResult =
  | { ok: true }
  | {
      ok: false;
      reason: "db_unavailable" | "not_found" | "wrong_status" | "cannot_cancel_after_submission";
    };

/**
 * Cancels a withdrawal that has not reached the provider.
 *
 * FAILS CLOSED ONCE A PAYOUT EXISTS. The provider does allow cancelling a
 * payout, but only while its status is `in_review` — `requested` answers 409
 * because funds may be converting, and from `processing` on the money is on its
 * way. A local "cancellation" of a payout that is actually in flight would tell
 * the creator their money is back while it is still moving, so this refuses
 * instead. A submitted payout terminates through reconciliation, which is the
 * only thing that knows what really happened.
 */
export async function cancelWithdrawal(
  withdrawalId: string,
  reason?: string,
): Promise<CancelWithdrawalResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "db_unavailable" };

  const withdrawal = await loadWithdrawal(db, withdrawalId, environment);
  if (!withdrawal) return { ok: false, reason: "not_found" };

  if (withdrawal.providerPayoutId) {
    return { ok: false, reason: "cannot_cancel_after_submission" };
  }

  const cancellable: WithdrawalStatus[] = ["requested", "eligible"];
  if (!cancellable.includes(withdrawal.status as WithdrawalStatus)) {
    return { ok: false, reason: "wrong_status" };
  }

  const changed = await setWithdrawalStatus(db, withdrawalId, environment, "canceled", {
    cancelReason: reason ?? null,
  });
  if (!changed) return { ok: false, reason: "wrong_status" };

  /* NOTHING TO RELEASE AND NOTHING TO REVERSE. No journal was written, no
   * earning was linked, and the money never left the creator's Whop balance —
   * so cancelling is purely a status change, and the funds are withdrawable
   * again the moment the provider is next read. */
  return { ok: true };
}

/* -------------------------------------------------------------------------
   Lookups — every one environment-scoped
   ------------------------------------------------------------------------- */

async function loadWithdrawal(
  db: NonNullable<ReturnType<typeof getDb>>,
  withdrawalId: string,
  environment: WhopEnvironmentName,
) {
  const [row] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.withdrawalId, withdrawalId),
        eq(schema.creatorWithdrawals.environment, environment),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findWithdrawalByRequestId(
  db: NonNullable<ReturnType<typeof getDb>>,
  firebaseUid: string,
  environment: WhopEnvironmentName,
  requestId: string,
) {
  const [row] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.firebaseUid, firebaseUid),
        eq(schema.creatorWithdrawals.environment, environment),
        eq(schema.creatorWithdrawals.requestId, requestId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolves a withdrawal from a provider payout id.
 *
 * SCOPED BY ENVIRONMENT, and that is not optional. A `wdrl_` value is Whop's
 * namespace, and sandbox and production are separate id spaces with no
 * guarantee the value is unique across them — matching on the id alone would
 * let a sandbox delivery settle or reverse a production withdrawal. The
 * environment comes from `getWhopEnvironment()`, never from the payload: a
 * caller who could name the environment could aim the write.
 */
export async function findWithdrawalByProviderPayoutId(
  providerPayoutId: string,
): Promise<{ withdrawalId: string } | null> {
  const db = getDb();
  if (!db) return null;

  const environment = getWhopEnvironment();
  if (!environment) return null;

  const [row] = await db
    .select({ withdrawalId: schema.creatorWithdrawals.withdrawalId })
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.providerPayoutId, providerPayoutId),
        eq(schema.creatorWithdrawals.environment, environment),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function getWithdrawal(withdrawalId: string): Promise<WithdrawalView | null> {
  const db = getDb();
  if (!db) return null;
  const environment = getWhopEnvironment();
  if (!environment) return null;
  const row = await loadWithdrawal(db, withdrawalId, environment);
  return row ? toView(row) : null;
}

export async function getActiveWithdrawal(firebaseUid: string): Promise<WithdrawalView | null> {
  const db = getDb();
  if (!db) return null;
  const environment = getWhopEnvironment();
  if (!environment) return null;

  const [row] = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.firebaseUid, firebaseUid),
        eq(schema.creatorWithdrawals.environment, environment),
        inArray(schema.creatorWithdrawals.status, ACTIVE_STATUSES),
      ),
    )
    .limit(1);
  return row ? toView(row) : null;
}

export async function listWithdrawals(firebaseUid: string): Promise<WithdrawalView[]> {
  const db = getDb();
  if (!db) return [];
  const environment = getWhopEnvironment();
  if (!environment) return [];

  const rows = await db
    .select()
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.firebaseUid, firebaseUid),
        eq(schema.creatorWithdrawals.environment, environment),
      ),
    )
    .orderBy(asc(schema.creatorWithdrawals.createdAt));
  return rows.map(toView);
}

/**
 * Withdrawals the provider has accepted but not settled.
 *
 * The reconciliation sweep's only query, and the reason a missing webhook
 * cannot strand a withdrawal forever. Environment-scoped: an unscoped sweep is
 * worse than no sweep, because a sweep's whole job is to act on what it finds.
 */
export async function getWithdrawalsAwaitingProvider(
  limit = 50,
): Promise<{ withdrawalId: string }[]> {
  const db = getDb();
  if (!db) return [];
  const environment = getWhopEnvironment();
  if (!environment) return [];

  return db
    .select({ withdrawalId: schema.creatorWithdrawals.withdrawalId })
    .from(schema.creatorWithdrawals)
    .where(
      and(
        eq(schema.creatorWithdrawals.environment, environment),
        inArray(schema.creatorWithdrawals.status, ["processing", "provider_pending"]),
      ),
    )
    .orderBy(asc(schema.creatorWithdrawals.providerSubmittedAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------
   Serialisation
   ------------------------------------------------------------------------- */

/**
 * The creator-facing shape.
 *
 * WHAT IS DELIBERATELY ABSENT: `providerPayoutId`, `payoutMethodId`,
 * `transferId`, `providerFailureCode`, `accountingTransactionId`. Provider ids
 * and internal plumbing tell a creator nothing they can act on, and a
 * provider failure code is written for operators. `failureReason` is our own
 * vocabulary, never provider prose.
 */
function toView(row: typeof schema.creatorWithdrawals.$inferSelect): WithdrawalView {
  return {
    withdrawalId: row.withdrawalId,
    amountMinor: row.amountMinor,
    reservedAmountMinor: row.reservedAmountMinor,
    currency: row.currency,
    status: row.status as WithdrawalStatus,
    failureReason: row.failureReason ?? null,
    cancelReason: row.cancelReason ?? null,
    requestedAt: row.requestedAt,
    paidAt: row.paidAt ?? null,
    failedAt: row.failedAt ?? null,
    canceledAt: row.canceledAt ?? null,
    reversedAt: row.reversedAt ?? null,
  };
}

export { TERMINAL_STATUSES as WITHDRAWAL_TERMINAL_STATUSES };

/**
 * What the creator can actually withdraw right now, in minor units.
 *
 * Reads the PROVIDER's withdrawable balance for their own Whop account, which
 * is the only figure a payout can be checked against. Not `creator_payable`:
 * Task #13 discharges that the moment the money reaches the creator, so it
 * reads zero exactly when a withdrawal becomes possible.
 *
 * Returns null when the provider cannot be read. Callers must render that as
 * "cannot tell right now" and NEVER as a zero balance — a zero invites the
 * creator to conclude their money is gone.
 */
export async function getWithdrawableBalance(firebaseUid: string): Promise<bigint | null> {
  const environment = getWhopEnvironment();
  if (!environment) return null;

  const account = await getConnectedAccount(firebaseUid, environment);
  if (!account) return null;

  const balance = await readWithdrawableBalance(account.whopAccountId);
  return balance.ok ? balance.withdrawableMinor : null;
}
