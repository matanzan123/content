import Image from "next/image";
import Link from "next/link";
import { BRAND_MARKS, BrandLogo, VerifiedTick } from "./brand-kit";
import { FOUNDERS } from "../data/brands";

/* ==========================================================================
   WHY VERIFICATION MATTERS — 5-card bento + CTA block
   Top row: two large cards. Bottom row: three smaller ones. CTA underneath.
   ========================================================================== */

const DOT_TEXTURE = {
  backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1.4px)",
  backgroundSize: "15px 15px",
};

/** Shared card shell — warm near-black, copper rim light, dotted texture, depth. */
function Card({
  children,
  glow = "var(--accent)",
}: {
  children: React.ReactNode;
  glow?: string;
}) {
  return (
    <div
      className="group relative overflow-hidden rounded-[26px] border border-white/[0.08] p-6 transition-[transform,border-color] duration-300 hover:-translate-y-1.5 hover:border-white/[0.18] sm:p-7"
      style={{
        background:
          "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 97%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))",
        boxShadow: "0 30px 64px -24px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.03)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 opacity-70" style={DOT_TEXTURE} />
      <span
        className="pointer-events-none absolute inset-x-10 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${glow}, transparent)`, opacity: 0.55 }}
      />
      <span
        className="pointer-events-none absolute -top-24 left-1/2 h-[240px] w-[340px] -translate-x-1/2 rounded-full opacity-[0.22] blur-[70px] transition-opacity duration-300 group-hover:opacity-40"
        style={{ background: `radial-gradient(closest-side, ${glow}, transparent 72%)` }}
      />
      <div className="relative flex h-full flex-col">{children}</div>
    </div>
  );
}

function CardCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-5">
      <h3 className="font-[var(--font-display)] text-[20px] font-extrabold tracking-tight text-white sm:text-[22px]">
        {title}
      </h3>
      <p className="mt-2 max-w-[42ch] text-[13.5px] leading-[1.6] text-ink-inverse-soft">{body}</p>
    </div>
  );
}

/** Inset panel used inside cards so nested UI reads as a real surface. */
function Inset({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={["relative overflow-hidden rounded-[14px] border border-white/[0.1]", className ?? ""].join(" ")}
      style={{
        background: "linear-gradient(165deg, rgba(255,255,255,0.05), rgba(0,0,0,0.3))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.09), 0 12px 26px -14px rgba(0,0,0,0.9)",
      }}
    >
      {children}
    </div>
  );
}

/* ------------------- CARD 1 — real creator demand, not floating faces ---- */

const APPLICANTS = [
  { f: FOUNDERS[0], followers: "128K", ago: "2m" },
  { f: FOUNDERS[2], followers: "210K", ago: "6m" },
  { f: FOUNDERS[5], followers: "94K", ago: "11m" },
];

