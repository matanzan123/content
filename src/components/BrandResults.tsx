"use client";

import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Link } from "@/i18n/Link";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { useI18n } from "@/i18n/provider";
import { BRAND_MARKS, BrandLogo, VerifiedTick } from "./brand-kit";

/* ==========================================================================
   SEE WHAT BRANDS HAVE ACHIEVED
   A real coverflow carousel: the centre card is dominant, side cards frame it
   with scale/opacity/perspective falloff. Looping is done by recomputing each
   card's slot relative to the active index, so there is no scroll position to
   reset and therefore no jump when the loop wraps.
   ========================================================================== */

type CaseStudy = {
  brand: number;
  blurbKey: keyof Dictionary["brand"]["results"]["blurbs"];
  views: string;
  spent: string;
  cpm: string;
  seeds: [string, string, string];
  creator: number;
  platformKey: keyof Dictionary["brand"]["campaigns"];
};

const CASES: CaseStudy[] = [
  {
    brand: 0,
    blurbKey: "northwind",
    views: "27.3M",
    spent: "$18.4K",
    cpm: "$0.07",
    seeds: ["resNorthwindA", "resNorthwindB", "resNorthwindC"],
    creator: 14,
    platformKey: "seasonDrop",
  },
  {
    brand: 5,
    blurbKey: "orbitNine",
    views: "31.7M",
    spent: "$21.5K",
    cpm: "$0.06",
    seeds: ["resOrbitA", "resOrbitB", "resOrbitC"],
    creator: 49,
    platformKey: "capsule04",
  },
  {
    brand: 3,
    blurbKey: "kiteAudio",
    views: "12.6M",
    spent: "$9.2K",
    cpm: "$0.09",
    seeds: ["resKiteA", "resKiteB", "resKiteC"],
    creator: 36,
    platformKey: "winterDrop",
  },
  {
    brand: 2,
    blurbKey: "lumenCo",
    views: "19.1M",
    spent: "$13.8K",
    cpm: "$0.08",
    seeds: ["resLumenA", "resLumenB", "resLumenC"],
    creator: 61,
    platformKey: "haloLaunch",
  },
  {
    brand: 4,
    blurbKey: "pulseFit",
    views: "8.4M",
    spent: "$6.1K",
    cpm: "$0.11",
    seeds: ["resPulseA", "resPulseB", "resPulseC"],
    creator: 22,
    platformKey: "streakSeason",
  },
  {
    brand: 6,
    blurbKey: "fernway",
    views: "6.9M",
    spent: "$5.4K",
    cpm: "$0.12",
    seeds: ["resFernwayA", "resFernwayB", "resFernwayC"],
    creator: 45,
    platformKey: "trailSeries",
  },
];

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeMotion(cb: () => void) {
  const mq = window.matchMedia(MOTION_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false,
  );
}

/* --------------------------- the case study card ------------------------- */

