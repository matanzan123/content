"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { useI18n } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { Role } from "./RoleToggle";

type StoryKey = keyof Dictionary["home"]["stories"]["quotes"];
type CreatorStory = { name: string; key: StoryKey; photo: number; quote?: string; result?: string };
type BrandStory = { company: string; code: string; gradient: string; contact: string; views: string; spent: string; cpm: string; campaignSeed: string };

const CREATOR_STORIES: CreatorStory[] = [
  { name: "Amara Torres", key: "amara", photo: 21 },
  { name: "Devon Iwu", key: "devon", photo: 52 },
  { name: "Priya Nair", key: "priya", photo: 44 },
  { name: "Lucas Ferreira", key: "lucas", photo: 61 },
  { name: "Sena Okafor", key: "sena", photo: 29 },
];

const BRAND_STORIES: BrandStory[] = [
  { company: "Northwind", code: "NW", gradient: "linear-gradient(135deg, var(--accent), var(--accent-2))", contact: "Marketing Lead", views: "1.2M", spent: "$4,800", cpm: "$0.09 CPM", campaignSeed: "neonrift" },
  { company: "Solace", code: "SL", gradient: "linear-gradient(135deg, var(--accent-violet), var(--accent-cyan))", contact: "Growth Team", views: "3.1M", spent: "$6,240", cpm: "$0.11 CPM", campaignSeed: "solaceaudio" },
  { company: "Fernway", code: "FW", gradient: "linear-gradient(135deg, var(--accent-cyan), var(--accent-2))", contact: "Founder", views: "1.4M", spent: "$2,980", cpm: "$0.07 CPM", campaignSeed: "fernwayfit" },
  { company: "Roast House", code: "RH", gradient: "linear-gradient(135deg, var(--accent-warm), var(--accent-violet))", contact: "Brand Manager", views: "5.6M", spent: "$9,840", cpm: "$0.14 CPM", campaignSeed: "roasthouse" },
  { company: "Bloom Labs", code: "BL", gradient: "linear-gradient(135deg, var(--accent-violet), var(--accent-cyan))", contact: "CMO", views: "2.3M", spent: "$4,120", cpm: "$0.10 CPM", campaignSeed: "bloomskincare" },
];

const CLONE = 2;
const CARD_W = 320;
const GAP = 24;

export function SuccessStories({ role }: { role: Role }) {
  const { t, dir } = useI18n();
  const isBrand = role === "brand";
  const stories = isBrand ? BRAND_STORIES : CREATOR_STORIES;
  const total = stories.length;
  const copy = t.home.stories;

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
        style={{ background: `radial-gradient(closest-side, var(--accent-cyan), transparent 70%)` }}
      />

      <div className="relative mx-auto max-w-[1240px] text-center">
        <p
          className={[
            "font-[var(--font-display)] text-[12px] font-bold uppercase tracking-[0.14em]",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {isBrand ? "Results" : copy.eyebrow}
        </p>
        <h2
          className={[
            "mx-auto mt-4 max-w-lg font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {isBrand ? "See What Brands Have Achieved" : copy.heading}
        </h2>
        <p
          className={[
            "mx-auto mt-4 max-w-md text-[15px] leading-relaxed",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {isBrand ? "Real campaign performance from brands already scaling with us." : copy.subtitle}
        </p>
      </div>

      <div
        className="relative mt-14 select-none"
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label={isBrand ? "Brand results" : copy.region}
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
          {/* The track stays LTR in both languages. Its position is physical
              maths — translateX, marginRight, and the swipe delta all assume a
              left-to-right axis — so mirroring it would inverse Next/Previous
              rather than translate anything. Only the copy inside each card
              follows the document direction (dir below). The active card is
              always centred, so there is no first-card-on-the-left read to fix. */}
          <div
            dir="ltr"
            className={["flex h-full items-center", smooth ? "transition-transform duration-500 ease-out" : ""].join(" ")}
            style={{ transform: `translateX(calc(50% - ${CARD_W / 2}px - ${trackIndex * (CARD_W + GAP)}px))` }}
            onTransitionEnd={handleTransitionEnd}
          >
            {extended.map((s, i) => {
              const dist = Math.abs(i - trackIndex);
              const cardStyle = { width: CARD_W, marginRight: GAP, opacity: dist === 0 ? 1 : dist === 1 ? 0.45 : 0.15, transform: `scale(${dist === 0 ? 1 : 0.88})` };

              if (isBrand) {
                const b = s as BrandStory;
                return (
                  <div key={`${b.company}-${i}`} dir={dir} className="shrink-0 transition-all duration-500" style={cardStyle}>
                    <div className="relative h-[400px] overflow-hidden rounded-[28px] border border-white/10 bg-surface-inverse-raised shadow-[0_30px_60px_-15px_rgba(0,0,0,0.55)]">
                      <div className="relative h-[170px] w-full overflow-hidden">
                        <Image src={`https://picsum.photos/seed/${b.campaignSeed}/640/400`} alt="" fill unoptimized className="object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-surface-inverse-raised via-transparent to-black/20" />
                        <span
                          className="absolute right-3 top-3 rounded-full px-3 py-1 text-[11px] font-black text-white shadow-sm"
                          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
                        >
                          {b.cpm}
                        </span>
                      </div>
                      <div className="p-5">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-black text-white" style={{ background: b.gradient }}>
                            {b.code}
                          </span>
                          <div>
                            <p className="text-[14px] font-extrabold text-ink-inverse">{b.company}</p>
                            <p className="text-[11px] text-ink-inverse-soft">{b.contact}</p>
                          </div>
                        </div>
                        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-4">
                          <div>
                            <p className="text-[10px] text-ink-inverse-soft">Total Views</p>
                            <p className="font-[var(--font-display)] text-[16px] font-black text-ink-inverse">{b.views}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-ink-inverse-soft">Spent</p>
                            <p className="font-[var(--font-display)] text-[16px] font-black text-ink-inverse">{b.spent}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              const c = s as CreatorStory;
              return (
                <div key={`${c.name}-${i}`} dir={dir} className="shrink-0 transition-all duration-500" style={cardStyle}>
                  <div className="relative h-[400px] overflow-hidden rounded-[28px] shadow-[0_30px_60px_-15px_rgba(20,21,26,0.4)]">
                    <Image src={`https://i.pravatar.cc/640?img=${c.photo}`} alt={c.name} fill unoptimized className="object-cover" />
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
                        {c.result ?? copy.results[c.key]}
                      </span>
                      <p className="mt-3 text-[15px] font-medium leading-snug text-white">“{c.quote ?? copy.quotes[c.key]}”</p>
                      <p className="mt-2 text-[13px] font-bold text-white/80">{c.name}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          aria-label={isBrand ? "Previous story" : copy.previous}
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
          aria-label={isBrand ? "Next story" : copy.next}
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

        <div className="mt-6 flex items-center justify-center">
          {stories.map((s, i) => (
            <button
              key={isBrand ? (s as BrandStory).company : (s as CreatorStory).name}
              type="button"
              aria-label={isBrand ? `Go to story ${i + 1}` : copy.goTo.replace("{index}", String(i + 1))}
              aria-current={i === activeReal}
              onClick={() => goToReal(i)}
              className="flex h-6 w-6 items-center justify-center rounded-full"
            >
              <span
                aria-hidden="true"
                className={[
                  "block h-2 rounded-full transition-all duration-300",
                  i === activeReal ? "w-6 bg-accent" : isBrand ? "w-2 bg-white/20" : "w-2 bg-line",
                ].join(" ")}
              />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
