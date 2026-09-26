import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { canRelease, remainingCreatorNet } from "./creator-earnings-policy";
import { normaliseCurrency } from "./money";

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
  /**
   * The ONE currency every figure below is stated in.
   *
   * `null` only when the creator has no earnings and no payable legs at all:
   * there is no money, so there is nothing to denominate, and naming a currency
   * anyway would be inventing one. Every amount is zero in that case.
   */
  currency: string | null;
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
  | "pending_exceeds_payable"
  /**
   * The creator has money in more than one currency, so no single figure
   * describes what they are owed. The amounts returned alongside this describe
   * ONE of those currencies and are therefore incomplete — which is why this is
   * an inconsistency and not a note. Every consumer already refuses on a set
   * inconsistency, so a payout cannot be made against a partial picture.
   */
  | "mixed_currency"
  /**
   * A stored currency this build cannot convert to exact minor units. Refused
   * rather than skipped: ignoring it would report a position that silently
   * omits real money.
   */
  | "unsupported_currency";

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
 * SCOPED FOUR WAYS: the account, the creator, the environment, and THE
 * CURRENCY. The environment lives on the transaction, not the entry, so that
 * join is not optional — without it a sandbox read would include production
 * obligations.
 *
 * THE CURRENCY IS A REQUIRED PARAMETER, and that is deliberate. This used to
 * sum every `creator_payable` leg the creator had, in any denomination, and
 * return one bigint: 1000 EUR-cents added to 1000 USD-cents came back as 2000
 * of nothing. The figure gates transfers and withdrawals, so it is the last
 * number that should be summed before its denomination is proven. Making the
 * currency an argument rather than an option means a caller cannot reach this
 * without having decided what it is asking about.
 *
 * `accounting_entries.currency` is per leg and NOT NULL — the schema calls it
 * "repeated from the header so a leg can never be read without it" — so this
 * needs no join to the transaction for the currency and no migration.
 */
async function ledgerPayableMinor(
  db: Queryable,
  firebaseUid: string,
  environment: "sandbox" | "production",
  currency: string,
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
        eq(schema.accountingEntries.currency, currency),
      ),
    );

  return -BigInt(row?.total ?? "0");
}

/* -------------------------------------------------------------------------
   Which currency this creator's position is even in
   ------------------------------------------------------------------------- */

export type CurrencyResolution =
  /** Exactly one currency is present. The position can be stated in it. */
  | { kind: "single"; currency: string }
  /** No earnings and no payable legs. There is nothing to denominate. */
  | { kind: "none" }
  /** More than one. Every currency found, sorted, so the report is stable. */
  | { kind: "mixed"; currencies: string[] }
  /** A currency this build cannot do exact minor-unit arithmetic in. */
  | { kind: "unsupported"; currencies: string[] };

/**
 * Finds every currency this creator has money in, from BOTH sides.
 *
 * WHY BOTH SIDES. The position compares a ledger obligation against earning
 * rows, so a currency present in only one of them still makes the comparison
 * meaningless. Reading just the earning rows — which is what the old
 * `rows.find(Boolean)?.currency` did — would miss a `creator_payable` leg in
 * another denomination entirely.
 *
 * NO DEFAULT IS INVENTED. The old code fell back to `"usd"` when a creator had
 * no rows, which stated a denomination for money that did not exist, and picked
 * the FIRST row's currency otherwise — from a query with no ORDER BY, so for a
 * mixed creator the answer could differ between two calls and the whole
 * position was non-deterministic. This returns what is actually there and lets
 * the caller decide, and its ordering is explicit so the answer is stable.
 *
 * UNSUPPORTED FAILS CLOSED rather than being filtered out. A stored currency
 * this build cannot scale to minor units is a data fault, and dropping it would
 * quietly report a position that ignores real money.
 */