function CaseCard({ item, active }: { item: CaseStudy; active: boolean }) {
  const { t } = useI18n();
  const r = t.brand.results;
  const mark = BRAND_MARKS[item.brand];
  return (
    <article
      className="relative flex h-full w-full flex-col overflow-hidden rounded-[26px] border"
      style={{
        borderColor: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)",
        background:
          "linear-gradient(178deg, color-mix(in srgb, var(--accent) 26%, #241710) 0%, color-mix(in srgb, var(--surface-inverse-raised) 92%, black) 42%, var(--surface-inverse) 100%)",
        boxShadow: active
          ? "0 50px 90px -28px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.05), 0 0 110px -30px color-mix(in srgb, var(--accent) 85%, transparent)"
          : "0 30px 60px -26px rgba(0,0,0,0.9)",
      }}
    >
      {/* soft grid texture */}
      <span
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "linear-gradient(180deg, black, transparent 55%)",
          WebkitMaskImage: "linear-gradient(180deg, black, transparent 55%)",
        }}
      />

      <div className="relative flex flex-1 flex-col p-5 sm:p-6">
        {/* brand */}
        <div className="flex items-center gap-3">
          <BrandLogo mark={mark} size={44} radius={13} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-[var(--font-display)] text-[17px] font-black leading-tight tracking-tight text-white">
              <span className="ltr-token truncate">{mark.name}</span>
              <VerifiedTick size={14} />
            </p>
            <p className="text-[11px] leading-tight text-ink-inverse-soft">{t.brand.sectors[mark.sector as keyof typeof t.brand.sectors]}</p>
          </div>
        </div>

        <p className="mt-3.5 text-[13.5px] leading-[1.5] text-ink-inverse-soft">{r.blurbs[item.blurbKey]}</p>

        {/* metrics */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {[
            { k: r.totalViews, v: item.views },
            { k: r.spent, v: item.spent },
          ].map((m) => (
            <div
              key={m.k}
              className="rounded-[14px] border border-white/[0.08] px-3.5 py-3"
              style={{ background: "rgba(255,255,255,0.04)" }}
            >
              <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-ink-inverse-soft">{m.k}</p>
              <p className="ltr-token mt-1.5 font-[var(--font-display)] text-[30px] font-black leading-none tracking-[-0.03em] text-white">
                {m.v}
              </p>
            </div>
          ))}
        </div>

        {/* campaign media composition */}
        <div className="mt-5 grid flex-1 grid-cols-3 grid-rows-2 gap-2">
          <div className="relative col-span-2 row-span-2 overflow-hidden rounded-[14px] ring-1 ring-white/[0.1]">
            <Image
              src={`https://picsum.photos/seed/${item.seeds[0]}/600/700`}
              alt=""
              fill
              unoptimized
              loading="eager"
              sizes="300px"
              className="object-cover"
            />
            <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />
            <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-[3px] text-[8.5px] font-black uppercase tracking-[0.08em] text-emerald-300 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t.brand.hero.live}
            </span>
            <div className="absolute inset-x-2.5 bottom-2.5 flex items-center gap-2">
              <span className="relative block h-[24px] w-[24px] shrink-0 overflow-hidden rounded-full ring-2 ring-white/25">
                <Image
                  src={`https://i.pravatar.cc/64?img=${item.creator}`}
                  alt=""
                  fill
                  unoptimized
                  loading="eager"
                  sizes="24px"
                  className="object-cover"
                />
              </span>
              <span className="truncate text-[10px] font-bold text-white">{t.brand.campaigns[item.platformKey]}</span>
            </div>
          </div>
          {[item.seeds[1], item.seeds[2]].map((s) => (
            <div key={s} className="relative overflow-hidden rounded-[14px] ring-1 ring-white/[0.1]">
              <Image
                src={`https://picsum.photos/seed/${s}/400/400`}
                alt=""
                fill
                unoptimized
                loading="eager"
                sizes="150px"
                className="object-cover"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" />
            </div>
          ))}
        </div>

        {/* the result */}
        <div
          className="relative mt-5 flex items-center justify-center gap-3 overflow-hidden rounded-[16px] py-3.5"
          style={{
            background: "linear-gradient(135deg, #29d17c, #12b06a 55%, #0c8f56)",
            boxShadow: "0 18px 38px -14px rgba(18,176,106,0.65), inset 0 1px 0 rgba(255,255,255,0.35)",
          }}
        >
          {active && (
            <span
              className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-cpm-shimmer"
              style={{ background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.35), transparent)" }}
            />
          )}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="relative shrink-0">
            <path d="M6 18L18 6M18 6h-8M18 6v8" stroke="#07301f" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="relative font-[var(--font-display)] text-[28px] font-black leading-none tracking-[-0.02em] text-[#07301f] sm:text-[32px]">
            <span className="ltr-token">{item.cpm} {r.cpm}</span>
          </span>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------ the carousel ----------------------------- */

/** Slot geometry: how a card looks at each distance from the active index. */
const SLOT = [
  { off: 0, scale: 1, opacity: 1, rotate: 0, z: 40 },
  { off: 64, scale: 0.84, opacity: 0.36, rotate: 14, z: 30 },
  { off: 122, scale: 0.7, opacity: 0.08, rotate: 20, z: 20 },
];

