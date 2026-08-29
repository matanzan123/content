"use client";

import { useId, useState } from "react";
import { Link } from "@/i18n/Link";
import { useT } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { Role } from "./RoleToggle";

const FAQS: Record<Role, { q: string; a: string }[]> = {
  creator: [
    { q: "How do I get paid?", a: "Once your submission is approved and its views are verified, your payout is added to your balance and released on the next scheduled payout." },
    { q: "Do I need a large following?", a: "No — campaigns are open to any public account, and some are designed specifically for new creators." },
    { q: "Is there a fee on my earnings?", a: "Yes, a small platform fee is deducted automatically before your payout is calculated — the amount shown to you is always what you'll actually receive." },
    { q: "Can I join more than one campaign at a time?", a: "Yes, you can join as many active campaigns as you like and submit content to each of them." },
    { q: "What happens if my submission gets rejected?", a: "You'll see the reason in your dashboard, and you're free to submit a corrected version or try a different campaign." },
    { q: "Which platforms can I post on?", a: "Each campaign lists its accepted platforms — most support a mix of major short-form and video platforms." },
  ],
  brand: [
    { q: "How fast can I launch a campaign?", a: "Most campaigns go live within minutes of submitting your brief and budget." },
    { q: "How do I know creators are legitimate?", a: "Every creator has a trust score built from verified submissions, and top performers carry a verified badge." },
    { q: "What am I actually paying for?", a: "You only pay for verified views on approved content — unapproved or flagged submissions are never charged." },
    { q: "Can I set my own budget and rate?", a: "Yes, you control your total budget and your per-thousand-view rate when you launch a campaign." },
    { q: "How do I review submissions?", a: "Every submission appears in your dashboard for approval, with automatic flags for suspicious activity." },
    { q: "Can agencies manage campaigns on our behalf?", a: "Yes, verified agencies can manage multiple brand campaigns from a single account." },
    { q: "Can I add more budget to a campaign that's already live?", a: "Yes, you can top up an active campaign's budget at any time without creating a new one — creators keep submitting against the same brief." },
    { q: "What happens if a submission looks suspicious?", a: "It's automatically held for manual review before any payout is issued, so unusual view activity never gets billed to your budget." },
  ],
};

function FAQItem({ q, a, isBrand }: { q: string; a: string; isBrand: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonId = useId();
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
        id={buttonId}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className={["text-[14.5px] font-bold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>{q}</span>
        <span
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-300",
            open ? "rotate-45 bg-accent text-white" : isBrand ? "bg-white/10 text-ink-inverse" : "bg-surface-sunken text-ink",
          ].join(" ")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
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
          <p className={["px-5 pb-4 text-[13.5px] leading-relaxed", isBrand ? "text-ink-inverse-soft" : "text-ink-soft"].join(" ")}>
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Creator questions live in the dictionary; the brand set is migrated in the
 *  brand-home pass and still reads from FAQS. */
function creatorItems(t: Dictionary) {
  const f = t.home.faq.items;
  return [
    { q: f.paidQ, a: f.paidA },
    { q: f.followingQ, a: f.followingA },
    { q: f.feeQ, a: f.feeA },
    { q: f.multipleQ, a: f.multipleA },
    { q: f.rejectedQ, a: f.rejectedA },
    { q: f.platformsQ, a: f.platformsA },
  ];
}

export function FAQSection({ role }: { role: Role }) {
  const t = useT();
  const isBrand = role === "brand";
  const items = isBrand ? FAQS.brand : creatorItems(t);

  return (
    <section
      className={[
        "relative overflow-hidden px-6 pb-20 pt-20 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface",
      ].join(" ")}
    >
      <div className="relative mx-auto max-w-[720px] text-center">
        <span
          className={[
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide",
            isBrand ? "bg-white/10 text-ink-inverse-soft" : "bg-accent-soft text-accent-ink",
          ].join(" ")}
        >
          {t.home.faq.badge}
        </span>
        <h2
          className={[
            "mx-auto mt-4 font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {t.home.faq.heading}
        </h2>
        <p
          className={[
            "mx-auto mt-4 max-w-md text-[15px] leading-relaxed",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          {t.home.faq.subtitle}
        </p>

        <div className="mt-10 flex flex-col gap-3 text-left">
          {items.map((item) => (
            <FAQItem key={item.q} q={item.q} a={item.a} isBrand={isBrand} />
          ))}
        </div>

        <Link
          href="/faqs"
          className={[
            "mt-8 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] px-6 py-3 text-[14px] font-bold transition-colors",
            isBrand ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/90",
          ].join(" ")}
        >
          {t.home.faq.seeAll}
          <svg className="dir-flip" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
