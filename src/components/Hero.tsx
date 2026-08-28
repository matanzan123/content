"use client";

import { useId } from "react";
import Image from "next/image";
import Link from "next/link";
import { BRAND_MARKS, BrandLogo, VerifiedTick } from "./brand-kit";
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

/* ==========================================================================
   CREATOR VISUALS — approved light direction, unchanged.
   ========================================================================== */

function MockCard({
  label,
  rotate,
  className,
  children,
}: {
  label: string;
  rotate: number;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "absolute w-[172px] rounded-[22px] border border-line bg-surface p-3.5",
        className,
      ].join(" ")}
      style={{
        transform: `rotate(${rotate}deg)`,
        boxShadow: "0 30px 60px -14px rgba(20,21,26,0.35)",
      }}
    >
      <p className="relative text-[10px] font-bold uppercase tracking-wide text-ink-soft">{label}</p>
      <div className="relative mt-2.5">{children}</div>
    </div>
  );
}

function NetworkDiagram() {
  return (
    <div className="relative h-[120px]">
      <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-soft" />
      {[
        [10, 8],
        [110, 4],
        [4, 96],
        [126, 100],
        [66, 118],
      ].map(([x, y], i) => (
        <span key={i}>
          <span
            className="absolute h-1 w-6 origin-left bg-line"
            style={{
              left: "50%",
              top: "50%",
              transform: `rotate(${Math.atan2(y - 60, x - 66).toFixed(4)}rad)`,
            }}
          />
          <span
            className="absolute h-4 w-4 rounded-full border-2 border-surface bg-accent"
            style={{ left: x, top: y }}
          />
        </span>
      ))}
    </div>
  );
}

function TagRow({ tag }: { tag: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="rounded-full bg-accent-soft px-1.5 py-[3px] text-[8px] font-semibold uppercase text-accent-ink">
        {tag}
      </span>
      <span className="h-1.5 flex-1 rounded-full bg-surface-sunken" />
    </div>
  );
}

function GaugeCard({ value }: { value: number }) {
  const circumference = 2 * Math.PI * 34;
  const offset = circumference * (1 - value / 100);
  return (
    <div className="flex flex-col items-center pt-2">
      <svg width="96" height="56" viewBox="0 0 96 56">
        <path d="M6 50A42 42 0 0190 50" fill="none" stroke="var(--line)" strokeWidth="8" strokeLinecap="round" />
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
      <p className="font-[var(--font-display)] text-2xl font-black text-ink">{value}%</p>
    </div>
  );
}

function CreatorCards() {
  return (
    <>
      <MockCard label="New Creators" rotate={-10} className="left-0 top-0 h-[230px]">
        <NetworkDiagram />
      </MockCard>
      <MockCard label="Campaigns" rotate={5} className="left-28 top-16 h-[220px]">
        <div className="space-y-2.5">
          <TagRow tag="Clipping" />
          <TagRow tag="UGC" />
          <TagRow tag="Music" />
        </div>
      </MockCard>
      <MockCard label="Trust Score" rotate={-4} className="left-14 top-[210px] h-[165px]">
        <GaugeCard value={92} />
      </MockCard>
    </>
  );
}

/**
 * Card shell for the brand composition — warm glass with a copper rim light.
 * `tier` drives the depth read: back cards sit dimmer and flatter, the front
 * card carries the brightest rim and the widest copper bloom.
 */
function BrandCard({
  label,
  badge,
  className,
  children,
  flush,
  tier = "mid",
}: {
  label: string;
  badge?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  flush?: boolean;
  tier?: "back" | "mid" | "front";
}) {
  const rim =
    tier === "front" ? "rgba(255,255,255,0.14)" : tier === "mid" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.075)";
  const drop =
    tier === "front"
      ? "0 46px 90px -22px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.06), 0 0 90px -26px color-mix(in srgb, var(--accent) 85%, transparent)"
      : tier === "mid"
        ? "0 34px 72px -22px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.04), 0 0 62px -28px color-mix(in srgb, var(--accent) 60%, transparent)"
        : "0 26px 58px -22px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.03)";

  return (
    <div
      className={["relative overflow-hidden rounded-[22px] border", className ?? ""].join(" ")}
      style={{
        borderColor: rim,
        background:
          "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 96%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))",
        boxShadow: drop,
      }}
    >
      <span
        className="pointer-events-none absolute inset-x-6 top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)" }}
      />
      <div className="flex items-center gap-2 px-4 pt-4">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-inverse-soft">{label}</p>
        {badge}
      </div>
      <div className={flush ? "" : "px-4 pb-4 pt-3"}>{children}</div>
    </div>
  );
}

