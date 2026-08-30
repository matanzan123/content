"use client";

import { Link } from "@/i18n/Link";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { useT } from "@/i18n/provider";

/** Link lists are (dictionary key, href) pairs so no label is written twice. */
type FooterKey = keyof Dictionary["footer"];

/* ==========================================================================
   BRAND FOOTER — the end of the brand page.

   Two layers, as briefed: a spacious near-black information area, then a
   copper-lit closing band carrying the wordmark at display scale. The legal
   row sits over the bottom of that wordmark so the page finishes on the brand
   rather than on a rule and a copyright line.

   Only routes that exist are linked.
   ========================================================================== */

const NAVIGATION: { key: FooterKey; href: string }[] = [
  { key: "discover", href: "/discover" },
  { key: "forCreators", href: "/" },
  { key: "forBrands", href: "/brand" },
  { key: "faqs", href: "/faqs" },
];

const PAGES: { key: FooterKey; href: string }[] = [
  { key: "contact", href: "/contact" },
  { key: "signIn", href: "/login" },
  { key: "launchCampaign", href: "/contact" },
  { key: "terms", href: "/terms-of-service" },
  { key: "privacy", href: "/privacy-policy" },
  { key: "accessibility", href: "/accessibility" },
];

const SOCIALS = [
  {
    label: "X",
    href: "https://x.com",
    d: "M4.5 4.5l15 15M19.5 4.5l-15 15",
  },
  {
    label: "Instagram",
    href: "https://www.instagram.com",
    d: "",
  },
];

function SocialIcon({ label, d }: { label: string; d: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {label === "Instagram" ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.7" cy="7.3" r="1.1" fill="currentColor" />
        </>
      ) : (
        <path d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[color:var(--accent-2)]">{title}</p>
      <ul className="mt-5 space-y-3">{children}</ul>
    </div>
  );
}

function FooterLink({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <Link
        href={href}
        className="text-[14px] text-[color:var(--ink-inverse-soft)] transition-colors duration-200 hover:text-[color:var(--accent-2)]"
      >
        {label}
      </Link>
    </li>
  );
}

export function BrandFooter() {
  const t = useT();
  return (
    <footer className="relative overflow-hidden bg-[#040303]">
      <span
        className="pointer-events-none absolute inset-x-[20%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.09), transparent)" }}
      />

      {/* ---------------------------- information --------------------------- */}
      <div className="relative mx-auto max-w-[1240px] px-6 pt-20 sm:pt-24">
        <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div className="lg:pe-10">
            <Link href="/brand" className="flex items-center gap-2.5">
              <span
                className="relative flex h-[42px] w-[42px] items-center justify-center overflow-hidden rounded-[12px] text-white"
                style={{
                  background: "linear-gradient(140deg, var(--accent), var(--accent-violet))",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.3), 0 6px 16px -4px color-mix(in srgb, var(--accent) 70%, transparent)",
                }}
              >
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.24), transparent 62%)" }}
                />
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="relative">
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
              <span className="font-[var(--font-display)] text-[13.5px] font-extrabold uppercase leading-[1.1] tracking-[0.005em] text-white">
                Clip
                <br />
                Rewards
              </span>
            </Link>

            <p
              className="mt-5 max-w-[38ch] text-[14px] leading-[1.6]"
              style={{ color: "color-mix(in srgb, var(--ink-inverse) 68%, var(--ink-inverse-soft))" }}
            >
              {t.footer.brandFooterBlurb}
            </p>

            <span
              className="mt-7 block h-px w-full max-w-[300px]"
              style={{
                background:
                  "linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), transparent)",
              }}
            />

            <div className="mt-7 flex gap-2.5">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[color:var(--ink-inverse-soft)] transition-all duration-300 hover:-translate-y-0.5 hover:text-[color:var(--accent-2)]"
                  style={{
                    background: "linear-gradient(170deg, #17110c, #090706)",
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.09)",
                  }}
                >
                  <SocialIcon label={s.label} d={s.d} />
                </a>
              ))}
            </div>
          </div>

          <Column title={t.footer.navigation}>
            {NAVIGATION.map((item) => (
              <FooterLink key={item.key} href={item.href} label={t.footer[item.key]} />
            ))}
          </Column>

          <Column title={t.footer.socials}>
            {SOCIALS.map((s) => (
              <li key={s.label}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[14px] text-[color:var(--ink-inverse-soft)] transition-colors duration-200 hover:text-[color:var(--accent-2)]"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </Column>

          <Column title={t.footer.pages}>
            {PAGES.map((item) => (
              <FooterLink key={item.key} href={item.href} label={t.footer[item.key]} />
            ))}
          </Column>
        </div>
      </div>

      {/* --------------------- copper closing band + wordmark ---------------- */}
      <div className="relative mt-16 select-none sm:mt-20">
        {/* starts above the band so the copper fades in over ~160px instead of
            arriving as a step against the black information area */}
        <span
          className="pointer-events-none absolute inset-x-0 -top-40 bottom-0"
          style={{
            background:
              "linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--accent) 6%, transparent) 42%, color-mix(in srgb, var(--accent) 22%, transparent) 80%, color-mix(in srgb, var(--accent) 13%, transparent) 100%)",
          }}
        />
        <span
          className="pointer-events-none absolute bottom-[-160px] left-1/2 h-[420px] w-[1100px] -translate-x-1/2 rounded-full opacity-45 blur-[120px]"
          style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
        />

        {/* The wordmark is deliberately cropped by the band's lower edge, but it
            must never be cropped left or right. CLIPREWARDS is 11 caps which,
            at this weight and tracking, advance about 6.8em — so 13.8vw keeps
            the whole word inside any viewport, with the 230px cap taking over
            on very wide screens. */}
        <div
          className="relative overflow-hidden"
          style={{ height: "calc(min(13.8vw, 230px) * 1.2)" }}
        >
          <p
            aria-hidden="true"
            className="absolute inset-x-0 top-0 whitespace-nowrap text-center font-[var(--font-display)] font-black leading-[0.78] tracking-[-0.045em]"
            style={{
              fontSize: "min(13.8vw, 230px)",
              background: "linear-gradient(180deg, #ffe4c6 4%, var(--accent-warm) 32%, var(--accent) 66%, #742f0c 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              filter: "drop-shadow(0 0 60px color-mix(in srgb, var(--accent) 55%, transparent))",
            }}
          >
            CLIPREWARDS
          </p>
        </div>

        {/* ------------------------- legal row ------------------------------ */}
        <div className="relative">
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: "linear-gradient(180deg, rgba(4,3,3,0.55), rgba(4,3,3,0.9))" }}
          />
          <div className="relative mx-auto flex max-w-[1240px] flex-col items-center justify-between gap-2 px-6 py-6 sm:flex-row">
            {/* Mark, name and year are one Latin run — isolated so bidi cannot
                reorder them inside the Hebrew legal row. */}
            <p className="ltr-token text-[13px] font-semibold text-white/85">
              {t.footer.brandCopyright.replace("{year}", String(new Date().getFullYear()))}
            </p>
            <p className="text-[13px] text-[color:var(--ink-inverse-soft)]">{t.footer.rights}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
