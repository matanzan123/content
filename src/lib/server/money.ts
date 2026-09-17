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
 *
 * SOURCE: Whop's `Currencies` enum cross-referenced with Stripe's decimal
 * classification (which Whop inherits). Crypto and non-ISO currencies
 * (`eth`, `btc`, `usdt`, `ape`, `whop_usd`, `xau`) are intentionally
 * excluded — they carry non-integer or extremely large decimal precision
 * that is incompatible with this module's bigint arithmetic.
 *
 * DECIMAL RULES:
 *   0  — zero-decimal (Stripe classification): JPY, KRW, VND, CLP, PYG,
 *         RWF, XOF, MGA
 *   3  — three-decimal: BHD, JOD, KWD, OMR, TND
 *   2  — everything else (standard ISO 4217)
 */
export const SUPPORTED_CURRENCIES: Record<string, number> = {
  // ---- Zero-decimal --------------------------------------------------
  jpy: 0, // Japanese yen
  krw: 0, // South Korean won
  vnd: 0, // Vietnamese đồng
  clp: 0, // Chilean peso
  pyg: 0, // Paraguayan guaraní
  rwf: 0, // Rwandan franc
  xof: 0, // West African CFA franc
  mga: 0, // Malagasy ariary
  // ---- Three-decimal -------------------------------------------------
  bhd: 3, // Bahraini dinar
  jod: 3, // Jordanian dinar
  kwd: 3, // Kuwaiti dinar
  omr: 3, // Omani rial
  tnd: 3, // Tunisian dinar
  // ---- Two-decimal (alphabetical) ------------------------------------
  aed: 2, // UAE dirham
  all: 2, // Albanian lek
  amd: 2, // Armenian dram
  ars: 2, // Argentine peso
  aud: 2, // Australian dollar
  awg: 2, // Aruban florin
  azn: 2, // Azerbaijani manat
  bam: 2, // Bosnia-Herzegovina convertible mark
  bgn: 2, // Bulgarian lev
  bob: 2, // Bolivian boliviano
  brl: 2, // Brazilian real
  bsd: 2, // Bahamian dollar
  cad: 2, // Canadian dollar
  chf: 2, // Swiss franc
  cny: 2, // Chinese yuan
  cop: 2, // Colombian peso
  crc: 2, // Costa Rican colón
  czk: 2, // Czech koruna
  dkk: 2, // Danish krone
  dop: 2, // Dominican peso
  dzd: 2, // Algerian dinar
  egp: 2, // Egyptian pound
  etb: 2, // Ethiopian birr
  eur: 2, // Euro
  gbp: 2, // British pound
  ghs: 2, // Ghanaian cedi
  gmd: 2, // Gambian dalasi
  gtq: 2, // Guatemalan quetzal
  gyd: 2, // Guyanese dollar
  hkd: 2, // Hong Kong dollar
  huf: 2, // Hungarian forint (ISO 2; Stripe rounds to 100 for payments)
  idr: 2, // Indonesian rupiah
  ils: 2, // Israeli new shekel
  inr: 2, // Indian rupee
  jmd: 2, // Jamaican dollar
  kes: 2, // Kenyan shilling
  khr: 2, // Cambodian riel
  kzt: 2, // Kazakhstani tenge
  lkr: 2, // Sri Lankan rupee
  mad: 2, // Moroccan dirham
  mdl: 2, // Moldovan leu
  mkd: 2, // Macedonian denar
  mnt: 2, // Mongolian tögrög
  mop: 2, // Macanese pataca
  mur: 2, // Mauritian rupee
  mxn: 2, // Mexican peso
  myr: 2, // Malaysian ringgit
  nad: 2, // Namibian dollar
  ngn: 2, // Nigerian naira
  nok: 2, // Norwegian krone
  nzd: 2, // New Zealand dollar
  pen: 2, // Peruvian sol
  php: 2, // Philippine peso
  pkr: 2, // Pakistani rupee
  pln: 2, // Polish złoty
  qar: 2, // Qatari riyal
  ron: 2, // Romanian leu
  rsd: 2, // Serbian dinar
  rub: 2, // Russian ruble
  sar: 2, // Saudi riyal
  sek: 2, // Swedish krona
  sgd: 2, // Singapore dollar
  thb: 2, // Thai baht
  try: 2, // Turkish lira
  ttd: 2, // Trinidad and Tobago dollar
  twd: 2, // New Taiwan dollar
  usd: 2, // US dollar
  uyu: 2, // Uruguayan peso
  uzs: 2, // Uzbekistani som
  xcd: 2, // East Caribbean dollar
  zar: 2, // South African rand
  // ---- Excluded (not ISO fiat) ----------------------------------------
  // eth, btc, usdt, ape  → crypto; non-integer minor-unit precision
  // whop_usd             → Whop internal credits; not a real currency
  // xau                  → gold spot; no fixed minor-unit scale
};

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
