import { currencyDecimals, minorToDecimal, normaliseCurrency } from "@/lib/server/money";

/* ==========================================================================
   PRESENTING LEDGER FIGURES ON THE ADMIN FINANCE DASHBOARD.

   Extracted from the JSX so it can be tested as behaviour rather than asserted
   against markup, and so the rules below live in one place instead of at each
   render site.

   THREE RULES, ALL OF THEM ABOUT NOT LYING TO AN OPERATOR:

   1. MINOR UNITS ARE NOT DISPLAY UNITS. A ledger stores 204; that is $2.04, not
      two hundred and four dollars. Rendering the raw integer overstates every
      figure by the currency's scale, and the dashboard did exactly that.

   2. THE SCALE COMES FROM THE CURRENCY, never from a constant. JPY has zero
      decimal places: 1000 minor units is ¥1000, and dividing it by 100 would
      understate it hundredfold. `currencyDecimals` is the repository's own
      table and is the only authority used here.

   3. AN UNKNOWN CURRENCY FAILS VISIBLY. A figure whose denomination cannot be
      resolved is shown as unavailable, WITH its raw minor units, rather than
      guessed at or silently labelled as dollars. A number an operator cannot
      trust must not look like one they can.

   NOTHING HERE ADDS ACROSS CURRENCIES. There is deliberately no function that
   takes a list of differently-denominated amounts and returns one total: that
   arithmetic is meaningless, and the way to keep it from happening is to give
   nobody a tool for it.
   ========================================================================== */

/** One ledger figure, formatted for display in its own denomination. */
export type FormattedAmount = {
  /** The amount in major units, e.g. `"-2.04"`. Null when unresolvable. */
  display: string | null;
  /** Upper-case currency code, e.g. `"USD"`. Null when unresolvable. */
  currency: string | null;
  /** Always present: the raw signed minor units, as a string. */
  minor: string;
  /** True when the currency could not be resolved and nothing may be assumed. */
  unresolved: boolean;
};

/**
 * Formats one signed minor-unit amount in its own currency.
 *
 * Returns `unresolved` rather than throwing or defaulting: a dashboard cell has
 * to render something, and the honest something is "we cannot denominate this",
 * accompanied by the integer we do have.
 */
export function formatLedgerAmount(minor: bigint, currency: unknown): FormattedAmount {
  const code = normaliseCurrency(currency);
  const decimals = code === null ? null : currencyDecimals(code);

  if (code === null || decimals === null) {
    return { display: null, currency: null, minor: minor.toString(), unresolved: true };
  }

  const display = minorToDecimal(minor, decimals);
  if (display === null) {
    return { display: null, currency: code.toUpperCase(), minor: minor.toString(), unresolved: true };
  }

  return { display, currency: code.toUpperCase(), minor: minor.toString(), unresolved: false };
}

/** `"-2.04 USD"`, or the raw minor units when the currency is unresolvable. */
export function formatLedgerAmountLabel(minor: bigint, currency: unknown): string {
  const f = formatLedgerAmount(minor, currency);
  if (f.unresolved) return f.currency ? `${f.minor} (${f.currency}?)` : `${f.minor} (?)`;
  return `${f.display} ${f.currency}`;
}

/**
 * Formats a set of per-currency totals as separate figures.
 *
 * Returns a LIST, never a sum. Sorted by currency so the same ledger always
 * reads the same way.
 */
export function formatPerCurrencyTotals(
  totals: readonly { currency: string; totalMinor: bigint }[],
): string[] {
  return [...totals]
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((t) => formatLedgerAmountLabel(t.totalMinor, t.currency));
}

/* -------------------------------------------------------------------------
   Availability
   ------------------------------------------------------------------------- */

/**
 * A count that knows the difference between "none" and "we could not look".
 *
 * THE DISTINCTION IS THE WHOLE POINT. The dashboard summed three reconciler
 * results with `?? 0`, so a reconciler that failed contributed zero and the
 * total rendered as a confident `0` — an outage displayed as a clean bill of
 * health, on the one screen whose job is to say whether the books are sound.
 *
 * `null` means unknown. Any unknown part makes the whole unknown, because a
 * partial count presented as a total is a smaller version of the same lie.
 */
export function sumAvailableCounts(parts: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const part of parts) {
    if (part === null || part === undefined) return null;
    total += part;
  }
  return total;
}

/**
 * Whether a reconciliation dimension may be described as healthy.
 *
 * Healthy requires BOTH that it was reachable and that it found nothing. An
 * unreachable dimension is neither healthy nor unhealthy, and saying either
 * would be inventing a fact.
 */
export function isHealthy(configured: boolean | undefined, findingCount: number | null): boolean {
  return configured === true && findingCount === 0;
}
