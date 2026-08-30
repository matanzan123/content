"use client";

import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";

/**
 * Language selector.
 *
 * A radiogroup of two short labels rather than a dropdown: with exactly two
 * languages a menu would add a click and a focus trap for nothing. Each option
 * carries its language written in its own script and a `lang` attribute, so a
 * screen reader pronounces "עברית" in Hebrew rather than spelling it in English.
 *
 * No flags. A flag is a country, and neither language belongs to one country.
 */
export function LanguageSelector({
  isBrand = false,
  fullNames = false,
  className = "",
}: {
  isBrand?: boolean;
  /**
   * Spells each language out ("EN | עברית") instead of the compact pair the
   * header uses. Login and onboarding have no Header to give the control
   * context, so there the name has to carry it on its own.
   */
  fullNames?: boolean;
  className?: string;
}) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div
      role="radiogroup"
      aria-label={t.common.chooseLanguage}
      className={[
        "inline-flex items-center rounded-[var(--radius-token-pill)] p-0.5",
        isBrand ? "bg-white/[0.07]" : "bg-surface-sunken",
        className,
      ].join(" ")}
    >
      {SUPPORTED_LOCALES.map((code: Locale) => {
        const selected = locale === code;
        return (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={selected}
            lang={code}
            onClick={() => setLocale(code)}
            className={[
              "min-w-[38px] rounded-[var(--radius-token-pill)] px-2.5 py-1.5 text-[12.5px] font-bold transition-colors",
              selected
                ? isBrand
                  ? "bg-white/[0.16] text-ink-inverse"
                  : "bg-surface text-ink shadow-[var(--shadow-card)]"
                : isBrand
                  // full-strength ink: the muted tier fails 4.5:1 against the
                  // selector track on the dark header, and the selected option
                  // is already distinguished by its filled background
                  ? "text-ink-inverse hover:bg-white/[0.08]"
                  : "text-ink-soft hover:text-ink",
            ].join(" ")}
          >
            {/* "EN | עברית": the Latin code is the universally read token, while
                the Hebrew name is spelled out. Either way the accessible name
                is the full language name. */}
            {fullNames && code !== "en" ? (
              LOCALE_LABELS[code].name
            ) : (
              <>
                <span aria-hidden="true">{LOCALE_LABELS[code].short}</span>
                <span className="sr-only">{LOCALE_LABELS[code].name}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
