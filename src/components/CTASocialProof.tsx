"use client";

import { Link } from "@/i18n/Link";
import { useT } from "@/i18n/provider";
import type { Role } from "./RoleToggle";
import { TrustAvatars } from "./TrustAvatars";

const COPY: Record<"first" | "second", Record<Role, { heading: string; cta: { label: string; href: string }; trustLabel: string }>> = {
  first: {
    creator: {
      heading: "Your Next Payout Is One Post Away",
      cta: { label: "Start Earning Today", href: "/onboarding?type=creator" },
      trustLabel: "Trusted by 50k+ Creators",
    },
    brand: {
      heading: "Your Next Campaign Is One Brief Away",
      cta: { label: "Launch Your Campaign", href: "/onboarding?type=brand" },
      trustLabel: "Trusted by 200+ Brands",
    },
  },
  second: {
    creator: {
      heading: "Ready To Join Them?",
      cta: { label: "Create Your Account", href: "/onboarding?type=creator" },
      trustLabel: "Trusted by 50k+ Creators",
    },
    brand: {
      heading: "Ready To See Results Like These?",
      cta: { label: "Launch Your First Campaign", href: "/onboarding?type=brand" },
      trustLabel: "Trusted by 200+ Brands",
    },
  },
};

export function CTASocialProof({ role, variant = "first" }: { role: Role; variant?: "first" | "second" }) {
  const t = useT();
  const base = COPY[variant][role];
  // Only the creator realm is localized so far; the brand copy still comes
  // from COPY until the brand-home pass migrates it.
  const copy =
    role === "creator"
      ? {
          ...base,
          heading: variant === "first" ? t.home.cta.firstHeading : t.home.cta.secondHeading,
          cta: { ...base.cta, label: variant === "first" ? t.home.cta.firstCta : t.home.cta.secondCta },
          trustLabel: t.home.cta.trust,
        }
      : base;
  const isBrand = role === "brand";

  return (
    <section
      className={[
        "relative overflow-hidden px-6 py-16 text-center transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : variant === "second" ? "bg-surface" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-72 w-[720px] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-2), transparent 70%)" }}
      />
      <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-6">
        <h2
          className={[
            "font-[var(--font-display)] text-[30px] font-black leading-tight tracking-tight sm:text-[36px]",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {copy.heading}
        </h2>

        <Link
          href={copy.cta.href}
          className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-9 py-4 text-[16px] font-bold text-white shadow-[0_16px_40px_-10px_rgba(52,87,255,0.65)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_48px_-8px_rgba(52,87,255,0.75)]"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
        >
          {copy.cta.label}
        </Link>

        <div className="flex flex-col items-center gap-2.5">
          <TrustAvatars isBrand={isBrand} />
          <p className={["text-[13.5px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
            {copy.trustLabel}
          </p>
        </div>
      </div>
    </section>
  );
}
