"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Link } from "@/i18n/Link";
import { BRAND_MARKS, BrandLogo, VerifiedTick, type BrandMark } from "./brand-kit";
import { FOUNDERS } from "../data/brands";
import { VERIFIED_BRANDS_ID } from "./section-anchors";

/* ==========================================================================
   TILE PRIMITIVES
   Every tile is a finished visual asset — real imagery or a fully drawn brand
   mark. No initials, no empty boxes, no repeated generic glyphs.
   ========================================================================== */

function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={[
        "group/tile relative h-full w-full overflow-hidden rounded-[14px] ring-1 ring-white/[0.09]",
        className ?? "",
      ].join(" ")}
      style={{ boxShadow: "0 18px 38px -16px rgba(0,0,0,0.85)" }}
    >
      {children}
    </div>
  );
}

/** Four distinct treatments so the wall reads as many different companies. */
function LogoTile({
  mark,
  variant,
  meta,
}: {
  mark: BrandMark;
  variant: "gradient" | "dark" | "outline" | "solid";
  meta?: string;
}) {
  const onColor = variant === "gradient" || variant === "solid";
  const surface =
    variant === "gradient"
      ? { background: `linear-gradient(145deg, ${mark.from}, ${mark.to})` }
      : variant === "solid"
        ? { background: `color-mix(in srgb, ${mark.from} 76%, #140f0c)` }
        : variant === "dark"
          ? { background: "color-mix(in srgb, var(--surface-inverse-raised) 97%, white)" }
          : { background: "rgba(255,255,255,0.03)" };

  return (
    <Frame>
      <div className="relative flex h-full w-full flex-col justify-between p-2.5" style={surface}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[22%] -right-[26%] h-[120%] w-[120%]"
          style={{ opacity: onColor ? 0.17 : 0.12, transform: "rotate(-14deg)" }}
        >
          <path
            d={mark.d}
            stroke={onColor ? "white" : mark.from}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={mark.fill ? (onColor ? "rgba(255,255,255,0.5)" : mark.from) : "none"}
          />
        </svg>
        {onColor && (
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.2), transparent 52%)" }}
          />
        )}
        {variant === "dark" && (
          <span
            className="pointer-events-none absolute inset-x-4 top-0 h-px"
            style={{ background: `linear-gradient(90deg, transparent, ${mark.from}, transparent)` }}
          />
        )}

        <div className="relative flex items-start justify-between">
          {variant === "outline" ? (
            <span
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full border"
              style={{ borderColor: `color-mix(in srgb, ${mark.from} 50%, transparent)` }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d={mark.d}
                  stroke={mark.from}
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill={mark.fill ? `color-mix(in srgb, ${mark.from} 26%, transparent)` : "none"}
                />
              </svg>
            </span>
          ) : onColor ? (
            <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] bg-white/20 ring-1 ring-inset ring-white/25">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d={mark.d}
                  stroke="white"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill={mark.fill ? "rgba(255,255,255,0.3)" : "none"}
                />
              </svg>
            </span>
          ) : (
            <BrandLogo mark={mark} size={26} radius={8} />
          )}
          <VerifiedTick size={11} />
        </div>

        <div className="relative">
          <p
            className={[
              "truncate leading-tight",
              onColor ? "text-white" : "text-ink-inverse",
              variant === "outline"
                ? "text-[10px] font-bold uppercase tracking-[0.14em]"
                : variant === "solid"
                  ? "font-[var(--font-display)] text-[12.5px] font-bold italic tracking-tight"
                  : "font-[var(--font-display)] text-[12.5px] font-black tracking-tight",
            ].join(" ")}
          >
            {mark.name}
          </p>
          <p
            className={[
              "mt-0.5 truncate text-[8.5px] leading-tight",
              onColor ? "text-white/70" : "text-ink-inverse-soft",
            ].join(" ")}
          >
            {meta ? `${mark.sector} · ${meta}` : mark.sector}
          </p>
        </div>
      </div>
    </Frame>
  );
}

function PersonTile({ img, name, role }: { img: number; name: string; role: string }) {
  return (
    <Frame>
      <Image
        src={`https://i.pravatar.cc/400?img=${img}`}
        alt={`${name}, ${role}`}
        fill
        unoptimized
        sizes="180px"
        loading="eager"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/88 via-black/12 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <p className="flex items-center gap-1 text-[11px] font-bold leading-tight text-white">
          <span className="truncate">{name}</span>
          <VerifiedTick size={10} />
        </p>
        <p className="truncate text-[8.5px] leading-tight text-white/70">{role}</p>
      </div>
    </Frame>
  );
}

