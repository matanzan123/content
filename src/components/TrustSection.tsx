"use client";

import Image from "next/image";
import { useT } from "@/i18n/provider";
import type { Role } from "./RoleToggle";

const COPY: Record<Role, { eyebrow: string; heading: string; subtitle: string }> = {
  creator: {
    eyebrow: "Trust & Safety",
    heading: "Built On Real Trust",
    subtitle:
      "Every submission is scored, verified, and protected — so brands know exactly who they're working with.",
  },
  brand: {
    eyebrow: "Trust & Safety",
    heading: "Built On Real Trust",
    subtitle:
      "Every creator is scored, verified, and protected — so you know exactly who's posting for your brand.",
  },
};

const DOT_TEXTURE = {
  backgroundImage: "radial-gradient(rgba(52,87,255,0.16) 1px, transparent 1.5px)",
  backgroundSize: "14px 14px",
};

function Card({
  className = "",
  isBrand,
  children,
}: {
  className?: string;
  isBrand: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "group relative overflow-hidden rounded-[26px] border p-6 shadow-[var(--shadow-card)] transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_60px_-18px_rgba(20,21,26,0.35)]",
        isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold text-white shadow-[0_10px_20px_-4px_rgba(52,87,255,0.5)]"
      style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
    >
      {children}
    </span>
  );
}

