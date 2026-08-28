import Image from "next/image";
import Link from "next/link";
import { BRAND_MARKS, BrandLogo } from "./brand-kit";

/* ==========================================================================
   WHY VERIFICATION MATTERS
   Premium visual marketing section. Each card is built around one large
   dimensional hero object rather than embedded UI. Artwork first, copy second.
   ========================================================================== */

type Tone = "amber" | "rings" | "copper" | "gold" | "atmos";

/** Per-card lighting, so the five cards share a system without repeating. */
const TONE: Record<Tone, { glow: string; rim: string; wash: string }> = {
  amber: {
    glow: "var(--accent)",
    rim: "rgba(255,255,255,0.17)",
    wash: "radial-gradient(120% 90% at 20% 34%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 62%)",
  },
  rings: {
    glow: "var(--accent)",
    rim: "rgba(255,255,255,0.12)",
    wash: "radial-gradient(80% 72% at 50% 40%, color-mix(in srgb, var(--accent) 28%, transparent), transparent 68%)",
  },
  copper: {
    glow: "var(--accent-violet)",
    rim: "rgba(255,255,255,0.09)",
    wash: "radial-gradient(85% 75% at 50% 36%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 66%)",
  },
  gold: {
    glow: "var(--accent-warm)",
    rim: "rgba(255,255,255,0.09)",
    wash: "radial-gradient(110% 90% at 28% 76%, color-mix(in srgb, var(--accent-warm) 26%, transparent), transparent 64%)",
  },
  atmos: {
    glow: "var(--accent-cyan)",
    rim: "rgba(255,255,255,0.09)",
    wash: "linear-gradient(166deg, color-mix(in srgb, var(--accent) 24%, transparent), transparent 58%)",
  },
};

function Card({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  const t = TONE[tone];
  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-[28px] border p-6 transition-transform duration-300 hover:-translate-y-1.5 sm:p-7"
      style={{
        borderColor: "rgba(255,255,255,0.07)",
        background:
          "linear-gradient(162deg, color-mix(in srgb, var(--surface-inverse-raised) 96%, white), color-mix(in srgb, var(--surface-inverse) 94%, black) 70%)",
        boxShadow: "0 40px 80px -30px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: t.wash }} />
      <span
        className="pointer-events-none absolute inset-x-12 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${t.rim}, transparent)` }}
      />
      <span
        className="pointer-events-none absolute -top-32 left-1/2 h-[320px] w-[420px] -translate-x-1/2 rounded-full opacity-30 blur-[80px] transition-opacity duration-500 group-hover:opacity-50"
        style={{ background: `radial-gradient(closest-side, ${t.glow}, transparent 72%)` }}
      />
      <div className="relative flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function CardCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-auto pt-7">
      <h3 className="font-[var(--font-display)] text-[22px] font-black tracking-[-0.02em] text-white sm:text-[25px]">
        {title}
      </h3>
      <p
        className="mt-2.5 max-w-[40ch] text-[14px] leading-[1.55]"
        style={{ color: "color-mix(in srgb, var(--ink-inverse) 78%, var(--ink-inverse-soft))" }}
      >
        {body}
      </p>
    </div>
  );
}

/**
 * Extruded numeral: a stacked-shadow body sits behind a gradient face, which is
 * what makes the figures read as physical objects instead of flat text.
 */
function Extruded({
  children,
  className,
  depth = 15,
  face = "linear-gradient(168deg, #fff6ec 6%, var(--accent-warm) 46%, var(--accent) 96%)",
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
        style={{ color: shade, textShadow: `${stack}, 0 34px 56px rgba(0,0,0,0.9)` }}
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
          filter: "drop-shadow(0 2px 0 rgba(255,255,255,0.26))",
        }}
      >
        {children}
      </span>
    </span>
  );
}

/** Soft contact shadow under floating objects. */
function GroundShadow({ className }: { className?: string }) {
  return (
    <span
      className={["pointer-events-none absolute rounded-[50%] blur-[14px]", className ?? ""].join(" ")}
      style={{ background: "radial-gradient(closest-side, rgba(0,0,0,0.85), transparent 72%)" }}
    />
  );
}

/* ============================ CARD 1 — 30% ============================== */

/** Positioned inside the right-hand zone only, so nothing crosses the numeral. */
const ORBIT_FACES = [
  { img: 14, size: 92, right: "0%", top: "0%" },
  { img: 22, size: 56, right: "56%", top: "6%" },
  { img: 49, size: 76, right: "26%", top: "46%" },
  { img: 36, size: 62, right: "0%", top: "70%" },
];