function ApplicantsVisual() {
  return (
    <div className="flex flex-col gap-5 sm:h-[188px] sm:flex-row sm:items-center sm:gap-5">
      <div className="shrink-0">
        <p
          className="font-[var(--font-display)] text-[68px] font-black leading-[0.82] tracking-[-0.05em] sm:text-[86px]"
          style={{
            background: "linear-gradient(150deg, #ffffff 28%, var(--accent-2) 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          30%
        </p>
        <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-2.5 py-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="#34d399" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="whitespace-nowrap text-[10.5px] font-bold text-emerald-300">more applicants</span>
        </span>
      </div>

      {/* a live applicant feed reads as real demand */}
      <Inset className="min-w-0 flex-1">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
            <span className="text-[8.5px] font-bold uppercase tracking-[0.1em] text-ink-inverse-soft">
              New applicants
            </span>
          </span>
          <span
            className="rounded-full px-1.5 py-[2px] text-[8px] font-black"
            style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--accent-2)" }}
          >
            +142
          </span>
        </div>
        <div className="divide-y divide-white/[0.05]">
          {APPLICANTS.map(({ f, followers, ago }) => (
            <div key={f.img} className="flex items-center gap-2 px-3 py-[7px]">
              <span className="relative block h-[26px] w-[26px] shrink-0 overflow-hidden rounded-full ring-1 ring-white/[0.16]">
                <Image src={`https://i.pravatar.cc/96?img=${f.img}`} alt="" fill unoptimized sizes="26px" className="object-cover" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate text-[10px] font-bold leading-tight text-ink-inverse">{f.name}</span>
                  <VerifiedTick size={9} />
                </span>
                <span className="block text-[8px] leading-tight text-ink-inverse-soft">{followers} followers</span>
              </span>
              <span className="shrink-0 text-[8px] font-medium text-ink-inverse-soft">{ago}</span>
            </div>
          ))}
        </div>
      </Inset>
    </div>
  );
}

/* ------------------ CARD 2 — substantial, protective shield -------------- */

function ShieldVisual() {
  return (
    <div className="relative flex h-[188px] flex-col items-center justify-center">
      <svg viewBox="0 0 320 320" aria-hidden="true" className="pointer-events-none absolute h-[300px] w-[300px]">
        <defs>
          <radialGradient id="wvmRadar" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.14" />
          </radialGradient>
        </defs>
        <circle cx="160" cy="160" r="150" fill="url(#wvmRadar)" />
        {[60, 86, 112, 138].map((r, i) => (
          <circle key={r} cx="160" cy="160" r={r} fill="none" stroke="var(--accent)" strokeWidth="1" opacity={0.32 - i * 0.06} />
        ))}
        <circle cx="160" cy="160" r="112" fill="none" stroke="var(--accent-2)" strokeWidth="1.4" opacity="0.45" strokeDasharray="4 10" />
        {/* protected nodes sitting on the rings */}
        {[
          [160, 48],
          [272, 160],
          [160, 272],
          [48, 160],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="4.5" fill="var(--accent-2)" opacity="0.75" />
        ))}
      </svg>
      <span
        className="animate-glow pointer-events-none absolute h-[210px] w-[210px] rounded-full blur-[52px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />

      <svg width="124" height="124" viewBox="0 0 120 120" className="relative -mt-4">
        <defs>
          <linearGradient id="wvmShield" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-2)" />
            <stop offset="52%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-violet)" />
          </linearGradient>
          <linearGradient id="wvmShine" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.5" />
            <stop offset="52%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* outer plate for weight */}
        <path
          d="M60 6l44 18v38.5C104 92 85 111.5 60 121 35 111.5 16 92 16 62.5V24L60 6z"
          fill="rgba(255,255,255,0.06)"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="1.2"
        />
        <path
          d="M60 15l36 14.7V60c0 23.5-15.6 39.5-36 47.5C39.6 99.5 24 83.5 24 60V29.7L60 15z"
          fill="url(#wvmShield)"
          stroke="rgba(255,255,255,0.4)"
          strokeWidth="1.5"
        />
        <path d="M60 15l36 14.7V60c0 23.5-15.6 39.5-36 47.5C39.6 99.5 24 83.5 24 60V29.7L60 15z" fill="url(#wvmShine)" />
        <path d="M44 61L54.5 71.5 77 48.5" stroke="white" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>

      <div className="relative mt-1 flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-black/45 px-2.5 py-1 backdrop-blur-sm">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
          <span className="whitespace-nowrap text-[10px] font-bold text-emerald-300">$2.4M protected</span>
        </span>
        <span className="rounded-full border border-white/[0.1] bg-black/45 px-2.5 py-1 text-[10px] font-bold text-ink-inverse-soft backdrop-blur-sm">
          0 disputes
        </span>
      </div>
    </div>
  );
}

/* -------------------- CARD 3 — richer certified rosette ------------------ */

const ROSETTE = Array.from({ length: 24 }, (_, i) => {
  const a = (i / 24) * Math.PI * 2;
  const r = i % 2 === 0 ? 46 : 39;
  return `${(60 + Math.cos(a) * r).toFixed(2)},${(60 + Math.sin(a) * r).toFixed(2)}`;
}).join(" ");

