"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FAQ_CATEGORIES } from "@/data/faqs";
import { Footer } from "./Footer";
import { Header } from "./Header";
import type { Role } from "./RoleToggle";

function Chevron({ open, isBrand }: { open: boolean; isBrand: boolean }) {
  return (
    <span
      className={[
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-300",
        open
          ? "rotate-45 bg-accent text-white"
          : isBrand
            ? "bg-white/10 text-ink-inverse"
            : "bg-surface-sunken text-ink",
      ].join(" ")}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function FAQItem({
  q,
  a,
  isBrand,
  open,
  onToggle,
}: {
  q: string;
  a: string;
  isBrand: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={[
        "overflow-hidden rounded-[16px] border transition-colors",
        open
          ? "border-accent/40 " + (isBrand ? "bg-surface-inverse-raised" : "bg-accent-soft/40")
          : isBrand
            ? "border-white/10 bg-surface-inverse-raised"
            : "border-line bg-surface",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className={["text-[14.5px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
          {q}
        </span>
        <Chevron open={open} isBrand={isBrand} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p
            className={[
              "px-5 pb-4 text-[13.5px] leading-relaxed",
              isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
            ].join(" ")}
          >
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

export function FAQsExperience() {
  const [role, setRole] = useState<Role>("creator");
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const isBrand = role === "brand";

  const categories = FAQ_CATEGORIES[role];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return categories;
    return categories
      .map((cat) => ({
        ...cat,
        items: cat.items.filter(
          (item) =>
            item.q.toLowerCase().includes(needle) || item.a.toLowerCase().includes(needle)
        ),
      }))
      .filter((cat) => cat.items.length > 0);
  }, [categories, query]);

  const totalMatches = filtered.reduce((n, c) => n + c.items.length, 0);

  function switchRole(next: Role) {
    setRole(next);
    setOpenKey(null);
  }

  return (
    <div className={isBrand ? "realm-brand" : undefined}>
      <Header role={role} />

      <main className={["flex-1", isBrand ? "bg-surface-inverse" : "bg-surface"].join(" ")}>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 pt-16 pb-10">
          <div className="relative mx-auto max-w-[720px] text-center">
            <span
              className={[
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide",
                isBrand ? "bg-white/10 text-ink-inverse-soft" : "bg-accent-soft text-accent-ink",
              ].join(" ")}
            >
              Help Center
            </span>
            <h1
              className={[
                "mt-4 font-[var(--font-display)] text-[36px] font-black leading-[1.08] tracking-tight sm:text-[46px]",
                isBrand ? "text-ink-inverse" : "text-ink",
              ].join(" ")}
            >
              Frequently Asked Questions
            </h1>
            <p
              className={[
                "mx-auto mt-4 max-w-[480px] text-[15px] leading-relaxed",
                isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
              ].join(" ")}
            >
              Quick answers to the questions that come up most — for the side of the marketplace
              you&apos;re on.
            </p>

            {/* Creators / Brands tabs */}
            <div
              className={[
                "mx-auto mt-8 inline-flex rounded-[var(--radius-token-pill)] p-1",
                isBrand ? "bg-white/[0.07]" : "bg-surface-sunken",
              ].join(" ")}
              role="tablist"
              aria-label="Audience"
            >
              {(["creator", "brand"] as const).map((r) => {
                const active = role === r;
                return (
                  <button
                    key={r}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchRole(r)}
                    className={[
                      "rounded-[var(--radius-token-pill)] px-6 py-2 text-[14px] font-semibold transition-colors",
                      active
                        ? "bg-accent text-white"
                        : isBrand
                          ? "text-ink-inverse-soft hover:text-ink-inverse"
                          : "text-ink-soft hover:text-ink",
                    ].join(" ")}
                  >
                    {r === "creator" ? "Creators" : "Brands"}
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="relative mx-auto mt-6 max-w-[420px]">
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
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search questions"
                aria-label="Search questions"
                className={[
                  "w-full rounded-[var(--radius-token-pill)] border py-3 pl-11 pr-4 text-[14px] outline-none transition-colors focus:border-accent focus:ring-4 focus:ring-accent-soft",
                  isBrand
                    ? "border-white/10 bg-surface-inverse-raised text-ink-inverse placeholder:text-ink-inverse-soft/70"
                    : "border-line bg-surface-sunken text-ink placeholder:text-ink-soft/70",
                ].join(" ")}
              />
            </div>
          </div>
        </section>

        {/* Categories */}
        <section className="px-6 pb-20">
          <div className="mx-auto grid max-w-[1040px] gap-10 lg:grid-cols-[220px_1fr] lg:gap-14">
            {/* Category jump list */}
            <nav aria-label="FAQ categories" className="hidden lg:block">
              <div className="sticky top-28">
                <p
                  className={[
                    "text-[11px] font-bold uppercase tracking-[0.12em]",
                    isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                  ].join(" ")}
                >
                  Categories
                </p>
                <ul className="mt-4 space-y-1">
                  {filtered.map((cat) => (
                    <li key={cat.id}>
                      <a
                        href={`#${cat.id}`}
                        className={[
                          "block rounded-[var(--radius-token-sm)] px-3 py-2 text-[13.5px] font-medium transition-colors",
                          isBrand
                            ? "text-ink-inverse-soft hover:bg-white/[0.07] hover:text-ink-inverse"
                            : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
                        ].join(" ")}
                      >
                        {cat.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>

            <div>
              {query.trim() && (
                <p
                  className={[
                    "mb-6 text-[13.5px]",
                    isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                  ].join(" ")}
                >
                  {totalMatches} {totalMatches === 1 ? "result" : "results"} for &ldquo;
                  {query.trim()}&rdquo;
                </p>
              )}

              {filtered.length === 0 ? (
                <div
                  className={[
                    "rounded-[16px] border px-6 py-12 text-center",
                    isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface-sunken",
                  ].join(" ")}
                >
                  <p className={["text-[15px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
                    No questions match that search
                  </p>
                  <p
                    className={[
                      "mt-2 text-[13.5px]",
                      isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                    ].join(" ")}
                  >
                    Try a different word, or{" "}
                    <Link href="/contact" className="font-semibold underline underline-offset-2">
                      ask our team directly
                    </Link>
                    .
                  </p>
                </div>
              ) : (
                <div className="space-y-12">
                  {filtered.map((cat) => (
                    <div key={cat.id} id={cat.id} className="scroll-mt-28">
                      <h2
                        className={[
                          "font-[var(--font-display)] text-[20px] font-extrabold tracking-tight",
                          isBrand ? "text-ink-inverse" : "text-ink",
                        ].join(" ")}
                      >
                        {cat.title}
                      </h2>
                      <div className="mt-4 flex flex-col gap-3">
                        {cat.items.map((item) => {
                          const key = `${role}:${cat.id}:${item.q}`;
                          return (
                            <FAQItem
                              key={key}
                              q={item.q}
                              a={item.a}
                              isBrand={isBrand}
                              open={openKey === key}
                              onToggle={() => setOpenKey(openKey === key ? null : key)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Still stuck CTA */}
        <section className="px-6 pb-24">
          <div
            className={[
              "mx-auto max-w-[1040px] rounded-[var(--radius-token-lg)] px-8 py-12 text-center",
              isBrand ? "bg-surface-inverse-raised" : "bg-surface-sunken",
            ].join(" ")}
          >
            <h2
              className={[
                "font-[var(--font-display)] text-[26px] font-extrabold tracking-tight",
                isBrand ? "text-ink-inverse" : "text-ink",
              ].join(" ")}
            >
              Still stuck?
            </h2>
            <p
              className={[
                "mx-auto mt-3 max-w-[420px] text-[14.5px] leading-relaxed",
                isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
              ].join(" ")}
            >
              If your question isn&apos;t here, send it over — a real person reads every message.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/contact"
                className={[
                  "inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-6 py-3 text-[14px] font-bold transition-colors",
                  isBrand ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/90",
                ].join(" ")}
              >
                Contact our team
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
                href={isBrand ? "/onboarding?type=brand" : "/onboarding?type=creator"}
                className={[
                  "inline-flex items-center rounded-[var(--radius-token-pill)] border px-6 py-3 text-[14px] font-bold transition-colors",
                  isBrand
                    ? "border-white/15 text-ink-inverse hover:bg-white/[0.07]"
                    : "border-line text-ink hover:bg-surface",
                ].join(" ")}
              >
                {isBrand ? "Launch a campaign" : "Become a creator"}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer role={role} />
    </div>
  );
}
