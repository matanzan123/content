/* ==========================================================================
   REPORTING RANGE AND TIMEZONE

   One definition of "today", shared by every query and every label.

   Timestamps are stored in UTC. The dashboard reports in a single configured
   admin timezone rather than in whichever timezone the viewer's laptop happens
   to be set to — otherwise two admins comparing "yesterday" would be looking
   at different windows and neither would know.
   ========================================================================== */

/** Change here to move all reporting. Configurable per deployment later. */
export const ADMIN_TIMEZONE = process.env.ADMIN_TIMEZONE ?? "UTC";

export const RANGE_KEYS = ["today", "yesterday", "7d", "30d", "90d", "year"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const COMPARE_KEYS = ["none", "previous", "year"] as const;
export type CompareKey = (typeof COMPARE_KEYS)[number];

export type Range = {
  key: RangeKey;
  from: Date;
  to: Date;
  /** Bucket size for time series over this range. */
  bucket: "hour" | "day" | "week";
};

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

export function isCompareKey(value: unknown): value is CompareKey {
  return typeof value === "string" && (COMPARE_KEYS as readonly string[]).includes(value);
}

/** Start of a day in the reporting timezone, expressed as a UTC instant. */
function startOfDay(offsetDays = 0): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ADMIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  const date = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
}

export function resolveRange(key: RangeKey): Range {
  const now = new Date();
  switch (key) {
    case "today":
      return { key, from: startOfDay(), to: now, bucket: "hour" };
    case "yesterday":
      return { key, from: startOfDay(-1), to: startOfDay(), bucket: "hour" };
    case "7d":
      return { key, from: startOfDay(-6), to: now, bucket: "day" };
    case "30d":
      return { key, from: startOfDay(-29), to: now, bucket: "day" };
    case "90d":
      return { key, from: startOfDay(-89), to: now, bucket: "day" };
    case "year": {
      const from = startOfDay();
      from.setUTCMonth(0, 1);
      return { key, from, to: now, bucket: "week" };
    }
  }
}

/**
 * The window a comparison is measured against.
 *
 * Returns null when the mode is "none". The caller must additionally check
 * that data actually exists in the returned window — a percentage against a
 * period the product was not yet collecting in would be meaningless, and the
 * UI shows "not enough history" instead.
 */
export function resolveComparison(range: Range, mode: CompareKey): { from: Date; to: Date } | null {
  if (mode === "none") return null;
  const span = range.to.getTime() - range.from.getTime();

  if (mode === "previous") {
    return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) };
  }

  const from = new Date(range.from);
  const to = new Date(range.to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  to.setUTCFullYear(to.getUTCFullYear() - 1);
  return { from, to };
}

/** Percentage change, or null when the baseline is zero — not Infinity. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
