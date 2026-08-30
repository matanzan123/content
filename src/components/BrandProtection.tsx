"use client";

import Image from "next/image";
import { Link } from "@/i18n/Link";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { useT } from "@/i18n/provider";
import { BRAND_MARKS, BrandLogo } from "./brand-kit";

type ProtectionKey = keyof Dictionary["brand"]["protection"];

/* ==========================================================================
   PROTECTION FEATURES YOU CAN TRUST

   Premium visual marketing section. Each of the three cards is built around
   ONE large dimensional hero object — a satin flag, a security processor, a
   24Hrs support rig — that fills roughly two thirds of the card. Copy is
   secondary and sits under the artwork.

   Rendering notes that matter if you edit this file:
   - Every card renders exactly ONCE (a single responsive grid, stacked by CSS
     on mobile), so the hardcoded SVG gradient/clip ids below are unique. If a
     card is ever duplicated into a separate mobile tree, those ids collide and
     `url(#id)` resolves to the hidden copy — scope them with useId() first.
   - Ambient motion uses translate-only keyframes. Anything that also needs a
     rotation carries it on an outer wrapper, because a CSS animation on
     `transform` outranks an inline transform and would wipe the rotation out.
   ========================================================================== */

/* --------------------------------- shell -------------------------------- */

/**
 * Card shell. The whole hover state lives here: rim brightens, warm glow
 * swells, card lifts. Every hover change is a transition on an existing layer,
 * so pointing at a card never triggers layout.
 */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-[30px] p-6 transition-transform duration-500 ease-out hover:-translate-y-1.5 sm:p-7"
      style={{
        background: "linear-gradient(178deg, #15100b 0%, #0b0806 42%, #040303 100%)",
        boxShadow: "0 50px 90px -34px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {/* dotted technical texture, faded out toward the bottom */}
      <span
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage: "linear-gradient(180deg, black, transparent 72%)",
          WebkitMaskImage: "linear-gradient(180deg, black, transparent 72%)",
        }}
      />
      {/* resting hairline border */}
      <span
        className="pointer-events-none absolute inset-0 rounded-[30px]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.075)" }}
      />
      {/* copper rim + outer bloom — the hover tell */}
      <span
        className="pointer-events-none absolute inset-0 rounded-[30px] opacity-40 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--accent) 52%, transparent), 0 0 60px -14px color-mix(in srgb, var(--accent) 80%, transparent)",
        }}
      />
      <span
        className="pointer-events-none absolute inset-x-14 top-0 h-px opacity-60 transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,225,196,0.5), transparent)" }}
      />
      {/* warm interior light that intensifies with the artwork on hover */}
      <span
        className="pointer-events-none absolute -top-24 left-1/2 h-[300px] w-[400px] -translate-x-1/2 rounded-full opacity-30 blur-[80px] transition-opacity duration-500 group-hover:opacity-[0.62]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div className="relative flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function CardCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-auto pt-6">
      <h3 className="font-[var(--font-display)] text-[23px] font-black tracking-[-0.02em] text-white sm:text-[26px]">
        {title}
      </h3>
      <p
        className="mt-2.5 max-w-[34ch] text-[14px] leading-[1.55]"
        style={{ color: "color-mix(in srgb, var(--ink-inverse) 72%, var(--ink-inverse-soft))" }}
      >
        {body}
      </p>
    </div>
  );
}

/** Soft contact shadow that keeps floating objects from looking pasted on. */
function GroundShadow({ className }: { className?: string }) {
  return (
    <span
      className={["pointer-events-none absolute rounded-[50%] blur-[15px]", className ?? ""].join(" ")}
      style={{ background: "radial-gradient(closest-side, rgba(0,0,0,0.9), transparent 72%)" }}
    />
  );
}

/**
 * Extruded lettering: a stacked text-shadow body behind a gradient face. This
 * is what makes "24Hrs" read as a milled object rather than as bold text.
 */
