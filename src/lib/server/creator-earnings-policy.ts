import "server-only";

/* ==========================================================================
   CREATOR EARNINGS POLICY — server only.

   THE SINGLE AUTHORITATIVE PLACE for earnings calculation rules.
   Every fee, hold period, and state transition is defined here and only here.
   No other file may compute fees or hold periods from scratch.

   POLICY AS OF TASK #14:

   PLATFORM FEE
     Rate:        PLATFORM_FEE_BPS env var (basis points), default 2000 = 20%
     Fixed:       PLATFORM_PROCESSING_FEE_MINOR env var (minor units), default 0
                  A per-transaction fixed fee kept by the platform even on refund.
                  Set to 0 until the business decides the specific amount.
     Base:        gross amount the brand paid (before provider fees)
     NOT:         calculated from net-after-provider-fees
     NOT:         passed on to creator as a deduction of provider fees
     Why:         Provider fees are a platform expense. The creator's share is
                  calculated on what the brand paid. This is simpler, more legible
                  to creators, and consistent: a creator earning $100 campaign
                  value always knows their net is based on the agreed rate,
                  regardless of Whop's fees.

   REFUND FEE REVERSAL
     Policy: the percentage portion of the platform fee is returned pro-rata.
             The fixed processing fee (if any) is kept even on refund.
             computeRefundSplitReversal() encodes this rule.

   HOLD PERIOD
     Duration: CREATOR_HOLD_DAYS env var, default 7 days from settlement
     Purpose:  Covers the brand refund window. After 7 days, a brand
               refund is still technically possible (chargebacks happen for
               months) but is treated as a platform risk, not a creator hold.
     Dispute:  An open dispute freezes the earning regardless of hold_until.
               The freeze lifts when the dispute resolves. If the dispute is
               lost, the earning is reversed.

   RESERVE / WITHHOLDING
     None in this version. The platform accepts chargeback risk on cleared
     earnings. A reserve policy can be added by introducing a
     CREATOR_RESERVE_BPS env var and a `reserve_payable` account.

   WITHDRAWAL
     Handled entirely by Whop. We track when we send money to the creator's
     Whop account (transferred); what happens between the Whop account and
     the creator's bank is Whop's payout schedule, managed via the portal
     the creator accesses through Task #12. We do not track "withdrawn".

   CURRENCY
     USD only in this version. A currency column is always stored so
     adding other currencies is a new posting rule, not a schema change.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */

/** Basis points. 2000 = 20%. Max 10000 (100%). */
const DEFAULT_PLATFORM_FEE_BPS = 2000;

/** Fixed per-transaction platform fee in minor units (cents). 0 = none. */
const DEFAULT_PLATFORM_PROCESSING_FEE_MINOR = 0;

/** Days from payment settlement until earnings become payable. */
const DEFAULT_CREATOR_HOLD_DAYS = 7;

export function resolvePlatformFeeBps(): number {
  const raw = process.env.PLATFORM_FEE_BPS;
  if (!raw) return DEFAULT_PLATFORM_FEE_BPS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return DEFAULT_PLATFORM_FEE_BPS;
  return n;
}

/**
 * Fixed per-transaction processing fee kept by the platform even on refund.
 * Currently 0 (default) until the business decides the specific amount.
 * Set via PLATFORM_PROCESSING_FEE_MINOR env var (minor units, e.g. 30 = $0.30).
 */
export function resolveProcessingFeeMinor(): bigint {
  const raw = process.env.PLATFORM_PROCESSING_FEE_MINOR;
  if (!raw) return BigInt(DEFAULT_PLATFORM_PROCESSING_FEE_MINOR);
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return BigInt(DEFAULT_PLATFORM_PROCESSING_FEE_MINOR);
  return BigInt(n);
}

export function resolveCreatorHoldDays(): number {
  const raw = process.env.CREATOR_HOLD_DAYS;
  if (!raw) return DEFAULT_CREATOR_HOLD_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_CREATOR_HOLD_DAYS;
  return n;
}

/* -------------------------------------------------------------------------
   Fee calculation — the ONLY place in the codebase these formulas live
   ------------------------------------------------------------------------- */