function CertifiedVisual() {
  return (
    <div className="relative flex h-[168px] flex-col items-center justify-center">
      <span
        className="pointer-events-none absolute top-1 h-[150px] w-[150px] rounded-full opacity-45 blur-[42px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />
      <svg width="118" height="130" viewBox="0 0 120 132" className="relative">
        <defs>
          <linearGradient id="wvmRosette" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-cyan)" />
            <stop offset="48%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-violet)" />
          </linearGradient>
          <linearGradient id="wvmRibbonL" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-violet)" />
            <stop offset="100%" stopColor="#5c2a10" />
          </linearGradient>
          <linearGradient id="wvmRibbonR" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="#7a3a10" />
          </linearGradient>
        </defs>
        <path d="M45 90l-9 36 17-10 11 10-6-36z" fill="url(#wvmRibbonL)" />
        <path d="M75 90l9 36-17-10-11 10 6-36z" fill="url(#wvmRibbonR)" />
        <polygon points={ROSETTE} fill="url(#wvmRosette)" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" />
        <circle cx="60" cy="60" r="36" fill="rgba(0,0,0,0.18)" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        <circle cx="60" cy="60" r="30" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.42)" strokeWidth="1.4" />
        <path d="M47 60.5L56 69.5 74 51" stroke="white" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        {/* highlight sweep */}
        <path d="M30 40a34 34 0 0130-16 34 34 0 0122 8" stroke="rgba(255,255,255,0.35)" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>

      {/* the badge as it actually appears on a profile */}
      <span className="relative -mt-1 flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-black/45 px-2.5 py-1 backdrop-blur-sm">
        <BrandLogo mark={BRAND_MARKS[0]} size={15} radius={4} />
        <span className="text-[10px] font-bold text-ink-inverse">Northwind</span>
        <VerifiedTick size={11} />
      </span>
    </div>
  );
}

/* ------------------ CARD 4 — polished fee illustration ------------------- */

function FeeVisual() {
  return (
    <div className="relative flex h-[168px] flex-col justify-center">
      <span
        className="pointer-events-none absolute left-0 top-2 h-[130px] w-[190px] rounded-full opacity-30 blur-[46px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-warm), transparent 70%)" }}
      />
      <div className="relative flex items-end gap-4">
        <p
          className="font-[var(--font-display)] text-[72px] font-black leading-[0.85] tracking-[-0.05em]"
          style={{
            background: "linear-gradient(150deg, #ffffff 28%, var(--accent-warm) 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          8%
        </p>
        <div className="relative mb-2 h-[64px] w-[58px] shrink-0">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute left-0 flex h-[22px] w-[54px] items-center justify-center rounded-full"
              style={{
                bottom: i * 18,
                background: "linear-gradient(150deg, var(--accent-warm), var(--accent))",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), 0 8px 16px -8px rgba(0,0,0,0.95)",
                opacity: 1 - i * 0.1,
              }}
            >
              <span className="font-[var(--font-display)] text-[12px] font-black text-[#3c2415]">$</span>
            </span>
          ))}
        </div>
      </div>

      {/* what the number actually replaces */}
      <div className="relative mt-4 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-[52px] shrink-0 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-ink-inverse-soft">
            Standard
          </span>
          <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.07]">
            <span className="block h-full w-full rounded-full bg-white/[0.22]" />
          </span>
          <span className="w-[26px] shrink-0 text-right text-[9.5px] font-bold text-ink-inverse-soft">12%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[52px] shrink-0 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--accent-2)]">
            Verified
          </span>
          <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.07]">
            <span
              className="block h-full w-[67%] rounded-full"
              style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-warm))" }}
            />
          </span>
          <span className="w-[26px] shrink-0 text-right text-[9.5px] font-bold text-white">8%</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------- CARD 5 — believable product dashboard --------------- */

const DASH_ROWS = [
  { brand: 0, name: "Season drop", status: "Live", views: "27.3M", spend: "$8.2K", pct: 78 },
  { brand: 3, name: "Winter drop", status: "Live", views: "4.2M", spend: "$5.1K", pct: 54 },
  { brand: 8, name: "Launch film", status: "Review", views: "1.8M", spend: "$3.4K", pct: 31 },
];