function ApplicantsHero() {
  return (
    <div className="relative h-[248px] sm:h-[268px]">
      <span
        className="pointer-events-none absolute -left-12 top-2 h-[250px] w-[320px] rounded-full opacity-60 blur-[64px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />
      <GroundShadow className="left-2 top-[146px] h-[34px] w-[240px]" />

      <Extruded className="relative block pt-1 text-[92px] leading-[1.04] tracking-[-0.055em] sm:text-[122px]">
        30%
      </Extruded>

      <span
        className="relative mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-bold text-white"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-violet))",
          boxShadow: "0 16px 32px -10px color-mix(in srgb, var(--accent) 85%, transparent)",
        }}
      >
        more applicants
      </span>

      {/* creators fill the right-hand zone top to bottom */}
      <div className="absolute inset-y-0 right-0 w-[46%] origin-top-right scale-[0.74] sm:scale-100">
        {ORBIT_FACES.map((f, i) => (
          <span
            key={f.img}
            className="absolute overflow-hidden rounded-[22px]"
            style={{
              right: f.right,
              top: f.top,
              width: f.size,
              height: f.size,
              zIndex: 4 - i,
              boxShadow:
                "0 26px 44px -14px rgba(0,0,0,0.95), inset 0 0 0 1.5px rgba(255,255,255,0.22), 0 0 34px -10px color-mix(in srgb, var(--accent) 85%, transparent)",
            }}
          >
            <Image src={`https://i.pravatar.cc/240?img=${f.img}`} alt="" fill unoptimized sizes="96px" className="object-cover" />
            <span
              className="pointer-events-none absolute inset-0"
              style={{ background: "linear-gradient(205deg, rgba(255,190,120,0.22), transparent 55%)" }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

/* ========================= CARD 2 — shield ============================== */

function ShieldHero() {
  return (
    <div className="relative flex h-[248px] items-center justify-center sm:h-[268px]">
      <svg viewBox="0 0 420 420" aria-hidden="true" className="pointer-events-none absolute h-[430px] w-[430px]">
        <defs>
          <radialGradient id="vShieldField" cx="50%" cy="50%" r="50%">
            <stop offset="38%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="210" cy="210" r="205" fill="url(#vShieldField)" />
        {[80, 118, 156, 194].map((r, i) => (
          <circle
            key={r}
            cx="210"
            cy="210"
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={i === 1 ? 1.9 : 1.1}
            opacity={0.44 - i * 0.085}
          />
        ))}
        <circle cx="210" cy="210" r="156" fill="none" stroke="var(--accent-2)" strokeWidth="1.6" opacity="0.5" strokeDasharray="3 13" />
      </svg>

      <span
        className="animate-glow pointer-events-none absolute h-[250px] w-[250px] rounded-full blur-[58px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 68%)" }}
      />
      <GroundShadow className="left-1/2 top-[200px] h-[30px] w-[190px] -translate-x-1/2" />

      <svg width="208" height="208" viewBox="0 0 200 200" className="relative drop-shadow-[0_30px_50px_rgba(0,0,0,0.9)]">
        <defs>
          <linearGradient id="vShieldFace" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#ffd9ae" />
            <stop offset="34%" stopColor="var(--accent-2)" />
            <stop offset="72%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="#7a2f0c" />
          </linearGradient>
          <linearGradient id="vShieldEdge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffe3c4" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
          <linearGradient id="vShieldGloss" x1="0.1" y1="0" x2="0.6" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.55" />
            <stop offset="48%" stopColor="white" stopOpacity="0.06" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <filter id="vTickGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d="M100 26l66 27v56c0 42-28 70-66 84-38-14-66-42-66-84V53l66-27z" transform="translate(5 9)" fill="#4a1f08" opacity="0.95" />
        <path
          d="M100 20l70 28.5v58.5c0 44.5-29.5 74-70 88.5-40.5-14.5-70-44-70-88.5V48.5L100 20z"
          fill="none"
          stroke="url(#vShieldEdge)"
          strokeWidth="3"
          opacity="0.75"
        />
        <path
          d="M100 26l66 27v56c0 42-28 70-66 84-38-14-66-42-66-84V53l66-27z"
          fill="url(#vShieldFace)"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="1.6"
        />
        <path d="M100 26l66 27v56c0 42-28 70-66 84-38-14-66-42-66-84V53l66-27z" fill="url(#vShieldGloss)" />
        <path
          d="M74 102l19 19 40-42"
          stroke="white"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          filter="url(#vTickGlow)"
        />
      </svg>
    </div>
  );
}

/* ====================== CARD 3 — verification badge ===================== */

const ROSETTE = Array.from({ length: 26 }, (_, i) => {
  const a = (i / 26) * Math.PI * 2;
  const r = i % 2 === 0 ? 78 : 65;
  return `${(100 + Math.cos(a) * r).toFixed(1)},${(100 + Math.sin(a) * r).toFixed(1)}`;
}).join(" ");

function BadgeHero() {
  return (
    <div className="relative flex h-[228px] items-center justify-center">
      <svg viewBox="0 0 300 300" aria-hidden="true" className="pointer-events-none absolute h-[300px] w-[300px] opacity-45">
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return (
            <path
              key={i}
              d={`M150 150 L${(150 + Math.cos(a - 0.05) * 150).toFixed(1)} ${(150 + Math.sin(a - 0.05) * 150).toFixed(1)} L${(150 + Math.cos(a + 0.05) * 150).toFixed(1)} ${(150 + Math.sin(a + 0.05) * 150).toFixed(1)} Z`}
              fill="var(--accent)"
              opacity={i % 2 ? 0.18 : 0.07}
            />
          );
        })}
      </svg>
      <span
        className="pointer-events-none absolute h-[215px] w-[215px] rounded-full opacity-70 blur-[52px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 68%)" }}
      />
      <span
        className="pointer-events-none absolute bottom-2 h-[26px] w-[196px] rounded-[50%]"
        style={{ background: "radial-gradient(closest-side, rgba(0,0,0,0.9), transparent 74%)" }}
      />
      <span
        className="pointer-events-none absolute bottom-[16px] h-[10px] w-[134px] rounded-[50%]"
        style={{ background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 65%, transparent), transparent 72%)" }}
      />

      <svg width="190" height="206" viewBox="0 0 200 216" className="relative drop-shadow-[0_26px_44px_rgba(0,0,0,0.9)]">
        <defs>
          <linearGradient id="vBadgeFace" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#ffe0b8" />
            <stop offset="38%" stopColor="var(--accent-warm)" />
            <stop offset="74%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="#8a3a12" />
          </linearGradient>
          <linearGradient id="vRibbonA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="#5c2a10" />
          </linearGradient>
        </defs>
        <path d="M74 150l-16 60 30-16 20 16-12-60z" fill="url(#vRibbonA)" />
        <path d="M126 150l16 60-30-16-20 16 12-60z" fill="#8a3a12" />
        {[7, 5, 3].map((d) => (
          <polygon key={d} points={ROSETTE} transform={`translate(${(d * 0.5).toFixed(1)} ${d})`} fill="#4a1f08" opacity="0.9" />
        ))}
        <polygon points={ROSETTE} fill="url(#vBadgeFace)" stroke="rgba(255,255,255,0.45)" strokeWidth="1.6" />
        <circle cx="100" cy="100" r="56" fill="rgba(60,20,4,0.5)" stroke="rgba(255,255,255,0.35)" strokeWidth="1.4" />
        <circle cx="100" cy="100" r="47" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.5)" strokeWidth="2" />
        <path d="M78 101l16 16 32-34" stroke="white" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M52 68a56 56 0 0148-26 56 56 0 0136 13" stroke="rgba(255,255,255,0.45)" strokeWidth="3" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ============================ CARD 4 — 8% =============================== */

