/**
 * Locale configuration.
 *
 * URL strategy: locale is carried by a cookie, not by a path prefix. Every
 * existing route (`/`, `/brand`, `/discover`, …) keeps working unchanged, and a
 * language switch never moves the visitor to a different URL. The root layout
 * reads the cookie on the server, so the first byte of HTML already carries the
 * right `lang`, `dir` and copy — no flash, no hydration mismatch.
 *
 * The cost is that pages render per request rather than being prerendered. If
 * locale-prefixed URLs are wanted later for SEO, the dictionary layer below does
 * not change: only the resolver in `server.ts` and a route group would.
 */

export const SUPPORTED_LOCALES = ["en", "he"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Namespaced, no personal data, readable by the server on the first request. */
export const LOCALE_COOKIE = "cliprewards_locale";

/** One year — a language preference should not quietly expire. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_DIRECTION: Record<Locale, "ltr" | "rtl"> = {
  en: "ltr",
  he: "rtl",
};

/** What the language selector shows. Names are written in their own language. */
export const LOCALE_LABELS: Record<Locale, { short: string; name: string }> = {
  en: { short: "EN", name: "English" },
  he: { short: "עב", name: "עברית" },
};

/** BCP 47 tags used for Intl formatting. */
export const INTL_LOCALE: Record<Locale, string> = {
  en: "en-US",
  he: "he-IL",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Picks a locale from an Accept-Language header, honouring quality values.
 * Returns null when nothing in the header is supported, so the caller can fall
 * through to the next signal rather than guessing.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split("=")[1]) || 0 : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    // "he", "he-IL" and the legacy "iw" all mean Hebrew.
    const base = tag.split("-")[0];
    if (base === "he" || base === "iw") return "he";
    if (base === "en") return "en";
  }
  return null;
}

/**
 * Geo fallback, used only when the browser told us nothing usable.
 *
 * No IP is read, stored or sent anywhere. This reads a country code that the
 * hosting platform may attach to the request (Vercel's `x-vercel-ip-country`,
 * Cloudflare's `cf-ipcountry`). On a platform that sends neither — including
 * local development — it returns null and the caller falls back to English.
 * No geolocation service is called and nothing is added to track visitors.
 */
export function localeFromCountry(country: string | null | undefined): Locale | null {
  if (!country) return null;
  return country.toUpperCase() === "IL" ? "he" : null;
}

/**
 * Absolute origin for canonical and hreflang URLs.
 *
 * Unresolved on purpose: no production domain has been decided, and inventing
 * one (or baking in localhost) would ship wrong canonicals. Set
 * NEXT_PUBLIC_SITE_URL and the alternates below become absolute; until then
 * they are emitted as root-relative paths, which is valid and safe.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

/** Prefixes an app path with a locale: ("he", "/discover") -> "/he/discover". */
export function localePath(locale: Locale, path: string): string {
  const clean = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `/${locale}${clean}`;
}

/**
 * Splits a pathname into its locale prefix and the rest.
 * "/he/discover" -> { locale: "he", rest: "/discover" }
 * "/discover"    -> { locale: null, rest: "/discover" }
 */
export function splitLocalePath(pathname: string): { locale: Locale | null; rest: string } {
  const segments = pathname.split("/");
  const first = segments[1];
  if (isLocale(first)) {
    const rest = "/" + segments.slice(2).join("/");
    return { locale: first, rest: rest === "/" ? "/" : rest.replace(/\/$/, "") };
  }
  return { locale: null, rest: pathname };
}

/** Every route exists in both languages, so alternates are a pure mapping. */
export function alternateLanguages(rest: string): Record<string, string> {
  return Object.fromEntries(
    SUPPORTED_LOCALES.map((code) => [code, `${SITE_URL}${localePath(code, rest)}`]),
  );
}