/**
 * Positions one card in the cluster. The rotation lives on an inner element so
 * the float keyframe (which animates `transform`) cannot clobber it — CSS
 * animations outrank inline styles in the cascade.
 */
function Floater({
  className,
  rotate,
  scale = 1,
  opacity = 1,
  float,
  z,
  children,
}: {
  className: string;
  rotate: number;
  scale?: number;
  opacity?: number;
  float?: "normal" | "slow";
  z: number;
  children: React.ReactNode;
}) {
  return (
    <div className={["absolute", className].join(" ")} style={{ zIndex: z }}>
      <div className={float === "normal" ? "animate-float" : float === "slow" ? "animate-float-slow" : undefined}>
        <div style={{ transform: `rotate(${rotate}deg) scale(${scale})`, opacity }}>{children}</div>
      </div>
    </div>
  );
}

function Sparkline() {
  // The card renders twice (desktop cluster + mobile stack). Hard-coded gradient
  // ids would collide, and the first copy lives in a `display:none` subtree —
  // which makes `url(#id)` resolve to an unrenderable paint. Scope them per instance.
  const uid = useId().replace(/:/g, "");
  const fillId = `spark-fill-${uid}`;
  const lineId = `spark-line-${uid}`;
  return (
    <div className="relative">
      <svg viewBox="0 0 176 44" className="h-[44px] w-full" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent-2)" />
            <stop offset="100%" stopColor="var(--accent-cyan)" />
          </linearGradient>
        </defs>
        {[11, 22, 33].map((y) => (
          <line key={y} x1="0" y1={y} x2="176" y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}
        <path
          d="M0 35L17.6 31L35.2 33L52.8 24L70.4 27L88 17L105.6 20L123.2 11L140.8 13L158.4 5L176 8V44H0V35Z"
          fill={`url(#${fillId})`}
        />
        <path
          d="M0 35L17.6 31L35.2 33L52.8 24L70.4 27L88 17L105.6 20L123.2 11L140.8 13L158.4 5L176 8"
          fill="none"
          stroke={`url(#${lineId})`}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="pointer-events-none absolute right-0 top-[5px] h-[7px] w-[7px] -translate-y-1/2 translate-x-1/2 rounded-full"
        style={{ background: "var(--accent-cyan)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent-cyan) 22%, transparent)" }}
      />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[11px] border border-white/[0.08] bg-white/[0.04] px-2 py-2">
      <p className="font-[var(--font-display)] text-[16px] font-black leading-none tracking-tight text-ink-inverse">
        {value}
      </p>
      <p className="mt-1.5 text-[8px] font-semibold uppercase tracking-[0.06em] text-ink-inverse-soft">{label}</p>
    </div>
  );
}

/* ---- Card 1: live campaign (primary — strongest card in the cluster) ---- */
function LiveCampaignBody() {
  return (
    <>
      <div className="relative mt-3 h-[116px] w-full overflow-hidden">
        <Image
          src="https://picsum.photos/seed/clipHeroCampaign/620/340"
          alt="Campaign creative preview"
          fill
          unoptimized
          sizes="290px"
          className="object-cover"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(20,15,12,0.34) 0%, rgba(20,15,12,0.02) 42%, color-mix(in srgb, var(--surface-inverse-raised) 97%, white) 100%)",
          }}
        />
        {/* play affordance — reads the still as a clip, not a stock photo */}
        <span className="absolute left-1/2 top-[46%] flex h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/25 backdrop-blur-[2px]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 6.4l9 5.6-9 5.6V6.4z" fill="white" />
          </svg>
        </span>
        <span
          className="absolute right-3 top-3 rounded-full px-2 py-[3px] text-[8px] font-black uppercase tracking-[0.07em] text-white"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
        >
          Outdoor
        </span>
        <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-[3px] text-[8px] font-black uppercase tracking-[0.07em] text-emerald-300 backdrop-blur-sm">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
          Live
        </span>
        <span className="absolute bottom-2.5 right-3 rounded-[5px] bg-black/60 px-1.5 py-[2px] text-[8px] font-bold text-white/90 backdrop-blur-sm">
          0:24
        </span>
        <span className="absolute bottom-2.5 left-3 text-[9px] font-semibold text-white/90">
          312 creators clipping now
        </span>
      </div>

      <div className="px-4 pb-4">
        <div className="mt-3 flex items-center gap-2">
          <BrandLogo mark={BRAND_MARKS[0]} size={28} radius={8} />
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-[11.5px] font-bold leading-tight text-ink-inverse">
              <span className="truncate">Northwind</span>
              <VerifiedTick size={11} />
            </p>
            <p className="text-[8.5px] leading-tight text-ink-inverse-soft">Energy drinks · Season drop</p>
          </div>
          <span
            className="ml-auto shrink-0 rounded-full px-2 py-[3px] text-[9px] font-black"
            style={{
              background: "color-mix(in srgb, var(--accent-cyan) 20%, transparent)",
              color: "var(--accent-cyan)",
            }}
          >
            $0.09 CPM
          </span>
        </div>

        <div className="mt-3.5 grid grid-cols-3 gap-1.5">
          <MiniStat label="Approval" value="46%" />
          <MiniStat label="Views" value="27.3M" />
          <MiniStat label="Spend" value="$18.4K" />
        </div>

        <div className="mt-3.5 flex items-center justify-between">
          <span className="text-[8.5px] font-semibold uppercase tracking-[0.07em] text-ink-inverse-soft">
            Daily views
          </span>
          <span className="text-[8.5px] font-bold text-emerald-300">+18.2%</span>
        </div>
        <div className="mt-1">
          <Sparkline />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[8.5px] font-semibold uppercase tracking-[0.07em] text-ink-inverse-soft">Budget</span>
          <span className="text-[8.5px] font-bold text-ink-inverse">62%</span>
        </div>
        <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full w-[62%] rounded-full"
            style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-cyan))" }}
          />
        </div>
      </div>
    </>
  );
}