function Coin({ size, x, y, z }: { size: number; x: string; y: string; z: number }) {
  const h = size * 0.34;
  return (
    <span className="absolute" style={{ left: x, top: y, zIndex: z, width: size, height: size * 0.72 }}>
      <span
        className="absolute inset-x-0 rounded-[50%]"
        style={{
          top: h * 0.3,
          height: h,
          background: "linear-gradient(180deg, #b4600f, #6d3407)",
          boxShadow: "0 14px 24px -8px rgba(0,0,0,0.95)",
        }}
      />
      <span
        className="absolute inset-x-0 top-0 flex items-center justify-center rounded-[50%]"
        style={{
          height: h,
          background: "linear-gradient(150deg, #ffe6bd 4%, var(--accent-warm) 44%, var(--accent) 92%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.75), inset 0 -3px 6px rgba(120,55,10,0.5)",
        }}
      >
        <span className="font-[var(--font-display)] font-black text-[#5b2c0e]" style={{ fontSize: size * 0.26, lineHeight: 1 }}>
          $
        </span>
      </span>
    </span>
  );
}

function FeeHero() {
  return (
    <div className="relative h-[222px]">
      <span
        className="pointer-events-none absolute -left-10 bottom-0 h-[230px] w-[310px] rounded-full opacity-55 blur-[58px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-warm), transparent 70%)" }}
      />
      <GroundShadow className="left-0 top-[160px] h-[30px] w-[196px]" />

      <Extruded
        className="relative block pt-1 text-[86px] leading-[1.04] tracking-[-0.055em] sm:text-[108px]"
        face="linear-gradient(168deg, #fff8ee 6%, #ffd08a 44%, var(--accent) 96%)"
      >
        8%
      </Extruded>

      <div className="absolute inset-0">
        <Coin size={90} x="60%" y="4%" z={3} />
        <Coin size={74} x="75%" y="32%" z={2} />
        <Coin size={62} x="57%" y="50%" z={1} />
        <span
          className="absolute flex h-[46px] w-[46px] items-center justify-center rounded-full"
          style={{
            left: "41%",
            top: "60%",
            zIndex: 4,
            background: "linear-gradient(150deg, var(--accent-warm), var(--accent))",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6), 0 18px 28px -10px rgba(0,0,0,0.95)",
          }}
        >
          <span className="font-[var(--font-display)] text-[22px] font-black text-[#5b2c0e]">$</span>
        </span>
      </div>

      <span
        className="absolute bottom-0 left-0 z-[5] inline-flex items-center gap-2.5 rounded-full border border-white/[0.12] px-3.5 py-1.5"
        style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 84%, transparent)" }}
      >
        <span className="text-[12px] font-bold text-ink-inverse-soft line-through">12%</span>
        <span className="text-[12px] font-black text-[color:var(--accent-2)]">8% verified</span>
      </span>
    </div>
  );
}

