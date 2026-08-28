/*
 * PARKED — not rendered anywhere.
 *
 * A verified-vs-unverified comparison panel built by mistake in place of the
 * Why Verification Matters bento. Kept intact in case it is wanted further
 * down the Brand page; it is intentionally not imported by HomeExperience.
 */

import Image from "next/image";
import { BRAND_MARKS, BrandLogo, VerifiedTick } from "./brand-kit";
import { FOUNDERS } from "../data/brands";

/* ==========================================================================
   COMPARISON PANELS
   The section answers "why does verification matter" the most direct way it
   can: the same fictional brand, same brief, before and after. The unverified
   panel is deliberately flat and grey; the verified one carries the copper.
   ========================================================================== */

type Stat = { label: string; value: string };

const UNVERIFIED: Stat[] = [
  { label: "Applicants", value: "43" },
  { label: "Approval rate", value: "22%" },
  { label: "Time to fill", value: "9 days" },
];

const VERIFIED: Stat[] = [
  { label: "Applicants", value: "148" },
  { label: "Approval rate", value: "61%" },
  { label: "Time to fill", value: "48h" },
];

function StatRow({ stats, bright }: { stats: Stat[]; bright: boolean }) {
  return (
    <dl className="mt-5 grid grid-cols-3 gap-2">
      {stats.map((s) => (
        <div
          key={s.label}
          className={[
            "rounded-[12px] border px-2.5 py-2.5",
            bright ? "border-white/[0.09] bg-white/[0.05]" : "border-white/[0.05] bg-white/[0.02]",
          ].join(" ")}
        >
          <dt className="text-[8.5px] font-semibold uppercase tracking-[0.07em] text-ink-inverse-soft">{s.label}</dt>
          <dd
            className={[
              "mt-1.5 font-[var(--font-display)] text-[21px] font-black leading-none tracking-tight",
              bright ? "text-white" : "text-ink-inverse-soft",
            ].join(" ")}
          >
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ApplicantStack({ faces, extra, bright }: { faces: number[]; extra: string; bright: boolean }) {
  return (
    <div className="mt-5 flex items-center gap-2.5">
      <span className="flex -space-x-2">
        {faces.map((img) => (
          <span
            key={img}
            className="relative block h-[26px] w-[26px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse-raised)]"
            style={bright ? undefined : { filter: "grayscale(1)", opacity: 0.55 }}
          >
            <Image src={`https://i.pravatar.cc/64?img=${img}`} alt="" fill unoptimized sizes="26px" className="object-cover" />
          </span>
        ))}
      </span>
      <span className={["text-[11px]", bright ? "text-ink-inverse" : "text-ink-inverse-soft"].join(" ")}>{extra}</span>
    </div>
  );
}

function ComparisonPanel({
  state,
  children,
}: {
  state: "before" | "after";
  children: React.ReactNode;
}) {
  const after = state === "after";
  return (
    <div
      className="relative overflow-hidden rounded-[22px] border p-5 sm:p-6"
      style={{
        borderColor: after ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.06)",
        background: after
          ? "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 97%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))"
          : "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse) 96%, white), var(--surface-inverse))",
        boxShadow: after
          ? "0 38px 80px -24px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.05), 0 0 90px -30px color-mix(in srgb, var(--accent) 85%, transparent)"
          : "0 20px 44px -22px rgba(0,0,0,0.7)",
      }}
    >
      {after && (
        <span
          className="pointer-events-none absolute inset-x-10 top-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)" }}
        />
      )}
      {children}
    </div>
  );
}

function PanelHeader({ verified }: { verified: boolean }) {
  const mark = BRAND_MARKS[0];
  return (
    <div className="flex items-center gap-2.5">
      <span style={verified ? undefined : { filter: "grayscale(1)", opacity: 0.5 }}>
        <BrandLogo mark={mark} size={34} radius={10} />
      </span>
      <div className="min-w-0">
        <p
          className={[
            "flex items-center gap-1.5 text-[13px] font-bold leading-tight",
            verified ? "text-white" : "text-ink-inverse-soft",
          ].join(" ")}
        >
          <span className="truncate">{mark.name}</span>
          {verified && <VerifiedTick size={13} />}
        </p>
        <p className="text-[9.5px] leading-tight text-ink-inverse-soft">{mark.sector} · same brief</p>
      </div>
      <span
        className={[
          "ml-auto shrink-0 rounded-full px-2.5 py-1 text-[8.5px] font-black uppercase tracking-[0.09em]",
          verified ? "" : "bg-white/[0.06] text-ink-inverse-soft",
        ].join(" ")}
        style={
          verified
            ? { background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--accent-2)" }
            : undefined
        }
      >
        {verified ? "Verified" : "Unverified"}
      </span>
    </div>
  );
}

/* ==========================================================================
   BENEFIT CARDS — each carries a small piece of believable product UI
   ========================================================================== */

function BenefitCard({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="group relative overflow-hidden rounded-[18px] border border-white/[0.08] p-5 transition-[transform,border-color] duration-300 hover:-translate-y-1.5 hover:border-white/20"
      style={{
        background:
          "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 96%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))",
        boxShadow: "0 22px 48px -20px rgba(0,0,0,0.8)",
      }}
    >
      <span
        className="pointer-events-none absolute inset-x-8 top-0 h-px opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 80%, transparent), transparent)" }}
      />
      <div className="h-[96px]">{children}</div>
      <h3 className="mt-4 font-[var(--font-display)] text-[15.5px] font-extrabold tracking-tight text-white">{title}</h3>
      <p className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-inverse-soft">{body}</p>
    </div>
  );
}

