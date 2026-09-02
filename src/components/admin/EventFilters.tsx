"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/**
 * Filters for the event explorer.
 *
 * Only structured, low-cardinality fields are filterable: event name, locale,
 * country and a path prefix. There is deliberately no free-text search across
 * the row — the columns that would make that useful (search terms, form
 * values) are not stored, and offering the box would imply they are.
 *
 * State lives in the URL so a filtered view is shareable and the server stays
 * the single source of truth.
 */
export function EventFilters({ t, eventNames }: { t: Copy; eventNames: string[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current page offset.
    next.delete("page");
    startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }));
  }

  const field =
    "rounded-md border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] px-2.5 py-1.5 text-[12.5px] text-[color:var(--a-text)] outline-none";

  return (
    <div className="flex flex-wrap items-end gap-3" data-pending={pending ? "true" : undefined}>
      <div className="flex flex-col gap-1">
        <label htmlFor="ev-name" className="text-[11px] text-[color:var(--a-text-dim)]">
          {t.eventName}
        </label>
        <select
          id="ev-name"
          className={field}
          value={params.get("event") ?? ""}
          onChange={(e) => set("event", e.target.value)}
        >
          <option value="">{t.filterAll}</option>
          {eventNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ev-locale" className="text-[11px] text-[color:var(--a-text-dim)]">
          {t.localeDistribution}
        </label>
        <select
          id="ev-locale"
          className={field}
          value={params.get("evLocale") ?? ""}
          onChange={(e) => set("evLocale", e.target.value)}
        >
          <option value="">{t.filterAll}</option>
          <option value="en">en</option>
          <option value="he">he</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ev-country" className="text-[11px] text-[color:var(--a-text-dim)]">
          {t.countryDistribution}
        </label>
        <input
          id="ev-country"
          className={`${field} ltr-token w-[90px]`}
          dir="ltr"
          maxLength={2}
          placeholder="IL"
          defaultValue={params.get("country") ?? ""}
          onBlur={(e) => set("country", e.target.value.trim().toUpperCase())}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ev-path" className="text-[11px] text-[color:var(--a-text-dim)]">
          {t.page}
        </label>
        <input
          id="ev-path"
          className={`${field} ltr-token w-[180px]`}
          dir="ltr"
          placeholder="/he"
          defaultValue={params.get("path") ?? ""}
          onBlur={(e) => set("path", e.target.value.trim())}
        />
      </div>
    </div>
  );
}