function Extruded({
  children,
  className,
  depth = 14,
  face = "linear-gradient(168deg, #fff6ec 6%, var(--accent-warm) 44%, var(--accent) 96%)",
  shade = "#5b2c0e",
}: {
  children: React.ReactNode;
  className?: string;
  depth?: number;
  face?: string;
  shade?: string;
}) {
  const stack = Array.from({ length: depth }, (_, i) => `${i + 1}px ${i + 1}px 0 ${shade}`).join(", ");
  return (
    <span className={["relative inline-block font-[var(--font-display)] font-black", className ?? ""].join(" ")}>
      <span
        aria-hidden="true"
        className="block"
        style={{ color: shade, textShadow: `${stack}, 0 30px 50px rgba(0,0,0,0.9)` }}
      >
        {children}
      </span>
      <span
        className="absolute inset-0 block"
        style={{
          background: face,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          filter: "drop-shadow(0 2px 0 rgba(255,255,255,0.28))",
        }}
      >
        {children}
      </span>
    </span>
  );
}

/* ====================== CARD 1 — FLAG VIDEOS ============================ */

/**
 * The cloth outline, shared by the body fill, the fold clip and the rim light
 * so all three stay in register. Drawn in the 340x300 viewBox: it leaves the
 * mast at x=34 and reaches x=310, which is what makes the flag fill the card.
 */
const FLAG_D =
  "M34 44C100 10 158 84 226 50c38-19 66-23 84-11v168c-18-14-46-10-84 10-68 36-126-40-192-6z";

/**
 * Submission tiles pinned around the flag. `rotate` sits on the wrapper and the
 * drift animation on the inner element — see the transform note at the top.
 */
const SUBMISSIONS = [
  { seed: "protClipAurora", label: "offBrief" as ProtectionKey, value: "2.1M", left: "54%", top: "-2%", w: "min(128px, 40%)", rot: 6, drift: "animate-drift", z: 5 },
  { seed: "protClipRidge", label: "underReview" as ProtectionKey, value: "$412", left: "58%", top: "49%", w: "min(116px, 37%)", rot: -5, drift: "animate-drift-slow", z: 4 },
  { seed: "protClipHalden", label: "flagged" as ProtectionKey, value: "884K", left: "1%", top: "68%", w: "min(122px, 39%)", rot: -7, drift: "animate-drift-slower", z: 6 },
];

function SubmissionTile({ item }: { item: (typeof SUBMISSIONS)[number] }) {
  const t = useT().brand.protection;
  const flagged = item.label === "flagged";
  return (
    <span
      className="absolute block"
      style={{ left: item.left, top: item.top, width: item.w, zIndex: item.z, transform: `rotate(${item.rot}deg)` }}
    >
      <span className={`block ${item.drift}`}>
        <span
          className="block overflow-hidden rounded-[14px]"
          style={{
            background: "linear-gradient(178deg, #221a14, #0c0806)",
            boxShadow:
              "0 26px 42px -16px rgba(0,0,0,0.95), inset 0 0 0 1px rgba(255,255,255,0.12), 0 0 30px -12px color-mix(in srgb, var(--accent) 80%, transparent)",
          }}
        >
          <span className="relative block" style={{ aspectRatio: "3 / 2" }}>
            <Image
              src={`https://picsum.photos/seed/${item.seed}/300/200`}
              alt=""
              fill
              unoptimized
              sizes="140px"
              className="object-cover"
            />
            <span
              className="pointer-events-none absolute inset-0"
              style={{ background: "linear-gradient(190deg, rgba(255,178,104,0.2), rgba(0,0,0,0.55) 82%)" }}
            />
            <span
              className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-[3px] text-[8px] font-black uppercase tracking-[0.08em] text-white"
              style={{
                background: flagged
                  ? "linear-gradient(135deg, var(--accent), var(--accent-violet))"
                  : "rgba(10,7,5,0.78)",
                boxShadow: flagged ? "0 4px 12px -3px color-mix(in srgb, var(--accent) 85%, transparent)" : "none",
              }}
            >
              {flagged && (
                <svg width="7" height="7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 3v18" stroke="white" strokeWidth="3.4" strokeLinecap="round" />
                  <path d="M6 4.5h13l-3.4 4.6L19 13.7H6z" fill="white" />
                </svg>
              )}
              {t[item.label]}
            </span>
          </span>
          <span className="flex items-center justify-between gap-1.5 px-2 py-1.5">
            <span className="flex min-w-0 items-center gap-1">
              <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: flagged ? "var(--accent)" : "#7b8a6a" }} />
              <span className="truncate text-[8px] font-bold uppercase tracking-[0.05em] text-[color:var(--ink-inverse-soft)]">
                {t.submission}
              </span>
            </span>
            <span className="ltr-token shrink-0 text-[10px] font-black text-white">{item.value}</span>
          </span>
        </span>
      </span>
    </span>
  );
}