function Carousel() {
  const r = useI18n().t.brand.results;
  const [active, setActive] = useState(0);
  const reduced = usePrefersReducedMotion();
  const n = CASES.length;
  const uid = useId().replace(/:/g, "");
  const drag = useRef<{ x: number; active: boolean }>({ x: 0, active: false });

  const go = useCallback((dir: number) => setActive((a) => (a + dir + n) % n), [n]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, active: true };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.x;
    drag.current.active = false;
    if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
  };

  return (
    <div
      className="relative select-none outline-none"
      tabIndex={0}
      role="group"
      aria-roledescription="carousel"
      aria-label={r.region}
      onKeyDown={onKey}
    >
      <div
        className="relative mx-auto h-[560px] w-full touch-pan-y sm:h-[600px]"
        style={{ perspective: "1800px" }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current.active = false)}
      >
        {CASES.map((item, i) => {
          // shortest signed distance around the ring — this is what makes the
          // loop seamless in both directions
          let rel = ((i - active) % n + n) % n;
          if (rel > n / 2) rel -= n;
          const mag = Math.min(Math.abs(rel), 2);
          const s = SLOT[mag];
          const sign = Math.sign(rel);
          const hidden = Math.abs(rel) > 2;
          return (
            <div
              key={item.seeds[0]}
              className="absolute left-1/2 top-0 h-full w-[min(452px,86vw)]"
              aria-hidden={rel !== 0}
              style={{
                zIndex: s.z,
                opacity: hidden ? 0 : s.opacity,
                pointerEvents: rel === 0 ? "auto" : "none",
                transform: `translateX(calc(-50% + ${sign * s.off}%)) scale(${s.scale}) rotateY(${-sign * s.rotate}deg)`,
                transition: reduced ? "none" : "transform 620ms cubic-bezier(0.22,1,0.36,1), opacity 620ms ease",
              }}
            >
              <div className="relative h-full">
                <CaseCard item={item} active={rel === 0} />
              </div>
            </div>
          );
        })}
      </div>

      {/* controls */}
      <div className="mt-7 flex items-center justify-center gap-5">
        <button
          type="button"
          aria-label={r.previous}
          onClick={() => go(-1)}
          className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-white/[0.12] text-ink-inverse transition-colors hover:border-white/25 hover:bg-white/[0.07]"
          style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 80%, transparent)" }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5M5 12l6-6M5 12l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex items-center">
          {CASES.map((c, i) => (
            <button
              key={c.seeds[0]}
              type="button"
              aria-label={r.goTo.replace("{index}", String(i + 1))}
              aria-current={i === active}
              onClick={() => setActive(i)}
              className="flex h-6 w-6 items-center justify-center rounded-full"
            >
              <span
                aria-hidden="true"
                className="block rounded-full transition-all duration-300"
                style={{
                  width: i === active ? 26 : 8,
                  height: 8,
                  background: i === active ? "#ffffff" : "rgba(255,255,255,0.24)",
                }}
              />
            </button>
          ))}
        </div>

        <button
          type="button"
          aria-label={r.next}
          onClick={() => go(1)}
          className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-white/[0.12] text-ink-inverse transition-colors hover:border-white/25 hover:bg-white/[0.07]"
          style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 80%, transparent)" }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14M19 12l-6-6M19 12l-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <span className="sr-only" aria-live="polite">
        {r.announce.replace("{index}", String(active + 1)).replace("{total}", String(n)).replace("{name}", BRAND_MARKS[CASES[active].brand].name)}
      </span>
      <span hidden id={uid} />
    </div>
  );
}

/* -------------------------------- section -------------------------------- */

function CtaBlock() {
  const r = useI18n().t.brand.results;
  const stack: ({ face: number } | { brand: number })[] = [
    { face: 22 },
    { brand: 0 },
    { face: 61 },
    { brand: 3 },
    { face: 45 },
    { brand: 10 },
  ];
  return (
    <div className="mt-12 flex flex-col items-center gap-5">
      <Link
        href="/contact"
        className="group inline-flex items-center gap-2.5 rounded-[var(--radius-token-pill)] px-10 py-[19px] text-[17px] font-bold tracking-[-0.005em] text-white transition-all duration-200 hover:-translate-y-1"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-violet))",
          boxShadow:
            "0 26px 58px -12px color-mix(in srgb, var(--accent) 80%, transparent), inset 0 1px 0 rgba(255,255,255,0.26)",
        }}
      >
        {r.cta}
        <svg
          width="18"
          height="18"
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
              className="relative block h-[34px] w-[34px] overflow-hidden rounded-full ring-2 ring-[color:var(--surface-inverse)]"
            >
              <Image src={`https://i.pravatar.cc/80?img=${item.face}`} alt="" fill unoptimized sizes="34px" className="object-cover" />
            </span>
          ) : (
            <span key={i} className="rounded-full ring-2 ring-[color:var(--surface-inverse)]">
              <BrandLogo mark={BRAND_MARKS[item.brand]} size={34} radius={999} />
            </span>
          ),
        )}
      </span>

      <p className="text-[15px] font-bold text-white">{r.trust}</p>
    </div>
  );
}

export function BrandResults() {
  const r = useI18n().t.brand.results;
  return (
    <section className="relative overflow-hidden bg-surface-inverse px-6 pb-24 pt-28">
      <span
        className="pointer-events-none absolute inset-x-[12%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }}
      />
      <div
        className="pointer-events-none absolute left-1/2 top-10 h-[620px] w-[1100px] -translate-x-1/2 rounded-full opacity-[0.18] blur-[140px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div
        className="pointer-events-none absolute -left-40 bottom-20 h-[500px] w-[500px] rounded-full opacity-[0.12] blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />

      <div className="relative mx-auto max-w-[1240px]">
        <div className="text-center">
          <span
            className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-white/[0.1] px-3.5 py-1.5"
            style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 78%, transparent)" }}
          >
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-inverse-soft">
              {r.badge}
            </span>
          </span>
          <h2 className="mx-auto mt-5 max-w-[22ch] text-balance font-[var(--font-display)] text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-white sm:text-[56px]">
            {r.heading}
          </h2>
          <p
            className="mx-auto mt-4 max-w-[52ch] text-balance text-[17px] font-medium leading-[1.55]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 80%, var(--ink-inverse-soft))" }}
          >
            {r.subtitle}
          </p>
        </div>

        <div className="mt-12">
          <Carousel />
        </div>

        <CtaBlock />
      </div>
    </section>
  );
}
