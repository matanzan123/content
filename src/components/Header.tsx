"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@/i18n/Link";
import { LanguageSelector } from "./LanguageSelector";
import { useT } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { Role } from "./RoleToggle";

type NavKey = keyof Dictionary["header"]["nav"];

/** Destinations are fixed; the labels come from the active dictionary. */
const NAV_HREFS: Record<Role, { key: NavKey; href: string }[]> = {
  creator: [
    { key: "forBrands", href: "/brand" },
    { key: "discover", href: "/discover" },
    { key: "faqs", href: "/faqs" },
    { key: "agencies", href: "/agencies" },
    { key: "contact", href: "/contact" },
  ],
  brand: [
    { key: "forCreators", href: "/" },
    { key: "discover", href: "/discover" },
    { key: "faqs", href: "/faqs" },
    { key: "agencies", href: "/agencies" },
    { key: "contact", href: "/contact" },
  ],
};

const CTA_HREF: Record<Role, string> = {
  creator: "/onboarding?type=creator",
  brand: "/contact",
};

/** The logo returns you to the home of the realm you are currently in. */
const HOME_BY_ROLE: Record<Role, string> = { creator: "/", brand: "/brand" };

export function Header({ role }: { role: Role }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const t = useT();
  const nav = NAV_HREFS[role].map((item) => ({ href: item.href, label: t.header.nav[item.key] }));
  const cta = {
    href: CTA_HREF[role],
    label: role === "brand" ? t.header.launchCampaign : t.header.becomeCreator,
  };
  const isBrand = role === "brand";
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Escape closes the mobile menu and hands focus back to the button that
  // opened it, so a keyboard user is never left adrift after dismissing it.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setMobileOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <header className="sticky top-4 z-40 mx-4 sm:mx-5">
      <div
        className={[
          "relative mx-auto max-w-[1600px] border backdrop-blur-xl transition-[colors,border-radius] duration-200",
          mobileOpen ? "rounded-[28px]" : "rounded-[var(--radius-token-pill)]",
          isBrand
            ? "border-white/[0.09] bg-[color-mix(in_srgb,var(--surface-inverse-raised)_82%,transparent)] shadow-[0_20px_50px_-18px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.04)]"
            : "border-line bg-surface/90 shadow-[var(--shadow-card)]",
        ].join(" ")}
      >
        {isBrand && (
          <span
            className="pointer-events-none absolute inset-x-10 top-0 h-px"
            style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)" }}
          />
        )}
        <div className="flex items-center justify-between gap-4 px-5 py-[11px]">
          <Link
            href={HOME_BY_ROLE[role]}
            aria-label={t.header.logoAlt}
            className="flex shrink-0 items-center gap-2.5"
            onClick={() => setMobileOpen(false)}
          >
            <span
              className="relative flex h-[38px] w-[38px] items-center justify-center overflow-hidden rounded-[11px] text-white"
              style={{
                background: "linear-gradient(140deg, var(--accent), var(--accent-violet))",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.3), 0 4px 12px -3px color-mix(in srgb, var(--accent) 65%, transparent)",
              }}
            >
              <span
                className="pointer-events-none absolute inset-0"
                style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.24), transparent 62%)" }}
              />
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="relative">
                <path
                  d="M12 2.9l7.8 4.3v9.6L12 21.1l-7.8-4.3V7.2L12 2.9z"
                  fill="white"
                  fillOpacity="0.22"
                  stroke="white"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path d="M10.4 9.2l5 2.8-5 2.8V9.2z" fill="white" />
              </svg>
            </span>
            <span
              className={[
                "font-[var(--font-display)] text-[12.5px] font-extrabold uppercase leading-[1.12] tracking-[0.005em]",
                isBrand ? "text-ink-inverse" : "text-ink",
              ].join(" ")}
            >
              Clip
              <br />
              Rewards
            </span>
          </Link>

          <nav aria-label={t.header.primaryNav} className="hidden items-center gap-0.5 md:flex">
            {nav.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={[
                  "rounded-[var(--radius-token-pill)] px-4 py-2 text-[14px] font-medium transition-colors",
                  isBrand
                    ? "text-ink-inverse-soft hover:bg-white/[0.07] hover:text-ink-inverse"
                    : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
                ].join(" ")}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <LanguageSelector isBrand={isBrand} className="hidden sm:inline-flex" />
            <Link
              href="/login"
              className={[
                "hidden rounded-[var(--radius-token-pill)] px-3.5 py-2 text-[13.5px] font-medium transition-colors lg:inline-flex",
                isBrand
                  ? "text-ink-inverse-soft hover:bg-white/[0.07] hover:text-ink-inverse"
                  : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
              ].join(" ")}
            >
              {t.header.signIn}
            </Link>
            <Link
              href={cta.href}
              className={[
                "hidden items-center gap-1.5 rounded-[var(--radius-token-pill)] px-5 py-2.5 text-[13.5px] font-bold tracking-[-0.005em] transition-colors sm:inline-flex",
                isBrand
                  ? "bg-white text-ink shadow-[0_6px_18px_-6px_rgba(0,0,0,0.65)] hover:bg-white/90"
                  : "bg-ink text-white hover:bg-ink/90",
              ].join(" ")}
            >
              {cta.label}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="dir-flip">
                <path
                  d="M5 12H19M19 12L13 6M19 12L13 18"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>

            <button
              ref={toggleRef}
              type="button"
              aria-label={mobileOpen ? t.common.closeMenu : t.common.openMenu}
              aria-expanded={mobileOpen}
              aria-controls={menuId}
              onClick={() => setMobileOpen((v) => !v)}
              className={[
                "flex h-10 w-10 items-center justify-center rounded-[var(--radius-token-sm)] transition-colors md:hidden",
                isBrand ? "text-ink-inverse hover:bg-white/10" : "text-ink hover:bg-surface-sunken",
              ].join(" ")}
            >
              {mobileOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 7H20M4 12H20M4 17H20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav
            id={menuId}
            aria-label={t.header.mobileNav}
            className={[
              "flex flex-col gap-1 border-t px-4 py-3 md:hidden",
              isBrand ? "border-white/10" : "border-line",
            ].join(" ")}
          >
            {nav.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={[
                  "rounded-[var(--radius-token-sm)] px-3 py-2.5 text-[14px] font-medium transition-colors",
                  isBrand
                    ? "text-ink-inverse-soft hover:bg-white/10 hover:text-ink-inverse"
                    : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
                ].join(" ")}
              >
                {item.label}
              </Link>
            ))}
            <Link
              href={cta.href}
              onClick={() => setMobileOpen(false)}
              className={[
                "mt-2 inline-flex items-center justify-center gap-2 rounded-[var(--radius-token-pill)] px-4 py-2.5 text-[13px] font-semibold transition-colors sm:hidden",
                isBrand ? "bg-white text-ink" : "bg-ink text-white",
              ].join(" ")}
            >
              {cta.label}
            </Link>
            <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 sm:hidden"
              style={{ borderColor: isBrand ? "rgba(255,255,255,0.1)" : "var(--line)" }}
            >
              <span
                className={[
                  "text-[12.5px] font-semibold",
                  isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                ].join(" ")}
              >
                {t.common.language}
              </span>
              <LanguageSelector isBrand={isBrand} />
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
