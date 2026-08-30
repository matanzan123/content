"use client";

import { Link } from "@/i18n/Link";
import { useT } from "@/i18n/provider";
import type { Role } from "./RoleToggle";
import { TrustAvatars } from "./TrustAvatars";

const COPY: Record<
  Role,
  {
    eyebrow: string;
    heading: string;
    subtitle: string;
    cta: { label: string; href: string };
    trustLabel: string;
    steps: { title: string; description: string; art: "connect" | "dashboard" | "calendar" }[];
  }
> = {
  creator: {
    eyebrow: "Process",
    heading: "Three Steps To Get Paid",
    subtitle: "From your first post to your first payout, here's exactly how it works.",
    cta: { label: "Start Earning Today", href: "/onboarding?type=creator" },
    trustLabel: "Trusted by 50k+ Creators",
    steps: [
      { title: "Set Up Payouts", description: "Connect a payout method so your earnings have somewhere to land.", art: "connect" },
      { title: "Post And Earn", description: "Join campaigns, post clips, and watch your balance update live.", art: "dashboard" },
      { title: "Get Paid Weekly", description: "Withdraw your balance on a reliable weekly schedule.", art: "calendar" },
    ],
  },
  brand: {
    eyebrow: "Process",
    heading: "Three Steps To Launch",
    subtitle: "From your first brief to your first clip, here's exactly how it works.",
    cta: { label: "Launch Your Campaign", href: "/onboarding?type=brand" },
    trustLabel: "Trusted by 200+ Brands",
    steps: [
      { title: "Launch A Campaign", description: "Set a budget and a brief, and open it up to creators.", art: "connect" },
      { title: "Creators Post For You", description: "Independent creators make and publish clips for your brand.", art: "dashboard" },
      { title: "Pay For Results", description: "Only pay out once views are verified against your budget.", art: "calendar" },
    ],
  },
};

const CARD_GRADIENT = [
  "linear-gradient(135deg, var(--accent) 0%, var(--accent-violet) 100%)",
  "linear-gradient(135deg, var(--accent-2) 0%, var(--accent-cyan) 100%)",
  "linear-gradient(135deg, var(--accent-violet) 0%, var(--accent) 100%)",
];

const DOT_TEXTURE = {
  backgroundImage: "radial-gradient(rgba(255,255,255,0.35) 1px, transparent 1.5px)",
  backgroundSize: "14px 14px",
};

function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`flex h-9 w-9 items-center justify-center rounded-[10px] bg-white/90 text-accent-ink shadow-[0_6px_16px_rgba(0,0,0,0.18)] ${className}`}
    >
      {children}
    </div>
  );
}

function ConnectArt() {
  const art = useT().home.howItWorks.art;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 pb-9">
      <div className="relative flex w-full items-center justify-between px-9">
        <svg className="absolute left-0 top-1/2 -translate-y-1/2" width="100%" height="40" viewBox="0 0 140 40" preserveAspectRatio="none" fill="none">
          <path
            d="M28 20C55 20 55 8 70 8C85 8 85 20 112 20"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth="2"
            strokeDasharray="5 7"
            strokeLinecap="round"
            className="animate-dash"
          />
        </svg>
        <Chip className="relative">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 12L10 6M4 12L10 18M4 12H20" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Chip>
        <Chip className="relative">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="7" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
            <path d="M3 11H21" stroke="currentColor" strokeWidth="2" />
          </svg>
        </Chip>
      </div>
      <div className="animate-float-slow flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-ink shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {art.connected}
      </div>
    </div>
  );
}

function DashboardArt() {
  const art = useT().home.howItWorks.art;
  return (
    <div className="relative flex h-full w-full items-center justify-center pb-9">
      <div className="absolute left-1/2 top-1/2 -translate-x-[86px] -translate-y-[26px] -rotate-6 rounded-xl bg-white/25 px-3.5 py-2.5 shadow-[0_8px_20px_rgba(0,0,0,0.15)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-white/70" />
          <div className="space-y-1">
            <span className="block h-1.5 w-14 rounded-full bg-white/70" />
            <span className="block h-1.5 w-9 rounded-full bg-white/40" />
          </div>
        </div>
      </div>
      <div className="animate-float relative left-1/2 top-1/2 -translate-x-[46px] -translate-y-1/2 rounded-xl bg-white px-4 py-3 shadow-[0_16px_32px_rgba(0,0,0,0.25)]">
        <p className="text-[9px] font-semibold uppercase tracking-wide text-ink-soft">{art.availableBalance}</p>
        <p className="ltr-token font-[var(--font-display)] text-[19px] font-black text-ink">$2,140.00</p>
        <div className="mt-1.5 flex items-end gap-[3px]">
          {[6, 10, 7, 13, 9, 15].map((h, i) => (
            <span key={i} className="w-1.5 rounded-sm bg-accent-cyan" style={{ height: h }} />
          ))}
          <span className="ltr-token ms-1 text-[10px] font-bold text-emerald-700">+18%</span>
        </div>
      </div>
    </div>
  );
}