function ImageTile({ seed, brand, label }: { seed: string; brand: number; label: string }) {
  return (
    <Frame>
      <Image
        src={`https://picsum.photos/seed/${seed}/420/520`}
        alt={label}
        fill
        unoptimized
        sizes="180px"
        loading="eager"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/25" />
      <span className="absolute left-2 top-2">
        <BrandLogo mark={BRAND_MARKS[brand]} size={22} radius={7} />
      </span>
      <p className="absolute inset-x-0 bottom-0 truncate p-2.5 text-[10px] font-semibold text-white/90">{label}</p>
    </Frame>
  );
}

function CampaignTile({ seed, brand, title, views }: { seed: string; brand: number; title: string; views: string }) {
  return (
    <Frame>
      <Image
        src={`https://picsum.photos/seed/${seed}/420/300`}
        alt={title}
        fill
        unoptimized
        sizes="180px"
        loading="eager"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-black/10" />
      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-[2px] text-[7.5px] font-black uppercase tracking-[0.08em] text-emerald-300 backdrop-blur-sm">
        <span className="h-1 w-1 animate-pulse-soft rounded-full bg-emerald-400" />
        Live
      </span>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 p-2.5">
        <BrandLogo mark={BRAND_MARKS[brand]} size={20} radius={6} />
        <div className="min-w-0">
          <p className="truncate text-[10px] font-bold leading-tight text-white">{title}</p>
          <p className="text-[8px] leading-tight text-white/65">{views} views</p>
        </div>
      </div>
    </Frame>
  );
}

