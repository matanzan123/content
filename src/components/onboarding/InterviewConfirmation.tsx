import type { ReactNode } from "react";

/**
 * The booked-interview confirmation.
 *
 * PRESENTATION ONLY, AND DELIBERATELY SO. Every value arrives already read
 * from the applicant's own booking row and already formatted by the page —
 * this component cannot reach a database, a clock or a configuration, so there
 * is nowhere for an invented fact to enter. A meeting link is rendered only
 * when one was actually passed; otherwise the page says the link is still to
 * come rather than showing a control that would open nothing.
 */
export function InterviewConfirmation({
  eyebrow,
  title,
  body,
  detailsTitle,
  rows,
  meetingUrl,
  joinLabel,
  linkPending,
  nextTitle,
  steps,
}: {
  eyebrow: string;
  title: string;
  body: string;
  detailsTitle: string;
  /** Already-formatted booking facts, in display order. */
  rows: { label: string; value: ReactNode; icon: "calendar" | "clock" | "timer" | "video" | "globe" }[];
  /** The real link from the booking row, or null when staff have not set one. */
  meetingUrl: string | null;
  joinLabel: string;
  linkPending: string;
  nextTitle: string;
  steps: readonly string[];
}) {
  return (
    <main id="main-content" className="flex-1 px-5 py-14 sm:py-20">
      <div className="mx-auto max-w-[620px]">
        <div className="text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-[var(--shadow-card)]">
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>

          <p className="mt-5 text-[11.5px] font-bold uppercase tracking-[0.1em] text-accent-ink">
            {eyebrow}
          </p>
          <h1 className="mt-2.5 font-[var(--font-display)] text-[30px] font-extrabold leading-tight tracking-tight text-ink sm:text-[34px]">
            {title}
          </h1>
          <p className="mx-auto mt-3.5 max-w-[520px] text-[15px] leading-relaxed text-ink-soft">
            {body}
          </p>
        </div>

        <section
          aria-label={detailsTitle}
          className="mt-9 overflow-hidden rounded-[var(--radius-token-lg)] border border-line bg-surface shadow-[var(--shadow-float)]"
        >
          <h2 className="border-b border-line bg-surface-sunken/70 px-6 py-4 font-[var(--font-display)] text-[13px] font-extrabold uppercase tracking-[0.06em] text-ink sm:px-7">
            {detailsTitle}
          </h2>

          <dl className="divide-y divide-line">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center gap-3.5 px-6 py-3.5 sm:px-7">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-line bg-surface text-accent">
                  <Icon name={row.icon} />
                </span>
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
                    {row.label}
                  </dt>
                  <dd className="mt-[3px] text-[14.5px] font-bold leading-none text-ink">
                    {row.value}
                  </dd>
                </div>
              </div>
            ))}
          </dl>

          {/* THE LINK IS ONLY EVER REAL. Staff paste it into the booking; until
              then there is nothing to join, and a button that opened nothing
              would be a worse answer than a sentence. */}
          <div className="border-t border-line bg-surface-sunken/50 px-6 py-5 sm:px-7">
            {meetingUrl ? (
              <a
                href={meetingUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-token-pill)] bg-ink py-3.5 text-[14.5px] font-bold text-white shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:bg-ink/90"
              >
                <Icon name="video" />
                {joinLabel}
              </a>
            ) : (
              <p className="text-center text-[13.5px] leading-relaxed text-ink-soft">
                {linkPending}
              </p>
            )}
          </div>
        </section>

        <section className="mt-9">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
            {nextTitle}
          </h2>
          <ol className="mt-4 space-y-3.5">
            {steps.map((step, index) => (
              <li key={step} className="flex items-start gap-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-bold text-accent-ink">
                  {index + 1}
                </span>
                <span className="min-w-0 pt-[3px] text-[14px] leading-relaxed text-ink-soft">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------
   Icons — the same stroke treatment as the booking screen.
   ------------------------------------------------------------------------- */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ name }: { name: "calendar" | "clock" | "timer" | "video" | "globe" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      {name === "calendar" && (
        <>
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
          <path d="M3.5 9.8h17M8.2 3.2v3.4M15.8 3.2v3.4" />
        </>
      )}
      {name === "clock" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 1.8" />
        </>
      )}
      {name === "timer" && (
        <>
          <circle cx="12" cy="13.5" r="7.5" />
          <path d="M9.5 2.8h5M12 13.5V9.8" />
        </>
      )}
      {name === "video" && (
        <>
          <rect x="3" y="6" width="12.5" height="12" rx="3" />
          <path d="M15.5 10.8l5-2.8v7.9l-5-2.8" />
        </>
      )}
      {name === "globe" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
          <path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9s1.2-6.4 3.6-9z" />
        </>
      )}
    </svg>
  );
}
