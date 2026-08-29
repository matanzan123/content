"use client";

import { useId, useState } from "react";
import { Link } from "@/i18n/Link";

/* ==========================================================================
   ANSWERS TO YOUR QUESTIONS — brand realm FAQ

   A real accordion: rows open and close on click, on Enter and on Space,
   because the trigger is a real <button>. The open/close transition animates
   `grid-template-rows` from 0fr to 1fr rather than a hardcoded max-height, so
   the row grows to exactly the answer's height — no measured heights, no jump
   when a long answer outgrows a guessed maximum.
   ========================================================================== */

const FAQS = [
  {
    q: "What does ClipRewards charge on top of my campaign budget?",
    a: "A flat platform fee on verified spend. No agency retainer, no monthly minimum, and nothing charged for creators who join a campaign but never post.",
  },
  {
    q: "What happens when I flag a submission?",
    a: "It leaves the payable pool immediately and goes to our review team. If the flag stands, those views never bill against your budget.",
  },
  {
    q: "How do you catch fake engagement?",
    a: "Every submission is scored on view velocity, audience overlap and device patterns. Anything outside normal bounds is held before it can be paid.",
  },
  {
    q: "Is anything actually reviewed by a person?",
    a: "Yes. The automated checks decide what gets escalated, but a reviewer makes the final call on every held submission.",
  },
  {
    q: "Can I add budget to a campaign that is already live?",
    a: "At any time. The brief, the creators and the submissions all stay in place — only the ceiling moves.",
  },
  {
    q: "When do creators actually get paid?",
    a: "Once their views clear verification, on the next weekly payout run. You are billed against those same verified numbers, never the raw view count.",
  },
  {
    q: "What does the verified brand badge mean?",
    a: "That your company details and payment method have been confirmed. Verified campaigns rank higher in Discover and draw noticeably more applicants.",
  },
  {
    q: "Can an agency run campaigns on our behalf?",
    a: "Yes. A verified agency account manages several brands side by side, with separate budgets and reporting for each one.",
  },
];

function Row({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  const panelId = useId();
  const buttonId = useId();
  return (
    <div
      className="overflow-hidden rounded-[18px] transition-colors duration-300"
      style={{
        background: open
          ? "linear-gradient(170deg, #1d1610 0%, #100b08 100%)"
          : "linear-gradient(170deg, #16110c 0%, #0b0806 100%)",
        boxShadow: open
          ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 46%, transparent), 0 18px 40px -20px rgba(0,0,0,0.9)"
          : "inset 0 0 0 1px rgba(255,255,255,0.075)",
      }}
    >
      <button
        id={buttonId}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 px-5 py-[18px] text-left sm:px-6"
      >
        <span className="text-[15px] font-bold leading-snug text-white sm:text-[16px]">{q}</span>
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-300"
          style={{
            background: open
              ? "linear-gradient(140deg, var(--accent-2), var(--accent))"
              : "rgba(255,255,255,0.06)",
            boxShadow: open
              ? "0 8px 20px -6px color-mix(in srgb, var(--accent) 85%, transparent)"
              : "inset 0 0 0 1px rgba(255,255,255,0.1)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              stroke={open ? "#ffffff" : "var(--accent)"}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p
            className="px-5 pb-5 pr-12 text-[14px] leading-[1.6] transition-opacity duration-300 sm:px-6 sm:pb-[22px] sm:pr-16"
            style={{
              color: "color-mix(in srgb, var(--ink-inverse) 70%, var(--ink-inverse-soft))",
              opacity: open ? 1 : 0,
            }}
          >
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

export function BrandFAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="relative overflow-hidden bg-[#040303] px-6 pb-24 pt-24 sm:pt-28">
      <span
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.17] blur-[130px]"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent 70%)" }}
      />
      <span
        className="pointer-events-none absolute inset-x-[18%] top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.09), transparent)" }}
      />

      <div className="relative mx-auto max-w-[840px]">
        <div className="text-center">
          <span
            className="inline-flex items-center rounded-[var(--radius-token-pill)] px-4 py-1.5"
            style={{
              background: "color-mix(in srgb, var(--surface-inverse-raised) 82%, transparent)",
              boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)",
            }}
          >
            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-[color:var(--accent-2)]">
              FAQ
            </span>
          </span>
          <h2 className="mx-auto mt-5 max-w-[16ch] text-balance font-[var(--font-display)] text-[38px] font-black leading-[1] tracking-[-0.03em] text-white sm:text-[54px]">
            Answers to Your Questions
          </h2>
          <p
            className="mx-auto mt-4 max-w-[48ch] text-balance text-[16.5px] font-medium leading-[1.55]"
            style={{ color: "color-mix(in srgb, var(--ink-inverse) 74%, var(--ink-inverse-soft))" }}
          >
            What brands ask us most about budgets, verification and getting a campaign live.
          </p>
        </div>

        {/* the accordion sits in its own rimmed container so it reads as one
            central block rather than eight loose rows */}
        <div
          className="mt-12 rounded-[28px] p-3 sm:p-4"
          style={{
            background: "linear-gradient(180deg, rgba(30,22,16,0.72), rgba(8,6,5,0.72))",
            boxShadow:
              "inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent), 0 40px 90px -40px rgba(0,0,0,0.95), 0 0 70px -30px color-mix(in srgb, var(--accent) 70%, transparent)",
          }}
        >
          <div className="flex flex-col gap-2.5">
            {FAQS.map((item, i) => (
              <Row
                key={item.q}
                q={item.q}
                a={item.a}
                open={openIndex === i}
                onToggle={() => setOpenIndex((cur) => (cur === i ? null : i))}
              />
            ))}
          </div>
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            href="/faqs"
            className="group relative inline-flex items-center gap-2.5 rounded-[var(--radius-token-pill)] px-7 py-3.5 text-[15px] font-bold text-white transition-all duration-300 hover:-translate-y-0.5"
            style={{
              background: "linear-gradient(170deg, #1a130d, #0a0705)",
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--accent) 42%, transparent), 0 0 0 0 color-mix(in srgb, var(--accent) 70%, transparent)",
            }}
          >
            <span
              className="pointer-events-none absolute inset-0 rounded-[var(--radius-token-pill)] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{ boxShadow: "0 0 40px -8px color-mix(in srgb, var(--accent) 85%, transparent)" }}
            />
            See all questions
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="transition-transform duration-300 group-hover:translate-x-1"
            >
              <path
                d="M5 12h14M19 12l-6-6M19 12l-6 6"
                stroke="var(--accent-2)"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  );
}