function FlagHero() {
  return (
    <div className="relative h-[320px] sm:h-[344px]">
      <span
        className="animate-glow pointer-events-none absolute left-[6%] top-[12%] h-[250px] w-[280px] rounded-full blur-[64px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />
      <GroundShadow className="left-[4%] top-[72%] h-[32px] w-[62%]" />

      {/* the flag is the hero object — everything else orbits it */}
      <svg
        viewBox="0 0 340 300"
        aria-hidden="true"
        className="absolute -left-4 top-0 h-[292px] w-[330px] drop-shadow-[0_36px_56px_rgba(0,0,0,0.95)] sm:h-[310px] sm:w-[352px]"
      >
        <defs>
          <clipPath id="protFlagClip">
            <path d={FLAG_D} />
          </clipPath>
          {/* charcoal body — the cloth is black material, lit only from outside */}
          <linearGradient id="protFlagBase" x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0%" stopColor="#2b2724" />
            <stop offset="44%" stopColor="#141110" />
            <stop offset="100%" stopColor="#050404" />
          </linearGradient>
          {/* alternating bands read as satin folds; whites stay low so the
              material stays black rather than drifting to beige */}
          <linearGradient id="protFlagSatin" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#000000" stopOpacity="0.35" />
            <stop offset="9%" stopColor="#ffffff" stopOpacity="0.13" />
            <stop offset="17%" stopColor="#000000" stopOpacity="0.66" />
            <stop offset="28%" stopColor="#ffffff" stopOpacity="0.07" />
            <stop offset="38%" stopColor="#000000" stopOpacity="0.6" />
            <stop offset="49%" stopColor="#ffffff" stopOpacity="0.14" />
            <stop offset="59%" stopColor="#000000" stopOpacity="0.64" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="0.08" />
            <stop offset="81%" stopColor="#000000" stopOpacity="0.66" />
            <stop offset="91%" stopColor="#ffffff" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
          </linearGradient>
          {/* copper spill, confined to the two outer edges */}
          <linearGradient id="protFlagWarm" x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
            <stop offset="34%" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="78%" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--accent-warm)" stopOpacity="0.3" />
          </linearGradient>
          <linearGradient id="protMast" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0a0908" />
            <stop offset="30%" stopColor="#6d6259" />
            <stop offset="52%" stopColor="#cbb9a6" />
            <stop offset="72%" stopColor="#4a423b" />
            <stop offset="100%" stopColor="#0c0a09" />
          </linearGradient>
          <filter id="protSpec" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.6" />
          </filter>
        </defs>

        {/* mast */}
        <rect x="24" y="12" width="12" height="270" rx="6" fill="url(#protMast)" />
        <circle cx="30" cy="10" r="8.5" fill="url(#protMast)" />
        <circle cx="27.5" cy="7.5" r="2.8" fill="#fff0dd" opacity="0.75" />

        {/* satin body */}
        <g className="animate-sway" style={{ transformOrigin: "34px 110px" }}>
          <path d={FLAG_D} fill="url(#protFlagBase)" />
          <g clipPath="url(#protFlagClip)">
            <rect x="26" y="0" width="292" height="240" fill="url(#protFlagSatin)" />
            <rect x="26" y="0" width="292" height="240" fill="url(#protFlagWarm)" />
            {/* specular streaks riding the crests of the folds */}
            <path d="M92 18C88 82 96 148 88 216" stroke="#ffe2c0" strokeWidth="4.6" opacity="0.2" fill="none" filter="url(#protSpec)" />
            <path d="M186 30C182 96 190 160 182 226" stroke="#ffd7ac" strokeWidth="3.8" opacity="0.16" fill="none" filter="url(#protSpec)" />
            <path d="M270 16C266 82 274 146 266 210" stroke="#ffcf9c" strokeWidth="3.4" opacity="0.22" fill="none" filter="url(#protSpec)" />
            {/* deep creases between them */}
            <path d="M138 8v238M228 16v236" stroke="#000000" strokeWidth="9" opacity="0.5" filter="url(#protSpec)" />
          </g>
          {/* copper rim light tracing the cloth, brightest on the free edge */}
          <path d={FLAG_D} fill="none" stroke="var(--accent)" strokeWidth="1.6" opacity="0.6" />
          <path d="M310 39v168c-18-14-46-10-84 10" fill="none" stroke="#ffd2a4" strokeWidth="2.4" opacity="0.55" filter="url(#protSpec)" />
        </g>
      </svg>

      {SUBMISSIONS.map((item) => (
        <SubmissionTile key={item.seed} item={item} />
      ))}
    </div>
  );
}

