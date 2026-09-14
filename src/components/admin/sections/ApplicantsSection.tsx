import { Panel, Resolved } from "../Panel";
import { ApplicantDecision } from "../ApplicantDecision";
import { CalendarRetry } from "../CalendarRetry";
import { getApplicantQueue, type ApplicantView } from "@/lib/admin/firebase-queries";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { Locale } from "@/i18n/config";

type Copy = Dictionary["admin"];

/* ==========================================================================
   APPLICANT REVIEW.

   The queue every other admin surface was missing: who is waiting, what they
   applied as, whether they finished onboarding, when their interview is, and
   the three decisions an administrator may make.

   AWAITING FIRST, THEN THE REST. An applicant in `pending_review` is the only
   one actually blocking on staff, so they get their own panel at the top. The
   second panel is the full history, because a decision is reversible and an
   administrator needs to find a rejected account to reconsider it.
   ========================================================================== */

/** Statuses that still need a human. `pending_review` is the true queue. */
const AWAITING = "pending_review";

export async function ApplicantsBody({ t, locale }: { t: Copy; locale: Locale }) {
  const result = await getApplicantQueue();
  const copy = t.applicants;

  return (
    <Resolved outcome={result} t={t} isEmpty={(q) => q.applicants.length === 0}>
      {(queue) => {
        const awaiting = queue.applicants.filter((a) => a.approvalStatus === AWAITING);
        const others = queue.applicants.filter((a) => a.approvalStatus !== AWAITING);

        return (
          <div className="space-y-4">
            <SummaryStrip queue={queue} awaiting={awaiting.length} copy={copy} />

            <Panel
              title={copy.awaitingTitle}
              hint={copy.awaitingHint}
              action={<CountBadge n={awaiting.length} />}
            >
              {awaiting.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
                  {copy.noneAwaiting}
                </p>
              ) : (
                <ApplicantTable rows={awaiting} t={t} locale={locale} />
              )}
            </Panel>

            {others.length > 0 && (
              <Panel title={copy.allTitle} hint={copy.allHint} action={<CountBadge n={others.length} />}>
                <ApplicantTable rows={others} t={t} locale={locale} />
              </Panel>
            )}
          </div>
        );
      }}
    </Resolved>
  );
}

/* -------------------------------------------------------------------------
   Summary
   ------------------------------------------------------------------------- */

function CountBadge({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-[color:var(--a-accent-soft)] px-2.5 py-0.5 text-[11.5px] font-bold text-[color:var(--a-accent)] tabular-nums">
      {n}
    </span>
  );
}

