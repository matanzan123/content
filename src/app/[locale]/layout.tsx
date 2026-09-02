import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Script from "next/script";
import { Archivo, Heebo, Inter } from "next/font/google";
import { AccessibilityWidget } from "@/components/a11y/AccessibilityWidget";
import { AuthProvider } from "@/components/auth/AuthProvider";
import {
  LOCALE_DIRECTION,
  SUPPORTED_LOCALES,
  alternateLanguages,
  isLocale,
} from "@/i18n/config";
import { I18nProvider } from "@/i18n/provider";
import { PageViewTracker } from "@/components/analytics/PageViewTracker";
import { getClientDictionary, getI18n } from "@/i18n/server";
import "../globals.css";

/* ==========================================================================
   ROOT LAYOUT

   This is the application's root layout — it owns <html> and <body> — and it
   sits under [locale] so `lang` and `dir` come from the URL rather than from a
   cookie read at request time. That is what lets the pages below stay static.

   Unprefixed URLs never reach here: `src/middleware.ts` redirects them first.
   ========================================================================== */

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/**
 * Neither Archivo nor Inter ships Hebrew glyphs, so Hebrew would fall back to a
 * system face and lose the typographic identity. Heebo covers Hebrew and Latin
 * across the same weight range; globals.css swaps the font variables over when
 * the document language is Hebrew.
 */
const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

/** Both locales are prerendered; anything else 404s rather than being guessed. */
export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.meta.homeTitle,
    description: t.meta.homeDescription,
    alternates: { languages: alternateLanguages("/") },
  };
}

/**
 * Applies saved accessibility preferences before the first paint, so a returning
 * visitor never sees the page render at the default size and then jump.
 */
const APPLY_A11Y_PREFS = `(function(){try{var p=JSON.parse(localStorage.getItem("cliprewards_accessibility_preferences")||"{}");var r=document.documentElement;if(p.textSize==="large")r.classList.add("a11y-text-large");if(p.textSize==="xlarge")r.classList.add("a11y-text-xlarge");if(p.contrast)r.classList.add("a11y-contrast");if(p.highlightLinks)r.classList.add("a11y-highlight-links");if(p.reduceMotion)r.classList.add("a11y-reduce-motion");}catch(e){}})();`;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const { locale, t } = await getI18n(params);

  return (
    // suppressHydrationWarning: the inline script below adds the saved
    // accessibility classes to <html> before React hydrates, so the server and
    // client class lists legitimately differ on this one element.
    <html
      lang={locale}
      dir={LOCALE_DIRECTION[locale]}
      suppressHydrationWarning
      className={`${archivo.variable} ${inter.variable} ${heebo.variable} h-full`}
    >
      <head>
        {/* next/script rather than a raw <script>: a bare script tag inside the
            React tree warns on client-side navigation, which now happens every
            time someone switches language. */}
        <Script id="a11y-prefs" strategy="beforeInteractive">
          {APPLY_A11Y_PREFS}
        </Script>
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <a
          href="#main-content"
          className="skip-link rounded-[var(--radius-token-pill)] bg-ink px-5 py-3 text-[14px] font-bold text-white shadow-[var(--shadow-float)]"
        >
          {t.common.skipToContent}
        </a>
        <I18nProvider locale={locale} dictionary={getClientDictionary(locale)}>
          <PageViewTracker />
          <AuthProvider>{children}</AuthProvider>
          <AccessibilityWidget />
        </I18nProvider>
      </body>
    </html>
  );
}
