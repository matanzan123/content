import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { WhopError } from "@whop/sdk";
import { getDb } from "@/lib/db";
import { accountingEntries, accountingTransactions } from "@/lib/db/schema";
import { describeWhopError, getWhopPaymentsClient, getWhopEnvironment } from "../whop-payments";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "../money";
import { economicKey } from "./accounts";
import { postTransaction } from "./journal";

/* ==========================================================================
   PROVIDER FEE RECONCILIATION — server only.

   WHY THIS EXISTS.

   `whop-payment-posting.ts` posts actual provider fees from `listFees` at the
   moment of `payment.succeeded`. In rare cases, fees are not yet reported by
   the provider at that moment:

     - Zero-fee case: `amount_after_fees === total`, `listFees` empty.
       Settlement posts correctly (zero fee, full provider balance). If Whop
       later charges fees, `provider_balance` in our ledger becomes overstated.

     - Fee update case: fees change after settlement (e.g. a cross-border fee
       applied at batch settlement rather than at payment time).

   In both cases, the journal drifts from the provider's own ledger. This
   module detects and corrects that drift by:

     1. Fetching the current `listFees` total for the payment.
     2. Reading what the journal has already posted for `provider_fee_expense`.
     3. If they differ, posting a `provider_fee_reconciled` delta.

   THE DELTA JOURNAL:

     delta > 0  (fees higher than recorded)
       DR  provider_fee_expense    [delta]
       CR  provider_balance        [delta]

     delta < 0  (fees lower than recorded — e.g. a fee cap or correction)
       DR  provider_balance        [|delta|]
       CR  provider_fee_expense    [|delta|]

   IDEMPOTENCY: keyed on
   `whop:provider_fee_reconciled:<paymentId>:<correctionsAlreadyPosted>`.

   THE COUNT IS THE POINT. The key used to be the payment id alone, which
   allowed exactly ONE correction per payment ever — while these very lines
   promised that calling again after a later fee change would post the
   remaining delta. The second promise could not be kept: a second call was
   refused by the unique economic key and the delta was silently unbookable.

   Keying on how many corrections already exist makes each correction its own
   economic event, in order, the way `whop-dispute-posting.ts` keys each
   dispute movement on its own activity id rather than on the dispute.

   WHY NOT THE PREVIOUS POSTED TOTAL. That was the obvious discriminator and it
   is subtly wrong: a fee total revised DOWN and then back UP to a figure
   already seen reproduces a key already used, and the third genuine correction
   is refused. Keying on `<from>:<to>` fails the same way for the same reason —
   any key built from fee VALUES repeats when a transition repeats. A count
   only ever increases, so it cannot collide.

   REPLAY STILL CONVERGES, and not because of the key: once a correction is
   posted, the posted total equals the provider's total, so a replay computes a
   ZERO delta and returns before it ever builds a key. The key settles the
   narrower race of two callers reading the same state concurrently — both
   compute the same count, both build the same key, and the database admits
   one.

   CURRENCY: fees are always in the payment's own currency (settlement amount),
   and that currency is only ever taken from the provider — the fee lines when
   they supply one, otherwise the payment itself. There is no default and no
   inference from platform configuration: a currency that cannot be proven is a
   refusal, not a `"usd"`. Every fee line must agree, and the result must agree
   with the currency the settlement was booked in, or nothing is posted.
   ========================================================================== */

export type FeeReconcileResult =
  | {
      ok: true;
      deltaMinor: bigint;
      /** True when a delta entry was posted; false when already in sync. */
      posted: boolean;
      transactionId: string | null;
    }
  | { ok: false; reason: FeeReconcileFailure; detail?: string };

/** Every way a fee reconciliation or inspection can fail. */
export type FeeReconcileFailure =
  | "unconfigured"
  | "db_unavailable"
  | "provider_error"
  | "resource_not_found"
  | "unsupported_currency"
  | "currency_mismatch"
  | "amount_unreadable"
  | "journal_refused"
  | "already_reconciled";

/* -------------------------------------------------------------------------
   How much has already been posted for this payment's provider fees
   ------------------------------------------------------------------------- */

/**
 * Sums `provider_fee_expense` legs already in the journal for a payment.
 *
 * Covers both the original `payment_settled` posting AND any previous
 * `provider_fee_reconciled` correction, so the delta is always computed
 * against the most recently posted total.
 */