function IdentityTile({ mark }: { mark: BrandMark }) {
  return (
    <Frame>
      <div
        className="flex h-full w-full flex-col justify-between p-2.5"
        style={{
          background:
            "linear-gradient(155deg, color-mix(in srgb, var(--surface-inverse-raised) 97%, white), color-mix(in srgb, var(--surface-inverse) 90%, black))",
        }}
      >
        <div className="flex items-start justify-between">
          <BrandLogo mark={mark} size={28} radius={9} />
          <VerifiedTick size={11} />
        </div>
        <div>
          <p className="truncate font-[var(--font-display)] text-[12px] font-extrabold leading-tight tracking-tight text-ink-inverse">
            {mark.name}
          </p>
          <p className="mt-0.5 truncate text-[8.5px] leading-tight text-ink-inverse-soft">{mark.sector}</p>
          <div className="mt-2 flex gap-1">
            {(mark.palette ?? [mark.from, mark.to, "#2a1d12"]).map((c, i) => (
              <span
                key={i}
                className="h-[6px] flex-1 rounded-full"
                style={{ background: c, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.09)" }}
              />
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}

/* ==========================================================================
   LIVE BEHAVIOUR
   ========================================================================== */

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void) {
  const mq = window.matchMedia(MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Subscribes to the OS motion preference as an external store — no effect, no cascading render. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false,
  );
}

/**
 * Odometer digit. The 0-9 strip is translated by -value * 10% inside a
 * fixed-size box, so the roll can never shift layout or change width.
 */
function Digit({ value, reduced }: { value: number; reduced: boolean }) {
  return (
    <span className="relative inline-block h-[1em] w-[0.62em] overflow-hidden align-top">
      <span
        className="absolute inset-x-0 top-0 flex flex-col"
        style={{
          transform: `translateY(-${value * 10}%)`,
          transition: reduced ? "none" : "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <span key={d} className="flex h-[1em] items-center justify-center">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

const COUNT_START = 214;
const COUNT_MAX = COUNT_START + 6;

/** Ticks up occasionally, as though a brand just joined. Pauses when hidden. */
function LiveCounter() {
  const [count, setCount] = useState(COUNT_START);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (count >= COUNT_MAX) return;
    const delay = 7000 + Math.random() * 5000;
    const id = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      setCount((c) => Math.min(c + 1, COUNT_MAX));
    }, delay);
    return () => window.clearTimeout(id);
  }, [count]);

  const digits = String(count).padStart(3, "0").split("").map(Number);

  return (
    <p className="font-[var(--font-display)] text-[58px] font-black leading-[1] tracking-[-0.04em] text-white tabular-nums sm:text-[68px]">
      <span className="sr-only">{count} brands</span>
      <span aria-hidden="true" className="inline-flex">
        {digits.map((d, i) => (
          <Digit key={i} value={d} reduced={reduced} />
        ))}
      </span>
    </p>
  );
}

/**
 * Crossfades between finished tiles on a slow timer. Both layers sit absolutely
 * inside a fixed-size box, so a swap can never move anything.
 */
function LiveSwapTile({ tiles, period, offset }: { tiles: React.ReactNode[]; period: number; offset: number }) {
  const [i, setI] = useState(0);
  const reduced = usePrefersReducedMotion();
  const len = tiles.length;
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (reduced) return;
    const handles = timers.current;
    const start = window.setTimeout(() => {
      const id = window.setInterval(() => {
        if (document.visibilityState !== "visible") return;
        setI((v) => (v + 1) % len);
      }, period);
      handles.push(id);
    }, offset);
    handles.push(start);
    return () => {
      handles.forEach((h) => {
        window.clearTimeout(h);
        window.clearInterval(h);
      });
      handles.length = 0;
    };
  }, [reduced, period, offset, len]);

  return (
    <div className="relative h-full w-full">
      {tiles.map((t, idx) => (
        <div
          key={idx}
          className="absolute inset-0 transition-opacity duration-[900ms] ease-out"
          style={{ opacity: idx === i ? 1 : 0 }}
          aria-hidden={idx !== i}
        >
          {t}
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   MOSAIC
   A concentrated vertical cluster: four drifting columns around a static
   centre. Tiles continuously enter and leave the masked window, so the wall
   reads as a live network rather than a fixed grid. No card container — the
   composition fades straight into the section background.
   ========================================================================== */

type ColTile = { h: number; node: React.ReactNode };

function Column({
  tiles,
  dir,
  duration,
  className,
  style,
}: {
  tiles: ColTile[];
  dir: "up" | "down";
  duration: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const run = (prefix: string) =>
    tiles.map((t, i) => (
      <div key={`${prefix}-${i}`} style={{ height: t.h }} className="w-full shrink-0">
        {t.node}
      </div>
    ));

  return (
    <div className={["overflow-hidden", className ?? ""].join(" ")} style={style}>
      <div
        className={dir === "up" ? "mosaic-col-up flex flex-col gap-3" : "mosaic-col-down flex flex-col gap-3"}
        style={{ ["--drift" as string]: `${duration}s` }}
      >
        {run("a")}
        {run("b")}
      </div>
    </div>
  );
}

/** Small metric tile — platform activity, kept subtle and believable. */
function MetricTile({ value, label, tone }: { value: string; label: string; tone?: "amber" | "emerald" }) {
  return (
    <Frame>
      <div
        className="relative flex h-full w-full flex-col justify-center gap-1 px-3"
        style={{
          background:
            "linear-gradient(155deg, color-mix(in srgb, var(--surface-inverse-raised) 97%, white), color-mix(in srgb, var(--surface-inverse) 92%, black))",
        }}
      >
        <span
          className="pointer-events-none absolute inset-x-5 top-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.24), transparent)" }}
        />
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full"
            style={{ background: tone === "emerald" ? "#34d399" : "var(--accent-2)" }}
          />
          <p className="font-[var(--font-display)] text-[19px] font-black leading-none tracking-tight text-ink-inverse">
            {value}
          </p>
        </div>
        <p className="text-[8.5px] font-medium leading-tight text-ink-inverse-soft">{label}</p>
      </div>
    </Frame>
  );
}

/* --- column builders, driven entirely by the fictional dataset --- */

const B = BRAND_MARKS;

const logo = (i: number, h: number, live: number): ColTile => ({
  h,
  node: <LogoTile mark={B[i]} variant={B[i].style} meta={`${live} live`} />,
});
const person = (i: number, h: number): ColTile => ({ h, node: <PersonTile {...FOUNDERS[i]} /> });
const product = (i: number, h: number, label: string): ColTile => ({
  h,
  node: <ImageTile seed={B[i].seed} brand={i} label={label} />,
});
const campaign = (i: number, h: number, title: string, views: string): ColTile => ({
  h,
  node: <CampaignTile seed={`${B[i].seed}C`} brand={i} title={title} views={views} />,
});
const identity = (i: number, h: number): ColTile => ({ h, node: <IdentityTile mark={B[i]} /> });
const metric = (h: number, value: string, label: string, tone?: "amber" | "emerald"): ColTile => ({
  h,
  node: <MetricTile value={value} label={label} tone={tone} />,
});

// Outermost left — furthest back, most faded.
const COL_1: ColTile[] = [
  logo(12, 132, 6),
  person(7, 158),
  product(13, 144, "Solace · sleep set"),
  logo(14, 126, 9),
  identity(15, 138),
  campaign(16, 130, "Tallow film", "1.4M"),
  logo(17, 134, 4),
];

const COL_2: ColTile[] = [
  person(8, 162),
  logo(6, 136, 11),
  campaign(7, 132, "Coastal edit", "3.1M"),
  identity(9, 140),
  product(10, 150, "Vireo · care kit"),
  logo(11, 128, 7),
  metric(112, "4.9", "avg brand rating"),
];

// Inner left — sharper and brighter.
const COL_3: ColTile[] = [
  logo(0, 150, 14),
  person(0, 172),
  identity(2, 142),
  product(7, 158, "Saltmarsh · SS-24"),
  metric(116, "48h", "avg campaign fill"),
  logo(4, 140, 3),
  person(4, 166),
];

// Inner right.
const COL_4: ColTile[] = [
  person(2, 170),
  campaign(3, 138, "Winter drop", "4.2M"),
  logo(1, 148, 11),
  product(2, 156, "Lumen Co. · brand shoot"),
  metric(116, "27.3M", "views delivered", "emerald"),
  logo(5, 144, 9),
  person(5, 164),
];

const COL_5: ColTile[] = [
  logo(18, 138, 8),
  person(9, 160),
  product(19, 148, "Cinder · studio kit"),
  identity(20, 140),
  campaign(21, 130, "Nocturne live", "2.2M"),
  logo(22, 134, 5),
  person(10, 156),
];

// Outermost right.
const COL_6: ColTile[] = [
  identity(23, 136),
  logo(24, 128, 6),
  product(25, 146, "Cove & Cedar · oak"),
  person(11, 154),
  logo(26, 132, 10),
  campaign(27, 128, "Everdusk reel", "1.9M"),
  logo(19, 130, 4),
];

/** Centre anchor: the live counter, flanked by two swapping tiles the mask crops. */
function CentreColumn() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="h-[124px] w-full">
        <LiveSwapTile
          period={9000}
          offset={2600}
          tiles={[
            <CampaignTile key="a" seed="mosCentreA" brand={0} title="Season drop" views="27.3M" />,
            <ImageTile key="b" seed="mosCentreB" brand={5} label="Orbit Nine · lookbook" />,
          ]}
        />
      </div>

      <div
        className="relative w-full shrink-0 overflow-hidden rounded-[20px] border border-white/[0.14] px-3 py-5"
        style={{
          background:
            "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 98%, white), color-mix(in srgb, var(--surface-inverse) 94%, black))",
          boxShadow:
            "0 40px 90px -22px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.06), 0 0 110px -28px color-mix(in srgb, var(--accent) 92%, transparent)",
        }}
      >
        <span
          className="animate-glow pointer-events-none absolute left-1/2 top-1/2 h-[250px] w-[250px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[54px]"
          style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
        />
        <svg
          viewBox="0 0 400 400"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[160%] w-[160%] -translate-x-1/2 -translate-y-1/2"
        >
          {[78, 120, 162].map((r, i) => (
            <circle
              key={r}
              cx="200"
              cy="200"
              r={r}
              fill="none"
              stroke="var(--accent-2)"
              strokeWidth="1"
              opacity={0.15 - i * 0.038}
            />
          ))}
        </svg>
        <span
          className="pointer-events-none absolute inset-x-8 top-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)" }}
        />
        <div className="relative flex flex-col items-center text-center">
          <LiveCounter />
          <p className="mt-1.5 text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink-inverse-soft">Brands</p>
          {/* the mark row needs real width — below sm the centre column is too narrow for it */}
          <div className="mt-3 w-full border-t border-white/[0.08] pt-3">
            <div className="hidden items-center justify-center gap-1.5 sm:flex">
              {[6, 13, 18, 24].map((i) => (
                <BrandLogo key={i} mark={B[i]} size={16} radius={5} />
              ))}
              <span className="ml-0.5 whitespace-nowrap text-[9px] font-semibold text-ink-inverse-soft">
                +18 this month
              </span>
            </div>
            <p className="text-center text-[9.5px] font-semibold text-ink-inverse-soft sm:hidden">
              <span className="text-ink-inverse">+18</span> this month
            </p>
          </div>
        </div>
      </div>

      <div className="h-[124px] w-full">
        <LiveSwapTile
          period={11000}
          offset={5200}
          tiles={[
            <PersonTile key="a" {...FOUNDERS[6]} />,
            <LogoTile key="b" mark={B[3]} variant="gradient" meta="8 live" />,
          ]}
        />
      </div>
    </div>
  );
}

const EDGE_MASK =
  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 7%, black 22%, black 74%, rgba(0,0,0,0.28) 91%, transparent 99%)";

/**
 * Seven columns drifting in alternating directions around a static centre.
 * Width and opacity fall off toward the edges, so the eye lands on the counter
 * while the outer columns read as the network continuing past the frame.
 */
function Mosaic() {
  return (
    // The columns drift on a loop, so "pausable" stops them under a pointer or
    // keyboard focus and the whole wall is hidden from assistive tech — it is
    // decoration, and the brands it shows are named in the copy around it.
    <div
      aria-hidden="true"
      className="pausable relative mx-auto h-[560px] w-full max-w-[1160px] sm:h-[640px]"
      style={{ maskImage: EDGE_MASK, WebkitMaskImage: EDGE_MASK }}
    >
      <div className="flex h-full justify-center gap-2.5 sm:gap-3">
        <Column
          tiles={COL_1}
          dir="up"
          duration={72}
          className="hidden w-[128px] shrink-0 xl:block"
          style={{ opacity: 0.4, transform: "scale(0.9)" }}
        />
        <Column
          tiles={COL_2}
          dir="down"
          duration={66}
          className="hidden w-[140px] shrink-0 lg:block"
          style={{ opacity: 0.6, transform: "scale(0.95)" }}
        />
        <Column tiles={COL_3} dir="up" duration={60} className="w-[30%] shrink-0 sm:w-[152px]" style={{ opacity: 0.9 }} />
        <div className="w-[36%] shrink-0 sm:w-[212px]">
          <CentreColumn />
        </div>
        <Column tiles={COL_4} dir="down" duration={63} className="w-[30%] shrink-0 sm:w-[152px]" style={{ opacity: 0.9 }} />
        <Column
          tiles={COL_5}
          dir="up"
          duration={69}
          className="hidden w-[140px] shrink-0 lg:block"
          style={{ opacity: 0.6, transform: "scale(0.95)" }}
        />
        <Column
          tiles={COL_6}
          dir="down"
          duration={75}
          className="hidden w-[128px] shrink-0 xl:block"
          style={{ opacity: 0.4, transform: "scale(0.9)" }}
        />
      </div>
    </div>
  );
}

/** Rotating "just joined" line — the section's one overt sign of live activity. */
function ActivityTicker() {
  const picks = [6, 13, 18, 9, 24, 20];
  const [i, setI] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setI((v) => (v + 1) % picks.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [reduced, picks.length]);

  return (
    <span
      className="inline-flex h-[34px] items-center gap-2 overflow-hidden rounded-[var(--radius-token-pill)] border border-white/[0.09] pl-1.5 pr-3.5"
      style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 72%, transparent)" }}
    >
      {/* both strips roll vertically — crossfading two different names just looks garbled */}
      <span className="block h-[22px] w-[22px] shrink-0 overflow-hidden">
        <span
          className="flex flex-col"
          style={{
            transform: `translateY(-${i * 22}px)`,
            transition: reduced ? "none" : "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {picks.map((p) => (
            <span key={p} className="flex h-[22px] shrink-0 items-center">
              <BrandLogo mark={B[p]} size={22} radius={6} />
            </span>
          ))}
        </span>
      </span>
      <span className="block h-[16px] w-[142px] overflow-hidden text-left sm:w-[172px]">
        <span
          className="flex flex-col"
          style={{
            transform: `translateY(-${i * 16}px)`,
            transition: reduced ? "none" : "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {picks.map((p) => (
            <span
              key={p}
              className="h-[16px] shrink-0 truncate whitespace-nowrap text-[12px] leading-4 text-ink-inverse-soft"
            >
              <span className="font-semibold text-ink-inverse">{B[p].name}</span> just joined
            </span>
          ))}
        </span>
      </span>
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-emerald-400" />
    </span>
  );
}

