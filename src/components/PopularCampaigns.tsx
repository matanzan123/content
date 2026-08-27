import Image from "next/image";
import type { Role } from "./RoleToggle";

const COPY: Record<Role, { eyebrow: string; heading: string; subtitle: string }> = {
  creator: {
    eyebrow: "Hot Campaigns",
    heading: "Discover Popular Campaigns",
    subtitle: "Join top opportunities from trusted brands and start creating right away.",
  },
  brand: {
    eyebrow: "Live On The Platform",
    heading: "See What's Already Running",
    subtitle: "A look at the kind of campaigns brands are launching with us right now.",
  },
};

type Campaign = {
  title: string;
  agency: string;
  verified: boolean;
  category: string;
  categoryColor: string;
  platforms: string[];
  image: string;
  earned: number;
  budget: number;
  rate: string;
  approval: number;
  views: string;
  creators: string;
  posted: string;
};

const CAMPAIGNS: Campaign[] = [
  {
    title: "Neon Rift — Launch Trailer Clipping",
    agency: "Pulse Studios",
    verified: true,
    category: "Gaming",
    categoryColor: "linear-gradient(135deg, var(--accent-violet), var(--accent))",
    platforms: ["VID", "CLIP", "X"],
    image: "https://picsum.photos/seed/neonrift/480/320",
    earned: 18420,
    budget: 40000,
    rate: "$1.75",
    approval: 52,
    views: "9.8M",
    creators: "1,240",
    posted: "3d ago",
  },
  {
    title: "Solace Audio — New Album Clips",
    agency: "Wave Collective",
    verified: true,
    category: "Music",
    categoryColor: "linear-gradient(135deg, var(--accent-cyan), var(--accent-2))",
    platforms: ["VID", "CLIP"],
    image: "https://picsum.photos/seed/solaceaudio/480/320",
    earned: 6240,
    budget: 25000,
    rate: "$1.20",
    approval: 61,
    views: "3.1M",
    creators: "480",
    posted: "6h ago",
  },
  {
    title: "Fernway Fit — App Launch UGC",
    agency: "Fernway",
    verified: false,
    category: "Technology",
    categoryColor: "linear-gradient(135deg, var(--accent-2), var(--accent-violet))",
    platforms: ["PIC", "CLIP"],
    image: "https://picsum.photos/seed/fernwayfit/480/320",
    earned: 2980,
    budget: 15000,
    rate: "$0.90",
    approval: 74,
    views: "1.4M",
    creators: "210",
    posted: "1d ago",
  },
  {
    title: "Roast House — Coffee Drop UGC",
    agency: "Roast House",
    verified: true,
    category: "Lifestyle",
    categoryColor: "linear-gradient(135deg, var(--accent-warm), var(--accent-violet))",
    platforms: ["PIC", "VID"],
    image: "https://picsum.photos/seed/roasthouse/480/320",
    earned: 9840,
    budget: 20000,
    rate: "$2.10",
    approval: 68,
    views: "5.6M",
    creators: "690",
    posted: "12h ago",
  },
  {
    title: "Aftershock — Tour Recap Clipping",
    agency: "Live Circuit",
    verified: false,
    category: "Entertainment",
    categoryColor: "linear-gradient(135deg, var(--accent), var(--accent-cyan))",
    platforms: ["VID", "CLIP", "X"],
    image: "https://picsum.photos/seed/aftershocktour/480/320",
    earned: 31500,
    budget: 60000,
    rate: "$1.40",
    approval: 44,
    views: "22.1M",
    creators: "2,180",
    posted: "2d ago",
  },
  {
    title: "Bloom Skincare — Routine Reviews",
    agency: "Bloom Labs",
    verified: true,
    category: "Beauty",
    categoryColor: "linear-gradient(135deg, var(--accent-violet), var(--accent-cyan))",
    platforms: ["PIC", "CLIP"],
    image: "https://picsum.photos/seed/bloomskincare/480/320",
    earned: 4120,
    budget: 18000,
    rate: "$1.05",
    approval: 79,
    views: "2.3M",
    creators: "340",
    posted: "8h ago",
  },
];

