import "server-only";

/* ==========================================================================
   WHICH ACCOUNT A PROVIDER FEE LINE BELONGS IN.

   `payments.listFees` returns one line per fee, each naming itself with
   Whop's own `origin`. Almost every origin is a real cost of taking the
   payment and belongs in `provider_fee_expense`. Two are not costs at all:

     sales_tax_remittance           Whop handing the sales tax it collected to
                                    the tax authority. That is TAX PRINCIPAL
                                    moving, not a fee we were charged.
     sales_tax_remittance_reversal  the same movement undone.

   Booking those two as expense does two wrongs at once: it overstates
   `provider_fee_expense` by the tax, and it leaves `tax_payable` — credited at
   settlement from the provider's own `tax_amount` — never discharged, growing
   without bound for the life of the platform. The journal still BALANCES,
   because the two errors are equal and opposite, which is exactly why nothing
   caught it.

   `stripe_sales_tax_fee` IS a fee and stays in `provider_fee_expense`. It is
   what Stripe charges for operating tax calculation — a service we are billed
   for, not tax anyone owes. The names are similar and the accounting is not.

   ---------------------------------------------------------------------------
   SIGNS ARE THE PROVIDER'S, AND ARE NEVER TOUCHED HERE.

   Whop documents no sign convention for either remittance origin — verified
   against the installed SDK, where both appear as bare enum members in
   `PaymentFee.Origin`, `LedgerActivity.LineType` and the financial-report line
   types, with no statement about direction. So this module does not assume one.
   It maps an origin to an ACCOUNT and changes nothing else.

   That is not caution for its own sake; it is what keeps the books correct
   whichever convention Whop uses:

     - Reclassifying a leg cannot unbalance a transaction. The settlement's
       identity is `amount_after_fees + Σ(all fee lines) == total`, checked
       exactly. Moving a line to another account leaves `Σ` untouched, so the
       check and the balance hold for any sign.

     - The reversal's direction is FORCED by the provider's own arithmetic, not
       by a rule of ours. Both lines feed the same `Σ` that has to reconcile
       against `amount_after_fees` and `total`; a reversal that did not carry
       the opposite sign to the remittance would break Whop's own identity, and
       the posting would already be refused as `fees_do_not_reconcile`.

   So a remittance whose amount is positive DEBITS `tax_payable` and discharges
   the liability; its reversal, carrying the opposite sign, CREDITS it back. No
   sign is flipped, negated or inferred anywhere in this file, and any hand-made
   rule about direction would be a guess this design does not need.
   ========================================================================== */

/**
 * The fee origins that move tax principal rather than charge us a fee.
 *
 * `stripe_sales_tax_fee` is deliberately NOT here — see the header.
 */
export const TAX_REMITTANCE_ORIGINS = [
  "sales_tax_remittance",
  "sales_tax_remittance_reversal",
] as const;

/**
 * The `source_detail` we put on a NET remittance movement of our own.
 *
 * The settlement posts one leg per provider line and can name the exact origin.
 * The refund and reconciliation paths post a DIFFERENCE between two totals,
 * which cannot honestly claim to be a specific line — it may net a remittance
 * against a reversal. So those legs get this label instead: recognised by
 * `isTaxRemittanceOrigin` like the real origins, but visibly not pretending to
 * be one of them.
 */
export const TAX_REMITTANCE_NET_SOURCE_DETAIL = "sales_tax_remittance_net";

const TAX_REMITTANCE_SET: ReadonlySet<string> = new Set<string>([
  ...TAX_REMITTANCE_ORIGINS,
  TAX_REMITTANCE_NET_SOURCE_DETAIL,
]);

/** The two ledger accounts a provider fee line can land in. */
export type FeeLedgerAccount = "provider_fee_expense" | "tax_payable";

/**
 * True when this origin moves tax principal.
 *
 * Compared on a trimmed, lower-cased string. Whop sends lower case; normalising
 * anyway costs nothing and a mis-cased origin here would silently book tax as
 * an expense, which is the whole defect this module exists to prevent.
 */
export function isTaxRemittanceOrigin(origin: unknown): boolean {
  return typeof origin === "string" && TAX_REMITTANCE_SET.has(origin.trim().toLowerCase());
}

/**
 * The account a fee line with this origin belongs to.
 *
 * Every origin that is not a tax remittance keeps the behaviour it has always
 * had, including origins this build has never seen: an unknown fee is still a
 * fee, and defaulting an unrecognised line to `tax_payable` would be far worse
 * than leaving it in expense where it is visible.
 */
export function feeAccountForOrigin(origin: unknown): FeeLedgerAccount {
  return isTaxRemittanceOrigin(origin) ? "tax_payable" : "provider_fee_expense";
}

/** A fee line reduced to the two things classification needs. */
export type ClassifiableFeeLine = { origin: string; amountMinor: bigint };

export type FeeSplit<L extends ClassifiableFeeLine> = {
  /** Signed total of the lines that are genuinely fees. */
  providerFeeMinor: bigint;
  /** Signed total of the lines that move tax principal. */
  taxRemittanceMinor: bigint;
  providerFeeLines: L[];
  taxRemittanceLines: L[];
  /** Signed total of every line, whatever its class. */
  totalMinor: bigint;
};

/**
 * Splits fee lines into the two accounts they belong to, preserving signs.
 *
 * `totalMinor` is the sum of both classes and is deliberately reported: it is
 * the figure the provider's own arithmetic check uses, and it must stay equal
 * to what the un-split code summed or the reconciliation identity would shift
 * underneath the settlement rule.
 */
export function splitFeeLines<L extends ClassifiableFeeLine>(lines: readonly L[]): FeeSplit<L> {
  const providerFeeLines: L[] = [];
  const taxRemittanceLines: L[] = [];
  let providerFeeMinor = BigInt(0);
  let taxRemittanceMinor = BigInt(0);

  for (const line of lines) {
    if (isTaxRemittanceOrigin(line.origin)) {
      taxRemittanceLines.push(line);
      taxRemittanceMinor += line.amountMinor;
    } else {
      providerFeeLines.push(line);
      providerFeeMinor += line.amountMinor;
    }
  }

  return {
    providerFeeMinor,
    taxRemittanceMinor,
    providerFeeLines,
    taxRemittanceLines,
    totalMinor: providerFeeMinor + taxRemittanceMinor,
  };
}

/**
 * SQL fragment listing the remittance origins, for a `source_detail` filter.
 *
 * A `tax_payable` leg can now come from two unrelated places: the buyer's tax
 * (credited at settlement, debited when a refund returns some) and Whop's
 * remittance of that tax onward. Readers that mean one must not sum the other,
 * and `source_detail` is where the origin already lives — so no column, and no
 * migration, is needed to tell them apart.
 */
export const TAX_REMITTANCE_SOURCE_DETAIL_SQL = [
  ...TAX_REMITTANCE_ORIGINS,
  TAX_REMITTANCE_NET_SOURCE_DETAIL,
]
  .map((o) => `'${o}'`)
  .join(", ");