function CalendarArt() {
  const { weekTotal, weekdays } = useT().home.howItWorks.art;
  const days = weekdays;
  const done = [true, true, true, true, false, false, false];
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 pb-9">
      <div className="animate-float-slow rounded-full bg-white px-3.5 py-1.5 text-[11px] font-bold text-ink shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
        {weekTotal.replace("{amount}", "$540")}
      </div>
      <div className="flex gap-1.5 rounded-xl bg-white px-3.5 py-3 shadow-[0_16px_32px_rgba(0,0,0,0.22)]">
        {days.map((d, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <span className="text-[8px] font-semibold text-ink-soft">{d}</span>
            <span
              className={[
                "flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold",
                done[i] ? "bg-emerald-500 text-white" : "border border-line text-transparent",
                done[i] && i === 3 ? "animate-pulse-soft" : "",
              ].join(" ")}
            >
              {done[i] ? "✓" : "·"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ART: Record<string, () => React.JSX.Element> = {
  connect: ConnectArt,
  dashboard: DashboardArt,
  calendar: CalendarArt,
};

export function HowItWorks({ role }: { role: Role }) {
  const t = useT();
  const localized =
    role === "creator"
      ? {
          eyebrow: t.home.howItWorks.eyebrow,
          heading: t.home.howItWorks.heading,
          subtitle: t.home.howItWorks.subtitle,
          ctaLabel: t.home.howItWorks.cta,
          trustLabel: t.home.howItWorks.trust,
          steps: [
            { title: t.home.howItWorks.steps.twoTitle, description: t.home.howItWorks.steps.twoBody },
            { title: t.home.howItWorks.steps.oneTitle, description: t.home.howItWorks.steps.oneBody },
            { title: t.home.howItWorks.steps.threeTitle, description: t.home.howItWorks.steps.threeBody },
          ],
        }
      : null;
  const base = COPY[role];
  const copy = localized
    ? {
        ...base,
        eyebrow: localized.eyebrow,
        heading: localized.heading,
        subtitle: localized.subtitle,
        cta: { ...base.cta, label: localized.ctaLabel },
        trustLabel: localized.trustLabel,
        steps: base.steps.map((step, i) => ({ ...step, ...localized.steps[i] })),
      }
    : base;
  const isBrand = role === "brand";

  return (
    <section
      className={[
        "relative overflow-hidden px-6 pb-20 pt-20 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute -top-24 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--accent-soft), transparent 70%)",
        }}
      />
      <div
        className={[
          "pointer-events-none absolute right-[6%] top-32 h-64 w-64 rounded-full blur-3xl",
          isBrand ? "opacity-20" : "opacity-30",
        ].join(" ")}
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

        <div className="mx-auto mt-14 grid max-w-3xl grid-cols-1 gap-7 sm:grid-cols-3">
          {copy.steps.map((step, i) => {
            const Art = ART[step.art];
            return (
              <div
                key={step.title}
                className={[
                  "group overflow-hidden rounded-[26px] border text-left shadow-[var(--shadow-card)] transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_28px_60px_-18px_rgba(20,21,26,0.35)]",
                  isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
                ].join(" ")}
              >
                <div
                  className="relative h-[190px]"
                  style={{ background: CARD_GRADIENT[i] }}
                >
                  <div className="absolute inset-0" style={DOT_TEXTURE} />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Art />
                  </div>
                  <div
                    className={[
                      "absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent",
                      isBrand ? "to-surface-inverse-raised" : "to-surface",
                    ].join(" ")}
                  />
                  <span
                    className={[
                      "absolute -bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-wide text-white shadow-[0_10px_20px_-4px_rgba(52,87,255,0.55)] ring-2",
                      isBrand ? "ring-surface-inverse-raised" : "ring-surface",
                    ].join(" ")}
                    style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
                  >
                    {t.home.howItWorks.step.replace("{index}", String(i + 1))}
                  </span>
                </div>
                <div className="px-6 pb-7 pt-8">
                  <h3 className={["text-[17px] font-extrabold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
                    {step.title}
                  </h3>
                  <p className={["mt-2 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
                    {step.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-14 flex flex-col items-center gap-4">
          <Link
            href={copy.cta.href}
            className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-9 py-4 text-[17px] font-extrabold text-white shadow-[0_16px_40px_-10px_rgba(52,87,255,0.65)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_48px_-8px_rgba(52,87,255,0.75)]"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
          >
            {copy.cta.label}
          </Link>

          <div className="flex flex-col items-center gap-2">
            <TrustAvatars isBrand={isBrand} />
            <p className={["text-[13.5px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
              {copy.trustLabel}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