/* ====================== CARD 5 — product mockup ========================= */

const MOCK_ROWS = [
  { brand: 0, name: "Season drop", views: "27.3M", pct: 82, live: true },
  { brand: 3, name: "Winter drop", views: "4.2M", pct: 58, live: true },
  { brand: 8, name: "Launch film", views: "1.8M", pct: 34, live: false },
];

function DashboardHero() {
  return (
    <div className="relative h-[228px]">
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(90% 80% at 62% 22%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 68%)",
        }}
      />
      <span
        className="pointer-events-none absolute left-1/2 top-4 h-[210px] w-[310px] -translate-x-1/2 rounded-full opacity-60 blur-[62px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />

      {/* large light product panel, intentionally cropped by the card edge */}
      <div
        className="absolute -right-12 top-2 w-[118%] overflow-hidden rounded-[16px]"
        style={{
          transform: "perspective(1400px) rotateX(7deg) rotateY(-12deg)",
          transformOrigin: "left center",
          background: "linear-gradient(168deg, #fbf6ef, #e6d9ca)",
          boxShadow:
            "0 46px 70px -24px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.28), 0 0 70px -20px color-mix(in srgb, var(--accent) 85%, transparent)",
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-black/[0.08] bg-white/70 px-3 py-2">
          <span className="flex gap-1">
            {["#e0704a", "#e0ab3a", "#4ea87a"].map((c) => (
              <span key={c} className="h-[7px] w-[7px] rounded-full" style={{ background: c }} />
            ))}
          </span>
          <span className="ml-2 h-[12px] flex-1 rounded-full bg-black/[0.06]" />
        </div>

        <div className="px-4 py-3.5">
          <p className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#8a7566]">Campaign performance</p>
          <div className="mt-2.5 space-y-2.5">
            {MOCK_ROWS.map((r) => (
              <div key={r.name} className="flex items-center gap-2.5">
                <BrandLogo mark={BRAND_MARKS[r.brand]} size={22} radius={7} />
                <span className="w-[72px] shrink-0 truncate text-[10.5px] font-bold text-[#2d211a]">{r.name}</span>
                <span className="h-[7px] flex-1 overflow-hidden rounded-full bg-black/[0.08]">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${r.pct}%`,
                      background: r.live ? "linear-gradient(90deg, var(--accent), var(--accent-warm))" : "rgba(0,0,0,0.2)",
                    }}
                  />
                </span>
                <span className="w-[38px] shrink-0 text-right text-[10.5px] font-black text-[#2d211a]">{r.views}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* balance card floating over the panel */}
      <div
        className="absolute bottom-0 left-0 rounded-[16px] border border-white/[0.16] px-4 py-3"
        style={{
          background: "linear-gradient(158deg, color-mix(in srgb, var(--surface-inverse-raised) 98%, white), var(--surface-inverse))",
          boxShadow: "0 30px 50px -16px rgba(0,0,0,0.95), 0 0 44px -14px color-mix(in srgb, var(--accent) 85%, transparent)",
        }}
      >
        <p className="text-[8px] font-bold uppercase tracking-[0.14em] text-ink-inverse-soft">Campaign balance</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-[var(--font-display)] text-[26px] font-black leading-none tracking-tight text-white">$18,400</span>
          <span className="rounded-full bg-emerald-500/[0.18] px-1.5 py-[2px] text-[9px] font-black text-emerald-300">+18.2%</span>
        </div>
      </div>
    </div>
  );
}

/* ============================== CTA BLOCK =============================== */

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
    <div className="mt-16 flex flex-col items-center gap-5">
      <Link
        href="/onboarding?type=brand"
        className="group inline-flex items-center gap-2.5 rounded-[var(--radius-token-pill)] px-10 py-[19px] text-[17px] font-bold tracking-[-0.005em] text-white transition-all duration-200 hover:-translate-y-1"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-violet))",
          boxShadow:
            "0 26px 58px -12px color-mix(in srgb, var(--accent) 80%, transparent), inset 0 1px 0 rgba(255,255,255,0.26)",
        }}
      >
        Launch My Campaign
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

      <p className="text-[15px] font-bold text-white">Trusted by 200+ Brands</p>
    </div>
  );
}

/* ================================ SECTION =============================== */

export function WhyVerificationMatters() {
  return (
    <section className="relative overflow-hidden bg-surface-inverse px-6 pb-24 pt-28">
      <span
        className="pointer-events-none absolute inset-x-[12%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }}
      />
      <div
        className="pointer-events-none absolute left-1/2 top-4 h-[600px] w-[1100px] -translate-x-1/2 rounded-full opacity-20 blur-[140px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 72%)" }}
      />
      <div
        className="pointer-events-none absolute -right-40 bottom-24 h-[520px] w-[520px] rounded-full opacity-[0.14] blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent-violet), transparent 70%)" }}
      />

      <div className="relative mx-auto max-w-[1160px]">
        <div className="text-center">
          <span
            className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-white/[0.1] px-3.5 py-1.5"
            style={{ background: "color-mix(in srgb, var(--surface-inverse-raised) 78%, transparent)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent-2)" }} />
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-inverse-soft">Verification</span>
          </span>
          <h2 className="mx-auto mt-5 max-w-[20ch] text-balance font-[var(--font-display)] text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-white sm:text-[56px]">
            Why Verification Matters
          </h2>
          <p
            className="mx-auto mt-4 max-w-[46ch] text-balance text-[17px] font-medium leading-[1.55]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 80%, var(--ink-inverse-soft))" }}
          >
            Verification turns a listing into a brand creators trust.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card tone="amber">
            <ApplicantsHero />
            <CardCopy
              title="Get 30% More Applicants"
              body="Verified briefs reach more creators and are taken more seriously, so a bigger and better-matched pool applies to every campaign."
            />
          </Card>

          <Card tone="rings">
            <ShieldHero />
            <CardCopy
              title="Guaranteed Payout Insurance"
              body="Every campaign you fund is insured end to end. Your spend is protected and creators know they will be paid."
            />
          </Card>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Card tone="copper">
            <BadgeHero />
            <CardCopy
              title="Stand Out Fast"
              body="The verified mark sits on your profile and every brief, so creators know you are legitimate on sight."
            />
          </Card>

          <Card tone="gold">
            <FeeHero />
            <CardCopy
              title="Reduce Platform Fees"
              body="Verified brands and agencies pay a lower platform fee, so more of every budget reaches creators."
            />
          </Card>

          <Card tone="atmos">
            <DashboardHero />
            <CardCopy
              title="Boost Visibility"
              body="Priority placement in Discover puts your campaigns in front of more creators, tracked live in one place."
            />
          </Card>
        </div>

        <CtaBlock />
      </div>
    </section>
  );
}
