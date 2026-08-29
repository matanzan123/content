import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { en, type Dictionary } from "./dictionaries/en";
import { he } from "./dictionaries/he";

/* ==========================================================================
   SERVER-SIDE DICTIONARY ACCESS

   Locale comes from the route parameter, never from a cookie or header at
   render time. That is what keeps every page statically generatable: given
   `/he/discover`, the dictionary is known at build time.

   Request-time locale resolution (cookie, Accept-Language, country) happens
   once, in `src/middleware.ts`, and only for unprefixed URLs.
   ========================================================================== */

const DICTIONARIES: Record<Locale, Dictionary> = { en, he };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

/** Narrows an untrusted route param. `dynamicParams = false` should make the
 *  fallback unreachable, but a bad param must never render `undefined`. */
export function coerceLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** What every localized page and layout calls with its own `params`. */
export async function getI18n(
  params: Promise<{ locale: string }>,
): Promise<{ locale: Locale; t: Dictionary }> {
  const { locale: raw } = await params;
  const locale = coerceLocale(raw);
  return { locale, t: DICTIONARIES[locale] };
}
