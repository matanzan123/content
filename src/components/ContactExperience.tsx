"use client";

import { BrandOnboardingForm } from "./BrandOnboardingForm";
import { Footer } from "./Footer";
import { Header } from "./Header";

export function ContactExperience() {
  return (
    <>
      <Header role="brand" />

      <section className="relative overflow-hidden bg-surface-inverse pt-20 pb-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-40"
          style={{
            background:
              "radial-gradient(60% 100% at 50% 0%, var(--accent) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-[1240px] px-6 text-center">
          <span className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-white/10 bg-white/5 px-3.5 py-1.5 text-[12px] font-semibold text-ink-inverse-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-2 animate-pulse-soft" />
            Contact
          </span>

          <h1 className="mt-5 font-[var(--font-display)] text-[38px] font-black leading-[1.05] tracking-tight text-ink-inverse sm:text-[54px]">
            Talk directly with our team
          </h1>

          <p className="mx-auto mt-4 max-w-[520px] text-[15px] leading-relaxed text-ink-inverse-soft">
            Share a few details about your brand and a campaign strategist gets back to you within
            one business day.
          </p>
        </div>

        <div className="relative mx-auto mt-12 max-w-[1240px] px-6">
          <div className="overflow-hidden rounded-[var(--radius-token-lg)] bg-surface shadow-[var(--shadow-float)]">
            <div
              aria-hidden="true"
              className="h-1"
              style={{
                background:
                  "linear-gradient(90deg, var(--accent-violet), var(--accent), var(--accent-cyan))",
              }}
            />
            <BrandOnboardingForm />
          </div>
        </div>
      </section>

      <Footer role="brand" />
    </>
  );
}
