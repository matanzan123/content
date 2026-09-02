import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/* ==========================================================================
   CHARTS

   Hand-drawn SVG rather than a charting library. The shapes needed here are a
   line/area, a stacked bar and a sparkline; a general-purpose library would
   add several hundred kilobytes, fight the RTL document direction, and still
   need overriding to match this theme.

   ACCESSIBILITY: a chart is an image with a caption, plus the same numbers in
   a real table underneath. A screen reader gets the table; a sighted reader
   gets the shape. Neither is a second-class view — the table is inside a
   <details> so it is one keystroke away rather than hidden.

   DIRECTION: the plot area is wrapped in `.admin-chart`, which pins it to LTR.
   Time runs left to right in Hebrew too — mirroring a time axis would put
   later dates on the left, which is not an RTL convention, it is just wrong.
   ========================================================================== */

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function formatNumber(n: number, locale: "en" | "he"): string {
  return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
    notation: n >= 100000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
}

export type SeriesDef = { key: string; label: string; color: string };

/**
 * Multi-series line chart with a filled first series.
 * `points` is an array of records keyed by the series keys, plus a label.
 */
export function LineChart({
  points,
  series,
  locale,
  t,
  height = 200,
}: {
  points: { label: string; values: Record<string, number> }[];
  series: SeriesDef[];
  locale: "en" | "he";
  t: Copy;
  height?: number;
}) {
  const W = 720;
  const H = height;
  const PAD = { top: 12, right: 12, bottom: 24, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const max = niceMax(
    Math.max(1, ...points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0))),
  );
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const summary = series
    .map((s) => `${s.label}: ${formatNumber(points.reduce((n, p) => n + (p.values[s.key] ?? 0), 0), locale)}`)
    .join("; ");

  return (
    <figure className="m-0">
      <div className="admin-chart w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={summary}
          preserveAspectRatio="none"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={PAD.top + innerH * f}
                y2={PAD.top + innerH * f}
                stroke="var(--a-grid)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={PAD.top + innerH * f + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="var(--a-text-dim)"
              >
                {formatNumber(Math.round(max * (1 - f)), locale)}
              </text>
            </g>
          ))}

          {series.map((s, si) => {
            const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.values[s.key] ?? 0)}`).join(" ");
            const area = `${path} L${x(points.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;
            return (
              <g key={s.key}>
                {si === 0 && <path d={area} fill={s.color} fillOpacity="0.1" />}
                <path d={path} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {points.length <= 32 &&
                  points.map((p, i) => (
                    <circle key={i} cx={x(i)} cy={y(p.values[s.key] ?? 0)} r="2.5" fill={s.color}>
                      <title>{`${p.label} · ${s.label}: ${formatNumber(p.values[s.key] ?? 0, locale)}`}</title>
                    </circle>
                  ))}
              </g>
            );
          })}

          {points.map((p, i) =>
            i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? (
              <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--a-text-dim)">
                {p.label}
              </text>
            ) : null,
          )}
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--a-text-muted)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-[11.5px] text-[color:var(--a-text-dim)]">
          {t.chartSummary}
        </summary>
        <table className="mt-2 w-full text-[11.5px]">
          <caption className="sr-only">{t.chartSummary}</caption>
          <thead>
            <tr className="text-[color:var(--a-text-dim)]">
              <th scope="col" className="py-1 text-start font-medium">{t.time}</th>
              {series.map((s) => (
                <th key={s.key} scope="col" className="py-1 text-end font-medium">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label} className="border-t border-[color:var(--a-border)]">
                <th scope="row" className="py-1 text-start font-normal text-[color:var(--a-text-muted)]">{p.label}</th>
                {series.map((s) => (
                  <td key={s.key} className="admin-num py-1 text-end">{formatNumber(p.values[s.key] ?? 0, locale)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Ranked horizontal bars — countries, sources, pages. */
export function BarList({
  rows,
  locale,
  valueLabel,
}: {
  rows: { label: string; value: number; secondary?: string }[];
  locale: "en" | "he";
  valueLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.secondary && (
              <span className="admin-num text-[11.5px] text-[color:var(--a-text-dim)]">{row.secondary}</span>
            )}
            <span className="admin-num font-semibold">{formatNumber(row.value, locale)}</span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-[color:var(--a-panel-raised)]"
            role="img"
            aria-label={`${row.label}: ${formatNumber(row.value, locale)} ${valueLabel}`}
          >
            {/* The bar grows from the inline start, so it follows the document
                direction while the numbers stay readable. */}
            <div
              className="h-full rounded-full bg-[color:var(--a-accent)]"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Stacked bars for a two-part split, e.g. new vs returning. */
export function StackedBars({
  points,
  series,
  locale,
  t,
  height = 180,
}: {
  points: { label: string; values: Record<string, number> }[];
  series: SeriesDef[];
  locale: "en" | "he";
  t: Copy;
  height?: number;
}) {
  const W = 720;
  const H = height;
  const PAD = { top: 10, right: 10, bottom: 24, left: 40 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const totals = points.map((p) => series.reduce((n, s) => n + (p.values[s.key] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const bw = Math.max(3, (innerW / Math.max(points.length, 1)) * 0.62);

  const summary = series
    .map((s) => `${s.label}: ${formatNumber(points.reduce((n, p) => n + (p.values[s.key] ?? 0), 0), locale)}`)
    .join("; ");

  return (
    <figure className="m-0">
      <div className="admin-chart w-full overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={summary} preserveAspectRatio="none">
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + innerH * f}
              y2={PAD.top + innerH * f}
              stroke="var(--a-grid)"
            />
          ))}
          {points.map((p, i) => {
            const cx = PAD.left + (i + 0.5) * (innerW / Math.max(points.length, 1));
            let acc = 0;
            return (
              <g key={i}>
                {series.map((s) => {
                  const v = p.values[s.key] ?? 0;
                  const h = (v / max) * innerH;
                  const yPos = PAD.top + innerH - acc - h;
                  acc += h;
                  return (
                    <rect key={s.key} x={cx - bw / 2} y={yPos} width={bw} height={Math.max(h, 0)} fill={s.color} rx="1.5">
                      <title>{`${p.label} · ${s.label}: ${formatNumber(v, locale)}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--a-text-muted)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[11.5px] text-[color:var(--a-text-dim)]">{t.chartSummary}</summary>
        <table className="mt-2 w-full text-[11.5px]">
          <caption className="sr-only">{t.chartSummary}</caption>
          <thead>
            <tr className="text-[color:var(--a-text-dim)]">
              <th scope="col" className="py-1 text-start font-medium">{t.time}</th>
              {series.map((s) => (
                <th key={s.key} scope="col" className="py-1 text-end font-medium">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label} className="border-t border-[color:var(--a-border)]">
                <th scope="row" className="py-1 text-start font-normal text-[color:var(--a-text-muted)]">{p.label}</th>
                {series.map((s) => (
                  <td key={s.key} className="admin-num py-1 text-end">{formatNumber(p.values[s.key] ?? 0, locale)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
