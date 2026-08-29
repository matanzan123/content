"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/i18n/Link";
import {
  CATEGORIES,
  CONTENT_TYPES,
  PLATFORMS,
  STATUSES,
  getCampaigns,
  type Campaign,
  type Platform,
} from "@/data/campaigns";
import { Footer } from "../Footer";
import { Header } from "../Header";
import type { Role } from "../RoleToggle";
import { CampaignCard } from "./CampaignCard";
import { PlatformIcon } from "./PlatformIcon";

function Dropdown({
  label,
  options,
  value,
  onChange,
  isBrand,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  isBrand: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !open) return;
          setOpen(false);
          triggerRef.current?.focus();
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={[
          "inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border px-4 py-2 text-[13.5px] font-medium transition-colors",
          value
            ? "border-accent bg-accent text-white"
            : isBrand
              ? "border-white/10 bg-surface-inverse-raised text-ink-inverse-soft hover:text-ink-inverse"
              : "border-line bg-surface text-ink-soft hover:text-ink",
        ].join(" ")}
      >
        {value || label}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className={[
            "absolute right-0 z-30 mt-2 min-w-[180px] overflow-hidden rounded-[var(--radius-token-md)] border py-1 shadow-[var(--shadow-float)]",
            isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface",
          ].join(" ")}
        >
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={[
              "block w-full px-4 py-2 text-left text-[13.5px] transition-colors",
              isBrand ? "text-ink-inverse-soft hover:bg-white/[0.07]" : "text-ink-soft hover:bg-surface-sunken",
            ].join(" ")}
          >
            All {label.toLowerCase()}
          </button>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={[
                "block w-full px-4 py-2 text-left text-[13.5px] font-medium transition-colors",
                value === opt
                  ? "text-accent"
                  : isBrand
                    ? "text-ink-inverse hover:bg-white/[0.07]"
                    : "text-ink hover:bg-surface-sunken",
              ].join(" ")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HeroCarousel({ items, isBrand }: { items: Campaign[]; isBrand: boolean }) {
  const [index, setIndex] = useState(0);
  const current = items[index];

  if (!current) return null;

  const go = (delta: number) => setIndex((i) => (i + delta + items.length) % items.length);

  return (
    <section className="relative h-[440px] w-full overflow-hidden sm:h-[520px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={current.image} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.15) 100%)",
        }}
      />

      <div className="relative flex h-full items-end px-6 pb-16 sm:px-10">
        <div className="max-w-[520px]">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white">
              {current.owner.charAt(0)}
            </span>
            <span className="text-[13px] font-semibold text-white">{current.owner}</span>
            {current.ownerVerified && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-label="Verified">
                <path
                  d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1.2 2.8 1.2 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9L3.2 15.8 4.4 13 3.2 10.2l2.5-1.7.9-2.9 3 .2L12 2z"
                  fill="var(--accent)"
                />
                <path d="M8.6 12.2l2.3 2.3 4.5-4.6" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>

          <h2 className="mt-3 font-[var(--font-display)] text-[30px] font-extrabold leading-[1.12] tracking-tight text-white sm:text-[36px]">
            {current.title}
          </h2>
          <p className="mt-2.5 text-[13.5px] text-white/75">
            {current.category} · <span className="font-bold text-white">${current.cpm.toFixed(2)}</span>
            /1K views · ${current.budget.toLocaleString()}
          </p>

          <Link
            href={`/discover/${current.id}`}
            className="mt-6 inline-flex items-center rounded-[var(--radius-token-pill)] bg-white px-6 py-2.5 text-[13.5px] font-bold text-ink transition-colors hover:bg-white/90"
          >
            View Program
          </Link>
        </div>
      </div>

      {items.length > 1 && (
        <>
          <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2">
            {items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
                className="flex h-6 w-6 items-center justify-center rounded-full"
              >
                <span
                  aria-hidden="true"
                  className={[
                    "block h-1.5 rounded-full transition-all",
                    i === index ? "w-6 bg-white" : "w-1.5 bg-white/40 hover:bg-white/70",
                  ].join(" ")}
                />
              </button>
            ))}
          </div>

          <div className="absolute bottom-6 right-6 flex gap-2">
            {([-1, 1] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-label={d === -1 ? "Previous campaign" : "Next campaign"}
                onClick={() => go(d)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d={d === -1 ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ))}
          </div>
        </>
      )}

      {isBrand && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-white/10" />}
    </section>
  );
}

export function DiscoverExperience() {
  const [role] = useState<Role>("brand");
  const isBrand = role === "brand";

  const campaigns = getCampaigns();

  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [contentType, setContentType] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl-K focuses the search, matching the hint in the field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (needle && !`${c.title} ${c.owner}`.toLowerCase().includes(needle)) return false;
      if (platform && !c.platforms.includes(platform)) return false;
      if (status && c.status !== status) return false;
      if (category && c.category !== category) return false;
      if (contentType && c.contentType !== contentType) return false;
      return true;
    });
  }, [campaigns, query, platform, status, category, contentType]);

  const featured = campaigns.filter((c) => c.featured);
  const heroItems = featured.length > 0 ? featured : campaigns.slice(0, 6);
  const hasCampaigns = campaigns.length > 0;
  const anyFilter = Boolean(query.trim() || platform || status || category || contentType);

  function clearFilters() {
    setQuery("");
    setPlatform("");
    setStatus("");
    setCategory("");
    setContentType("");
  }

  return (
    <div className={isBrand ? "realm-brand" : undefined}>
      <Header role={role} />

      <main id="main-content" className={["flex-1", isBrand ? "bg-surface-inverse" : "bg-surface"].join(" ")}>
        {hasCampaigns ? (
          <HeroCarousel items={heroItems} isBrand={isBrand} />
        ) : (
          /* Nothing has been published yet — the carousel would be an empty
             black band, so this stands in for it. */
          <section className="px-6 pt-14">
            <div
              className={[
                "mx-auto flex max-w-[1240px] flex-col items-center justify-center rounded-[var(--radius-token-lg)] border border-dashed px-6 py-20 text-center",
                isBrand ? "border-white/15 bg-surface-inverse-raised" : "border-line bg-surface-sunken",
              ].join(" ")}
            >
              <span
                className={[
                  "flex h-14 w-14 items-center justify-center rounded-[16px]",
                  isBrand ? "bg-white/10 text-ink-inverse" : "bg-surface text-ink",
                ].join(" ")}
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="3.2" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M10 9.6l4.6 2.4-4.6 2.4V9.6z" fill="currentColor" />
                </svg>
              </span>
              <h1
                className={[
                  "mt-5 font-[var(--font-display)] text-[28px] font-extrabold tracking-tight sm:text-[34px]",
                  isBrand ? "text-ink-inverse" : "text-ink",
                ].join(" ")}
              >
                No campaigns live yet
              </h1>
              <p
                className={[
                  "mt-3 max-w-[440px] text-[14.5px] leading-relaxed",
                  isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                ].join(" ")}
              >
                Campaigns brands publish will show up here for creators to browse and join. Be the
                first to put one on the board.
              </p>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href="/contact"
                  className={[
                    "inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-6 py-3 text-[14px] font-bold transition-colors",
                    isBrand ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/90",
                  ].join(" ")}
                >
                  Launch a campaign
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M5 12H19M19 12L13 6M19 12L13 18"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Link>
                <Link
                  href="/onboarding?type=creator"
                  className={[
                    "inline-flex items-center rounded-[var(--radius-token-pill)] border px-6 py-3 text-[14px] font-bold transition-colors",
                    isBrand
                      ? "border-white/15 text-ink-inverse hover:bg-white/[0.07]"
                      : "border-line text-ink hover:bg-surface",
                  ].join(" ")}
                >
                  Join as a creator
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* Toolbar */}
        <section className="px-6 pt-8">
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1 sm:max-w-[300px]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className={[
                  "pointer-events-none absolute left-4 top-1/2 -translate-y-1/2",
                  isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                ].join(" ")}
              >
                <circle cx="11" cy="11" r="6.6" stroke="currentColor" strokeWidth="1.9" />
                <path d="M16 16L21 21" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Campaigns and creators"
                aria-label="Search campaigns and creators"
                className={[
                  "w-full rounded-[var(--radius-token-pill)] border py-2.5 pl-11 pr-14 text-[13.5px] outline-none transition-colors focus:border-accent",
                  isBrand
                    ? "border-white/10 bg-surface-inverse-raised text-ink-inverse placeholder:text-ink-inverse-soft/70"
                    : "border-line bg-surface-sunken text-ink placeholder:text-ink-soft/70",
                ].join(" ")}
              />
              <kbd
                className={[
                  "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 font-mono text-[10.5px]",
                  isBrand ? "bg-white/10 text-ink-inverse-soft" : "bg-line/70 text-ink-soft",
                ].join(" ")}
              >
                ⌘K
              </kbd>
            </div>

            <div className="flex items-center gap-1.5">
              {PLATFORMS.map((p) => {
                const active = platform === p;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-label={p}
                    aria-pressed={active}
                    onClick={() => setPlatform(active ? "" : p)}
                    className={[
                      "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                      active
                        ? "border-accent bg-accent text-white"
                        : isBrand
                          ? "border-white/10 bg-surface-inverse-raised text-ink-inverse hover:border-white/25"
                          : "border-line bg-surface text-ink hover:border-accent/40",
                    ].join(" ")}
                  >
                    <PlatformIcon platform={p} size={15} />
                  </button>
                );
              })}
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Dropdown label="Status" options={STATUSES} value={status} onChange={setStatus} isBrand={isBrand} />
              <Dropdown label="Category" options={CATEGORIES} value={category} onChange={setCategory} isBrand={isBrand} />
              <Dropdown label="Content" options={CONTENT_TYPES} value={contentType} onChange={setContentType} isBrand={isBrand} />
            </div>
          </div>
        </section>

        {/* Feed */}
        <section className="px-6 pb-24 pt-8">
          <div className="mx-auto max-w-[1240px]">
            <div className="flex items-center gap-3">
              <h2
                className={[
                  "font-[var(--font-display)] text-[18px] font-extrabold tracking-tight",
                  isBrand ? "text-ink-inverse" : "text-ink",
                ].join(" ")}
              >
                {anyFilter ? "Results" : "Featured"}
              </h2>
              {hasCampaigns && (
                <span
                  className={[
                    "text-[13px]",
                    isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                  ].join(" ")}
                >
                  {filtered.length} {filtered.length === 1 ? "campaign" : "campaigns"}
                </span>
              )}
              {anyFilter && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-auto text-[13px] font-semibold text-accent hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>

            {filtered.length > 0 ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((c) => (
                  <CampaignCard key={c.id} campaign={c} isBrand={isBrand} />
                ))}
              </div>
            ) : (
              <div
                className={[
                  "mt-5 rounded-[16px] border border-dashed px-6 py-16 text-center",
                  isBrand ? "border-white/12 bg-surface-inverse-raised/50" : "border-line bg-surface-sunken/60",
                ].join(" ")}
              >
                <p className={["text-[15px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
                  {hasCampaigns ? "Nothing matches those filters" : "The board is empty for now"}
                </p>
                <p
                  className={[
                    "mx-auto mt-2 max-w-[380px] text-[13.5px] leading-relaxed",
                    isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                  ].join(" ")}
                >
                  {hasCampaigns ? (
                    "Try clearing a filter or searching for something broader."
                  ) : (
                    <>
                      As soon as a brand publishes a campaign it lands here.{" "}
                      <Link href="/contact" className="font-semibold underline underline-offset-2">
                        Talk to us
                      </Link>{" "}
                      about launching the first one.
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      <Footer role={role} />
    </div>
  );
}
