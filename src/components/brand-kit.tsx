/**
 * Shared rendering helpers for the fictional brand identity system.
 * The dataset itself lives in src/data/brands.ts; this module only draws it.
 */

import { BRANDS, type Brand } from "../data/brands";

export type BrandMark = Brand;

/** Alias kept so the Hero's existing imports keep working unchanged. */
export const BRAND_MARKS: Brand[] = BRANDS;

export function BrandLogo({
  mark,
  size = 40,
  radius = 10,
}: {
  mark: BrandMark;
  size?: number;
  radius?: number;
}) {
  const glyph = Math.round(size * 0.54);
  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(140deg, ${mark.from}, ${mark.to})`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3), 0 2px 6px -1px rgba(0,0,0,0.5)",
      }}
    >
      <span
        className="pointer-events-none absolute inset-0"
        style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.24), transparent 58%)" }}
      />
      <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" className="relative">
        <path
          d={mark.d}
          stroke="white"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={mark.fill ? "rgba(255,255,255,0.22)" : "none"}
        />
      </svg>
    </span>
  );
}

export function VerifiedTick({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M12 2.4l7.6 3.3v5.4c0 4.8-3.3 8.2-7.6 9.5-4.3-1.3-7.6-4.7-7.6-9.5V5.7L12 2.4z"
        fill="var(--accent-cyan)"
        fillOpacity="0.92"
      />
      <path
        d="M8.6 12.1l2.4 2.4 4.4-4.8"
        stroke="#1a1108"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
