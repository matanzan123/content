import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { canRelease, remainingCreatorNet } from "./creator-earnings-policy";

/* ==========================================================================
   THE CREATOR'S FINANCIAL POSITION — one answer to "what is this creator owed".

   THERE USED TO BE TWO ANSWERS, and they disagreed.

   `creator_earnings` rows carried a whole-row status, and the number shown to
   a creator was a sum over those rows. The ledger carried a `creator_payable`
   balance built from the same events. Nothing compared them, and a Task #13
   admin transfer moved only one of them: it debited `creator_payable` but
   marked no earning row, so the creator kept seeing money that had already
   left. The same balance could then be withdrawn again through Task #15.

   THE LEDGER IS NOW THE MONETARY AUTHORITY.

   That choice is not arbitrary. The ledger is double-entry, append-only, and
   already records every event that changes the obligation — the revenue split
   that creates it, the payout that discharges it, the reversal that restores
   it, and the refund or lost dispute that unwinds it. Earning rows record only
   one of those four. Deriving the obligation from the ledger means a transfer
   cannot move the books without moving the creator's balance, because they are
   the same number read twice.

   `creator_earnings` REMAINS THE AUDIT TRAIL and keeps two jobs no ledger
   account can do: it says WHEN money matures (`hold_until`) and whether a
   dispute has frozen it. Those are not monetary facts, they are eligibility
   facts, and they are what separates "owed" from "withdrawable".

   WHY `available` IS NOT THE RAW LEDGER BALANCE.

   `postRevenueSplit` credits `creator_payable` the moment an earning is
   recorded, while the earning itself is still `held`. So the ledger balance
   includes money the creator is owed but may not yet take. Subtracting the
   still-held portion is what turns an obligation into a withdrawable amount:

       payable   = -(sum of creator_payable entries for this creator)
       pending   = net of earnings still held or frozen
       available = payable - pending

   NO EARNING ALLOCATION IS INVENTED. A $20 transfer against a $100 earning
   moves the ledger by $20 and leaves the $100 row untouched and truthful. The
   row says what was earned; the ledger says what is still owed. Marking the
   whole row "transferred" would have been a lie worth $80.

   WHAT THIS DELIBERATELY DOES NOT COUNT: an external payout (Task #15).

   A Task #13 transfer DISCHARGES this obligation — it moves the money into
   the creator's own Whop account, after which ClipRewards owes them nothing
   and `creator_payable` is correctly zero. A Task #15 withdrawal then moves
   THE CREATOR'S OWN FUNDS from that Whop balance to their bank, and touches
   no liability of ours at all.

   An earlier version of Task #15 subtracted in-flight withdrawals here and
   posted a second `creator_payable` debit when the payout executed. Both were
   wrong for the same reason: they treated money we had already handed over as
   though we still owed it, which drove the balance negative and left a
   creator whose funds had reached their Whop account unable to withdraw at
   all. Withdrawal eligibility is the provider's withdrawable balance, not
   this figure.
   ========================================================================== */

export type CreatorPosition = {
  currency: string;
  /** Sum of net amounts ever earned, excluding reversed. Audit figure. */
  earnedMinor: bigint;
  /** Net amount unwound by refunds or lost disputes. Audit figure. */
  reversedMinor: bigint;
  /** Net amount still inside its hold window, or frozen by a dispute. */
  pendingMinor: bigint;
  /** THE OBLIGATION, from the ledger. What we still owe, all states. */
  payableMinor: bigint;
  /** What the creator may withdraw now: payable minus pending. */
  availableMinor: bigint;
  /** Net amount on earnings already marked transferred. Audit figure. */
  transferredMinor: bigint;
  /**
   * Set when the numbers cannot be true at once — a negative obligation, or
   * pending exceeding payable. Surfaced rather than clamped away: a balance
   * that silently reads zero hides the fault that produced it.
   */
  inconsistency: PositionInconsistency | null;
};

export type PositionInconsistency =
  /** The ledger says we owe a negative amount: more paid out than credited. */
  | "negative_payable"
  /** More is held than is owed. Rows and ledger disagree. */
  | "pending_exceeds_payable";

export type PositionResult =
  | { ok: true; position: CreatorPosition }
  | { ok: false; reason: "db_unavailable" };

/**
 * Anything that can run a query: the pool, or an open transaction.
 *
 * Accepting a transaction is what lets a caller take a row lock, read the
 * position, and post against it without another writer slipping in between.
 */
