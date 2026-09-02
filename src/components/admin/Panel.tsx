import type { Outcome } from "@/lib/analytics/dashboard";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/* ==========================================================================
   PANEL AND ITS STATES

   Every data surface has five outcomes, and they mean different things:

     unconfigured  no database — the figure would not be real, so none is shown
     error         the query failed — this panel only, others keep working
     empty         the database answered and there is nothing yet
     data          a real answer, including a real zero
     unavailable   the source does not exist and is not coming today

   Keeping them distinct is the whole point. Collapsing "unconfigured" into a
   zero would make an unplugged dashboard look like a dead business.
   ========================================================================== */

export function Panel({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={[
        "rounded-xl border border-[color:var(--a-border)] bg-[color:var(--a-panel)]",
        className,
      ].join(" ")}
    >
      {title && (
        <div className="flex items-start gap-3 border-b border-[color:var(--a-border)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-bold tracking-tight">{title}</h2>
            {hint && <p className="mt-0.5 text-[11.5px] leading-snug text-[color:var(--a-text-dim)]">{hint}</p>}
          </div>
          {action && <div className="ms-auto shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">{children}</div>;
}

export function EmptyState({ t }: { t: Copy }) {
  return (
    <Centered>
      <span aria-hidden="true" className="text-[color:var(--a-text-dim)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 10h18" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-[13px] font-semibold">{t.noData}</p>
      <p className="max-w-[36ch] text-[12px] text-[color:var(--a-text-dim)]">{t.noDataBody}</p>
    </Centered>
  );
}

export function ErrorState({ t }: { t: Copy }) {
  return (
    <Centered>
      {/* Colour is not the only signal — the icon and the wording carry it too. */}
      <span aria-hidden="true" className="text-[color:var(--a-negative)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5M12 16h.01" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-[13px] font-semibold text-[color:var(--a-negative)]">{t.errorTitle}</p>
      <p className="max-w-[40ch] text-[12px] text-[color:var(--a-text-dim)]">{t.errorBody}</p>
    </Centered>
  );
}

export function UnconfiguredState({ t }: { t: Copy }) {
  return (
    <Centered>
      <span aria-hidden="true" className="text-[color:var(--a-warning)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 4l9 16H3z" strokeLinejoin="round" />
          <path d="M12 10v4M12 17.5h.01" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-[13px] font-semibold text-[color:var(--a-warning)]">{t.dbNotConfigured}</p>
      <p className="max-w-[46ch] text-[12px] leading-relaxed text-[color:var(--a-text-dim)]">
        {t.dbNotConfiguredBody}
      </p>
    </Centered>
  );
}

/**
 * Renders one of the states for a query result. `isEmpty` decides whether a
 * successful answer counts as empty — a count of zero is data, an empty list
 * is not.
 */
export function Resolved<T>({
  outcome,
  t,
  isEmpty,
  children,
}: {
  outcome: Outcome<T>;
  t: Copy;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (!outcome.ok) return outcome.reason === "unconfigured" ? <UnconfiguredState t={t} /> : <ErrorState t={t} />;
  if (isEmpty?.(outcome.data)) return <EmptyState t={t} />;
  return <>{children(outcome.data)}</>;
}