/* ---- Card 2: verified brands (a populated network, not a shape grid) ---- */
type VbTile =
  | { kind: "logo"; i: number; verified?: boolean }
  | { kind: "face"; img: number }
  | { kind: "thumb"; seed: string };

const VB_TILES: VbTile[] = [
  { kind: "logo", i: 0, verified: true },
  { kind: "face", img: 12 },
  { kind: "thumb", seed: "vbProductA" },
  { kind: "logo", i: 1 },
  { kind: "face", img: 45 },
  { kind: "logo", i: 3, verified: true },
  { kind: "thumb", seed: "vbProductB" },
  { kind: "face", img: 32 },
];

function VerifiedBrandsBody() {
  return (
    <>
      <div className="grid grid-cols-4 gap-[7px]">
        {VB_TILES.map((tile, idx) => {
          if (tile.kind === "logo") {
            return (
              <span key={idx} className="relative">
                <BrandLogo mark={BRAND_MARKS[tile.i]} size={42} radius={10} />
                {tile.verified && (
                  <span className="absolute -bottom-[3px] -right-[3px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-[color:var(--surface-inverse-raised)]">
                    <VerifiedTick size={11} />
                  </span>
                )}
              </span>
            );
          }
          if (tile.kind === "thumb") {
            return (
              <span
                key={idx}
                className="relative block h-[42px] w-[42px] overflow-hidden rounded-[10px] ring-1 ring-white/[0.12]"
              >
                <Image
                  src={`https://picsum.photos/seed/${tile.seed}/120/120`}
                  alt=""
                  fill
                  unoptimized
                  sizes="42px"
                  className="object-cover"
                />
                <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
              </span>
            );
          }
          return (
            <span
              key={idx}
              className="relative block h-[42px] w-[42px] overflow-hidden rounded-full ring-1 ring-white/[0.14]"
            >
              <Image
                src={`https://i.pravatar.cc/96?img=${tile.img}`}
                alt=""
                fill
                unoptimized
                sizes="42px"
                className="object-cover"
              />
            </span>
          );
        })}
      </div>

      <div className="mt-3 space-y-1.5">
        {[BRAND_MARKS[2], BRAND_MARKS[5]].map((mark, i) => (
          <div
            key={mark.name}
            className="flex items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.035] px-2 py-1.5"
          >
            <BrandLogo mark={mark} size={22} radius={6} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate text-[10px] font-bold leading-tight text-ink-inverse">{mark.name}</span>
                <VerifiedTick size={9} />
              </span>
              <span className="block truncate text-[7.5px] leading-tight text-ink-inverse-soft">{mark.sector}</span>
            </span>
            <span
              className="shrink-0 rounded-full px-1.5 py-[2px] text-[7.5px] font-black"
              style={{
                background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                color: "var(--accent-2)",
              }}
            >
              {i === 0 ? "4 live" : "2 live"}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-white/[0.07] pt-2.5">
        <span className="flex -space-x-2">
          {[9, 27, 55].map((img) => (
            <span
              key={img}
              className="relative block h-[17px] w-[17px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse-raised)]"
            >
              <Image src={`https://i.pravatar.cc/48?img=${img}`} alt="" fill unoptimized sizes="17px" className="object-cover" />
            </span>
          ))}
        </span>
        <span className="text-[8.5px] font-medium text-ink-inverse-soft">
          <span className="font-bold text-ink-inverse">+190</span> verified this quarter
        </span>
      </div>
    </>
  );
}

/* ---- Card 3: moderation queue (a believable working tool) ---- */
function ModeratorBody() {
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="relative block h-[34px] w-[34px] shrink-0 overflow-hidden rounded-full ring-2 ring-white/[0.12]">
          <Image src="https://i.pravatar.cc/96?img=52" alt="" fill unoptimized sizes="34px" className="object-cover" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-bold leading-tight text-ink-inverse">Devon Iwu</p>
          <p className="text-[8.5px] leading-tight text-ink-inverse-soft">4 clips · submitted 2 min ago</p>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-[3px] text-[8px] font-black uppercase tracking-[0.06em]"
          style={{ background: "color-mix(in srgb, var(--accent-warm) 18%, transparent)", color: "var(--accent-warm)" }}
        >
          Pending
        </span>
      </div>

      <div className="mt-3 flex gap-1.5">
        {["clipModA", "clipModB", "clipModC"].map((seed, i) => (
          <div key={seed} className="relative h-[62px] flex-1 overflow-hidden rounded-[10px] ring-1 ring-white/[0.12]">
            <Image
              src={`https://picsum.photos/seed/${seed}/200/240`}
              alt=""
              fill
              unoptimized
              sizes="76px"
              className="object-cover"
            />
            <span className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" />
            {i === 2 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-[11px] font-black text-white">
                +2
              </span>
            ) : (
              <span className="absolute bottom-1 left-1.5 text-[7.5px] font-bold text-white/90">
                {i === 0 ? "0:18" : "0:31"}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-full bg-emerald-500/[0.18] text-[10px] font-bold text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13L10 18L19 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Approve
        </span>
        <span
          className="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-full text-[10px] font-bold ring-1 ring-inset"
          style={{
            background: "color-mix(in srgb, var(--accent) 15%, transparent)",
            color: "var(--accent-2)",
            // @ts-expect-error -- CSS custom property for the ring colour
            "--tw-ring-color": "color-mix(in srgb, var(--accent) 32%, transparent)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 3.5V20.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
            <path
              d="M6 5C9 3.6 11 6.4 14 5C16 4.1 18 5 18 5V12.2C18 12.2 16 11.3 14 12.2C11 13.6 9 10.8 6 12.2V5Z"
              fill="currentColor"
              fillOpacity="0.32"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          Flag
        </span>
      </div>
    </>
  );
}

/* ---- Floating payout chip — present but deliberately secondary ---- */
function PayoutChip({ className }: { className?: string }) {
  return (
    <div
      className={["relative overflow-hidden rounded-[18px] border border-white/[0.09] px-3.5 py-3", className ?? ""].join(" ")}
      style={{
        background:
          "linear-gradient(150deg, color-mix(in srgb, var(--surface-inverse-raised) 97%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))",
        boxShadow:
          "0 28px 58px -20px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.04), 0 0 48px -24px color-mix(in srgb, var(--accent-cyan) 70%, transparent)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full"
          style={{ background: "linear-gradient(140deg, var(--accent-cyan), var(--accent))" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13L10 18L19 7" stroke="#1a1108" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[9px] font-medium leading-tight text-ink-inverse-soft">Payout released</p>
          <p className="font-[var(--font-display)] text-[16px] font-black leading-tight tracking-tight text-ink-inverse">
            $2,480.00
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t border-white/[0.07] pt-2.5">
        <span className="flex -space-x-1.5">
          {[24, 60, 15].map((img) => (
            <span
              key={img}
              className="relative block h-[17px] w-[17px] overflow-hidden rounded-full ring-[1.5px] ring-[color:var(--surface-inverse-raised)]"
            >
              <Image src={`https://i.pravatar.cc/48?img=${img}`} alt="" fill unoptimized sizes="17px" className="object-cover" />
            </span>
          ))}
        </span>
        <span className="text-[8.5px] font-medium text-ink-inverse-soft">to 38 creators</span>
      </div>
    </div>
  );
}

/**
 * Desktop brand cluster. Column is 500px; every card carries rotation slack of
 * `sin(angle) * height / 2` on each edge, and front cards are allowed to cross
 * only into the 16px padding of the card behind them — never onto its content.
 *
 *   VerifiedBrands  left 282  top   0   w 218  rot  5.5  scale .97  z10  (back)
 *   LiveCampaign    left   0  top  34   w 268  rot -4.5  scale 1    z30  (front, primary)
 *   PayoutChip      left 318  top 306   w 182  rot  6.5  scale .95  z20  (secondary)
 *   Moderation      left  74  top 428   w 268  rot -3    scale 1    z40  (front)
 */
function BrandComposition() {
  return (
    <div className="relative hidden h-[646px] w-full lg:block">
      <Floater className="left-[282px] top-0 w-[218px]" rotate={5.5} scale={0.97} opacity={0.96} z={10}>
        <BrandCard label="Verified Brands" tier="back">
          <VerifiedBrandsBody />
        </BrandCard>
      </Floater>

      <Floater className="left-0 top-[34px] w-[268px]" rotate={-4.5} float="normal" z={30}>
        <BrandCard
          label="Live Campaign"
          tier="front"
          flush
          badge={
            <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-500/[0.16] px-1.5 py-[2px] text-[7.5px] font-black uppercase tracking-[0.07em] text-emerald-300">
              <span className="h-1 w-1 animate-pulse-soft rounded-full bg-emerald-400" />
              Running
            </span>
          }
        >
          <LiveCampaignBody />
        </BrandCard>
      </Floater>

      <Floater className="left-[318px] top-[306px] w-[182px]" rotate={6.5} scale={0.95} opacity={0.94} float="slow" z={20}>
        <PayoutChip />
      </Floater>

      <Floater className="left-[74px] top-[428px] w-[268px]" rotate={-3} z={40}>
        <BrandCard label="Moderation Queue" tier="mid">
          <ModeratorBody />
        </BrandCard>
      </Floater>
    </div>
  );
}

/* ==========================================================================
   BRAND LEFT-COLUMN FURNITURE — supporting, never competing with the headline
   ========================================================================== */

function LiveEyebrow() {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-white/[0.08] py-[5px] pl-[5px] pr-3.5"
      style={{
        background: "color-mix(in srgb, var(--surface-inverse-raised) 70%, transparent)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <span className="flex -space-x-1.5">
        {[11, 26, 47].map((img) => (
          <span
            key={img}
            className="relative block h-[18px] w-[18px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse)]"
          >
            <Image src={`https://i.pravatar.cc/48?img=${img}`} alt="" fill unoptimized sizes="18px" className="object-cover" />
          </span>
        ))}
      </span>
      <span className="text-[11.5px] font-medium tracking-[0.005em] text-ink-inverse-soft">
        <span className="font-semibold text-ink-inverse">190+ verified brands</span> running campaigns now
      </span>
    </span>
  );
}

function RatingRow() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex -space-x-2">
        {[33, 8, 51, 16, 68].map((img) => (
          <span
            key={img}
            className="relative block h-[26px] w-[26px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse)]"
          >
            <Image src={`https://i.pravatar.cc/64?img=${img}`} alt="" fill unoptimized sizes="26px" className="object-cover" />
          </span>
        ))}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="flex gap-[1.5px]">
          {[0, 1, 2, 3, 4].map((i) => (
            <svg key={i} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95L12 2.6z"
                fill="var(--accent-warm)"
                fillOpacity="0.85"
              />
            </svg>
          ))}
        </span>
        <span className="text-[12.5px] text-ink-inverse-soft">
          <span className="font-semibold text-ink-inverse">4.9</span> from 2,400+ brand teams
        </span>
      </span>
    </div>
  );
}

const BRAND_KPIS = [
  { value: "27.3M", label: "Qualified views delivered" },
  { value: "190+", label: "Verified brands onboard" },
  { value: "48h", label: "Average campaign fill" },
];

function KpiRow() {
  return (
    <dl className="grid max-w-[500px] grid-cols-3 divide-x divide-white/[0.08] border-t border-white/[0.08] pt-5">
      {BRAND_KPIS.map((kpi, i) => (
        <div key={kpi.label} className={i === 0 ? "pr-4" : "px-4 last:pr-0"}>
          <dt className="sr-only">{kpi.label}</dt>
          <dd>
            <span className="block font-[var(--font-display)] text-[22px] font-extrabold leading-none tracking-tight text-ink-inverse/90">
              {kpi.value}
            </span>
            <span className="mt-1.5 block text-[10.5px] leading-snug text-ink-inverse-soft">{kpi.label}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TrustedByStrip() {
  return (
    <div className="relative mx-auto mt-14 max-w-[1240px] border-t border-white/[0.07] px-6 pt-6">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-inverse-soft/70">
          Trusted by teams at
        </p>
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3.5">
          {BRAND_MARKS.slice(0, 6).map((mark) => (
            <span
              key={mark.name}
              className="group flex items-center gap-2 opacity-55 transition-opacity duration-200 hover:opacity-100"
            >
              <BrandLogo mark={mark} size={24} radius={7} />
              <span className="font-[var(--font-display)] text-[13px] font-bold tracking-tight text-ink-inverse transition-colors duration-200 group-hover:text-[color:var(--accent-2)]">
                {mark.name}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   HERO
   ========================================================================== */

export function Hero({ role, onRoleChange }: { role: Role; onRoleChange: (r: Role) => void }) {
  const copy = COPY[role];
  const isBrand = role === "brand";

  return (
    <section
      className={[
        "relative overflow-hidden transition-colors duration-300",
        isBrand ? "bg-surface-inverse pb-12 pt-12" : "bg-surface-sunken pb-16 pt-14",
      ].join(" ")}
    >
      {isBrand ? (
        <>
          {/* warm key light, upper left */}
          <div
            className="pointer-events-none absolute -top-44 left-[-8%] h-[640px] w-[640px] rounded-full opacity-[0.34] blur-[120px]"
            style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
          />
          {/* copper bloom directly behind the card cluster */}
          <div
            className="pointer-events-none absolute right-[2%] top-[40px] h-[620px] w-[620px] rounded-full opacity-[0.3] blur-[120px]"
            style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
          />
          <div
            className="pointer-events-none absolute right-[12%] top-[220px] h-[440px] w-[440px] rounded-full opacity-[0.2] blur-[110px]"
            style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent 70%)" }}
          />
          {/* fine grid, masked to the centre so edges stay clean */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.13]"
            style={{
              backgroundImage:
                "linear-gradient(color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px)",
              backgroundSize: "72px 72px",
              maskImage: "radial-gradient(ellipse 78% 58% at 52% 34%, black, transparent 76%)",
              WebkitMaskImage: "radial-gradient(ellipse 78% 58% at 52% 34%, black, transparent 76%)",
            }}
          />
          {/* gentle falloff toward the section edges */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 92% 78% at 50% 42%, transparent 42%, color-mix(in srgb, var(--surface-inverse) 82%, transparent) 100%)",
            }}
          />
        </>
      ) : (
        <>
          <div
            className="pointer-events-none absolute -top-16 left-[8%] h-[420px] w-[420px] rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
          />
          <div
            className="pointer-events-none absolute right-[4%] top-24 h-[380px] w-[380px] rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent 70%)" }}
          />
        </>
      )}

      <div
        className={[
          "relative mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-10 px-6",
          isBrand ? "lg:grid-cols-[1fr_500px] lg:gap-12" : "md:grid-cols-[1fr_420px]",
        ].join(" ")}
      >
        <div>
          {isBrand && (
            <div className="mb-7">
              <LiveEyebrow />
            </div>
          )}

          <h1
            className={[
              "font-[var(--font-display)] font-black",
              isBrand
                ? "text-[46px] leading-[0.98] tracking-[-0.028em] text-ink-inverse sm:text-[62px]"
                : "text-[46px] leading-[1.02] tracking-tight text-ink sm:text-[58px]",
            ].join(" ")}
          >
            {copy.headlineLead}
            <br />
            As A <RoleToggle role={role} onChange={onRoleChange} theme={isBrand ? "dark" : "light"} />{" "}
            {copy.trailingWord}
          </h1>

          <p
            className={[
              isBrand
                ? "mt-6 max-w-[30rem] text-[17.5px] leading-[1.62]"
                : "mt-6 max-w-md text-[17px] leading-relaxed text-ink-soft",
            ].join(" ")}
            style={
              isBrand
                ? { color: "color-mix(in srgb, var(--ink-inverse) 72%, var(--ink-inverse-soft))" }
                : undefined
            }
          >
            {copy.subtitle}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href={copy.primaryCta.href}
              className={[
                "inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] text-white transition-all duration-200 hover:-translate-y-1",
                isBrand ? "px-7 py-[15px] text-[15.5px] font-bold tracking-[-0.005em]" : "px-7 py-3.5 text-[15px] font-bold",
              ].join(" ")}
              style={{
                background: "linear-gradient(135deg, var(--accent), var(--accent-violet))",
                boxShadow: isBrand
                  ? "0 18px 40px -12px color-mix(in srgb, var(--accent) 68%, transparent), inset 0 1px 0 rgba(255,255,255,0.22)"
                  : "0 16px 36px -10px color-mix(in srgb, var(--accent) 60%, transparent)",
              }}
            >
              {copy.primaryCta.label}
              {isBrand && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 12H19M19 12L13 6M19 12L13 18"
                    stroke="currentColor"
                    strokeWidth="2.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </Link>
            <Link
              href={copy.secondaryCta.href}
              className={[
                "rounded-[var(--radius-token-pill)] transition-colors",
                isBrand
                  ? "border border-white/[0.13] bg-white/[0.055] px-7 py-[15px] text-[15.5px] font-bold tracking-[-0.005em] text-ink-inverse hover:bg-white/[0.11]"
                  : "bg-surface px-7 py-3.5 text-[15px] font-bold text-ink shadow-[var(--shadow-card)] hover:bg-white",
              ].join(" ")}
            >
              {copy.secondaryCta.label}
            </Link>
          </div>

          {isBrand && (
            <>
              <div className="mt-9">
                <RatingRow />
              </div>
              <div className="mt-8">
                <KpiRow />
              </div>
            </>
          )}
        </div>

        {isBrand ? (
          <div className="relative">
            <BrandComposition />
            {/* mobile keeps a real card instead of an empty column */}
            <div className="relative mx-auto max-w-[330px] pb-4 lg:hidden">
              <BrandCard
                label="Live Campaign"
                tier="front"
                flush
                badge={
                  <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-500/[0.16] px-1.5 py-[2px] text-[7.5px] font-black uppercase tracking-[0.07em] text-emerald-300">
                    <span className="h-1 w-1 animate-pulse-soft rounded-full bg-emerald-400" />
                    Running
                  </span>
                }
                className="w-full"
              >
                <LiveCampaignBody />
              </BrandCard>
              <PayoutChip className="z-10 mx-auto mt-3 w-[210px]" />
            </div>
          </div>
        ) : (
          <div className="relative hidden h-[440px] md:block">
            <CreatorCards />
          </div>
        )}
      </div>

      {isBrand && <TrustedByStrip />}
    </section>
  );
}