async function postedFeeTotal(paymentId: string): Promise<bigint | null> {
  const db = getDb();
  if (!db) return null;

  // Environment-scoped: a fee total that summed the other environment's entries
  // would be a wrong figure compared against this environment's provider.
  const environment = getWhopEnvironment();
  if (!environment) return null;

  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${accountingEntries.amountMinor}), 0)::text`,
    })
    .from(accountingEntries)
    .innerJoin(
      accountingTransactions,
      eq(accountingEntries.transactionId, accountingTransactions.transactionId),
    )
    .where(
      and(
        eq(accountingEntries.account, "provider_fee_expense"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
        sql`(
          ${accountingTransactions.providerResourceId} = ${paymentId}
          or ${accountingTransactions.metadata}->>'payment_id' = ${paymentId}
        )`,
      ),
    );

  return rows[0] ? BigInt(rows[0].total) : BigInt(0);
}

/**
 * How many fee corrections this payment already carries.
 *
 * The idempotency discriminator. Counting `provider_fee_reconciled`
 * transactions for this payment gives a value that only ever increases, so
 * every genuine later correction gets a fresh key while two concurrent callers
 * reading the same state get the same one.
 *
 * Scoped exactly as `postedFeeTotal` is — same provider, same environment,
 * same payment-id match on either the resource id or the metadata — so the
 * count and the total can never describe different sets of transactions.
 */
async function reconciliationCount(paymentId: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  const environment = getWhopEnvironment();
  if (!environment) return null;

  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "provider_fee_reconciled"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
        sql`(
          ${accountingTransactions.providerResourceId} = ${paymentId}
          or ${accountingTransactions.metadata}->>'payment_id' = ${paymentId}
        )`,
      ),
    );

  return rows[0] ? Number(rows[0].n) : 0;
}

/* -------------------------------------------------------------------------
   Actual fee total from Whop
   ------------------------------------------------------------------------- */

type ActualFees = {
  total: bigint;
  currency: string;
  /** Each fee line for the delta journal's sourceDetail. */
  lines: { origin: string; amountMinor: bigint }[];
};

async function fetchActualFees(paymentId: string): Promise<
  | { ok: true; fees: ActualFees }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "resource_not_found"
        | "provider_error"
        | "unsupported_currency"
        | "currency_mismatch"
        | "amount_unreadable";
      detail?: string;
    }
> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  let feeLines;
  try {
    feeLines = (await client.payments.listFees({ id: paymentId })).data;
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[fee-reconcile] listFees failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }

  /* CURRENCY COMES FROM THE PROVIDER OR NOT AT ALL.
   *
   * Source order:
   *   1. the fee lines' own settlement currency, when any line supplies one
   *   2. the payment's authoritative currency from `payments.retrieve`
   *
   * There is NO third source. A fee correction booked in a guessed currency is
   * worse than no correction at all: it lands a leg in the wrong denomination
   * on a payment that is already booked in another, and nothing downstream can
   * tell that the number is meaningless. So this fails closed instead.
   */
  let currency: string | null = null;
  const lines: ActualFees["lines"] = [];
  let total = BigInt(0);

  for (const line of feeLines) {
    const raw = line.settlement_amount;
    if (!raw) continue;

    const lineCurrency = normaliseCurrency(raw.currency);
    if (!lineCurrency) return { ok: false, reason: "unsupported_currency", detail: raw.currency };

    /* EVERY LINE MUST AGREE, not just the first one.
     *
     * `settlement_amount` is by contract the line converted into the payment's
     * own currency, so two lines in different currencies cannot both be right.
     * Previously only the first line's currency was read and the rest were
     * summed into it regardless — which would silently add, say, EUR minor
     * units to a USD total and post the sum as USD. Unprovable means refused. */
    if (currency === null) {
      currency = lineCurrency;
    } else if (lineCurrency !== currency) {
      return {
        ok: false,
        reason: "currency_mismatch",
        detail: `fee:${line.origin} ${lineCurrency} vs ${currency}`,
      };
    }

    const decimals = currencyDecimals(currency);
    if (decimals === null || raw.decimals !== decimals) {
      return { ok: false, reason: "amount_unreadable", detail: `fee:${line.origin}` };
    }

    const minor = decimalToMinor(raw.amount, decimals);
    if (minor === null) return { ok: false, reason: "amount_unreadable", detail: `fee:${line.origin}` };
    if (minor === BigInt(0)) continue;

    lines.push({ origin: String(line.origin), amountMinor: minor });
    total += minor;
  }

  if (currency) return { ok: true, fees: { total, currency, lines } };

  /* NO FEE LINE SUPPLIED A CURRENCY — fees are genuinely zero, or not yet
   * reported. The total is zero either way, but the caller still needs a
   * denomination for it, because a zero delta and a posted correction both
   * have to be attributed to a currency.
   *
   * The payment itself is the authority. This is the ONE case that costs a
   * second provider call, and it only happens when the cheaper source proved
   * nothing — exactly the same two-call shape `fetchSettlementFacts` uses, and
   * for the same reason: `listFees` cannot answer this and the payment can. */
  let payment;
  try {
    payment = await client.payments.retrieve({ id: paymentId });
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[fee-reconcile] payment fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error", detail: "retrieve" };
  }

  const paymentCurrency = normaliseCurrency(payment.currency);
  if (!paymentCurrency) {
    // The provider could not prove a currency. Refuse; do not assume one.
    return { ok: false, reason: "unsupported_currency", detail: "payment_currency_unprovable" };
  }

  return { ok: true, fees: { total: BigInt(0), currency: paymentCurrency, lines: [] } };
}

/**
 * The currency this payment is already booked in, from our own journal.
 *
 * NOT A SOURCE OF TRUTH FOR THE CURRENCY — the provider is, above. This is a
 * CONSISTENCY CHECK: if the provider now reports fees in a currency other than
 * the one the settlement was booked in, the two cannot be totalled and the
 * correction must not be posted. `currency_mismatch` has existed in this
 * module's failure set from the start with nothing to raise it; this is it.
 *
 * `null` means there is nothing to check against — no settlement of ours for
 * this payment — and a null must never be read as agreement.
 */
async function bookedSettlementCurrency(paymentId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const environment = getWhopEnvironment();
  if (!environment) return null;

  const rows = await db
    .select({ currency: accountingTransactions.currency })
    .from(accountingTransactions)
    .where(
      and(
        eq(accountingTransactions.economicEvent, "payment_settled"),
        eq(accountingTransactions.provider, "whop"),
        eq(accountingTransactions.environment, environment),
        sql`(
          ${accountingTransactions.providerResourceId} = ${paymentId}
          or ${accountingTransactions.metadata}->>'payment_id' = ${paymentId}
        )`,
      ),
    )
    .limit(1);

  return rows[0]?.currency ?? null;
}

/* -------------------------------------------------------------------------
   Main reconciliation entry point
   ------------------------------------------------------------------------- */

/**
 * Compares the provider's current `listFees` against what the journal has
 * already posted for `provider_fee_expense`, and posts a delta entry if they
 * differ.
 *
 * Safe to call repeatedly: if the ledger is already current, no entry is
 * posted and `posted: false` is returned. If fees have changed since the last
 * reconciliation, the new delta is posted.
 *
 * WHEN TO CALL:
 *   - After a `payment.succeeded` posting that had `feesAreActual: false`
 *   - On a scheduled reconciliation pass (e.g. daily)
 *   - Manually via admin endpoint when a fee discrepancy is suspected
 */
/** What the provider says versus what the journal holds. Read-only. */
export type FeeDriftInspection =
  | {
      ok: true;
      /** Net `provider_fee_expense` currently posted for this payment. */
      postedMinor: bigint;
      /** The provider's own current fee total. */
      actualMinor: bigint;
      /** `actual - posted`. Non-zero means the journal has drifted. */
      deltaMinor: bigint;
      currency: string;
      /** The provider's fee lines behind `actualMinor`. */
      lines: { origin: string; amountMinor: bigint }[];
    }
  | { ok: false; reason: FeeReconcileFailure; detail?: string };

/**
 * Compares the provider's current fee total against what the journal holds.
 *
 * READ-ONLY, and that is the point. The drift scan needs exactly this
 * comparison but must not correct anything, while `reconcileProviderFees` needs
 * it and then posts. Extracting it means there is ONE authoritative comparison
 * rather than a detector that re-derives the provider's fees with its own
 * arithmetic — which is how a detector and a corrector come to disagree about
 * whether anything is wrong at all.
 *
 * Both halves reach `listFees` through `fetchActualFees`, so the provider
 * remains the authority for the amount and no percentage is involved anywhere.
 */
export async function inspectProviderFeeDrift(
  paymentId: string,
): Promise<FeeDriftInspection> {
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "unconfigured" };

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [actualResult, posted, booked] = await Promise.all([
    fetchActualFees(paymentId),
    postedFeeTotal(paymentId),
    bookedSettlementCurrency(paymentId),
  ]);

  if (!actualResult.ok) {
    return { ok: false, reason: actualResult.reason, detail: actualResult.detail };
  }
  if (posted === null) return { ok: false, reason: "db_unavailable" };

  /* THE PROVIDER'S CURRENCY VERSUS THE ONE WE BOOKED THE SETTLEMENT IN.
   *
   * `postedMinor` is a sum of minor units taken from the settlement's own legs,
   * and `actualMinor` is a sum in whatever currency the provider just reported.
   * Subtracting one from the other is only meaningful if both are the same
   * denomination. If they are not, there is no delta to speak of — so this
   * refuses rather than returning a number that looks like one.
   *
   * A payment with no settlement of ours (`null`) has nothing to contradict,
   * and is left to the provider's answer alone. */
  if (booked !== null && booked !== actualResult.fees.currency) {
    return {
      ok: false,
      reason: "currency_mismatch",
      detail: `provider ${actualResult.fees.currency} vs booked ${booked}`,
    };
  }

  return {
    ok: true,
    postedMinor: posted,
    actualMinor: actualResult.fees.total,
    deltaMinor: actualResult.fees.total - posted,
    currency: actualResult.fees.currency,
    lines: actualResult.fees.lines,
  };
}

export async function reconcileProviderFees(
  paymentId: string,
): Promise<FeeReconcileResult> {
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "unconfigured" };

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  // The SAME comparison the drift scan runs, so detection and correction can
  // never disagree about whether this payment drifted or by how much.
  const [inspection, corrections] = await Promise.all([
    inspectProviderFeeDrift(paymentId),
    reconciliationCount(paymentId),
  ]);

  if (!inspection.ok) return { ok: false, reason: inspection.reason, detail: inspection.detail };
  if (corrections === null) return { ok: false, reason: "db_unavailable" };

  // Kept in the original shape so the journal below — including the fee-line
  // origins it puts in `sourceDetail` — is byte-for-byte what it always was.
  const posted = inspection.postedMinor;
  const actualResult = {
    fees: {
      total: inspection.actualMinor,
      currency: inspection.currency,
      lines: inspection.lines,
    },
  };
  const delta = inspection.deltaMinor;

  if (delta === BigInt(0)) {
    return { ok: true, deltaMinor: BigInt(0), posted: false, transactionId: null };
  }

  const currency = actualResult.fees.currency;

  // Build the legs. The delta is always a two-leg entry:
  //   provider_fee_expense  [delta]   — positive = more fees, negative = fewer
  //   provider_balance      [-delta]  — balancing leg
  const absDelta = delta < BigInt(0) ? -delta : delta;
  const sign = delta > BigInt(0) ? BigInt(1) : BigInt(-1);

  const sourceDetail = actualResult.fees.lines.length > 0
    ? actualResult.fees.lines.map((l) => l.origin).join(",")
    : "fee_correction";

  const result = await postTransaction({
    economicEvent: "provider_fee_reconciled",
    provider: "whop",
    providerResourceId: paymentId,
    environment,
    currency,
    // Each correction is its own economic event, numbered in order. See the
    // module header for why a fee VALUE cannot serve as the discriminator.
    idempotencyKey: economicKey(
      "whop",
      "provider_fee_reconciled",
      `${paymentId}:${corrections}`,
    ),
    description: `Provider fee reconciliation — payment ${paymentId}`,
    metadata: {
      delta_minor: delta.toString(),
      fee_lines: actualResult.fees.lines.length,
      previously_posted_minor: posted.toString(),
      actual_total_minor: actualResult.fees.total.toString(),
      // Which correction in the sequence this is. Zero-based, matching the key.
      correction_index: corrections,
    },
    legs: [
      {
        account: "provider_fee_expense",
        amountMinor: sign * absDelta,
        counterpartyType: "provider",
        counterpartyId: "whop",
        sourceDetail,
      },
      {
        account: "provider_balance",
        amountMinor: -(sign * absDelta),
        counterpartyType: "provider",
        counterpartyId: "whop",
      },
    ],
  });

  if (!result.ok) {
    return { ok: false, reason: "journal_refused" };
  }

  if (result.alreadyPosted) {
    return { ok: false, reason: "already_reconciled" };
  }

  return {
    ok: true,
    deltaMinor: delta,
    posted: true,
    transactionId: result.transactionId,
  };
}
