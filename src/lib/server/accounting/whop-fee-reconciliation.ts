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

   IDEMPOTENCY: keyed on `whop:provider_fee_reconciled:<paymentId>`.
   Only ONE reconciliation per payment is recorded. If fees change again after
   a reconciliation, call this function again — it reads the CURRENT posted
   total (including any previous reconciliation) and posts the remaining delta.

   CURRENCY: fees are always in the payment's own currency (settlement amount).
   ========================================================================== */

export type FeeReconcileResult =
  | {
      ok: true;
      deltaMinor: bigint;
      /** True when a delta entry was posted; false when already in sync. */
      posted: boolean;
      transactionId: string | null;
    }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "db_unavailable"
        | "provider_error"
        | "resource_not_found"
        | "unsupported_currency"
        | "currency_mismatch"
        | "amount_unreadable"
        | "journal_refused"
        | "already_reconciled";
      detail?: string;
    };

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
        sql`(
          ${accountingTransactions.providerResourceId} = ${paymentId}
          or ${accountingTransactions.metadata}->>'payment_id' = ${paymentId}
        )`,
      ),
    );

  return rows[0] ? BigInt(rows[0].total) : BigInt(0);
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

  // Derive currency from the first fee line that has one, or from the payment.
  let currency: string | null = null;
  const lines: ActualFees["lines"] = [];
  let total = BigInt(0);

  for (const line of feeLines) {
    const raw = line.settlement_amount;
    if (!raw) continue;

    if (!currency) {
      currency = normaliseCurrency(raw.currency);
      if (!currency) return { ok: false, reason: "unsupported_currency", detail: raw.currency };
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

  if (!currency) {
    // No fee lines at all — fees are genuinely zero (or not yet reported).
    // Caller treats this as delta = 0 - posted, which means if we previously
    // posted fees, they've been removed. If we posted nothing, no-op.
    return { ok: true, fees: { total: BigInt(0), currency: "usd", lines: [] } };
  }

  return { ok: true, fees: { total, currency, lines } };
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
export async function reconcileProviderFees(
  paymentId: string,
): Promise<FeeReconcileResult> {
  const environment = getWhopEnvironment();
  if (!environment) return { ok: false, reason: "unconfigured" };

  const db = getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };

  const [actualResult, posted] = await Promise.all([
    fetchActualFees(paymentId),
    postedFeeTotal(paymentId),
  ]);

  if (!actualResult.ok) return actualResult;
  if (posted === null) return { ok: false, reason: "db_unavailable" };

  const delta = actualResult.fees.total - posted;

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
    idempotencyKey: economicKey("whop", "provider_fee_reconciled", paymentId),
    description: `Provider fee reconciliation — payment ${paymentId}`,
    metadata: {
      delta_minor: delta.toString(),
      fee_lines: actualResult.fees.lines.length,
      previously_posted_minor: posted.toString(),
      actual_total_minor: actualResult.fees.total.toString(),
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
