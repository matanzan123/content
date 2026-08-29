import { INTL_LOCALE, type Locale } from "./config";

/**
 * Locale-aware formatting, centralised so no component ever concatenates a
 * currency symbol onto a number by hand.
 *
 * Currency is a business fact, not a language one: the product prices in USD, so
 * USD stays USD in Hebrew. Only the *presentation* changes — Hebrew renders it
 * as ‎$1,250 with the digits and symbol kept in logical order.
 */

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions) {
  const key = `n:${locale}:${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(INTL_LOCALE[locale], options);
    cache.set(key, f);
  }
  return f;
}

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions) {
  return numberFormat(locale, options ?? {}).format(value);
}

/** Whole-dollar amounts stay whole; cents are shown only when present. */
export function formatCurrency(
  locale: Locale,
  value: number,
  currency = "USD",
  options?: Intl.NumberFormatOptions,
) {
  return numberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    ...options,
  }).format(value);
}

export function formatPercent(locale: Locale, value: number, options?: Intl.NumberFormatOptions) {
  return numberFormat(locale, { style: "percent", maximumFractionDigits: 0, ...options }).format(
    value / 100,
  );
}

/** Compact counts — 27.3M, 4.2K — in the reader's own notation. */
export function formatCompact(locale: Locale, value: number) {
  return numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(locale: Locale, iso: string, options?: Intl.DateTimeFormatOptions) {
  const key = `d:${locale}:${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
      ...options,
    });
    cache.set(key, f);
  }
  return f.format(new Date(`${iso}T00:00:00Z`));
}

/** "3 days ago" / "לפני 3 ימים". */
export function formatRelative(locale: Locale, value: number, unit: Intl.RelativeTimeFormatUnit) {
  const key = `r:${locale}`;
  let f = cache.get(key) as Intl.RelativeTimeFormat | undefined;
  if (!f) {
    f = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: "auto" });
    cache.set(key, f);
  }
  return f.format(value, unit);
}