function SummaryStrip({
  queue,
  awaiting,
  copy,
}: {
  queue: { counts: { total: number; creators: number; brands: number; unassigned: number } };
  awaiting: number;
  copy: Copy["applicants"];
}) {
  const stats = [
    { label: copy.statAwaiting, value: awaiting, accent: true },
    { label: copy.statTotal, value: queue.counts.total, accent: false },
    { label: copy.statCreators, value: queue.counts.creators, accent: false },
    { label: copy.statBrands, value: queue.counts.brands, accent: false },
    { label: copy.statUnassigned, value: queue.counts.unassigned, accent: false },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-xl border border-[color:var(--a-border)] bg-[color:var(--a-panel)] px-4 py-3"
        >
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-[color:var(--a-text-dim)]">
            {s.label}
          </p>
          <p
            className={[
              "mt-1 text-[22px] font-extrabold leading-none tabular-nums",
              s.accent ? "text-[color:var(--a-accent)]" : "text-[color:var(--a-text)]",
            ].join(" ")}
          >
            {s.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Table
   ------------------------------------------------------------------------- */

function ApplicantTable({ rows, t, locale }: { rows: ApplicantView[]; t: Copy; locale: Locale }) {
  const copy = t.applicants;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-[13px]">
        <thead>
          <tr className="border-b border-[color:var(--a-border)] text-start text-[11.5px] font-bold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
            <th className="py-2 pe-4 text-start">{copy.colApplicant}</th>
            <th className="py-2 pe-4 text-start">{copy.colRole}</th>
            <th className="py-2 pe-4 text-start">{copy.colStatus}</th>
            <th className="py-2 pe-4 text-start">{copy.colOnboarding}</th>
            <th className="py-2 pe-4 text-start">{copy.colInterview}</th>
            <th className="py-2 pe-4 text-start">{copy.colDecision}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <ApplicantRowView key={a.firebaseUid} a={a} t={t} locale={locale} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplicantRowView({ a, t, locale }: { a: ApplicantView; t: Copy; locale: Locale }) {
  const copy = t.applicants;
  const name = a.fullName ?? a.displayName ?? a.companyName ?? null;

  return (
    <tr className="border-b border-[color:var(--a-border)] align-top last:border-0">
      <td className="py-3 pe-4">
        <div className="flex items-start gap-2.5">
          {a.photoURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.photoURL} alt="" className="mt-0.5 h-7 w-7 rounded-full" />
          ) : (
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--a-accent-soft)] text-[11px] font-bold text-[color:var(--a-accent)]">
              {(name ?? a.email ?? "?").charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-medium text-[color:var(--a-text)]">{name ?? "—"}</p>
            <p className="ltr-token truncate text-[12px] text-[color:var(--a-text-dim)]">
              {a.email ?? "—"}
            </p>
            {/* Diagnostics: the UID is the join key for every other surface,
                so it is worth having here — muted, and never the headline. */}
            <p className="ltr-token mt-0.5 truncate font-mono text-[10.5px] text-[color:var(--a-text-dim)]/80">
              {a.firebaseUid}
            </p>
          </div>
        </div>
      </td>

      <td className="py-3 pe-4">
        <Chip
          tone={a.role === "brand" ? "violet" : a.role === "creator" ? "positive" : "neutral"}
          label={a.role === "brand" ? t.brandsLabel : a.role === "creator" ? t.creatorsLabel : t.unassignedLabel}
        />
      </td>

      <td className="py-3 pe-4">
        <Chip tone={statusTone(a.approvalStatus)} label={copy.status[a.approvalStatus] ?? a.approvalStatus} />
      </td>

      <td className="py-3 pe-4 text-[12.5px]">
        {a.onboardingCompletedAt ? (
          <span className="text-[color:var(--a-positive)]">✓ {copy.onboardingDone}</span>
        ) : (
          <span className="text-[color:var(--a-text-dim)]">{copy.onboardingPending}</span>
        )}
      </td>

      <td className="py-3 pe-4 text-[12.5px]">
        {a.scheduledAt ? (
          <div className="space-y-0.5">
            <p className="text-[color:var(--a-text)]">{fmtDateTime(a.scheduledAt, locale)}</p>
            <p className="text-[color:var(--a-text-dim)]">
              {a.durationMinutes !== null
                ? copy.durationValue.replace("{minutes}", String(a.durationMinutes))
                : "—"}
              {a.bookingStatus ? ` · ${bookingLabel(copy, a.bookingStatus)}` : ""}
            </p>
            {/* PROVISIONING, NOT APPROVAL. This says whether the Meet room
                exists; whether the applicant is approved is the column to the
                right and the two must not be read as one. */}
            <p
              className={
                a.calendarStatus === "ready"
                  ? "text-[color:var(--a-positive)]"
                  : a.calendarStatus === "failed"
                    ? "text-[color:var(--a-negative)]"
                    : "text-[color:var(--a-warning)]"
              }
            >
              {a.calendarStatus === "ready"
                ? copy.meetReady
                : a.calendarStatus === "failed"
                  ? copy.meetFailed
                  : copy.meetPreparing}
            </p>
            {a.meetingUrl && (
              <a
                href={a.meetingUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-block text-[12px] font-semibold text-[color:var(--a-accent)] underline underline-offset-2"
              >
                {copy.meetJoin}
              </a>
            )}
            {a.calendarStatus === "failed" && a.bookingId && (
              <CalendarRetry
                bookingId={a.bookingId}
                label={copy.meetRetry}
                busyLabel={copy.meetRetrying}
                doneLabel={copy.meetRetryDone}
                failedLabel={copy.meetRetryFailed}
              />
            )}
          </div>
        ) : (
          <span className="text-[color:var(--a-text-dim)]">{copy.noInterview}</span>
        )}
      </td>

      <td className="py-3 pe-4">
        <ApplicantDecision
          firebaseUid={a.firebaseUid}
          currentStatus={a.approvalStatus}
          t={copy}
        />
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------
   Presentation helpers
   ------------------------------------------------------------------------- */

/** The column is a plain string in the row type, so it is looked up loosely
 *  and falls back to the stored value rather than rendering "undefined". */
function bookingLabel(copy: Copy["applicants"], status: string): string {
  const labels: Record<string, string> = copy.bookingStatus;
  return labels[status] ?? status;
}

type Tone = "positive" | "negative" | "warning" | "violet" | "neutral" | "info";

function statusTone(status: string): Tone {
  if (status === "approved") return "positive";
  if (status === "rejected") return "negative";
  if (status === "needs_followup") return "warning";
  if (status === "pending_review") return "info";
  return "neutral";
}

function Chip({ tone, label }: { tone: Tone; label: string }) {
  const tones: Record<Tone, string> = {
    positive: "bg-emerald-900/30 text-emerald-300",
    negative: "bg-red-900/30 text-red-300",
    warning: "bg-amber-900/30 text-amber-300",
    violet: "bg-purple-900/30 text-purple-300",
    info: "bg-sky-900/30 text-sky-300",
    neutral: "bg-slate-800 text-slate-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tones[tone]}`}>{label}</span>
  );
}

/** Admin times are always stamped in the admin timezone, as elsewhere. */
function fmtDateTime(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ADMIN_TIMEZONE,
  }).format(value);
}
