"use client";

import Image from "next/image";
import { Link } from "@/i18n/Link";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { useT } from "@/i18n/provider";
import type { Role } from "./RoleToggle";

type Campaigns = Dictionary["home"]["campaigns"];

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
  /** Dictionary key for the title; the brand half of it is a proper noun. */
  key: keyof Campaigns["items"];
  agency: string;
  verified: boolean;
  category: keyof Campaigns["categories"];
  categoryColor: string;
  platforms: string[];
  image: string;
  earned: number;
  budget: number;
  rate: string;
  approval: number;
  views: string;
  creators: string;
  posted: keyof Campaigns["posted"];
};

const CAMPAIGNS: Campaign[] = [
  {
    key: "neonRift",
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
    posted: "3d",
  },
  {
    key: "solaceAudio",
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
    posted: "6h",
  },
  {
    key: "fernwayFit",
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
    posted: "1d",
  },
  {
    key: "roastHouse",
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
    posted: "12h",
  },
  {
    key: "aftershock",
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
    posted: "2d",
  },
  {
    key: "bloomSkincare",
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
    posted: "8h",
  },
];

function StatCell({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  return (
    <div className="flex flex-col items-start">
      <span className={["text-[10px]", dark ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>{label}</span>
      <span className={["ltr-token text-[12.5px] font-extrabold", dark ? "text-ink-inverse" : "text-ink"].join(" ")}>{value}</span>
    </div>
  );
}

function CampaignCard({ c, isBrand }: { c: Campaign; isBrand: boolean }) {
  const t = useT().home.campaigns;
  const progress = Math.min(100, Math.round((c.earned / c.budget) * 100));
  const title = t.items[c.key];
  // Budget figures stay in the "$18,420" shape in both languages: the product
  // prices in USD, and he-IL's own currency form ("18,420 $") would move the
  // symbol and change the approved card design. `.ltr-token` keeps the run in
  // logical order inside the Hebrew sentence.
  const money = (v: number) => `$${v.toLocaleString("en-US")}`;
  return (
    <Link
      href="/discover"
      aria-label={title}
      className={[
        "group block cursor-pointer overflow-hidden rounded-[24px] border text-left shadow-[var(--shadow-card)] transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_60px_-18px_rgba(20,21,26,0.35)]",
        isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
      ].join(" ")}
    >
      <div className="relative h-[160px] w-full overflow-hidden">
        <Image
          src={c.image}
          alt={title}
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
            {t.categories[c.category]}
          </span>
        </div>
        <span className="absolute bottom-3 left-3 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
          {t.ago.replace("{time}", t.posted[c.posted])}
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
          {title}
        </h3>

        <div className="mt-3 flex items-baseline justify-between">
          <span className={["ltr-token font-[var(--font-display)] text-[18px] font-black", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
            {money(c.earned)}
            <span className={["text-[12px] font-semibold", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}> / {money(c.budget)}</span>
          </span>
          <span className="ltr-token rounded-full bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent-ink">{c.rate}{t.perThousand}</span>
        </div>

        <div className={["mt-2 h-1.5 rounded-full", isBrand ? "bg-white/10" : "bg-surface-sunken"].join(" ")}>
          <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-violet))" }} />
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: isBrand ? "var(--line-inverse)" : "var(--line)" }}>
          <StatCell label={t.approval} value={`${c.approval}%`} dark={isBrand} />
          <StatCell label={t.views} value={c.views} dark={isBrand} />
          <StatCell label={t.creators} value={c.creators} dark={isBrand} />
        </div>
      </div>
    </Link>
  );
}

export function PopularCampaigns({ role }: { role: Role }) {
  const t = useT();
  const isBrand = role === "brand";
  // Only the creator realm is localized so far; the brand copy still comes
  // from COPY until the brand-home pass migrates it.
  const copy = isBrand
    ? COPY.brand
    : {
        eyebrow: t.home.campaigns.eyebrow,
        heading: t.home.campaigns.heading,
        subtitle: t.home.campaigns.subtitle,
      };

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
            <CampaignCard key={c.key} c={c} isBrand={isBrand} />
          ))}
        </div>

        <Link
          href="/discover"
          className="mt-12 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-9 py-4 text-[16px] font-bold text-white shadow-[0_16px_40px_-10px_rgba(52,87,255,0.65)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_48px_-8px_rgba(52,87,255,0.75)]"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-violet))" }}
        >
          {t.home.campaigns.seeAll}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="dir-flip" aria-hidden="true">
            <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