export type EarningsBreakdown = {
  grossAmountMinor: bigint;
  /** Total platform fee: percentageFeeMinor + processingFeeMinor. */
  platformFeeMinor: bigint;
  /** The fixed per-transaction portion of platformFeeMinor (kept on refund). */
  processingFeeMinor: bigint;
  /** The rate-based portion of platformFeeMinor (returned pro-rata on refund). */
  percentageFeeMinor: bigint;
  netAmountMinor: bigint;
  platformFeeBps: number;
  currency: string;
};

/**
 * Computes the creator's net earnings from a gross payment amount.
 *
 * ROUNDING: platform fee is rounded DOWN (floor) to the nearest minor unit.
 * The creator therefore receives the ceiling of their share. This avoids
 * accumulating fractional amounts that cannot be paid out.
 *
 * PROVIDER FEES: NOT deducted here. They are a platform expense posted
 * separately to `provider_fee_expense`. The creator always earns from gross.
 */
export function computeEarningsBreakdown(
  grossAmountMinor: bigint,
  currency: string,
  overrideFeeBps?: number,
): EarningsBreakdown {
  const feeBps = overrideFeeBps ?? resolvePlatformFeeBps();
  const processingFeeMinor = resolveProcessingFeeMinor();

  // Integer arithmetic only. percentage = floor(gross * bps / 10000)
  const percentageFeeMinor = (grossAmountMinor * BigInt(feeBps)) / BigInt(10_000);
  const platformFeeMinor = percentageFeeMinor + processingFeeMinor;
  const netAmountMinor = grossAmountMinor - platformFeeMinor;

  return {
    grossAmountMinor,
    platformFeeMinor,
    processingFeeMinor,
    percentageFeeMinor,
    netAmountMinor,
    platformFeeBps: feeBps,
    currency,
  };
}

/* -------------------------------------------------------------------------
   Refund fee reversal
   ------------------------------------------------------------------------- */

export type RefundSplitReversal = {
  /** How much to DR creator_payable (return to suspense). */
  creatorShareToReturn: bigint;
  /**
   * How much to DR platform_revenue (the percentage fee portion only —
   * the processing fee is deliberately kept even on a full refund).
   */
  platformFeeToReturn: bigint;
  /** Total: creatorShareToReturn + platformFeeToReturn. */
  totalToReturn: bigint;
};

/**
 * Computes the journal amounts to unwind a revenue split for a refund.
 *
 * PROCESSING FEE KEPT: only the percentage component of the platform fee is
 * returned. The fixed processing fee (PLATFORM_PROCESSING_FEE_MINOR, default 0)
 * stays as platform_revenue regardless of refund size.
 *
 * PARTIAL REFUND: all amounts are pro-rated by refundAmountMinor/gross,
 * integer-floored. The rounding residual stays in unallocated_customer_funds
 * and appears in reconciliation.
 *
 * STORED ROWS: when reversing from a DB row, reconstruct percentageFeeMinor as
 * `(grossAmountMinor * platformFeeBps) / 10000` and processingFeeMinor as
 * `platformFeeMinor - percentageFeeMinor`. This is historically correct even if
 * env vars change later.
 */
export function computeRefundSplitReversal(
  breakdown: Pick<EarningsBreakdown, "grossAmountMinor" | "netAmountMinor" | "percentageFeeMinor">,
  refundAmountMinor: bigint,
): RefundSplitReversal {
  if (refundAmountMinor <= BigInt(0) || breakdown.grossAmountMinor <= BigInt(0)) {
    return { creatorShareToReturn: BigInt(0), platformFeeToReturn: BigInt(0), totalToReturn: BigInt(0) };
  }

  // Full refund shortcut — avoids rounding on clean divisions.
  if (refundAmountMinor >= breakdown.grossAmountMinor) {
    const totalToReturn = breakdown.netAmountMinor + breakdown.percentageFeeMinor;
    return {
      creatorShareToReturn: breakdown.netAmountMinor,
      platformFeeToReturn: breakdown.percentageFeeMinor,
      totalToReturn,
    };
  }

  // Partial: floor both to avoid returning more than exists.
  const platformFeeToReturn = (breakdown.percentageFeeMinor * refundAmountMinor) / breakdown.grossAmountMinor;
  const creatorShareToReturn = (breakdown.netAmountMinor * refundAmountMinor) / breakdown.grossAmountMinor;

  return {
    creatorShareToReturn,
    platformFeeToReturn,
    totalToReturn: creatorShareToReturn + platformFeeToReturn,
  };
}

