"use client";

import Link from "next/link";
import { RoleToggle, type Role } from "./RoleToggle";

const COPY: Record<
  Role,
  {
    headlineLead: string;
    trailingWord: string;
    subtitle: string;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
  }
> = {
  creator: {
    headlineLead: "Earn From Every Post",
    trailingWord: "Creator",
    subtitle:
      "Post short clips for real brand campaigns and get paid for every view that qualifies.",
    primaryCta: { label: "Start Earning", href: "/onboarding?type=creator" },
    secondaryCta: { label: "Browse Campaigns", href: "/discover" },
  },
  brand: {
    headlineLead: "Reach Real Fans Fast",
    trailingWord: "Brand",
    subtitle:
      "Launch a campaign and let independent creators turn it into organic short-form reach.",
    primaryCta: { label: "Launch a Campaign", href: "/onboarding?type=brand" },
    secondaryCta: { label: "See Verified Brands", href: "/brand" },
  },
};

/** Small phone-like mockup card shell — matches the tall, portrait, stacked
 *  cards from the reference screenshots (not flat generic rectangles). */
function MockCard({
  label,
  rotate,
  className,
  dark,
  children,
}: {
  label: string;
  rotate: number;
  className: string;
  dark?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "absolute w-[172px] rounded-[22px] border p-3.5 shadow-[0_30px_60px_-14px_rgba(20,21,26,0.35)]",
        dark ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
        className,
      ].join(" ")}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <p
        className={[
          "text-[10px] font-bold uppercase tracking-wide",
          dark ? "text-ink-inverse-soft" : "text-ink-soft",
        ].join(" ")}
      >
        {label}
      </p>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function NetworkDiagram({ dark }: { dark?: boolean }) {
  const dot = dark ? "bg-white/25" : "bg-accent-soft";
  const line = dark ? "bg-white/15" : "bg-line";
  return (
    <div className="relative h-[120px]">
      <span className={`absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${dot}`} />
      {[
        [10, 8],
        [110, 4],
        [4, 96],
        [126, 100],
        [66, 118],
      ].map(([x, y], i) => (
        <span key={i}>
          <span
            className={`absolute h-1 w-6 origin-left ${line}`}
            style={{
              left: "50%",
              top: "50%",
              transform: `rotate(${Math.atan2(y - 60, x - 66).toFixed(4)}rad)`,
            }}
          />
          <span
            className={`absolute h-4 w-4 rounded-full border-2 ${dark ? "border-surface-inverse-raised bg-white/40" : "border-surface bg-accent"}`}
            style={{ left: x, top: y }}
          />
        </span>
      ))}
    </div>
  );
}

function TagRow({ tag, dark }: { tag: string; dark?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={[
          "rounded-full px-1.5 py-[3px] text-[8px] font-semibold uppercase",
          dark ? "bg-accent/25 text-accent" : "bg-accent-soft text-accent-ink",
        ].join(" ")}
      >
        {tag}
      </span>
      <span className={`h-1.5 flex-1 rounded-full ${dark ? "bg-white/10" : "bg-surface-sunken"}`} />
    </div>
  );
}

function GaugeCard({ value, dark }: { value: number; dark?: boolean }) {
  const circumference = 2 * Math.PI * 34;
  const offset = circumference * (1 - value / 100);
  return (
    <div className="flex flex-col items-center pt-2">
      <svg width="96" height="56" viewBox="0 0 96 56">
        <path d="M6 50A42 42 0 0190 50" fill="none" stroke={dark ? "rgba(255,255,255,0.12)" : "var(--line)"} strokeWidth="8" strokeLinecap="round" />
        <path
          d="M6 50A42 42 0 0190 50"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <p className={`font-[var(--font-display)] text-2xl font-black ${dark ? "text-ink-inverse" : "text-ink"}`}>
        {value}%
      </p>
    </div>
  );
}

function IconGrid({ dark }: { dark?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {Array.from({ length: 9 }).map((_, i) => (
        <span key={i} className={`aspect-square rounded-[6px] ${dark ? "bg-white/10" : "bg-surface-sunken"}`} />
      ))}
    </div>
  );
}

