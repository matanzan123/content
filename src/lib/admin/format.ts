import type { RangeKey } from "@/lib/analytics/range";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

/* ==========================================================================
   ADMIN FORMATTING

   All of it goes through Intl with the reporting timezone, so a figure means
   the same thing to every admin regardless of where their laptop is.

   Currency is NOT derived from language: a Hebrew reader still sees USD as
   USD. Language and money are separate axes.
   ========================================================================== */

const intlLocale = (locale: "en" | "he") => (locale === "he" ? "he-IL" : "en-US");

export function formatNumber(value: number, locale: "en" | "he"): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    notation: value >= 100000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number, locale: "en" | "he"): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/** Human duration from seconds: "4m 12s", "1h 05m". */
export function formatDuration(seconds: number, locale: "en" | "he"): string {
  const n = (v: number) => new Intl.NumberFormat(intlLocale(locale)).format(v);
  if (seconds < 60) return `${n(Math.round(seconds))}s`;
  if (seconds < 3600) return `${n(Math.floor(seconds / 60))}m ${n(Math.round(seconds % 60))}s`;
  return `${n(Math.floor(seconds / 3600))}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** Axis label for a time bucket, at a granularity that matches the range. */
export function formatBucket(iso: string, range: RangeKey, locale: "en" | "he"): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions =
    range === "today" || range === "yesterday"
      ? { hour: "2-digit", minute: "2-digit", timeZone: ADMIN_TIMEZONE }
      : { day: "numeric", month: "short", timeZone: ADMIN_TIMEZONE };
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(date);
}

export function formatDateTime(iso: string | null, locale: "en" | "he"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ADMIN_TIMEZONE,
  }).format(new Date(iso));
}

/**
 * Localized country name from an ISO code.
 *
 * `Intl.DisplayNames` is what turns "IL" into "Israel" or "ישראל" without us
 * shipping a country table. A code the runtime does not recognise falls back
 * to the code itself rather than to a guess.
 */
export function countryName(
  code: string | null,
  locale: "en" | "he",
  unknownLabel: string,
): string {
  if (!code) return unknownLabel;
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Flag emoji from an ISO alpha-2 code, for a compact visual anchor. */
export function countryFlag(code: string | null): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "🏳";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}