export async function resolveCreatorCurrency(
  db: Queryable,
  firebaseUid: string,
  environment: "sandbox" | "production",
): Promise<CurrencyResolution> {
  const [earningRows, ledgerRows] = await Promise.all([
    db
      .selectDistinct({ currency: schema.creatorEarnings.currency })
      .from(schema.creatorEarnings)
      .where(
        and(
          eq(schema.creatorEarnings.firebaseUid, firebaseUid),
          eq(schema.creatorEarnings.environment, environment),
        ),
      ),
    db
      .selectDistinct({ currency: schema.accountingEntries.currency })
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
      ),
  ]);

  const raw = [...earningRows, ...ledgerRows].map((r) => r.currency);

  // Stored codes are trimmed and lower-cased before comparison: `char(3)` pads,
  // so a leg read back can carry trailing spaces that would otherwise look like
  // a different currency from the same code on an earning row.
  const seen = new Set<string>();
  const unsupported = new Set<string>();
  for (const value of raw) {
    const code = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!code) continue;
    const normalised = normaliseCurrency(code);
    if (!normalised) {
      unsupported.add(code);
      continue;
    }
    seen.add(normalised);
  }

  if (unsupported.size > 0) {
    return { kind: "unsupported", currencies: [...unsupported].sort() };
  }
  if (seen.size === 0) return { kind: "none" };
  if (seen.size === 1) return { kind: "single", currency: [...seen][0] };
  return { kind: "mixed", currencies: [...seen].sort() };
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
export async function computeCreatorPositionInCurrency(
  firebaseUid: string,
  environment: "sandbox" | "production",
  db: Queryable,
  currency: string,
  /** Carried through when the caller already knows the position is partial. */
  presetInconsistency: PositionInconsistency | null = null,
): Promise<CreatorPosition> {
  /* THE CURRENCY IS PROVEN BEFORE ANY SUM IS TAKEN. An unsupported code cannot
   * be scaled to minor units, so there is no honest figure to return for it. */
  const target = normaliseCurrency(currency);
  if (!target) {
    return {
      currency: null,
      earnedMinor: BigInt(0),
      reversedMinor: BigInt(0),
      pendingMinor: BigInt(0),
      payableMinor: BigInt(0),
      availableMinor: BigInt(0),
      transferredMinor: BigInt(0),
      inconsistency: "unsupported_currency",
    };
  }

  const [payableMinor, rows] = await Promise.all([
    ledgerPayableMinor(db, firebaseUid, environment, target),
    eligibilityRows(db, firebaseUid, environment),
  ]);

  const now = new Date();

  let earnedMinor = BigInt(0);
  let reversedMinor = BigInt(0);
  let pendingMinor = BigInt(0);
  let transferredMinor = BigInt(0);

  for (const row of rows) {
    /* ONLY THE TARGET CURRENCY. A row in another denomination is real money
     * that this figure does not describe, so it is left out rather than added —
     * and the caller is told the position is partial through `mixed_currency`,
     * so the omission is never silent.
     *
     * Trimmed and lower-cased on both sides: `char(3)` pads on storage, so a
     * padded `"usd "` must not read as a different currency from `"usd"`. */
    if (row.currency?.trim().toLowerCase() !== target) continue;

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
  // A preset fault outranks the arithmetic ones: if the position is already
  // known to be partial, that is the more important thing to say about it.
  let inconsistency: PositionInconsistency | null = presetInconsistency;
  if (inconsistency === null) {
    if (payableMinor < BigInt(0)) inconsistency = "negative_payable";
    else if (rawAvailable < BigInt(0)) inconsistency = "pending_exceeds_payable";
  }

  const availableMinor = rawAvailable > BigInt(0) ? rawAvailable : BigInt(0);

  return {
    currency: target,
    earnedMinor,
    reversedMinor,
    pendingMinor,
    payableMinor: payableMinor > BigInt(0) ? payableMinor : BigInt(0),
    availableMinor,
    transferredMinor,
    inconsistency,
  };
}

/**
 * The creator's position, with the currency resolved from their own data.
 *
 * FOR CALLERS THAT HAVE NO CURRENCY TO OFFER — the balance a creator is shown,
 * and the reconciler sweeping every creator. A money-moving caller should use
 * `computeCreatorPositionInCurrency` and name the currency it is moving, so the
 * cap it checks is denominated in the same thing as the amount it is paying.
 *
 * WHAT IT DOES WITH EACH OUTCOME:
 *
 *   single       state the position in that currency — the ordinary case, and
 *                byte-for-byte what this function always returned for a
 *                single-currency creator
 *   none         an empty position with a NULL currency. No money exists, so
 *                nothing is denominated and nothing is invented
 *   mixed        the alphabetically first currency's figures, flagged
 *                `mixed_currency`. Deterministic, so two calls agree, and
 *                flagged, so no consumer treats a partial figure as the whole
 *   unsupported  refused outright as `unsupported_currency`
 */
export async function computeCreatorPosition(
  firebaseUid: string,
  environment: "sandbox" | "production",
  db: Queryable,
): Promise<CreatorPosition> {
  const resolution = await resolveCreatorCurrency(db, firebaseUid, environment);

  switch (resolution.kind) {
    case "single":
      return computeCreatorPositionInCurrency(firebaseUid, environment, db, resolution.currency);

    case "mixed":
      /* THE FIRST BY CODE, not the first row a query happened to return. The
       * choice is arbitrary but it must be STABLE: the figures accompany a
       * `mixed_currency` flag that makes them unusable for payment anyway, and
       * an unstable pick would make the same creator's balance change between
       * two reads for no reason. */
      return computeCreatorPositionInCurrency(
        firebaseUid,
        environment,
        db,
        resolution.currencies[0],
        "mixed_currency",
      );

    case "unsupported":
      return {
        currency: null,
        earnedMinor: BigInt(0),
        reversedMinor: BigInt(0),
        pendingMinor: BigInt(0),
        payableMinor: BigInt(0),
        availableMinor: BigInt(0),
        transferredMinor: BigInt(0),
        inconsistency: "unsupported_currency",
      };

    case "none":
      // Nothing earned, nothing owed. A real, consistent zero — not a fault.
      return {
        currency: null,
        earnedMinor: BigInt(0),
        reversedMinor: BigInt(0),
        pendingMinor: BigInt(0),
        payableMinor: BigInt(0),
        availableMinor: BigInt(0),
        transferredMinor: BigInt(0),
        inconsistency: null,
      };
  }
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
  /**
   * THE CURRENCY THE AMOUNT IS IN. Required, because the comparison below is
   * between two numbers and is only meaningful if both are the same money. The
   * cap is computed in exactly this currency, so a creator owed 1000 EUR-cents
   * cannot cover a request for 1000 USD-cents.
   */
  currency: string,
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

  /* IN THE REQUESTED CURRENCY, not in whichever one this creator's data
   * happens to suggest. A payout is denominated by the payout, and resolving
   * the currency from the creator's rows here would let a request in one
   * currency be capped by a balance in another. */
  const position = await computeCreatorPositionInCurrency(
    firebaseUid,
    environment,
    tx,
    currency,
  );

  // An inconsistent position is not a small balance, it is an unknown one.
  // Refusing beats paying out against a number we cannot vouch for. An
  // unsupported currency arrives here as exactly that kind of refusal.
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