function StatBlock({ label, value, dark }: { label: string; value: string; dark?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={`text-[9px] ${dark ? "text-ink-inverse-soft" : "text-ink-soft"}`}>{label}</span>
      <span className={`font-[var(--font-display)] text-[13px] font-black ${dark ? "text-ink-inverse" : "text-ink"}`}>
        {value}
      </span>
    </div>
  );
}

function FloatingCards({ role }: { role: Role }) {
  if (role === "creator") {
    return (
      <>
        <MockCard label="New Creators" rotate={-10} dark={false} className="left-0 top-0 h-[230px]">
          <NetworkDiagram />
        </MockCard>
        <MockCard label="Campaigns" rotate={5} dark={false} className="left-28 top-16 h-[220px]">
          <div className="space-y-2.5">
            <TagRow tag="Clipping" />
            <TagRow tag="UGC" />
            <TagRow tag="Music" />
          </div>
        </MockCard>
        <MockCard label="Trust Score" rotate={-4} dark={false} className="left-14 top-[210px] h-[165px]">
          <GaugeCard value={92} />
        </MockCard>
      </>
    );
  }
  return (
    <>
      <MockCard label="Verified Brands" rotate={-10} dark className="left-0 top-0 h-[230px]">
        <IconGrid dark />
      </MockCard>
      <MockCard label="Live Campaigns" rotate={5} dark className="left-28 top-16 h-[220px]">
        <div className="space-y-3">
          <TagRow tag="Clipping" dark />
          <StatBlock label="Approval" value="46%" dark />
          <StatBlock label="Views" value="27.3M" dark />
          <TagRow tag="UGC" dark />
        </div>
      </MockCard>
      <MockCard label="Moderator Panel" rotate={-4} dark className="left-14 top-[210px] h-[165px]">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-[3px] bg-accent" />
              <div className="h-1.5 flex-1 rounded-full bg-white/10" style={{ width: `${70 - i * 10}%` }} />
            </div>
          ))}
        </div>
      </MockCard>
    </>
  );
}

export function Hero({ role, onRoleChange }: { role: Role; onRoleChange: (r: Role) => void }) {
  const copy = COPY[role];
  const isBrand = role === "brand";

  return (
    <section
      className={[
        "relative overflow-hidden pb-16 pt-14 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute -top-16 left-[8%] h-[420px] w-[420px] rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute right-[4%] top-24 h-[380px] w-[380px] rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent 70%)" }}
      />
      <div className="relative mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-10 px-6 md:grid-cols-[1fr_420px]">
        <div>
          <h1
            className={[
              "font-[var(--font-display)] text-[46px] font-black leading-[1.02] tracking-tight sm:text-[58px]",
              isBrand ? "text-ink-inverse" : "text-ink",
            ].join(" ")}
          >
            {copy.headlineLead}
            <br />
            As A{" "}
            <RoleToggle role={role} onChange={onRoleChange} theme={isBrand ? "dark" : "light"} />{" "}
            {copy.trailingWord}
          </h1>

          <p
            className={[
              "mt-5 max-w-sm text-[16px] leading-relaxed",
              isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
            ].join(" ")}
          >
            {copy.subtitle}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={copy.primaryCta.href}
              className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-7 py-3.5 text-[15px] font-bold text-white shadow-[0_16px_36px_-10px_rgba(52,87,255,0.6)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_44px_-8px_rgba(52,87,255,0.7)]"
              style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
            >
              {copy.primaryCta.label}
            </Link>
            <Link
              href={copy.secondaryCta.href}
              className={[
                "rounded-[var(--radius-token-pill)] px-7 py-3.5 text-[15px] font-bold transition-colors",
                isBrand
                  ? "bg-white/10 text-ink-inverse hover:bg-white/15"
                  : "bg-surface text-ink shadow-[var(--shadow-card)] hover:bg-white",
              ].join(" ")}
            >
              {copy.secondaryCta.label}
            </Link>
          </div>
        </div>

        <div className="relative hidden h-[440px] md:block">
          <FloatingCards role={role} />
        </div>
      </div>
    </section>
  );
}