function StatCell({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  return (
    <div className="flex flex-col items-start">
      <span className={["text-[10px]", dark ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>{label}</span>
      <span className={["text-[12.5px] font-extrabold", dark ? "text-ink-inverse" : "text-ink"].join(" ")}>{value}</span>
    </div>
  );
}

function CampaignCard({ c, isBrand }: { c: Campaign; isBrand: boolean }) {
  const progress = Math.min(100, Math.round((c.earned / c.budget) * 100));
  return (
    <div
      className={[
        "group cursor-pointer overflow-hidden rounded-[24px] border text-left shadow-[var(--shadow-card)] transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_60px_-18px_rgba(20,21,26,0.35)]",
        isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
      ].join(" ")}
    >
      <div className="relative h-[160px] w-full overflow-hidden">
        <Image
          src={c.image}
          alt={c.title}
          fill
          unoptimized
          className="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/0 to-black/0" />
        <div className="absolute right-3 top-3 flex gap-1.5">
          <span
            className="rounded-full px-2.5 py-1 text-[10px] font-bold text-white shadow-sm"
            style={{ background: c.categoryColor }}
          >
            {c.category}
          </span>
        </div>
        <span className="absolute bottom-3 left-3 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
          {c.posted}
        </span>
        <div className="absolute bottom-3 right-3 flex gap-1">
          {c.platforms.map((p) => (
            <span key={p} className="flex h-6 items-center justify-center rounded-full bg-white/90 px-2 text-[9px] font-black text-ink shadow-sm">
              {p}
            </span>
          ))}
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-center gap-1.5">
          <span
            className="h-5 w-5 rounded-full"
            style={{ background: c.categoryColor }}
          />
          <span className={["text-[12px] font-semibold", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
            {c.agency}
          </span>
          {c.verified && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-accent">
              <path d="M12 2L20 5.5V11C20 16 16.5 19.5 12 21C7.5 19.5 4 16 4 11V5.5L12 2Z" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8.5 12L11 14.5L15.5 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        <h3 className={["mt-2 text-[15px] font-extrabold leading-snug", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
          {c.title}
        </h3>

        <div className="mt-3 flex items-baseline justify-between">
          <span className={["font-[var(--font-display)] text-[18px] font-black", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
            ${c.earned.toLocaleString()}
            <span className={["text-[12px] font-semibold", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}> / ${c.budget.toLocaleString()}</span>
          </span>
          <span className="rounded-full bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent-ink">{c.rate}/1K</span>
        </div>

        <div className={["mt-2 h-1.5 rounded-full", isBrand ? "bg-white/10" : "bg-surface-sunken"].join(" ")}>
          <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-violet))" }} />
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: isBrand ? "var(--line-inverse)" : "var(--line)" }}>
          <StatCell label="Approval" value={`${c.approval}%`} dark={isBrand} />
          <StatCell label="Views" value={c.views} dark={isBrand} />
          <StatCell label="Creators" value={c.creators} dark={isBrand} />
        </div>
      </div>
    </div>
  );
}

export function PopularCampaigns({ role }: { role: Role }) {
  const copy = COPY[role];
  const isBrand = role === "brand";

  return (
    <section
      className={[
        "relative overflow-hidden px-6 pb-20 pt-20 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface",
      ].join(" ")}
    >
      <div className="relative mx-auto max-w-[1240px] text-center">
        <p
          className={[
            "font-[var(--font-display)] text-[12px] font-bold uppercase tracking-[0.14em]",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {copy.eyebrow}
        </p>
        <h2
          className={[
            "mx-auto mt-4 max-w-lg font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {copy.heading}
        </h2>
        <p
          className={[
            "mx-auto mt-4 max-w-md text-[15px] leading-relaxed",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {copy.subtitle}
        </p>

        <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-3">
          {CAMPAIGNS.map((c) => (
            <CampaignCard key={c.title} c={c} isBrand={isBrand} />
          ))}
        </div>

        <a
          href="/discover"
          className="mt-12 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-9 py-4 text-[16px] font-bold text-white shadow-[0_16px_40px_-10px_rgba(52,87,255,0.65)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_48px_-8px_rgba(52,87,255,0.75)]"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
        >
          See All Campaigns
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>
    </section>
  );
}
