"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { Role } from "./RoleToggle";

type Story = { name: string; quote: string; result: string; photo: number };

const STORIES: Record<Role, Story[]> = {
  creator: [
    { name: "Amara Torres", quote: "I posted three clips in my first week and the payout landed exactly on schedule.", result: "$3,240 in 30 days", photo: 21 },
    { name: "Devon Iwu", quote: "No followers, no portfolio — just picked a campaign and started posting.", result: "$1,180 first month", photo: 52 },
    { name: "Priya Nair", quote: "The trust score actually unlocked bigger campaigns once I built it up.", result: "$6,900 lifetime", photo: 44 },
    { name: "Lucas Ferreira", quote: "Payout protection made me comfortable posting for a brand I'd never heard of.", result: "$2,410 in 45 days", photo: 61 },
    { name: "Sena Okafor", quote: "I clip in my downtime between classes — it adds up faster than I expected.", result: "$890 part-time", photo: 29 },
  ],
  brand: [
    { name: "Northwind — Marketing Lead", quote: "We had verified creators posting within a day of launching the campaign.", result: "1.2M organic views", photo: 15 },
    { name: "Solace — Growth Team", quote: "Payout protection meant we only ever paid for verified performance.", result: "$0.09 CPM average", photo: 33 },
    { name: "Fernway — Founder", quote: "It replaced three separate agency relationships for a fraction of the cost.", result: "210 creators onboarded", photo: 8 },
    { name: "Roast House — Brand Manager", quote: "The approval workflow made quality control genuinely easy to manage.", result: "68% approval rate", photo: 47 },
    { name: "Bloom Labs — CMO", quote: "We finally have organic content that doesn't feel like an ad.", result: "4.1M total reach", photo: 60 },
  ],
};

const CLONE = 2;
const CARD_W = 320;
const GAP = 24;

export function SuccessStories({ role }: { role: Role }) {
  const stories = STORIES[role];
  const isBrand = role === "brand";
  const total = stories.length;

  // Extended track: [clone of last 2] + [real stories] + [clone of first 2].
  // trackIndex walks this extended array; when it lands in a cloned region we
  // silently (no transition) snap it back to the equivalent real position —
  // that's what makes next/prev feel circular with no visible reset.
  const extended = [...stories.slice(-CLONE), ...stories, ...stories.slice(0, CLONE)];
  const [trackIndex, setTrackIndex] = useState(CLONE);
  const [smooth, setSmooth] = useState(true);
  const touchStartX = useRef<number | null>(null);

  const activeReal = ((trackIndex - CLONE) % total + total) % total;

  const go = (delta: number) => {
    setSmooth(true);
    setTrackIndex((i) => i + delta);
  };

  const goToReal = (realIndex: number) => {
    setSmooth(true);
    setTrackIndex(CLONE + realIndex);
  };

  const handleTransitionEnd = () => {
    if (trackIndex < CLONE || trackIndex >= CLONE + total) {
      const real = ((trackIndex - CLONE) % total + total) % total;
      setSmooth(false);
      setTrackIndex(CLONE + real);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  };

  return (
    <section
      className={[
        "relative overflow-hidden px-6 pb-20 pt-20 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute -left-24 top-10 h-96 w-96 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-cyan), transparent 70%)" }}
      />

      <div className="relative mx-auto max-w-[1240px] text-center">
        <p
          className={[
            "font-[var(--font-display)] text-[12px] font-bold uppercase tracking-[0.14em]",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          Success Stories
        </p>
        <h2
          className={[
            "mx-auto mt-4 max-w-lg font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          See How {isBrand ? "Brands" : "Creators"} Are Winning
        </h2>
        <p
          className={[
            "mx-auto mt-4 max-w-md text-[15px] leading-relaxed",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          Real results from real {isBrand ? "brands" : "creators"} already on the platform.
        </p>
      </div>

      <div
        className="relative mt-14 select-none"
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label="Success stories"
        onKeyDown={onKeyDown}
        onTouchStart={(e) => (touchStartX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchStartX.current === null) return;
          const delta = e.changedTouches[0].clientX - touchStartX.current;
          if (delta > 50) go(-1);
          if (delta < -50) go(1);
          touchStartX.current = null;
        }}
      >
        <div className="mx-auto h-[420px] max-w-[1240px] overflow-hidden">
          <div
            className={["flex h-full items-center", smooth ? "transition-transform duration-500 ease-out" : ""].join(" ")}
            style={{ transform: `translateX(calc(50% - ${CARD_W / 2}px - ${trackIndex * (CARD_W + GAP)}px))` }}
            onTransitionEnd={handleTransitionEnd}
          >
            {extended.map((s, i) => {
              const dist = Math.abs(i - trackIndex);
              return (
                <div
                  key={`${s.name}-${i}`}
                  className="shrink-0 transition-all duration-500"
                  style={{ width: CARD_W, marginRight: GAP, opacity: dist === 0 ? 1 : dist === 1 ? 0.45 : 0.15, transform: `scale(${dist === 0 ? 1 : 0.88})` }}
                >
                  <div className="relative h-[400px] overflow-hidden rounded-[28px] shadow-[0_30px_60px_-15px_rgba(20,21,26,0.4)]">
                    <Image src={`https://i.pravatar.cc/640?img=${s.photo}`} alt={s.name} fill unoptimized className="object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/0" />
                    <span className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M8 6.5L18 12L8 17.5V6.5Z" fill="white" />
                      </svg>
                    </span>
                    <div className="absolute inset-x-0 bottom-0 p-5">
                      <span
                        className="inline-block rounded-full px-3 py-1 text-[11px] font-black text-white shadow-sm"
                        style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
                      >
                        {s.result}
                      </span>
                      <p className="mt-3 text-[15px] font-medium leading-snug text-white">“{s.quote}”</p>
                      <p className="mt-2 text-[13px] font-bold text-white/80">{s.name}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          aria-label="Previous story"
          onClick={() => go(-1)}
          className={[
            "absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full shadow-[var(--shadow-card)] transition-colors sm:left-8",
            isBrand ? "bg-surface-inverse-raised text-ink-inverse hover:bg-white/10" : "bg-surface text-ink hover:bg-surface-sunken",
          ].join(" ")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Next story"
          onClick={() => go(1)}
          className={[
            "absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full shadow-[var(--shadow-card)] transition-colors sm:right-8",
            isBrand ? "bg-surface-inverse-raised text-ink-inverse hover:bg-white/10" : "bg-surface text-ink hover:bg-surface-sunken",
          ].join(" ")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 6L15 12L9 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="mt-6 flex items-center justify-center gap-2">
          {stories.map((s, i) => (
            <button
              key={s.name}
              type="button"
              aria-label={`Go to story ${i + 1}`}
              onClick={() => goToReal(i)}
              className={[
                "h-2 rounded-full transition-all duration-300",
                i === activeReal ? "w-6 bg-accent" : isBrand ? "w-2 bg-white/20" : "w-2 bg-line",
              ].join(" ")}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