function TierTrack({ isBrand }: { isBrand: boolean }) {
  const { tiers: tier } = useT().home.trust;
  const tiers = [tier.new, tier.rising, tier.trusted, tier.elite];
  return (
    <div className="mt-4 flex items-center gap-1.5">
      {tiers.map((t, i) => (
        <div key={t} className="flex flex-1 flex-col items-center gap-1.5">
          <span
            className="h-1.5 w-full rounded-full"
            style={{
              background:
                i <= 2
                  ? "linear-gradient(90deg, var(--accent), var(--accent-violet))"
                  : isBrand
                    ? "rgba(255,255,255,0.12)"
                    : "var(--surface-sunken)",
            }}
          />
          <span className={["text-[9px] font-semibold", i === 2 ? "text-accent-ink" : isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
            {t}
          </span>
        </div>
      ))}
    </div>
  );
}

function TrustScoreCard({ isBrand }: { isBrand: boolean }) {
  const t = useT().home.trust;
  const value = 94;
  const circumference = 2 * Math.PI * 52;
  const offset = circumference * (1 - value / 100);
  return (
    <Card isBrand={isBrand} className="sm:min-h-[380px]">
      <div className="absolute inset-0" style={DOT_TEXTURE} />
      <div className="relative flex items-start justify-between">
        <p className={["text-[13px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.trustScore}</p>
        <Badge>
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
          {t.trusted}
        </Badge>
      </div>

      <div className="relative mt-5 flex items-center gap-4">
        <div className="relative flex items-center justify-center">
          <svg width="118" height="118" viewBox="0 0 118 118" className="animate-float-slow">
            <circle cx="59" cy="59" r="46" fill="none" stroke={isBrand ? "rgba(255,255,255,0.1)" : "var(--surface-sunken)"} strokeWidth="10" />
            <circle
              cx="59"
              cy="59"
              r="46"
              fill="none"
              stroke="url(#trustGrad)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              transform="rotate(-90 59 59)"
            />
            <defs>
              <linearGradient id="trustGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--accent-cyan)" />
                <stop offset="100%" stopColor="var(--accent-violet)" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute flex flex-col items-center">
            <Image
              src="https://i.pravatar.cc/80?img=33"
              alt=""
              width={36}
              height={36}
              unoptimized
              className="h-9 w-9 rounded-full object-cover shadow-sm"
            />
            <span className={["mt-0.5 font-[var(--font-display)] text-xl font-black", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
              {value}
            </span>
          </div>
        </div>
        <div>
          <p className={["text-[13.5px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>Maya Chen</p>
          <p className={["text-[11.5px]", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
            {t.campaignsCompleted.replace("{count}", "12")}
          </p>
          <p className="mt-1 text-[11.5px] font-bold text-accent-ink">{t.toElite.replace("{count}", "3")}</p>
        </div>
      </div>

      <TierTrack isBrand={isBrand} />

      <div className="relative mt-6">
        <h3 className={["text-[17px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.growTitle}</h3>
        <p className={["mt-1.5 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
          {t.growBody}
        </p>
      </div>
    </Card>
  );
}

function VerifiedCard({ isBrand }: { isBrand: boolean }) {
  const t = useT().home.trust;
  return (
    <Card isBrand={isBrand}>
      <div className="absolute inset-0" style={DOT_TEXTURE} />
      <div className="relative flex flex-col items-center py-3 text-center">
        <div
          className="animate-pulse-soft flex h-16 w-16 items-center justify-center rounded-full shadow-[0_16px_30px_-6px_rgba(139,92,246,0.55)]"
          style={{ background: "linear-gradient(135deg, var(--accent-violet), var(--accent-2))" }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L20 5.5V11C20 16 16.5 19.5 12 21C7.5 19.5 4 16 4 11V5.5L12 2Z" fill="white" fillOpacity="0.2" stroke="white" strokeWidth="1.6" />
            <path d="M8.5 12L11 14.5L15.5 9.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Image
            src="https://i.pravatar.cc/64?img=47"
            alt=""
            width={22}
            height={22}
            unoptimized
            className="h-[22px] w-[22px] rounded-full object-cover"
          />
          <p className={["text-[13px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
            {t.verifiedName.replace("{name}", "Jordan Ray")}
          </p>
        </div>
        <h3 className={["mt-3 text-[17px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.standOutTitle}</h3>
        <p className={["mt-1.5 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
          {t.standOutBody}
        </p>
      </div>
    </Card>
  );
}

function ProtectionCard({ isBrand }: { isBrand: boolean }) {
  const t = useT().home.trust;
  return (
    <Card isBrand={isBrand}>
      <div className="absolute inset-0" style={DOT_TEXTURE} />
      <div className="relative flex flex-col items-center py-3 text-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <span
            className="absolute inset-0 animate-pulse-soft rounded-full opacity-40 blur-md"
            style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent)" }}
          />
          <div
            className="relative flex h-14 w-14 items-center justify-center rounded-full shadow-[0_16px_30px_-6px_rgba(34,199,217,0.5)]"
            style={{ background: "linear-gradient(135deg, var(--accent-2), var(--accent-cyan))" }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="6" y="10" width="12" height="9" rx="2" stroke="white" strokeWidth="1.8" />
              <path d="M8.5 10V7.5C8.5 5.5 10 4 12 4C14 4 15.5 5.5 15.5 7.5V10" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        <p className={["mt-3 text-[13px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.protected}</p>
        <div className={["mt-2 flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold", isBrand ? "bg-white/5 text-ink-inverse-soft" : "bg-surface-sunken text-ink-soft"].join(" ")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="7" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
            <path d="M3 11H21" stroke="currentColor" strokeWidth="2" />
          </svg>
          {t.bank} <span className="ltr-token">•••• 4821</span>
          <span className="ltr-token font-black text-emerald-700">$1,240.00</span>
        </div>
        <h3 className={["mt-3 text-[17px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.payoutProtection}</h3>
        <p className={["mt-1.5 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
          {t.protectionBody}
        </p>
      </div>
    </Card>
  );
}

function SubmissionCard({ isBrand }: { isBrand: boolean }) {
  const t = useT().home.trust;
  return (
    <Card isBrand={isBrand} className="sm:min-h-[380px]">
      <div className="absolute inset-0" style={DOT_TEXTURE} />
      <div className="relative flex items-start justify-between">
        <p className={["text-[13px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.latestSubmission}</p>
        <Badge>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13L10 18L19 7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t.approved}
        </Badge>
      </div>

      <div className="relative mt-5 flex gap-4">
        <div
          className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl shadow-[0_14px_28px_-8px_rgba(52,87,255,0.4)]"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-cyan))" }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M8 6.5L18 12L8 17.5V6.5Z" fill="white" fillOpacity="0.92" />
          </svg>
          <span className="animate-float absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_8px_16px_rgba(16,185,129,0.5)]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M5 13L10 18L19 7" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <Image
            src="https://i.pravatar.cc/64?img=15"
            alt=""
            width={26}
            height={26}
            unoptimized
            className="absolute -left-2 -top-2 h-[26px] w-[26px] rounded-full object-cover shadow-[0_6px_14px_rgba(0,0,0,0.3)]"
            style={{ border: "2px solid var(--surface)" }}
          />
        </div>
        <div className="flex flex-1 flex-col justify-center gap-2">
          <div className="flex items-baseline justify-between">
            <span className={["text-[11px]", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>{t.views}</span>
            <span className={["ltr-token font-[var(--font-display)] text-[15px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>128.4K</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className={["text-[11px]", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>{t.earned}</span>
            <span className="ltr-token font-[var(--font-display)] text-[15px] font-extrabold text-emerald-700">$212.40</span>
          </div>
          <div className={["h-1.5 rounded-full", isBrand ? "bg-white/10" : "bg-surface-sunken"].join(" ")}>
            <div className="h-full w-4/5 rounded-full" style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-violet))" }} />
          </div>
        </div>
      </div>

      <div className="relative mt-6">
        <h3 className={["text-[17px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{t.submitTitle}</h3>
        <p className={["mt-1.5 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
          {t.submitBody}
        </p>
      </div>
    </Card>
  );
}

export function TrustSection({ role }: { role: Role }) {
  const t = useT();
  const isBrand = role === "brand";
  // Only the creator realm is localized so far; the brand copy still comes
  // from COPY until the brand-home pass migrates it.
  const copy = isBrand
    ? COPY.brand
    : { eyebrow: t.home.trust.eyebrow, heading: t.home.trust.heading, subtitle: t.home.trust.subtitle };

  return (
    <section
      className={[
        "relative overflow-hidden px-6 pb-20 pt-20 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute -left-24 top-40 h-96 w-96 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute -right-24 bottom-24 h-96 w-96 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent 70%)" }}
      />

      <div className="relative mx-auto max-w-[1240px] text-center">
        <p
          className={[
            "font-[var(--font-display)] text-[12px] font-bold uppercase tracking-[0.14em]",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {copy.eyebrow}
        </p>
        <h2
          className={[
            "mx-auto mt-4 max-w-lg font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {copy.heading}
        </h2>
        <p
          className={[
            "mx-auto mt-4 max-w-md text-[15px] leading-relaxed",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {copy.subtitle}
        </p>

        <div className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-6 text-left sm:grid-cols-2">
          <div className="flex flex-col gap-6">
            <TrustScoreCard isBrand={isBrand} />
            <ProtectionCard isBrand={isBrand} />
          </div>
          <div className="flex flex-col gap-6">
            <VerifiedCard isBrand={isBrand} />
            <SubmissionCard isBrand={isBrand} />
          </div>
        </div>
      </div>
    </section>
  );
}
