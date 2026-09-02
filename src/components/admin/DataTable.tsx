import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

export type Column<T> = {
  key: string;
  header: string;
  /** Right-aligned and tabular for figures. */
  numeric?: boolean;
  render: (row: T) => React.ReactNode;
};

/**
 * A table with a sticky header that scrolls inside its own container.
 *
 * The horizontal scroll lives on the wrapper, never on the page — a dense
 * table must not be able to give the whole document a horizontal scrollbar.
 * The wrapper is focusable so a keyboard user can scroll it without a mouse.
 */
export function DataTable<T>({
  columns,
  rows,
  caption,
  rowKey,
  t,
  maxHeight = "560px",
}: {
  columns: Column<T>[];
  rows: T[];
  caption: string;
  rowKey: (row: T, index: number) => string;
  t: Copy;
  maxHeight?: string;
}) {
  if (!rows.length) {
    return (
      <p className="py-8 text-center text-[12.5px] text-[color:var(--a-text-dim)]">{t.noDataBody}</p>
    );
  }

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={caption}
      className="overflow-auto rounded-lg border border-[color:var(--a-border)]"
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse text-[12.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-[color:var(--a-panel-raised)]">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={[
                  "whitespace-nowrap border-b border-[color:var(--a-border)] px-3 py-2.5 font-semibold text-[color:var(--a-text-muted)]",
                  col.numeric ? "text-end" : "text-start",
                ].join(" ")}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className="border-b border-[color:var(--a-border)] last:border-0 hover:bg-[color:var(--a-panel-raised)]"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={[
                    "px-3 py-2.5",
                    col.numeric ? "admin-num text-end" : "text-start",
                  ].join(" ")}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Says plainly whether a section has a data source. Used at the top of pages
 * whose product database does not exist yet, so nobody reads an empty screen
 * as a business result.
 */
export function SourceStatus({
  label,
  status,
  body,
  tone = "warning",
}: {
  label: string;
  status: string;
  body: string;
  tone?: "warning" | "positive";
}) {
  const color = tone === "positive" ? "var(--a-positive)" : "var(--a-warning)";
  return (
    <div className="rounded-xl border border-[color:var(--a-border)] bg-[color:var(--a-panel)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
          {label}
        </p>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold"
          style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
        >
          {/* A dot alone would be colour-only; the word beside it carries it. */}
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {status}
        </span>
      </div>
      <p className="mt-2.5 max-w-[80ch] text-[12.5px] leading-relaxed text-[color:var(--a-text-muted)]">
        {body}
      </p>
    </div>
  );
}
