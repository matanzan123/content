"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "@/i18n/Link";
import { useT } from "@/i18n/provider";
import { trackSearch } from "@/lib/analytics/client";
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
  const panelId = useId();
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
        id={`${panelId}-trigger`}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-start"
      >
        <span className={["text-[14.5px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
          {q}
        </span>
        <Chevron open={open} isBrand={isBrand} />
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={`${panelId}-trigger`}
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
  const t = useT();

  /**
   * The dataset holds ids; the words come from the dictionary. Resolving first
   * means the search below matches whatever language is on screen — a Hebrew
   * visitor searching "תשלום" filters Hebrew answers, not English ones.
   */
  const categories = useMemo(() => {
    const titles = t.faqs.categoryTitles;
    const groups = t.faqs.items as Record<string, Record<string, { q: string; a: string }>>;
    return FAQ_CATEGORIES[role].map((cat) => ({
      id: cat.id,
      title: titles[cat.id],
      items: cat.items.map((itemId) => ({ id: itemId, ...groups[cat.id][itemId] })),
    }));
  }, [role, t]);

  const filtered = useMemo(() => {
    // Hebrew has no case, so toLowerCase() is a no-op for it and still
    // normalises the Latin half of a mixed query.
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

  // Records that a search happened and how many results it found. The query
  // text never leaves the browser — only its length bucket. Debounced so a
  // single search is one event rather than one per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(() => trackSearch("faq_searched", q, totalMatches), 700);
    return () => clearTimeout(timer);
  }, [query, totalMatches]);

  function switchRole(next: Role) {
    setRole(next);
    setOpenKey(null);
  }

  /**
   * Arrow-key movement across the audience tabs, per the ARIA tabs pattern:
   * the tablist is one tab stop and Left/Right (plus Home/End) move between
   * tabs, activating as they go.
   */
  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const order: Role[] = ["creator", "brand"];
    const i = order.indexOf(role);
    let next: Role | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = order[(i - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    switchRole(next);
    document.getElementById(`faq-tab-${next}`)?.focus();
  }

  return (
    <div className={isBrand ? "realm-brand" : undefined}>
      <Header role={role} />

      <main id="main-content" className={["flex-1", isBrand ? "bg-surface-inverse" : "bg-surface"].join(" ")}>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 pt-16 pb-10">
          <div className="relative mx-auto max-w-[720px] text-center">
            <span
              className={[
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide",
                isBrand ? "bg-white/10 text-ink-inverse-soft" : "bg-accent-soft text-accent-ink",
              ].join(" ")}
            >
              {t.faqs.badge}
            </span>
            <h1
              className={[
                "mt-4 font-[var(--font-display)] text-[36px] font-black leading-[1.08] tracking-tight sm:text-[46px]",
                isBrand ? "text-ink-inverse" : "text-ink",
              ].join(" ")}
            >
              {t.faqs.heading}
            </h1>
            <p
              className={[
                "mx-auto mt-4 max-w-[480px] text-[15px] leading-relaxed",
                isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
              ].join(" ")}
            >
              {t.faqs.subtitle}

            </p>

            {/* Creators / Brands tabs */}
            <div
              className={[
                "mx-auto mt-8 inline-flex rounded-[var(--radius-token-pill)] p-1",
                isBrand ? "bg-white/[0.07]" : "bg-surface-sunken",
              ].join(" ")}
              role="tablist"
              aria-label={t.faqs.audience}
            >
              {(["creator", "brand"] as const).map((r) => {
                const active = role === r;
                return (
                  <button
                    key={r}
                    id={`faq-tab-${r}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="faq-panel"
                    tabIndex={active ? 0 : -1}
                    onKeyDown={onTabKey}
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
                    {r === "creator" ? t.faqs.creators : t.faqs.brands}
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
                  "pointer-events-none absolute start-4 top-1/2 -translate-y-1/2",
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
                placeholder={t.faqs.searchPlaceholder}
                aria-label={t.faqs.searchLabel}
                className={[
                  "w-full rounded-[var(--radius-token-pill)] border py-3 ps-11 pe-4 text-[14px] outline-none transition-colors focus:border-accent focus:ring-4 focus:ring-accent-soft",
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
            <nav aria-label={t.faqs.categoryNav} className="hidden lg:block">
              <div className="sticky top-28">
                <p
                  className={[
                    "text-[11px] font-bold uppercase tracking-[0.12em]",
                    isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                  ].join(" ")}
                >
                  {t.faqs.categories}
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

            <div id="faq-panel" role="tabpanel" aria-labelledby={`faq-tab-${role}`} tabIndex={-1}>
              <p
                role="status"
                className={[
                  "mb-6 text-[13.5px]",
                  query.trim() ? "" : "sr-only",
                  isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                ].join(" ")}
              >
                {query.trim()
                  ? (totalMatches === 1 ? t.faqs.resultFor : t.faqs.resultsFor)
                      .replace("{count}", String(totalMatches))
                      .replace("{query}", query.trim())
                  : (role === "brand" ? t.faqs.countForBrands : t.faqs.countForCreators).replace("{count}", String(totalMatches))}
              </p>

              {filtered.length === 0 ? (
                <div
                  className={[
                    "rounded-[16px] border px-6 py-12 text-center",
                    isBrand ? "border-white/10 bg-surface-inverse-raised" : "border-line bg-surface-sunken",
                  ].join(" ")}
                >
                  <p className={["text-[15px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
                    {t.faqs.noMatchTitle}
                  </p>
                  <p
                    className={[
                      "mt-2 text-[13.5px]",
                      isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
                    ].join(" ")}
                  >
                    {t.faqs.noMatchBody.split("{link}")[0]}
                    <Link href="/contact" className="font-semibold underline underline-offset-2">
                      {t.faqs.askTeam}
                    </Link>
                    {t.faqs.noMatchBody.split("{link}")[1]}
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
                          // Keyed by id, not by the question text, so switching language keeps the
                          // open row open instead of collapsing it.
                          const key = `${role}:${cat.id}:${item.id}`;
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
              {t.faqs.stuckHeading}
            </h2>
            <p
              className={[
                "mx-auto mt-3 max-w-[420px] text-[14.5px] leading-relaxed",
                isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
              ].join(" ")}
            >
              {t.faqs.stuckBody}
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/contact"
                className={[
                  "inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-6 py-3 text-[14px] font-bold transition-colors",
                  isBrand ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/90",
                ].join(" ")}
              >
                {t.faqs.contactTeam}
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
                href={isBrand ? "/contact" : "/onboarding?type=creator"}
                className={[
                  "inline-flex items-center rounded-[var(--radius-token-pill)] border px-6 py-3 text-[14px] font-bold transition-colors",
                  isBrand
                    ? "border-white/15 text-ink-inverse hover:bg-white/[0.07]"
                    : "border-line text-ink hover:bg-surface",
                ].join(" ")}
              >
                {isBrand ? t.faqs.launchCampaign : t.faqs.becomeCreator}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer role={role} />
    </div>
  );
}
