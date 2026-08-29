"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ==========================================================================
   LEGAL DOCUMENT SHELL

   One renderer for both /privacy-policy and /terms-of-service. The pages supply
   structured content; this file owns the reading experience: a sticky table of
   contents on desktop, a collapsible one on mobile, scroll-spy, and the
   optional part switcher the Terms page uses for General / Creators / Brands.

   The part switcher never hides content — hiding terms behind a tab would mean
   a user could accept terms they were never shown. It scrolls to the part and
   highlights it in the contents instead.
   ========================================================================== */

import type { Block, Section } from "./content";

export type { Block, Section };

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h3":
            return (
              <h3
                key={i}
                className="mt-8 font-[var(--font-display)] text-[17px] font-extrabold tracking-tight text-ink"
              >
                {block.text}
              </h3>
            );
          case "list":
            return (
              <ul key={i} className="mt-4 space-y-2.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-3 text-[15px] leading-[1.7] text-ink-soft">
                    <span
                      aria-hidden="true"
                      className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            );
          case "callout":
            return (
              <p
                key={i}
                className="mt-5 rounded-[var(--radius-token-md)] border-l-2 border-accent bg-accent-soft/45 px-4 py-3 text-[14.5px] leading-[1.65] text-ink-soft"
              >
                {block.text}
              </p>
            );
          default:
            return (
              <p key={i} className="mt-4 text-[15px] leading-[1.75] text-ink-soft">
                {block.text}
              </p>
            );
        }
      })}
    </>
  );
}