/** Discover ranking: the verified brief sits above the rest. */
function RankingVisual() {
  return (
    <div className="space-y-1 pt-0.5">
      {[
        { i: 0, on: true },
        { i: 8, on: false },
        { i: 13, on: false },
      ].map((row, idx) => (
        <div
          key={row.i}
          className={[
            "flex items-center gap-2 rounded-[9px] border px-2 py-[5px]",
            row.on ? "border-white/[0.12] bg-white/[0.06]" : "border-white/[0.05] bg-white/[0.02]",
          ].join(" ")}
        >
          <span className="w-2.5 shrink-0 text-[8px] font-black text-ink-inverse-soft">{idx + 1}</span>
          <span style={row.on ? undefined : { filter: "grayscale(1)", opacity: 0.5 }}>
            <BrandLogo mark={BRAND_MARKS[row.i]} size={16} radius={5} />
          </span>
          <span
            className={[
              "truncate text-[9.5px] font-semibold",
              row.on ? "text-ink-inverse" : "text-ink-inverse-soft",
            ].join(" ")}
          >
            {BRAND_MARKS[row.i].name}
          </span>
          {row.on && <VerifiedTick size={9} />}
        </div>
      ))}
    </div>
  );
}

/** Escrow: budget locked before the brief goes live. */
function EscrowVisual() {
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="flex items-center gap-2">
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: "linear-gradient(140deg, var(--accent), var(--accent-violet))" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 10.5V8a5.5 5.5 0 0111 0v2.5" stroke="white" strokeWidth="1.9" strokeLinecap="round" />
            <rect x="4.4" y="10.5" width="15.2" height="9.6" rx="2.4" fill="white" fillOpacity="0.28" stroke="white" strokeWidth="1.7" />
            <circle cx="12" cy="15.3" r="1.5" fill="white" />
          </svg>
        </span>
        <div>
          <p className="font-[var(--font-display)] text-[19px] font-black leading-none tracking-tight text-white">
            $18,400
          </p>
          <p className="mt-1 text-[8.5px] font-semibold uppercase tracking-[0.07em] text-ink-inverse-soft">
            Held in escrow
          </p>
        </div>
      </div>
      <div className="mt-3 h-[5px] overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full w-full rounded-full"
          style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-cyan))" }}
        />
      </div>
    </div>
  );
}

/** Approval gauge: verified briefs get better-matched submissions. */
function ApprovalVisual() {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex h-full items-center gap-3">
      <svg width="66" height="66" viewBox="0 0 66 66" className="shrink-0">
        <circle cx="33" cy="33" r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="7" />
        <circle
          cx="33"
          cy="33"
          r={r}
          fill="none"
          stroke="url(#wvmGauge)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - 0.61)}
          transform="rotate(-90 33 33)"
        />
        <defs>
          <linearGradient id="wvmGauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-cyan)" />
          </linearGradient>
        </defs>
        <text
          x="33"
          y="37"
          textAnchor="middle"
          className="font-[var(--font-display)]"
          style={{ fill: "white", fontSize: 15, fontWeight: 900 }}
        >
          61%
        </text>
      </svg>
      <div>
        <p className="text-[11px] font-bold leading-tight text-ink-inverse">Approved on first pass</p>
        <p className="mt-1 text-[9.5px] leading-tight text-ink-inverse-soft">up from 22% unverified</p>
      </div>
    </div>
  );
}