/* ==========================================================================
   SECTION
   ========================================================================== */

function BrandAvatarRow() {
  const items: ({ face: number } | { brand: number })[] = [
    { face: 22 },
    { brand: 0 },
    { face: 61 },
    { brand: 3 },
    { face: 45 },
    { brand: 10 },
  ];
  return (
    <span className="flex -space-x-2.5">
      {items.map((item, i) =>
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
  );
}

export function BrandCredibility() {
  return (
    <section
      id={VERIFIED_BRANDS_ID}
      className="scroll-anchor-offset relative z-10 -mt-10 overflow-hidden rounded-t-[44px] px-6 pb-20 pt-16 sm:rounded-t-[56px] sm:pt-20"
      style={{
        background:
          "linear-gradient(180deg, #1d140c 0%, color-mix(in srgb, var(--surface-inverse) 90%, #2a1d12) 32%, var(--surface-inverse) 70%)",
      }}
    >
      {/* copper rim along the rounded top edge */}
      <span
        className="pointer-events-none absolute inset-x-[8%] top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 85%, transparent), transparent)",
        }}
      />
      <span
        className="pointer-events-none absolute left-1/2 top-0 h-[200px] w-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-30 blur-[80px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />

      {/* atmosphere */}
      <div
        className="pointer-events-none absolute left-1/2 top-[140px] h-[680px] w-[1000px] -translate-x-1/2 rounded-full opacity-20 blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div
        className="pointer-events-none absolute -right-40 top-1/2 h-[520px] w-[520px] rounded-full opacity-[0.16] blur-[120px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />
      {[
        { l: "14%", t: "26%", s: 5, o: 0.45 },
        { l: "86%", t: "34%", s: 4, o: 0.38 },
        { l: "24%", t: "74%", s: 5, o: 0.3 },
        { l: "76%", t: "82%", s: 4, o: 0.4 },
      ].map((p, i) => (
        <span
          key={i}
          className="pointer-events-none absolute rounded-full blur-[2px]"
          style={{
            left: p.l,
            top: p.t,
            width: p.s,
            height: p.s,
            opacity: p.o,
            background: "var(--accent-2)",
            boxShadow: "0 0 12px 2px color-mix(in srgb, var(--accent) 55%, transparent)",
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.1]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent) 1px, transparent 1px)",
          backgroundSize: "76px 76px",
          maskImage: "radial-gradient(ellipse 70% 56% at 50% 50%, black, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 56% at 50% 50%, black, transparent 78%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 86% 74% at 50% 48%, transparent 42%, color-mix(in srgb, var(--surface-inverse) 90%, transparent) 100%)",
        }}
      />

      <div className="relative mx-auto max-w-[1240px]">
        <div className="text-center">
          <p className="font-[var(--font-display)] text-[11px] font-bold uppercase tracking-[0.2em] text-ink-inverse-soft/75">
            Verified Network
          </p>
          <h2 className="mx-auto mt-4 max-w-[18ch] text-balance font-[var(--font-display)] text-[42px] font-black leading-[0.97] tracking-[-0.03em] text-white sm:text-[58px] lg:max-w-[30ch]">
            Join 200+ Profitable Brands
          </h2>
          <p
            className="mx-auto mt-4 max-w-[52ch] text-balance text-[16.5px] font-medium leading-[1.6]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 74%, var(--ink-inverse-soft))" }}
          >
            Verified brands win more deals and build more trust — stronger placement, more
            applicants, and creators who actually ship.
          </p>
          <div className="mt-6 flex justify-center">
            <ActivityTicker />
          </div>
        </div>

        <div className="mt-6">
          <Mosaic />
        </div>

        <div className="mt-1 flex flex-col items-center gap-4">
          <Link
            href="/contact"
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
              <path
                d="M5 12H19M19 12L13 6M19 12L13 18"
                stroke="currentColor"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>

          <BrandAvatarRow />
          <p className="text-[14px] font-bold text-white">Trusted by 200+ Brands</p>
        </div>
      </div>
    </section>
  );
}