function DashboardVisual() {
  return (
    <Inset className="h-[168px]">
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-white/[0.07] px-3 py-1.5">
        <span className="flex gap-1">
          {["#e0704a", "#e0ab3a", "#4ea87a"].map((c) => (
            <span key={c} className="h-[6px] w-[6px] rounded-full" style={{ background: c, opacity: 0.75 }} />
          ))}
        </span>
        <span className="ml-1 text-[7.5px] font-semibold text-ink-inverse-soft">Campaigns</span>
        <span className="ml-auto flex items-center gap-1 rounded-[4px] bg-white/[0.06] px-1.5 py-[2px]">
          <span className="text-[7px] font-semibold text-ink-inverse-soft">Last 30d</span>
          <svg width="7" height="7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-ink-inverse-soft" />
          </svg>
        </span>
      </div>

      {/* balance + delta */}
      <div className="flex items-end justify-between px-3 pb-1.5 pt-2">
        <div>
          <p className="text-[7px] font-bold uppercase tracking-[0.11em] text-ink-inverse-soft">Campaign balance</p>
          <p className="mt-0.5 font-[var(--font-display)] text-[17px] font-black leading-none tracking-tight text-white">
            $18,400
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span
            className="rounded-full px-1.5 py-[2px] text-[7.5px] font-black"
            style={{ background: "color-mix(in srgb, #34d399 20%, transparent)", color: "#6ee7b7" }}
          >
            +18.2%
          </span>
          <span className="rounded-full bg-white/[0.06] px-1.5 py-[2px] text-[7.5px] font-bold text-ink-inverse-soft">
            3 active
          </span>
        </div>
      </div>

      {/* rows */}
      <div className="space-y-[3px] px-3 pb-1">
        {DASH_ROWS.map((r) => (
          <div key={r.name} className="flex items-center gap-1.5 rounded-[6px] px-1 py-[3px] hover:bg-white/[0.04]">
            <BrandLogo mark={BRAND_MARKS[r.brand]} size={14} radius={4} />
            <span className="w-[54px] shrink-0 truncate text-[8px] font-semibold text-ink-inverse">{r.name}</span>
            <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${r.pct}%`,
                  background:
                    r.status === "Live"
                      ? "linear-gradient(90deg, var(--accent), var(--accent-cyan))"
                      : "rgba(255,255,255,0.26)",
                }}
              />
            </span>
            <span className="w-[26px] shrink-0 text-right text-[7.5px] font-bold text-ink-inverse-soft">{r.spend}</span>
            <span
              className={[
                "flex w-[30px] shrink-0 items-center justify-end gap-[3px] text-[7px] font-bold",
                r.status === "Live" ? "text-emerald-300" : "text-ink-inverse-soft",
              ].join(" ")}
            >
              {r.status === "Live" && <span className="h-1 w-1 rounded-full bg-emerald-400" />}
              {r.status}
            </span>
            <span className="w-[28px] shrink-0 text-right text-[8px] font-bold text-ink-inverse">{r.views}</span>
          </div>
        ))}
      </div>

      {/* spend chart */}
      <div className="absolute inset-x-0 bottom-0 px-3 pb-1.5">
        <svg viewBox="0 0 180 22" preserveAspectRatio="none" className="h-[20px] w-full" aria-hidden="true">
          <defs>
            <linearGradient id="wvmDashFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.42" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[7, 14].map((y) => (
            <line key={y} x1="0" y1={y} x2="180" y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          ))}
          <path d="M0 17L22 14L44 16L66 10L88 12L110 6L132 9L154 3L180 5V22H0V17Z" fill="url(#wvmDashFill)" />
          <path
            d="M0 17L22 14L44 16L66 10L88 12L110 6L132 9L154 3L180 5"
            fill="none"
            stroke="var(--accent-2)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </Inset>
  );
}

/* ------------------------------ CTA BLOCK -------------------------------- */

function CtaBlock() {
  const stack: ({ face: number } | { brand: number })[] = [
    { face: 22 },
    { brand: 0 },
    { face: 61 },
    { brand: 3 },
    { face: 45 },
    { brand: 10 },
  ];
  return (
    <div className="mt-14 flex flex-col items-center gap-4">
      <Link
        href="/onboarding?type=brand"
        className="group inline-flex items-center gap-2.5 rounded-[var(--radius-token-pill)] px-9 py-[18px] text-[16.5px] font-bold tracking-[-0.005em] text-white transition-all duration-200 hover:-translate-y-1"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-violet))",
          boxShadow:
            "0 22px 52px -12px color-mix(in srgb, var(--accent) 75%, transparent), inset 0 1px 0 rgba(255,255,255,0.24)",
        }}
      >
        Launch My Campaign
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="transition-transform duration-200 group-hover:translate-x-1"
        >
          <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      <span className="flex -space-x-2.5">
        {stack.map((item, i) =>
          "face" in item ? (
            <span
              key={i}
              className="relative block h-[32px] w-[32px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse)]"
            >
              <Image src={`https://i.pravatar.cc/80?img=${item.face}`} alt="" fill unoptimized sizes="32px" className="object-cover" />
            </span>
          ) : (
            <span key={i} className="rounded-full ring-2 ring-[color:var(--surface-inverse)]">
              <BrandLogo mark={BRAND_MARKS[item.brand]} size={32} radius={999} />
            </span>
          ),
        )}
      </span>

      <p className="text-[14px] font-bold text-white">Trusted by 200+ Brands</p>
    </div>
  );
}