/** Asset protection: usage rules attached to every brief. */
function ProtectionVisual() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5">
      {["Usage window enforced", "Takedown on request", "No resale of assets"].map((rule) => (
        <div key={rule} className="flex items-center gap-1.5">
          <span
            className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
            style={{ background: "color-mix(in srgb, var(--accent) 24%, transparent)" }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 13L10 18L19 7"
                stroke="var(--accent-2)"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="truncate text-[10px] text-ink-inverse-soft">{rule}</span>
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   SECTION
   ========================================================================== */

const DELTAS = [
  { value: "3.4×", label: "more applicants" },
  { value: "+39", label: "pts approval rate" },
  { value: "4.5×", label: "faster to fill" },
];

export function VerificationComparison() {
  return (
    <section className="relative overflow-hidden bg-surface-inverse px-6 pb-24 pt-20">
      <span
        className="pointer-events-none absolute inset-x-[12%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }}
      />
      <div
        className="pointer-events-none absolute -left-32 top-24 h-[560px] w-[560px] rounded-full opacity-[0.18] blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div
        className="pointer-events-none absolute -right-32 bottom-0 h-[520px] w-[520px] rounded-full opacity-[0.14] blur-[130px]"
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
          <p className="font-[var(--font-display)] text-[11px] font-bold uppercase tracking-[0.2em] text-ink-inverse-soft/75">
            Verification
          </p>
          <h2 className="mx-auto mt-4 max-w-[20ch] text-balance font-[var(--font-display)] text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-white sm:text-[54px]">
            Verified Brands Get Picked First
          </h2>
          <p
            className="mx-auto mt-4 max-w-[54ch] text-balance text-[16.5px] font-medium leading-[1.6]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 74%, var(--ink-inverse-soft))" }}
          >
            Same brand, same budget, same brief — run once unverified and once verified.
            This is the difference creators actually respond to.
          </p>
        </div>

        {/* before / after */}
        <div className="mt-12 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr] lg:gap-5">
          <ComparisonPanel state="before">
            <PanelHeader verified={false} />
            <StatRow stats={UNVERIFIED} bright={false} />
            <ApplicantStack faces={[12, 32]} extra="43 creators applied" bright={false} />
          </ComparisonPanel>

          <div className="flex items-center justify-center lg:w-[64px] lg:flex-col lg:gap-3">
            <span
              className="flex h-[38px] w-[38px] items-center justify-center rounded-full border border-white/[0.12]"
              style={{
                background: "color-mix(in srgb, var(--surface-inverse-raised) 90%, transparent)",
                boxShadow: "0 0 34px -8px color-mix(in srgb, var(--accent) 70%, transparent)",
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="lg:hidden">
                <path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="var(--accent-2)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="hidden lg:block">
                <path d="M5 12h14M19 12l-6-6M19 12l-6 6" stroke="var(--accent-2)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>

          <ComparisonPanel state="after">
            <PanelHeader verified />
            <StatRow stats={VERIFIED} bright />
            <ApplicantStack faces={[14, 36, 49, 61, 22]} extra="148 creators applied" bright />
          </ComparisonPanel>
        </div>

        {/* the delta, stated plainly */}
        <div className="mx-auto mt-5 flex max-w-[760px] flex-wrap items-center justify-center gap-2.5">
          {DELTAS.map((d) => (
            <span
              key={d.label}
              className="inline-flex items-baseline gap-1.5 rounded-[var(--radius-token-pill)] border border-white/[0.09] px-3.5 py-2"
              style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 75%, transparent)" }}
            >
              <span className="font-[var(--font-display)] text-[16px] font-black tracking-tight text-[color:var(--accent-2)]">
                {d.value}
              </span>
              <span className="text-[12px] text-ink-inverse-soft">{d.label}</span>
            </span>
          ))}
        </div>

        {/* what verification actually buys */}
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <BenefitCard
            title="Priority in Discover"
            body="Verified briefs rank above unverified ones in the creator feed, so yours is seen first."
          >
            <RankingVisual />
          </BenefitCard>
          <BenefitCard
            title="Budget held in escrow"
            body="Your spend is locked before the brief goes live, which is the reason creators commit."
          >
            <EscrowVisual />
          </BenefitCard>
          <BenefitCard
            title="Fewer rejected clips"
            body="Better-matched creators apply, so far more submissions clear review on the first pass."
          >
            <ApprovalVisual />
          </BenefitCard>
          <BenefitCard
            title="Your assets stay yours"
            body="Usage rules travel with every brief, and takedowns are handled for you on request."
          >
            <ProtectionVisual />
          </BenefitCard>
        </div>

        {/* quiet close — a founder line, not another CTA */}
        <div className="mt-12 flex flex-col items-center gap-3 text-center">
          <span className="relative block h-[38px] w-[38px] overflow-hidden rounded-full ring-2 ring-white/[0.12]">
            <Image
              src={`https://i.pravatar.cc/96?img=${FOUNDERS[0].img}`}
              alt=""
              fill
              unoptimized
              sizes="38px"
              className="object-cover"
            />
          </span>
          <p className="max-w-[46ch] text-balance text-[15px] leading-[1.6] text-ink-inverse">
            &ldquo;We ran the same brief twice. Verified filled in two days — unverified never
            filled at all.&rdquo;
          </p>
          <p className="text-[11.5px] text-ink-inverse-soft">
            {FOUNDERS[0].name} · {FOUNDERS[0].role}
          </p>
        </div>
      </div>
    </section>
  );
}