/* -------------------------------------------------------------------------
   Hold period
   ------------------------------------------------------------------------- */

/**
 * Returns the datetime after which this earning becomes available for payout,
 * absent any dispute.
 */
export function computeHoldUntil(paymentSettledAt: Date, overrideHoldDays?: number): Date {
  const days = overrideHoldDays ?? resolveCreatorHoldDays();
  const holdUntil = new Date(paymentSettledAt.getTime() + days * 24 * 60 * 60 * 1000);
  return holdUntil;
}

/* -------------------------------------------------------------------------
   State transitions — what may change status and to what
   ------------------------------------------------------------------------- */

export type EarningStatus = "held" | "available" | "transferred" | "reversed";

/**
 * Whether a `held` earning may be promoted to `available`.
 *
 * Both conditions must hold:
 *   1. The hold window has expired.
 *   2. No open dispute is attached to this earning.
 */
export function canRelease(
  holdUntil: Date,
  frozenByDispute: boolean,
  now = new Date(),
): boolean {
  return !frozenByDispute && now >= holdUntil;
}

/**
 * Whether a `transferred` earning may still be reversed.
 * (It can — a Whop payout reversal can happen after transfer.)
 */
export function isReversible(status: EarningStatus): boolean {
  return status !== "reversed";
}

/* -------------------------------------------------------------------------
   Balance computation from a list of earnings
   ------------------------------------------------------------------------- */

export type CreatorBalance = {
  currency: string;
  /** Held + available + transferred: lifetime earnings not reversed. */
  earnedMinor: bigint;
  /** In hold window or frozen by dispute. Not yet payable. */
  pendingMinor: bigint;
  /** Hold expired, no dispute. Ready to transfer now. */
  availableMinor: bigint;
  /** A creator_transfer has been initiated. May be en route or completed. */
  transferredMinor: bigint;
  /** Reversed by refund, chargeback, or payout reversal. */
  reversedMinor: bigint;
};

type EarningRow = {
  status: EarningStatus;
  netAmountMinor: bigint;
  holdUntil: Date;
  frozenByDispute: boolean;
  currency: string;
};

/**
 * Derives the balance from a list of earning rows.
 *
 * `available` is computed dynamically: a `held` row is counted as available
 * if `canRelease` returns true, even if the DB status has not been swept yet.
 * This means the balance is always current without requiring a sweep job to
 * have run recently.
 *
 * Currency: rows must all share one currency (USD for now). If they don't,
 * only the first currency seen is returned and others are ignored.
 */
export function computeBalance(rows: EarningRow[], now = new Date()): CreatorBalance {
  const currency = rows.find(Boolean)?.currency ?? "usd";
  let earnedMinor = BigInt(0);
  let pendingMinor = BigInt(0);
  let availableMinor = BigInt(0);
  let transferredMinor = BigInt(0);
  let reversedMinor = BigInt(0);

  for (const row of rows) {
    if (row.currency !== currency) continue; // skip mixed-currency rows

    if (row.status === "reversed") {
      reversedMinor += row.netAmountMinor;
      continue;
    }

    earnedMinor += row.netAmountMinor;

    if (row.status === "transferred") {
      transferredMinor += row.netAmountMinor;
    } else if (row.status === "available") {
      availableMinor += row.netAmountMinor;
    } else {
      // status === "held": check if it should count as available
      if (canRelease(row.holdUntil, row.frozenByDispute, now)) {
        availableMinor += row.netAmountMinor;
      } else {
        pendingMinor += row.netAmountMinor;
      }
    }
  }

  return {
    currency,
    earnedMinor,
    pendingMinor,
    availableMinor,
    transferredMinor,
    reversedMinor,
  };
}
