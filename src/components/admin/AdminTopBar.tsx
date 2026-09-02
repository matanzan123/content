"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { DateRangeControl } from "./DateRangeControl";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/**
 * Page title, reporting window, identity and sign-out.
 *
 * Deliberately none of the public marketing navigation: this is an operating
 * console, and a link back into the funnel would be noise.
 *
 * `showRange` is off for pages whose data is not windowed (System, Audit),
 * because a range control that changes nothing is a lie about what the page
 * is showing.
 */
export function AdminTopBar({
  t,
  title,
  email,
  timezone,
  showRange = true,
}: {
  t: Copy;
  title: string;
  email: string | null;
  timezone: string;
  showRange?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // The name is only ever an email or a generic label — never the raw Firebase
  // uid, which is an internal identifier and reads as noise in a header.
  const identity = email ?? t.administrator;

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--a-border)] bg-[color:var(--a-bg)]/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <h1 className="me-auto text-[15px] font-bold tracking-tight">{title}</h1>

        {showRange && <DateRangeControl t={t} />}

        <button
          type="button"
          onClick={() => router.refresh()}
          className="flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--a-border)] px-2.5 text-[12.5px] text-[color:var(--a-text-muted)] transition-colors hover:text-[color:var(--a-text)]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M20 11a8 8 0 10-2.3 5.7" strokeLinecap="round" />
            <path d="M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t.refresh}
        </button>

        <LanguageSelector className="hidden sm:inline-flex" />

        <div className="flex items-center gap-2">
          <span
            className="hidden max-w-[190px] truncate text-[12.5px] text-[color:var(--a-text-muted)] sm:inline"
            title={identity}
          >
            <span className={email ? "ltr-token" : undefined}>{identity}</span>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fetch("/api/admin/session", { method: "DELETE" });
              } finally {
                router.refresh();
              }
            }}
            className="rounded-md border border-[color:var(--a-border)] px-3 py-1.5 text-[12.5px] font-medium text-[color:var(--a-text-muted)] transition-colors hover:text-[color:var(--a-text)] disabled:opacity-60"
          >
            {t.signOut}
          </button>
        </div>
      </div>

      <p className="px-4 pb-2 text-[11px] text-[color:var(--a-text-dim)] sm:px-6">
        {t.timezoneNote.replace("{tz}", timezone)}
      </p>
    </header>
  );
}