/* ================================ SECTION =============================== */

export function WhyVerificationMatters() {
  return (
    <section className="relative overflow-hidden bg-surface-inverse px-6 pb-24 pt-20">
      <span
        className="pointer-events-none absolute inset-x-[12%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }}
      />
      <div
        className="pointer-events-none absolute left-1/2 top-8 h-[560px] w-[1000px] -translate-x-1/2 rounded-full opacity-[0.18] blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div
        className="pointer-events-none absolute -right-40 bottom-24 h-[480px] w-[480px] rounded-full opacity-[0.14] blur-[120px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px)",
          backgroundSize: "76px 76px",
          maskImage: "radial-gradient(ellipse 72% 58% at 50% 40%, black, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 72% 58% at 50% 40%, black, transparent 78%)",
        }}
      />

      <div className="relative mx-auto max-w-[1160px]">
        <div className="text-center">
          <span
            className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-white/[0.1] px-3.5 py-1.5"
            style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 78%, transparent)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent-2)" }} />
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-inverse-soft">
              Verification
            </span>
          </span>
          <h2 className="mx-auto mt-5 max-w-[20ch] text-balance font-[var(--font-display)] text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-white sm:text-[54px]">
            Why Verification Matters
          </h2>
          <p
            className="mx-auto mt-4 max-w-[52ch] text-balance text-[16.5px] font-medium leading-[1.6]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 74%, var(--ink-inverse-soft))" }}
          >
            Verification is what turns a listing into a brand creators trust — and it changes
            everything about how your campaigns perform.
          </p>
        </div>

        {/* top row — two large cards */}
        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <ApplicantsVisual />
            <CardCopy
              title="Get 30% More Applicants"
              body="Verified briefs are surfaced to more creators and taken more seriously, so you get a bigger, better-matched pool applying to every campaign you launch."
            />
          </Card>

          <Card glow="var(--accent-violet)">
            <ShieldVisual />
            <CardCopy
              title="Guaranteed Payout Insurance"
              body="Every campaign you fund is insured end to end. Your spend is protected, creators know they will be paid, and neither side carries the risk."
            />
          </Card>
        </div>

        {/* bottom row — three smaller cards */}
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CertifiedVisual />
            <CardCopy
              title="Stand Out Fast"
              body="The verified mark sits on your profile and every brief, telling creators you are legitimate before they read a single line."
            />
          </Card>

          <Card glow="var(--accent-warm)">
            <FeeVisual />
            <CardCopy
              title="Reduce Platform Fees"
              body="Verified brands and agencies pay a reduced platform fee on every campaign, so more of your budget reaches creators."
            />
          </Card>

          <Card glow="var(--accent-cyan)">
            <DashboardVisual />
            <CardCopy
              title="Boost Visibility"
              body="Priority placement in Discover puts your campaigns in front of more creators, with live performance tracked from one dashboard."
            />
          </Card>
        </div>

        <CtaBlock />
      </div>
    </section>
  );
}
