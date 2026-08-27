"use client";

import { useState } from "react";
import Link from "next/link";
import type { Role } from "./RoleToggle";

const NAV_BY_ROLE: Record<Role, { label: string; href: string }[]> = {
  creator: [
    { label: "For Brands", href: "/brand" },
    { label: "Discover", href: "/discover" },
    { label: "Agencies", href: "/agencies" },
    { label: "Contact", href: "/contact" },
  ],
  brand: [
    { label: "For Creators", href: "/" },
    { label: "Discover", href: "/discover" },
    { label: "Agencies", href: "/agencies" },
    { label: "Contact", href: "/contact" },
  ],
};

const CTA_BY_ROLE: Record<Role, { label: string; href: string }> = {
  creator: { label: "Become a Creator", href: "/onboarding?type=creator" },
  brand: { label: "Launch Campaign", href: "/onboarding?type=brand" },
};

export function Header({ role }: { role: Role }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = NAV_BY_ROLE[role];
  const cta = CTA_BY_ROLE[role];
  const isBrand = role === "brand";

  return (
    <header className="sticky top-4 z-40 mx-4 sm:mx-5">
      <div
        className={[
          "mx-auto max-w-[1600px] border shadow-[var(--shadow-card)] backdrop-blur transition-[colors,border-radius] duration-200",
          mobileOpen ? "rounded-[28px]" : "rounded-[var(--radius-token-pill)]",
          isBrand
            ? "border-white/10 bg-surface-inverse-raised/90"
            : "border-line bg-surface/90",
        ].join(" ")}
      >
        <div className="flex items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5" onClick={() => setMobileOpen(false)}>
            <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-token-sm)] bg-accent text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 12L10 6M4 12L10 18M4 12H20"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span
              className={[
                "font-[var(--font-display)] text-[13px] font-extrabold uppercase leading-[1.05] tracking-tight",
                isBrand ? "text-ink-inverse" : "text-ink",
              ].join(" ")}
            >
              Clip
              <br />
              Rewards
            </span>
          </Link>

          <nav className="hidden items-center gap-7 md:flex">
            {nav.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={[
                  "text-[14px] font-medium transition-colors",
                  isBrand
                    ? "text-ink-inverse-soft hover:text-ink-inverse"
                    : "text-ink-soft hover:text-ink",
                ].join(" ")}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <Link
              href={cta.href}
              className={[
                "hidden items-center gap-2 rounded-[var(--radius-token-pill)] px-4 py-2.5 text-[13px] font-semibold transition-colors sm:inline-flex",
                isBrand
                  ? "bg-white text-ink hover:bg-white/90"
                  : "bg-ink text-white hover:bg-ink/90",
              ].join(" ")}
            >
              {cta.label}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
              type="button"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
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
          <div
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
          </div>
        )}
      </div>
    </header>
  );
}