function TocList({
  sections,
  activeId,
  onPick,
}: {
  sections: { section: Section; number: number }[];
  activeId: string;
  onPick: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {sections.map(({ section, number }) => {
        const active = section.id === activeId;
        return (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              onClick={onPick}
              aria-current={active ? "true" : undefined}
              className={[
                "flex gap-2.5 rounded-[var(--radius-token-sm)] px-3 py-2 text-[13px] leading-snug transition-colors",
                active
                  ? "bg-accent-soft font-semibold text-accent-ink"
                  : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
              ].join(" ")}
            >
              <span className={active ? "text-accent-ink" : "text-ink-soft"}>{number}.</span>
              <span>{section.title}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function LegalDocument({
  label,
  title,
  intro,
  lastUpdated,
  sections,
  partLabels,
}: {
  label: string;
  title: string;
  intro: string;
  lastUpdated: string;
  sections: Section[];
  /** Ordered part keys → switcher labels. Omit for an ungrouped document. */
  partLabels?: { key: string; label: string; tocLabel?: string }[];
}) {
  const numbered = useMemo(
    () => sections.map((section, i) => ({ section, number: i + 1 })),
    [sections],
  );
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const [tocOpen, setTocOpen] = useState(false);
  const observed = useRef<IntersectionObserver | null>(null);

  // Scroll-spy. The top margin matches the sticky header's footprint so a
  // heading counts as "current" from the moment it clears the header.
  useEffect(() => {
    const headings = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => Boolean(n));
    if (!headings.length) return;

    const visible = new Set<string>();
    observed.current?.disconnect();
    observed.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // The topmost visible section wins, so scrolling up feels right too.
        const first = sections.find((s) => visible.has(s.id));
        if (first) setActiveId(first.id);
      },
      { rootMargin: "-104px 0px -70% 0px", threshold: 0 },
    );
    headings.forEach((n) => observed.current?.observe(n));
    return () => observed.current?.disconnect();
  }, [sections]);

  // Keep the active entry visible in the desktop rail without ever moving the
  // page itself — scrollIntoView would bubble to the window and fight the read.
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const link = rail?.querySelector<HTMLElement>('a[aria-current="true"]');
    if (!rail || !link) return;
    const top = link.offsetTop - rail.offsetTop;
    const bottom = top + link.offsetHeight;
    if (top < rail.scrollTop) rail.scrollTop = top - 12;
    else if (bottom > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = bottom - rail.clientHeight + 12;
    }
  }, [activeId]);

  const activePart = numbered.find(({ section }) => section.id === activeId)?.section.part;

  const grouped = partLabels?.map(({ key, label: partLabel, tocLabel }) => ({
    key,
    label: tocLabel ?? partLabel,
    items: numbered.filter(({ section }) => section.part === key),
  }));

  return (
    <main id="main-content" className="flex-1 bg-surface-sunken">
      {/* ------------------------------- hero ------------------------------- */}
      <section className="border-b border-line bg-surface px-6 pb-12 pt-16 sm:pt-20">
        <div className="mx-auto max-w-[1160px]">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-accent">{label}</p>
          <h1 className="mt-3 font-[var(--font-display)] text-[38px] font-black leading-[1.05] tracking-[-0.03em] text-ink sm:text-[52px]">
            {title}
          </h1>
          <p className="mt-4 max-w-[62ch] text-[16px] leading-[1.7] text-ink-soft">{intro}</p>
          <p className="mt-6 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] border border-line bg-surface-sunken px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-soft">
            Last updated: {lastUpdated}
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-[1160px] px-6 pb-24 pt-10 lg:pt-14">
        <div className="lg:grid lg:grid-cols-[268px_1fr] lg:gap-14">
          {/* --------------------------- contents --------------------------- */}
          <nav aria-label="Table of contents" className="lg:sticky lg:top-28 lg:self-start">
            {/* mobile: collapsible */}
            <div className="lg:hidden">
              <button
                type="button"
                onClick={() => setTocOpen((v) => !v)}
                aria-expanded={tocOpen}
                className="flex w-full items-center justify-between rounded-[var(--radius-token-md)] border border-line bg-surface px-4 py-3 text-left text-[14px] font-bold text-ink"
              >
                Contents
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className="transition-transform duration-300"
                  style={{ transform: tocOpen ? "rotate(180deg)" : "none" }}
                >
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-out"
                style={{ gridTemplateRows: tocOpen ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden">
                  <div className="mt-2 rounded-[var(--radius-token-md)] border border-line bg-surface p-2">
                    {grouped
                      ? grouped.map((group) => (
                          <div key={group.key} className="mb-2 last:mb-0">
                            <p className="px-3 py-1.5 text-[10.5px] font-black uppercase tracking-[0.14em] text-ink-soft/80">
                              {group.label}
                            </p>
                            <TocList
                              sections={group.items}
                              activeId={activeId}
                              onPick={() => setTocOpen(false)}
                            />
                          </div>
                        ))
                      : (
                          <TocList
                            sections={numbered}
                            activeId={activeId}
                            onPick={() => setTocOpen(false)}
                          />
                        )}
                  </div>
                </div>
              </div>
            </div>

            {/* desktop: sticky rail */}
            <div
              ref={railRef}
              className="hidden max-h-[calc(100vh-9rem)] overflow-y-auto pr-1 lg:block"
            >
              <p className="px-3 text-[11px] font-black uppercase tracking-[0.14em] text-ink-soft">
                Contents
              </p>
              <div className="mt-3">
                {grouped
                  ? grouped.map((group) => (
                      <div key={group.key} className="mb-4 last:mb-0">
                        <p
                          className={[
                            "border-l-2 px-3 py-1.5 text-[10.5px] font-black uppercase tracking-[0.14em] transition-colors",
                            activePart === group.key
                              ? "border-accent text-accent-ink"
                              : "border-transparent text-ink-soft",
                          ].join(" ")}
                        >
                          {group.label}
                        </p>
                        <TocList
                          sections={group.items}
                          activeId={activeId}
                          onPick={() => undefined}
                        />
                      </div>
                    ))
                  : <TocList sections={numbered} activeId={activeId} onPick={() => undefined} />}
              </div>
            </div>
          </nav>

          {/* --------------------------- document --------------------------- */}
          <article className="mt-8 min-w-0 lg:mt-0">
            {partLabels && (
              <div className="mb-8">
                <nav
                  aria-label="Jump to a part of these terms"
                  className="inline-flex flex-wrap rounded-[var(--radius-token-pill)] bg-surface-sunken p-1 ring-1 ring-line"
                >
                  {partLabels.map(({ key, label: partLabel }) => {
                    const target = sections.find((s) => s.part === key);
                    const selected = activePart === key;
                    return (
                      <a
                        key={key}
                        aria-current={selected ? "true" : undefined}
                        href={`#${target?.id ?? ""}`}
                        className={[
                          "rounded-[var(--radius-token-pill)] px-5 py-2 text-[13.5px] font-bold transition-colors",
                          selected ? "bg-accent text-white" : "text-ink-soft hover:text-ink",
                        ].join(" ")}
                      >
                        {partLabel}
                        <span className="sr-only"> terms</span>
                      </a>
                    );
                  })}
                </nav>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
                  The General Terms apply to everyone. The Creator and Brand parts add to them —
                  they do not replace them, and nothing here is hidden behind a tab.
                </p>
              </div>
            )}

            {numbered.map(({ section, number }, i) => (
              <section
                key={section.id}
                className={i === 0 ? "" : "mt-12 border-t border-line pt-12"}
              >
                <h2
                  id={section.id}
                  className="scroll-anchor-offset font-[var(--font-display)] text-[22px] font-black leading-tight tracking-[-0.02em] text-ink sm:text-[26px]"
                >
                  <span className="mr-2 text-accent">{number}.</span>
                  {section.title}
                </h2>
                <Blocks blocks={section.blocks} />
              </section>
            ))}
          </article>
        </div>
      </div>
    </main>
  );
}