/* ====================== CARD 2 — BOT PROTECTION ========================= */

/** One pin run, drawn along the top edge and rotated into place per side. */
function PinRow({ count, length, gap }: { count: number; length: number; gap: number }) {
  const span = (count - 1) * gap;
  return (
    <g>
      {Array.from({ length: count }, (_, i) => (
        <rect
          key={i}
          x={-span / 2 + i * gap - 3}
          y={-length}
          width="6"
          height={length}
          rx="2.4"
          fill="url(#protPin)"
        />
      ))}
    </g>
  );
}

const DATA_TILES = [
  { label: "botsBlocked" as ProtectionKey, value: "1,284", left: "-2%", top: "2%", drift: "animate-drift" },
  { label: "verifiedViews" as ProtectionKey, value: "98.6%", left: "54%", top: "0%", drift: "animate-drift-slow" },
  { label: "signalsPerSec" as ProtectionKey, value: "4.2K", left: "57%", top: "76%", drift: "animate-drift-slower" },
];

function ChipHero() {
  const t = useT().brand.protection;
  return (
    <div className="relative h-[320px] sm:h-[344px]">
      <span
        className="animate-glow pointer-events-none absolute left-1/2 top-[16%] h-[250px] w-[250px] -translate-x-1/2 rounded-full blur-[62px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 68%)" }}
      />
      <GroundShadow className="left-1/2 top-[78%] h-[30px] w-[210px] -translate-x-1/2" />

      <svg
        viewBox="0 0 340 320"
        aria-hidden="true"
        className="absolute left-1/2 top-2 h-[300px] w-[320px] -translate-x-1/2 drop-shadow-[0_34px_52px_rgba(0,0,0,0.95)] sm:h-[318px] sm:w-[340px]"
      >
        <defs>
          <linearGradient id="protPin" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#3b342e" />
            <stop offset="40%" stopColor="#d3c1ac" />
            <stop offset="72%" stopColor="#7a6d60" />
            <stop offset="100%" stopColor="#241e19" />
          </linearGradient>
          <linearGradient id="protChipFrame" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#8d8177" />
            <stop offset="26%" stopColor="#3d3630" />
            <stop offset="62%" stopColor="#221d19" />
            <stop offset="100%" stopColor="#0a0807" />
          </linearGradient>
          <linearGradient id="protChipPlate" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#1c1713" />
            <stop offset="55%" stopColor="#100c0a" />
            <stop offset="100%" stopColor="#070505" />
          </linearGradient>
          <radialGradient id="protCoreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe6c6" stopOpacity="0.95" />
            <stop offset="40%" stopColor="var(--accent)" stopOpacity="0.7" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="protCoreFace" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#fff1de" />
            <stop offset="34%" stopColor="var(--accent-warm)" />
            <stop offset="72%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="#7f350f" />
          </linearGradient>
          <linearGradient id="protChipGloss" x1="0.1" y1="0" x2="0.55" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
            <stop offset="46%" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* faint substrate traces running out to the board */}
        <g stroke="var(--accent)" strokeWidth="1.1" fill="none" opacity="0.3">
          <path d="M22 96h40v-28h34M318 96h-40v-28h-34M22 232h40v28h34M318 232h-40v28h-34" />
        </g>
        <g fill="var(--accent-2)" opacity="0.5">
          <circle cx="22" cy="96" r="3" />
          <circle cx="318" cy="96" r="3" />
          <circle cx="22" cy="232" r="3" />
          <circle cx="318" cy="232" r="3" />
        </g>

        <g transform="translate(170 164)">
          {/* pins */}
          <g transform="translate(0 -98)">
            <PinRow count={9} length={26} gap={18} />
          </g>
          <g transform="translate(0 98) rotate(180)">
            <PinRow count={9} length={26} gap={18} />
          </g>
          <g transform="translate(-98 0) rotate(-90)">
            <PinRow count={9} length={26} gap={18} />
          </g>
          <g transform="translate(98 0) rotate(90)">
            <PinRow count={9} length={26} gap={18} />
          </g>

          {/* extrusion — the body's thickness, drawn behind the face */}
          <rect x="-100" y="-88" width="200" height="200" rx="26" fill="#050404" />
          <rect x="-100" y="-94" width="200" height="196" rx="26" fill="#161110" />

          {/* metallic frame + inner plate */}
          <rect x="-100" y="-100" width="200" height="200" rx="26" fill="url(#protChipFrame)" />
          <rect
            x="-100"
            y="-100"
            width="200"
            height="200"
            rx="26"
            fill="none"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="1.4"
          />
          <rect x="-84" y="-84" width="168" height="168" rx="18" fill="url(#protChipPlate)" />
          <rect
            x="-84"
            y="-84"
            width="168"
            height="168"
            rx="18"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1.2"
          />

          {/* etched die traces */}
          <g stroke="var(--accent)" strokeWidth="1.2" fill="none" opacity="0.42">
            <path d="M-70 -56h26v-18M70 -56h-26v-18M-70 56h26v18M70 56h-26v18" />
            <path d="M-74 0h22M74 0h-22M0 -74v18M0 74v-18" />
          </g>
          <g fill="var(--accent-2)" opacity="0.55">
            <circle cx="-52" cy="-52" r="2.6" className="animate-pulse-soft" />
            <circle cx="52" cy="-52" r="2.6" />
            <circle cx="-52" cy="52" r="2.6" />
            <circle cx="52" cy="52" r="2.6" className="animate-pulse-soft" />
          </g>

          {/* glowing core */}
          <circle cx="0" cy="0" r="72" fill="url(#protCoreGlow)" className="animate-glow" />
          <path d="M0 -50l43 25v50L0 50l-43-25v-50z" fill="#3a1608" transform="translate(3 6)" opacity="0.9" />
          <path
            d="M0 -50l43 25v50L0 50l-43-25v-50z"
            fill="url(#protCoreFace)"
            stroke="rgba(255,255,255,0.5)"
            strokeWidth="1.6"
          />
          <path d="M0 -50l43 25v50L0 50l-43-25v-50z" fill="url(#protChipGloss)" />
          <path
            d="M-17 2l12 12 23-26"
            stroke="#fffaf3"
            strokeWidth="7.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      </svg>

      {DATA_TILES.map((tile) => (
        <span key={tile.label} className="absolute" style={{ left: tile.left, top: tile.top, zIndex: 6 }}>
          <span
            className={`flex flex-col gap-0.5 rounded-[11px] px-2.5 py-1.5 ${tile.drift}`}
            style={{
              background: "linear-gradient(178deg, rgba(34,26,20,0.96), rgba(10,7,5,0.96))",
              boxShadow:
                "0 20px 34px -14px rgba(0,0,0,0.95), inset 0 0 0 1px rgba(255,255,255,0.11), 0 0 26px -12px color-mix(in srgb, var(--accent) 75%, transparent)",
            }}
          >
            <span className="text-[8px] font-bold uppercase tracking-[0.1em] text-[color:var(--ink-inverse-soft)]">
              {t[tile.label]}
            </span>
            <span className="ltr-token text-[13px] font-black leading-none text-white">{tile.value}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/* ======================== CARD 3 — VIP SUPPORT ========================== */

function HeadsetGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M9 29v-5a15 15 0 0130 0v5" stroke="#fffaf3" strokeWidth="3.6" strokeLinecap="round" />
      <rect x="4.5" y="26" width="10.5" height="15" rx="5" fill="#fffaf3" fillOpacity="0.94" />
      <rect x="33" y="26" width="10.5" height="15" rx="5" fill="#fffaf3" fillOpacity="0.94" />
      <path d="M38 41v1.5a4.5 4.5 0 01-4.5 4.5H27" stroke="#fffaf3" strokeWidth="3.2" strokeLinecap="round" opacity="0.95" />
    </svg>
  );
}

const SIDE_TILES = [
  { key: "chat", left: "0%", top: "48%", size: 74, drift: "animate-drift-slow", rot: -8, d: "M6 8h36v22H22l-9 8v-8H6z" },
  { key: "clock", left: "72%", top: "42%", size: 68, drift: "animate-drift-slower", rot: 9, d: "M24 6a18 18 0 100 36 18 18 0 000-36zM24 14v11l7 5" },
  { key: "agent", left: "67%", top: "76%", size: 58, drift: "animate-drift", rot: -6, d: "M24 10a7 7 0 100 14 7 7 0 000-14zM11 40c0-7 6-11 13-11s13 4 13 11" },
];

function VipHero() {
  const t = useT().brand.protection;
  return (
    <div className="relative h-[320px] sm:h-[344px]">
      <span
        className="animate-glow pointer-events-none absolute left-1/2 top-[26%] h-[250px] w-[270px] -translate-x-1/2 rounded-full blur-[64px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />

      <div className="relative flex justify-center pt-1">
        <Extruded className="text-[68px] leading-[0.92] tracking-[-0.05em] sm:text-[80px]">24Hrs</Extruded>
      </div>

      {/* darker satellites first, so the bright rig always reads on top */}
      {SIDE_TILES.map((tile) => (
        <span
          key={tile.key}
          className="absolute"
          style={{
            left: tile.left,
            top: tile.top,
            width: tile.size,
            height: tile.size,
            zIndex: 3,
            transform: `rotate(${tile.rot}deg)`,
          }}
        >
          <span
            className={`flex h-full w-full items-center justify-center rounded-[18px] ${tile.drift}`}
            style={{
              background: "linear-gradient(168deg, #241b14, #0b0806)",
              boxShadow: "0 24px 40px -16px rgba(0,0,0,0.95), inset 0 0 0 1px rgba(255,255,255,0.1)",
            }}
          >
            <svg
              width={Math.round(tile.size * 0.44)}
              height={Math.round(tile.size * 0.44)}
              viewBox="0 0 48 48"
              fill="none"
              aria-hidden="true"
            >
              <path
                d={tile.d}
                stroke="var(--accent-2)"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity="0.8"
              />
            </svg>
          </span>
        </span>
      ))}

      {/* the support rig — brightest object in the card */}
      <div className="absolute left-1/2 top-[44%] z-[5] -translate-x-1/2">
        <GroundShadow className="left-1/2 top-[126px] h-[28px] w-[170px] -translate-x-1/2" />
        <span
          className="animate-drift relative flex h-[138px] w-[138px] items-center justify-center rounded-[32px]"
          style={{
            background: "linear-gradient(158deg, #fff0dc 2%, var(--accent-warm) 34%, var(--accent) 74%, #83380f 100%)",
            boxShadow:
              "inset 0 2px 0 rgba(255,255,255,0.65), inset 0 -6px 14px rgba(120,55,10,0.55), 0 34px 56px -18px rgba(0,0,0,0.95), 0 0 60px -14px color-mix(in srgb, var(--accent) 90%, transparent)",
          }}
        >
          <span
            className="pointer-events-none absolute inset-0 rounded-[32px]"
            style={{ background: "linear-gradient(178deg, rgba(255,255,255,0.4), transparent 52%)" }}
          />
          <span className="relative drop-shadow-[0_4px_10px_rgba(90,40,8,0.6)]">
            <HeadsetGlyph size={76} />
          </span>
        </span>
      </div>

      {/* status pill grounds the promise without adding a paragraph */}
      <span
        className="absolute bottom-0 left-1/2 z-[6] inline-flex -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5"
        style={{
          background: "color-mix(in srgb, var(--surface-inverse-raised) 88%, transparent)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
        }}
      >
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
        <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[color:var(--ink-inverse-soft)]">
          {t.teamOnline}
        </span>
      </span>
    </div>
  );
}

/* ============================== CTA BLOCK =============================== */

const PROOF_STACK = [
  { brand: 0 },
  { face: 14 },
  { brand: 5 },
  { face: 49 },
  { brand: 3 },
  { face: 36 },
  { brand: 8 },
] as const;

function CtaBlock() {
  const t = useT().brand.protection;
  return (
    <div className="relative mt-16 flex flex-col items-center gap-6 sm:mt-20">
      <Link
        href="/contact"
        className="group/cta inline-flex items-center gap-2.5 rounded-[var(--radius-token-pill)] px-9 py-4 text-[16.5px] font-bold text-white transition-transform duration-300 hover:-translate-y-1"
        style={{
          background: "linear-gradient(135deg, var(--accent-2), var(--accent) 55%, #9c440f)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.4), 0 22px 50px -14px color-mix(in srgb, var(--accent) 85%, transparent)",
        }}
      >
        {t.cta}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="transition-transform duration-300 group-hover/cta:translate-x-1"
        >
          <path
            d="M5 12h14M19 12l-6-6M19 12l-6 6"
            stroke="currentColor"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>

      <span className="flex -space-x-2.5">
        {PROOF_STACK.map((item, i) =>
          "face" in item ? (
            <span key={i} className="relative block h-[34px] w-[34px] overflow-hidden rounded-full ring-2 ring-[#0a0705]">
              <Image src={`https://i.pravatar.cc/80?img=${item.face}`} alt="" fill unoptimized sizes="34px" className="object-cover" />
            </span>
          ) : (
            <span key={i} className="rounded-full ring-2 ring-[#0a0705]">
              <BrandLogo mark={BRAND_MARKS[item.brand]} size={34} radius={999} />
            </span>
          ),
        )}
      </span>

      <p className="text-[15px] font-bold text-white">{t.trust}</p>
    </div>
  );
}

/* =============================== SECTION ================================ */

export function BrandProtection() {
  const t = useT().brand.protection;
  return (
    <section
      className="relative overflow-hidden px-6 pb-24 pt-24 sm:pt-28"
      style={{
        background:
          "radial-gradient(88% 40% at 50% -4%, rgba(217,118,46,0.46), transparent 66%), linear-gradient(180deg, #2e1c11 0%, #190f08 13%, #0a0705 32%, #030202 58%, #000000 100%)",
      }}
    >
      {/* warm atmosphere, confined to the band under the heading */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-[300px]"
        style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent)" }}
      />
      {/* vignette — this is what takes the frame to black around and below the
          cards instead of leaving the section a uniform brown */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(96% 52% at 50% 8%, transparent 34%, rgba(0,0,0,0.9) 100%)" }}
      />
      <span
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage: "radial-gradient(80% 50% at 50% 6%, black, transparent 78%)",
          WebkitMaskImage: "radial-gradient(80% 50% at 50% 6%, black, transparent 78%)",
        }}
      />
      {/* blends the warm opening into the near-black bottom of the approved
          section above — without it the colour change lands as a hard line */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-[190px]"
        style={{ background: "linear-gradient(180deg, var(--surface-inverse), rgba(20,15,12,0) 100%)" }}
      />

      <div className="relative mx-auto max-w-[1240px]">
        <div className="text-center">
          <h2 className="mx-auto max-w-[18ch] text-balance font-[var(--font-display)] text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-white sm:text-[58px]">
            {t.heading}
          </h2>
          <p
            className="mx-auto mt-5 max-w-[46ch] text-balance text-[17px] font-medium leading-[1.55]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 76%, var(--ink-inverse-soft))" }}
          >
            {t.subtitle}
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card>
            <FlagHero />
            <CardCopy title={t.flagTitle} body={t.flagBody} />
          </Card>
          <Card>
            <ChipHero />
            <CardCopy title={t.botTitle} body={t.botBody} />
          </Card>
          <Card>
            <VipHero />
            <CardCopy title={t.vipTitle} body={t.vipBody} />
          </Card>
        </div>

        <CtaBlock />
      </div>
    </section>
  );
}
