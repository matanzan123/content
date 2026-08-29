import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  localeFromAcceptLanguage,
  localeFromCountry,
  splitLocalePath,
  type Locale,
} from "@/i18n/config";

/* ==========================================================================
   LOCALE ROUTING

   Every public page lives under /en/... or /he/..., which is what lets the
   pages be statically generated: the locale is a route parameter, so no page
   has to read a cookie at request time.

   This middleware does two things:

     1. Sends a visitor who arrives at an unprefixed URL — /brand, /faqs, a
        bookmark, an old inbound link — to the same page under the locale they
        should get, honouring an explicit choice first.
     2. Keeps the saved preference in step with the URL, so /he/discover opened
        directly wins over a stale English cookie.

   It never rewrites a request that already carries a valid locale prefix, so
   there is no redirect loop.
   ========================================================================== */

/** Paths middleware must not touch. */
const BYPASS = /^\/(?:api|_next|favicon\.ico|robots\.txt|sitemap\.xml)(?:\/|$)/;

function resolveLocale(request: NextRequest): Locale {
  // 1. An explicit choice the visitor already made.
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;

  // 2. What their browser asks for.
  const fromBrowser = localeFromAcceptLanguage(request.headers.get("accept-language"));
  if (fromBrowser) return fromBrowser;

  // 3. A country the hosting platform attached to the request. No IP is read
  //    or stored, and nothing is called out to.
  const fromCountry = localeFromCountry(
    request.headers.get("x-vercel-ip-country") ??
      request.headers.get("cf-ipcountry") ??
      request.headers.get("x-country"),
  );
  if (fromCountry) return fromCountry;

  // 4. English.
  return DEFAULT_LOCALE;
}

function withLocaleCookie(response: NextResponse, locale: Locale) {
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (BYPASS.test(pathname)) return NextResponse.next();

  const { locale: urlLocale } = splitLocalePath(pathname);

  // Already localised: the URL is the authority for this request. Only sync the
  // saved preference when it has drifted, so opening /he/discover with an old
  // English cookie renders — and then remembers — Hebrew.
  if (urlLocale) {
    const saved = request.cookies.get(LOCALE_COOKIE)?.value;
    if (saved === urlLocale) return NextResponse.next();
    return withLocaleCookie(NextResponse.next(), urlLocale);
  }

  // Unprefixed: send them to the right language, keeping the path, query and
  // (client-side) hash intact.
  const locale = resolveLocale(request);
  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
  return withLocaleCookie(NextResponse.redirect(url), locale);
}

export const config = {
  // Everything except Next internals, the API and files with an extension.
  matcher: ["/((?!api|_next/static|_next/image|.*\\..*).*)"],
};
