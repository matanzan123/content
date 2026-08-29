"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_DIRECTION,
  localePath,
  splitLocalePath,
  type Locale,
} from "./config";
import type { Dictionary } from "./dictionaries/en";
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
} from "./format";

/* ==========================================================================
   LOCALE CONTEXT

   The dictionary is resolved on the server and handed down as a plain object,
   so the very first HTML already contains the right language. Client components
   read it through `useI18n()`; nothing fetches or lazy-loads a translation.
   ========================================================================== */

type I18nValue = {
  locale: Locale;
  dir: "ltr" | "rtl";
  t: Dictionary;
  /** Switches language in place — same URL, same scroll position. */
  setLocale: (next: Locale) => void;
  n: (value: number, options?: Intl.NumberFormatOptions) => string;
  currency: (value: number, currency?: string) => string;
  percent: (value: number) => string;
  compact: (value: number) => string;
  date: (iso: string, options?: Intl.DateTimeFormatOptions) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Switches language by swapping the locale segment of the current URL, so the
   * visitor lands on the same page in the other language — /en/discover becomes
   * /he/discover, never the home page. Query string and hash are carried over,
   * both read from the document rather than from useSearchParams(): that hook
   * would force a Suspense boundary and de-opt every page out of static
   * rendering, and inside a click handler the live URL is right there.
   */
  const setLocale = useCallback(
    (next: Locale) => {
      if (next === locale) return;

      const { rest } = splitLocalePath(pathname);
      const { search, hash } = window.location;
      const target = `${localePath(next, rest)}${search}${hash}`;

      // Remember the choice. Middleware also syncs this, but writing it here
      // means the preference is correct even before the next request lands.
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
      router.push(target);
    },
    [locale, pathname, router],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: LOCALE_DIRECTION[locale],
      t: dictionary,
      setLocale,
      n: (v, o) => formatNumber(locale, v, o),
      currency: (v, c) => formatCurrency(locale, v, c),
      percent: (v) => formatPercent(locale, v),
      compact: (v) => formatCompact(locale, v),
      date: (iso, o) => formatDate(locale, iso, o),
    }),
    [locale, dictionary, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Shorthand for the common case of only needing the dictionary. */
export function useT(): Dictionary {
  return useI18n().t;
}
