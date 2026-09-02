"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { COMPARE_KEYS, RANGE_KEYS, type CompareKey, type RangeKey } from "@/lib/analytics/range";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

type StringKey = { [K in keyof Copy]: Copy[K] extends string ? K : never }[keyof Copy];

const RANGE_LABEL: Record<RangeKey, StringKey> = {
  today: "rangeToday",
  yesterday: "rangeYesterday",
  "7d": "range7",
  "30d": "range30",
  "90d": "range90",
  year: "rangeYear",
};

const COMPARE_LABEL: Record<CompareKey, StringKey> = {
  none: "compareNone",
  previous: "comparePrevious",
  year: "compareYear",
};

/**
 * The range lives in the URL, not in component state.
 *
 * That makes a filtered view shareable and bookmarkable between admins, keeps
 * the server components as the source of truth, and means every panel on the
 * page re-queries against the same window instead of each holding its own idea
 * of "the last 30 days".
 */
export function DateRangeControl({ t }: { t: Copy }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const range = (params.get("range") ?? "30d") as RangeKey;
  const compare = (params.get("compare") ?? "none") as CompareKey;

  function set(key: "range" | "compare", value: string) {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }));
  }

  const selectClass =
    "rounded-md border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] px-2.5 py-1.5 text-[12.5px] text-[color:var(--a-text)] outline-none transition-colors hover:border-[color:var(--a-border-strong)]";

  return (
    <div className="flex items-center gap-2" data-pending={pending ? "true" : undefined}>
      <label className="sr-only" htmlFor="admin-range">
        {t.dateRange}
      </label>
      <select
        id="admin-range"
        value={range}
        onChange={(e) => set("range", e.target.value)}
        className={selectClass}
      >
        {RANGE_KEYS.map((key) => (
          <option key={key} value={key}>
            {t[RANGE_LABEL[key]]}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="admin-compare">
        {t.compare}
      </label>
      <select
        id="admin-compare"
        value={compare}
        onChange={(e) => set("compare", e.target.value)}
        className={selectClass}
      >
        {COMPARE_KEYS.map((key) => (
          <option key={key} value={key}>
            {t[COMPARE_LABEL[key]]}
          </option>
        ))}
      </select>
    </div>
  );
}
