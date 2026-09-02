import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/**
 * One headline figure.
 *
 * `value === null` means the source cannot answer, and the card says so rather
 * than printing a zero. That distinction is the difference between "nobody
 * visited" and "we are not measuring", and an operator has to be able to tell
 * them apart at a glance.
 */
export function KpiCard({
  label,
  value,
  hint,
  change,
  changeUnavailable,
  unavailableLabel,
  locale,
  accent = false,
  t,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  change?: number | null;
  changeUnavailable?: boolean;
  unavailableLabel?: string;
  locale: "en" | "he";
  accent?: boolean;
  t: Copy;
}) {
  const unavailable = value === null;
  const formatted =
    typeof value === "number"
      ? new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
          notation: value >= 100000 ? "compact" : "standard",
          maximumFractionDigits: 1,
        }).format(value)
      : value;

  return (
    <div className="rounded-xl border border-[color:var(--a-border)] bg-[color:var(--a-panel)] p-4">
      <div className="flex items-start gap-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
          {label}
        </p>
        {hint && (
          // A title attribute is reachable by keyboard focus and by screen
          // readers, unlike a hover-only tooltip.
          <span
            tabIndex={0}
            role="note"
            aria-label={hint}
            title={hint}
            className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[color:var(--a-border-strong)] text-[9px] leading-none text-[color:var(--a-text-dim)]"
          >
            ?
          </span>
        )}
      </div>

      {unavailable ? (
        <p className="mt-2.5 text-[13px] font-medium text-[color:var(--a-text-dim)]">
          <span aria-hidden="true" className="me-1.5 text-[color:var(--a-text-dim)]">
            —
          </span>
          {unavailableLabel ?? t.unavailable}
        </p>
      ) : (
        <p
          className={[
            "admin-num mt-2 text-[26px] font-bold leading-none tracking-tight",
            accent ? "text-[color:var(--a-accent)]" : "text-[color:var(--a-text)]",
          ].join(" ")}
        >
          {formatted}
        </p>
      )}

      {!unavailable && changeUnavailable && (
        <p className="mt-2 text-[11.5px] text-[color:var(--a-text-dim)]">{t.compareUnavailable}</p>
      )}

      {!unavailable && !changeUnavailable && change != null && (
        <p
          className={[
            "mt-2 flex items-center gap-1 text-[12px] font-semibold",
            change >= 0 ? "text-[color:var(--a-positive)]" : "text-[color:var(--a-negative)]",
          ].join(" ")}
        >
          {/* The arrow carries the direction too, so the colour is never alone. */}
          <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span>
          <span className="ltr-token">
            {Math.abs(change).toFixed(1)}%
          </span>
        </p>
      )}
    </div>
  );
}