type Queryable = NonNullable<ReturnType<typeof getDb>>;

/* -------------------------------------------------------------------------
   The ledger side
   ------------------------------------------------------------------------- */

/**
 * What we still owe this creator, from the journal.
 *
 * SIGNS. A credit is stored negative and a debit positive, so the raw sum of
 * `creator_payable` entries for a creator is negative while money is owed.
 * The obligation is therefore the NEGATED sum, and that single minus sign is
 * the reason this lives in one function instead of being written out at each
 * call site.
 *
 * SCOPED THREE WAYS: the account, the creator, and the environment. The
 * environment lives on the transaction, not the entry, so the join is not
 * optional — without it a sandbox read would include production obligations.
 */
async function ledgerPayableMinor(
  db: Queryable,
  firebaseUid: string,
  environment: "sandbox" | "production",
): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${schema.accountingEntries.amountMinor}), 0)::text`,
    })
    .from(schema.accountingEntries)
    .innerJoin(
      schema.accountingTransactions,
      eq(schema.accountingEntries.transactionId, schema.accountingTransactions.transactionId),
    )
    .where(
      and(
        eq(schema.accountingEntries.account, "creator_payable"),
        eq(schema.accountingEntries.counterpartyId, firebaseUid),
        eq(schema.accountingTransactions.environment, environment),
      ),
    );

  return -BigInt(row?.total ?? "0");
}

/* -------------------------------------------------------------------------
   The eligibility side
   ------------------------------------------------------------------------- */

type EligibilityRow = {
  status: string;
  netAmountMinor: bigint;
  grossAmountMinor: bigint;
  platformFeeBps: number;
  /** Cumulative gross refunded. Reduces what this earning still represents. */
  refundedGrossMinor: bigint;
  holdUntil: Date;
  frozenByDispute: boolean;
  currency: string;
};

/**
 * Reads the earning rows that decide eligibility and the audit figures.
 *
 * Environment-scoped, like every other read in this domain.
 */
async function eligibilityRows(
  db: Queryable,
  firebaseUid: string,
  environment: "sandbox" | "production",
): Promise<EligibilityRow[]> {
  return db
    .select({
      status: schema.creatorEarnings.status,
      netAmountMinor: schema.creatorEarnings.netAmountMinor,
      grossAmountMinor: schema.creatorEarnings.grossAmountMinor,
      platformFeeBps: schema.creatorEarnings.platformFeeBps,
      refundedGrossMinor: schema.creatorEarnings.refundedGrossMinor,
      holdUntil: schema.creatorEarnings.holdUntil,
      frozenByDispute: schema.creatorEarnings.frozenByDispute,
      currency: schema.creatorEarnings.currency,
    })
    .from(schema.creatorEarnings)
    .where(
      and(
        eq(schema.creatorEarnings.firebaseUid, firebaseUid),
        eq(schema.creatorEarnings.environment, environment),
      ),
    );
}

/* -------------------------------------------------------------------------
   The one helper
   ------------------------------------------------------------------------- */

/**
 * Computes the creator's position, optionally inside a caller's transaction.
 *
 * Pass `db` when the caller has already opened a transaction and taken a lock;
 * a reserving caller MUST do that, or two of them can read the same balance
 * and both spend it.
 */
export async function computeCreatorPosition(
  firebaseUid: string,
  environment: "sandbox" | "production",
  db: Queryable,
): Promise<CreatorPosition> {
  const [payableMinor, rows] = await Promise.all([
    ledgerPayableMinor(db, firebaseUid, environment),
    eligibilityRows(db, firebaseUid, environment),
  ]);

  const now = new Date();
  const currency = rows.find(Boolean)?.currency ?? "usd";

  let earnedMinor = BigInt(0);
  let reversedMinor = BigInt(0);
  let pendingMinor = BigInt(0);
  let transferredMinor = BigInt(0);

  for (const row of rows) {
    // A mixed-currency row cannot be added to a single total. Skipping keeps
    // the figure honest for the dominant currency; a second currency becoming
    // real is a product decision, not something to average over.
    if (row.currency !== currency) continue;

    if (row.status === "reversed") {
      reversedMinor += row.netAmountMinor;
      continue;
    }

    /* PARTIAL REFUNDS REDUCE WHAT THIS EARNING STILL REPRESENTS.
     *
     * `net_amount_minor` is what the earning was WORTH when created, not what
     * is still owed. One payment may be refunded many times, and each refund
     * returns part of the creator's share to suspense. Using the original net
     * here would overstate the creator on every aggregate and put the row
     * totals permanently at odds with the ledger — which is precisely the
     * `payable_mismatch` the reconciler would then report forever.
     *
     * `remainingCreatorNet` derives the remainder from the cumulative refunded
     * gross through the canonical fee policy. It is not a second formula. */
    const remaining = remainingCreatorNet(row, row.refundedGrossMinor);
    const returned = row.netAmountMinor - remaining;

    // The returned portion is economically reversed, and is reported as such
    // so that earned + reversed still totals what was originally earned.
    reversedMinor += returned;
    earnedMinor += remaining;

    if (row.status === "transferred") {
      transferredMinor += remaining;
      continue;
    }

    // What is left is unsettled: `held` or `available`. Either is pending
    // while its hold window is open or a dispute has frozen it. `canRelease`
    // is the single definition of both conditions and is reused here rather
    // than restated, so the balance and the release path can never drift.
    if (!canRelease(row.holdUntil, row.frozenByDispute, now)) {
      pendingMinor += remaining;
    }
  }

  const rawAvailable = payableMinor - pendingMinor;

  // A negative figure is never shown as money. It is reported as a fault, and
  // the withdrawable amount floors at zero so nothing downstream can spend a
  // negative number into a positive one.
  let inconsistency: PositionInconsistency | null = null;
  if (payableMinor < BigInt(0)) inconsistency = "negative_payable";
  else if (rawAvailable < BigInt(0)) inconsistency = "pending_exceeds_payable";

  const availableMinor = rawAvailable > BigInt(0) ? rawAvailable : BigInt(0);

  return {
    currency,
    earnedMinor,
    reversedMinor,
    pendingMinor,
    payableMinor: payableMinor > BigInt(0) ? payableMinor : BigInt(0),
    availableMinor,
    transferredMinor,
    inconsistency,
  };
}

/** Convenience wrapper for read-only callers with no open transaction. */
export async function getCreatorPosition(
  firebaseUid: string,
  environment: "sandbox" | "production",
): Promise<PositionResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  return { ok: true, position: await computeCreatorPosition(firebaseUid, environment, db) };
}

/* -------------------------------------------------------------------------
   Reserving against the position
   ------------------------------------------------------------------------- */

export type ReservationOutcome =
  | { ok: true; position: CreatorPosition }
  | {
      ok: false;
      reason: "insufficient_available";
      /**
       * What WAS available, so a caller can tell "you have nothing" from "you
       * asked for more than you have". Two different messages to a creator,
       * and the distinction is gone once this returns a bare reason.
       */
      availableMinor: bigint;
    }
  // Split rather than combined, so a `reason ===` check actually narrows the
  // union down to one member and the insufficiency's extra field stays
  // reachable at the call site.
  | { ok: false; reason: "position_inconsistent" }
  | { ok: false; reason: "creator_not_found" };

/**
 * Takes the per-creator lock and proves an amount is covered.
 *
 * MUST BE CALLED INSIDE A TRANSACTION, with the money-moving write that
 * follows it in the SAME transaction. That is the whole point: the check and
 * the debit have to be one atomic act, or two admins clicking at once both see
 * the same balance and both spend it.
 *
 * THE LOCK IS THE CREATOR'S `whop_accounts` ROW. It is the one row that
 * already exists once per creator per environment, so it serialises every
 * money movement for that creator — an admin transfer and a creator withdrawal
 * contend for the same lock and cannot interleave. Locking the earning rows
 * instead would not work: the position is partly a ledger aggregate, and new
 * entries can appear under a range lock.
 *
 * Returns the position as it was UNDER THE LOCK, so the caller posts against a
 * figure that cannot have moved.
 */
export async function reserveFromPosition(
  tx: Queryable,
  firebaseUid: string,
  environment: "sandbox" | "production",
  amountMinor: bigint,
): Promise<ReservationOutcome> {
  const locked = await tx
    .select({ id: schema.whopAccounts.id })
    .from(schema.whopAccounts)
    .where(
      and(
        eq(schema.whopAccounts.firebaseUid, firebaseUid),
        eq(schema.whopAccounts.environment, environment),
      ),
    )
    .limit(1)
    .for("update");

  if (locked.length === 0) return { ok: false, reason: "creator_not_found" };

  const position = await computeCreatorPosition(firebaseUid, environment, tx);

  // An inconsistent position is not a small balance, it is an unknown one.
  // Refusing beats paying out against a number we cannot vouch for.
  if (position.inconsistency) return { ok: false, reason: "position_inconsistent" };

  if (amountMinor > position.availableMinor) {
    return {
      ok: false,
      reason: "insufficient_available",
      availableMinor: position.availableMinor,
    };
  }

  return { ok: true, position };
}

/* -------------------------------------------------------------------------
   Earning state machine
   ------------------------------------------------------------------------- */

/** The `creator_earning_status` enum, named so the guards can be typed by it. */
export type EarningStatusName = "held" | "available" | "transferred" | "reversed";

/**
 * The only transitions an earning may make.
 *
 * `transferred` AND `reversed` ARE BOTH TERMINAL. Nothing leaves either.
 *
 * WHAT `reversed` MEANS, AND WHY IT IS NARROW. It means the EARNING ITSELF
 * was invalidated — a refund, a lost dispute, a chargeback. The creator was
 * never entitled to the money. Every reader in the codebase treats it that
 * way: `computeCreatorPosition` excludes reversed rows from `earnedMinor`,
 * and the creator's dashboard renders the bucket as "Reversed" — "בוטל",
 * literally CANCELLED, to a Hebrew-reading creator.
 *
 * A PAYOUT OR WITHDRAWAL REVERSAL IS A DIFFERENT DOMAIN EVENT and must not
 * be written here. The entitlement is untouched; only the attempt to DELIVER
 * the money was returned. Recording that as an earning reversal would tell a
 * creator their valid $100 was cancelled, drop it out of their lifetime
 * earnings, and leave them owed nothing — when in truth the money came back
 * to us and we still owe it.
 *
 * That event belongs to the WITHDRAWAL and TRANSFER lifecycles, which have
 * `reversed` states of their own meaning exactly this. Its eventual
 * earning-side treatment is a RESTORATION, not a reversal, and a correct one
 * needs BOTH halves: the entitlement restored on the row, and the
 * `creator_payable` obligation credited back in the ledger. Neither half
 * exists yet — nothing currently restores the ledger after a payout
 * reversal — so doing one without the other would leave the two sources
 * disagreeing, which is the defect this whole task exists to remove.
 *
 * DEFERRED TO TASK #15, where the withdrawal lifecycle is wired. Until then
 * this table's job is to make the wrong mutation IMPOSSIBLE rather than
 * merely unwise: an update that tries it matches no rows and is a no-op.
 *
 * Enforced in SQL rather than in a branch — see `earningSourceStatuses`.
 */
export const ALLOWED_EARNING_TRANSITIONS: Record<EarningStatusName, readonly EarningStatusName[]> = {
  held: ["held", "available", "reversed"],
  available: ["available", "transferred", "reversed"],
  // Self-entries only. They keep a REPLAYED delivery inert rather than
  // erroring, while `earningSourceStatuses` drops them from every guard so
  // no other state can reach these two.
  transferred: ["transferred"],
  reversed: ["reversed"],
};

export function isAllowedEarningTransition(from: string, to: string): boolean {
  return (ALLOWED_EARNING_TRANSITIONS[from as EarningStatusName] ?? []).includes(
    to as EarningStatusName,
  );
}

/**
 * States no transition may leave.
 *
 * One set, not two. While `transferred` could still become `reversed` there
 * was a real difference between "nothing leaves" and "nothing spendable
 * leaves"; now that both are terminal the distinction described only the
 * transition that was removed.
 */
export const TERMINAL_EARNING_STATUSES: ReadonlySet<string> = new Set([
  "transferred",
  "reversed",
]);

/**
 * The statuses an update to `next` may legally start from.
 *
 * Fed straight into an `inArray(...)` in the WHERE clause so Postgres
 * evaluates the guard against committed state under a row lock. An
 * application-side `if` loses that race; a WHERE clause does not.
 */
export function earningSourceStatuses(next: EarningStatusName): EarningStatusName[] {
  return (Object.keys(ALLOWED_EARNING_TRANSITIONS) as EarningStatusName[]).filter(
    (from) => from !== next && ALLOWED_EARNING_TRANSITIONS[from].includes(next),
  );
}

/** The guard itself, so every caller spells it the same way. */
export function earningTransitionGuard(next: EarningStatusName) {
  return inArray(schema.creatorEarnings.status, earningSourceStatuses(next));
}
