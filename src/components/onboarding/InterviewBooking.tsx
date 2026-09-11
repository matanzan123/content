"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n/provider";

/**
 * Interview slot picker.
 *
 * THE DATA IS REAL AND UNCHANGED. Every instant rendered here comes from
 * `listAvailableSlots`, generated from the configured operating hours, and is
 * posted back verbatim. Nothing on this screen is derived, rounded or invented
 * — the duration and the timezone are the operator's own configuration, passed
 * through from the server.
 *
 * THIS COMPONENT IS NOT A BOUNDARY. It posts an instant, and the server
 * re-validates that instant against the same availability rules before writing
 * anything — a client could post any time it liked and be refused.
 *
 * THE SHAPE OF THE UI IS THE POINT. A flat list of every slot in a two-week
 * horizon is ~140 rows of near-identical text; grouping by calendar day turns
 * it into one short strip of days and one small grid of times, which is how
 * people actually think about booking a call.
 */
export function InterviewBooking({
  slots,
  timezone,
  locale,
  durationMinutes,
}: {
  slots: string[];
  timezone: string;
  locale: string;
  /** The operator's configured slot length. Never guessed. */
  durationMinutes: number;
}) {
  const t = useT().approval.interview;
  const intlLocale = locale === "he" ? "he-IL" : "en-US";

  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [pickedSlot, setPickedSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Formatters are built once. Every one of them is pinned to the configured
   * interview timezone, so a creator in another country still sees the times
   * the interview is actually held at, labelled with that zone.
   */
  const fmt = useMemo(() => {
    const at = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intlLocale, { ...options, timeZone: timezone });
    return {
      // en-CA yields YYYY-MM-DD, which is a stable grouping key in any UI
      // locale — the visible labels are formatted separately.
      key: new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      weekday: at({ weekday: "short" }),
      day: at({ day: "numeric" }),
      month: at({ month: "short" }),
      time: at({ hour: "numeric", minute: "2-digit" }),
      longDate: at({ weekday: "long", month: "long", day: "numeric" }),
    };
  }, [intlLocale, timezone]);

  /** The real slots, bucketed into the calendar days they fall on. */
  const days = useMemo(() => {
    const buckets = new Map<string, { key: string; first: Date; times: string[] }>();
    for (const iso of slots) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) continue;
      const key = fmt.key.format(date);
      const bucket = buckets.get(key);
      if (bucket) bucket.times.push(iso);
      else buckets.set(key, { key, first: date, times: [iso] });
    }
    return [...buckets.values()];
  }, [slots, fmt]);

  const activeDay = days.some((d) => d.key === pickedDay) ? pickedDay : (days[0]?.key ?? null);
  const times = days.find((d) => d.key === activeDay)?.times ?? [];

  /*
   * DAY STRIP SCROLLING.
   *
   * The native scrollbar is hidden (the arrows and the snap points say the
   * strip moves) but the element is still a real scroll container, so wheel,
   * trackpad, touch and keyboard all behave normally — a focused day card
   * scrolls itself into view like any other focusable child.
   *
   * RTL: `scrollLeft` runs NEGATIVE from 0 at the start of the content, so
   * distance travelled is its magnitude in either direction, and "next" means
   * "later dates" regardless of which way that is on screen.
   */
  const stripRef = useRef<HTMLDivElement | null>(null);
  const rtl = locale === "he";
  const [reach, setReach] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const travelled = Math.abs(el.scrollLeft);
    // A 1px tolerance: sub-pixel layout makes exact equality unreliable.
    setReach({ start: travelled <= 1, end: max <= 1 || travelled >= max - 1 });
  }, []);

  useEffect(() => {
    measure();
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, days.length]);

  function nudge(direction: 1 | -1) {
    const el = stripRef.current;
    if (!el) return;
    // Roughly three cards, and never more than one screenful.
    const step = Math.min(el.clientWidth * 0.8, 252);
    el.scrollBy({ left: (rtl ? -1 : 1) * direction * step, behavior: "smooth" });
  }

  function chooseDay(key: string) {
    setPickedDay(key);
    // A time on one day means nothing on another.
    setPickedSlot(null);
    setError(null);
  }

  async function book() {
    if (!pickedSlot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/interview/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduled_at: pickedSlot }),
      });
      if (response.ok) {
        // The server decides where they belong next; a reload re-runs the
        // page guard rather than this component guessing.
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "generic");
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  const errors: Record<string, string> = t.errors;
  const message = error ? (errors[error] ?? t.errors.generic) : null;

  if (days.length === 0) {
    return (
      <div className="mt-9 rounded-[var(--radius-token-lg)] border border-line bg-surface p-9 text-center shadow-[var(--shadow-card)]">
        <p className="text-[14.5px] leading-relaxed text-ink-soft">{t.noSlots}</p>
      </div>
    );
  }

  return (
    <div className="mt-9 overflow-hidden rounded-[var(--radius-token-lg)] border border-line bg-surface shadow-[var(--shadow-float)] lg:grid lg:grid-cols-[300px_1fr]">
      {/* ── Left: what the call actually is. Border flips side in RTL because
             it is a logical border, not a left/right one. ───────────────── */}
      <aside className="border-b border-line bg-surface-sunken/70 p-7 sm:p-8 lg:border-b-0 lg:border-e">
        <h2 className="font-[var(--font-display)] text-[15px] font-extrabold uppercase tracking-[0.06em] text-ink">
          {t.detailsTitle}
        </h2>

        <dl className="mt-5 space-y-1">
          <Detail label={t.durationLabel} icon={<ClockIcon />}>
            {t.durationValue.replace("{minutes}", String(durationMinutes))}
          </Detail>
          <Detail label={t.formatLabel} icon={<VideoIcon />}>
            {t.formatValue}
          </Detail>
          <Detail label={t.timezoneLabel} icon={<GlobeIcon />}>
            {/* An IANA zone is an identifier, so it stays LTR in Hebrew. */}
            <span className="ltr-token">{timezone}</span>
          </Detail>
        </dl>

        <hr className="mt-6 border-line" />

        <h3 className="mt-6 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
          {t.expectTitle}
        </h3>
        <ul className="mt-3.5 space-y-3">
          {t.expect.map((line) => (
            <li key={line} className="flex gap-3 text-[13.5px] leading-relaxed text-ink-soft">
              <span
                aria-hidden="true"
                className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70"
              />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Right: pick a day, pick a time, confirm. `min-w-0` is load-bearing:
             without it this grid track sizes to the un-scrolled width of the
             day strip and the whole card overflows. ──────────────────────── */}
      <div className="min-w-0 p-7 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
            {t.chooseDay}
          </p>
          {/* Arrows live in the header rather than floating over the cards, so
              nothing ever overlaps a date and the control order flips with the
              writing direction on its own. */}
          <div className="flex shrink-0 items-center gap-1.5">
            <StripArrow
              label={t.previousDays}
              disabled={reach.start}
              onClick={() => nudge(-1)}
              back
            />
            <StripArrow label={t.nextDays} disabled={reach.end} onClick={() => nudge(1)} />
          </div>
        </div>

        {/* The strip scrolls rather than wrapping, so a two-week horizon stays
            one clean row on desktop and one swipe on a phone. The scrollbar is
            hidden; the arrows, the snap points and the deliberately half-shown
            next card are what say "there is more". */}
        <div
          ref={stripRef}
          onScroll={measure}
          role="group"
          aria-label={t.chooseDay}
          className="-mx-1 mt-3 flex snap-x snap-mandatory gap-2.5 overflow-x-auto scroll-pl-1 px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {days.map((day) => {
            const active = day.key === activeDay;
            return (
              <button
                key={day.key}
                type="button"
                aria-pressed={active}
                onClick={() => chooseDay(day.key)}
                className={[
                  "min-w-[74px] shrink-0 snap-start rounded-[var(--radius-token-md)] border px-3 py-3 text-center transition-all",
                  active
                    ? "border-accent bg-accent text-white shadow-[var(--shadow-card)]"
                    : "border-line bg-surface text-ink hover:border-accent/40 hover:bg-accent-soft/40",
                ].join(" ")}
              >
                <span
                  className={[
                    "block text-[11px] font-semibold uppercase tracking-[0.06em]",
                    active ? "text-white/75" : "text-ink-soft",
                  ].join(" ")}
                >
                  {fmt.weekday.format(day.first)}
                </span>
                <span className="mt-1 block text-[19px] font-extrabold leading-none tracking-tight">
                  {fmt.day.format(day.first)}
                </span>
                <span
                  className={[
                    "mt-1 block text-[11.5px] font-medium",
                    active ? "text-white/75" : "text-ink-soft",
                  ].join(" ")}
                >
                  {fmt.month.format(day.first)}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-7 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
          {t.chooseTime}
        </p>
        <div
          role="group"
          aria-label={t.chooseTime}
          className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3"
        >
          {times.map((iso) => {
            const active = iso === pickedSlot;
            return (
              <button
                key={iso}
                type="button"
                aria-pressed={active}
                disabled={busy}
                onClick={() => {
                  setPickedSlot(iso);
                  setError(null);
                }}
                className={[
                  "rounded-[var(--radius-token-md)] border py-2.5 text-[14px] tabular-nums transition-all disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-accent bg-accent-soft font-bold text-accent-ink shadow-[0_0_0_3px_var(--accent-soft)]"
                    : "border-line bg-surface font-semibold text-ink hover:border-accent/40 hover:bg-accent-soft/40",
                ].join(" ")}
              >
                {fmt.time.format(new Date(iso))}
              </button>
            );
          })}
        </div>

        {/* The summary states the choice in full words before anything is
            written, so nobody books a time they misread off a grid. */}
        {pickedSlot ? (
          <div className="mt-7 flex items-center gap-3.5 rounded-[var(--radius-token-md)] border border-accent/25 bg-accent-soft/55 px-4 py-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
                {t.selectedTitle}
              </p>
              <p className="mt-1 text-[15px] font-bold leading-tight text-ink">
                {fmt.longDate.format(new Date(pickedSlot))}
              </p>
              <p className="mt-0.5 text-[13.5px] font-medium text-ink-soft">
                {fmt.time.format(new Date(pickedSlot))} ·{" "}
                <span className="ltr-token">{timezone}</span>
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-7 text-[13.5px] leading-relaxed text-ink-soft">{t.pickTimeHint}</p>
        )}

        {message ? (
          <p
            role="alert"
            className="mt-4 rounded-[var(--radius-token-md)] bg-red-50 px-4 py-3 text-[13.5px] font-medium text-red-700"
          >
            {message}
          </p>
        ) : null}

        <button
          type="button"
          onClick={book}
          disabled={!pickedSlot || busy}
          aria-busy={busy}
          className={[
            "mt-5 w-full rounded-[var(--radius-token-pill)] py-3.5 text-[14.5px] font-bold transition-all",
            pickedSlot && !busy
              ? "bg-ink text-white shadow-[var(--shadow-card)] hover:-translate-y-px hover:bg-ink/90"
              : "cursor-not-allowed border border-line bg-surface-sunken text-ink-soft",
          ].join(" ")}
        >
          {busy ? t.ctaBusy : t.cta}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Presentational bits
   ------------------------------------------------------------------------- */

function Detail({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-line bg-surface text-accent">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
          {label}
        </dt>
        <dd className="mt-[3px] text-[14.5px] font-bold leading-none text-ink">{children}</dd>
      </div>
    </div>
  );
}

/**
 * One day-strip arrow. Disabled at the ends of the strip, and hidden from
 * assistive tech: it scrolls a container whose contents are already reachable
 * by tab, so announcing it would only add noise.
 */
function StripArrow({
  label,
  disabled,
  onClick,
  back = false,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  back?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-ink transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:border-line/60 disabled:text-ink-soft/40 disabled:hover:border-line/60 disabled:hover:text-ink-soft/40"
    >
      {/* The glyph is a left chevron, so each arrow flips when the writing
          direction does: "back" points at the start of the strip in both. */}
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={back ? "rtl:scale-x-[-1]" : "scale-x-[-1] rtl:scale-x-100"}
        {...STROKE}
      >
        <path d="M14.5 5.5L8 12l6.5 6.5" />
      </svg>
    </button>
  );
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      <rect x="3" y="6" width="12.5" height="12" rx="3" />
      <path d="M15.5 10.8l5-2.8v7.9l-5-2.8" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
      <path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9s1.2-6.4 3.6-9z" />
    </svg>
  );
}
