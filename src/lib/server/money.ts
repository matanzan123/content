import "server-only";

/* ==========================================================================
   MONEY CONVERSION — exact, never floating point.

   Whop reports amounts as a decimal STRING plus a `decimals` precision
   ("10.00", decimals 2). We store minor units as a bigint. Converting between
   them through `Number` would be the one place a rounding error could enter a
   payment comparison, so nothing here parses a float: the string is split on
   its decimal point, the fraction is padded or checked, and the result is
   assembled as a BigInt.

   Every function refuses rather than guesses. An amount that cannot be
   converted exactly is not an amount we are willing to compare a payment
   against.
   ========================================================================== */

/** Decimal string in major units, exactly as a provider reports it. */
const DECIMAL = /^-?\d{1,15}(\.\d{1,8})?$/;

/**
 * "10.00" at 2 decimals -> 1000n.
 *
 * Returns null when the string is not a plain decimal, when the precision does
 * not fit, or when the fraction carries more digits than the currency has —
 * truncating a real sub-unit would silently change an amount.
 */
export function decimalToMinor(amount: string, decimals: number): bigint | null {
  if (typeof amount !== "string" || !DECIMAL.test(amount.trim())) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;

  const negative = amount.trim().startsWith("-");
  const [whole, fraction = ""] = amount.trim().replace("-", "").split(".");
  if (fraction.length > decimals) return null;

  const padded = fraction.padEnd(decimals, "0");
  try {
    const value = BigInt(whole + padded);
    return negative ? -value : value;
  } catch {
    return null;
  }
}

/** 1000n at 2 decimals -> "10.00". The form Whop's plan price expects. */
export function minorToDecimal(minor: bigint, decimals: number): string | null {
  if (typeof minor !== "bigint") return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;
  if (decimals === 0) return minor.toString();

  const negative = minor < BigInt(0);
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Currencies this build is willing to charge in, with their minor-unit
 * precision. A closed list on purpose: a currency we have not thought about is
 * one whose decimals we would be guessing at, and a guess here mis-states a
 * price by a factor of ten or a hundred.
 */
export const SUPPORTED_CURRENCIES: Record<string, number> = { usd: 2 };

export function currencyDecimals(currency: unknown): number | null {
  if (typeof currency !== "string") return null;
  const code = currency.trim().toLowerCase();
  return code in SUPPORTED_CURRENCIES ? SUPPORTED_CURRENCIES[code] : null;
}

export function normaliseCurrency(currency: unknown): string | null {
  if (typeof currency !== "string") return null;
  const code = currency.trim().toLowerCase();
  return /^[a-z]{3}$/.test(code) && code in SUPPORTED_CURRENCIES ? code : null;
}

/** Bounds a chargeable amount. Zero and negative are not payments. */
export function isChargeableAmount(minor: bigint): boolean {
  return typeof minor === "bigint" && minor > BigInt(0) && minor <= BigInt(100000000);
}
