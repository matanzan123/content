"use client";

import { useT } from "@/i18n/provider";
import { track } from "@/lib/analytics/client";

type Role = "creator" | "brand";

export function RoleToggle({
  role,
  onChange,
  theme,
}: {
  role: Role;
  onChange: (role: Role) => void;
  theme: "light" | "dark";
}) {
  const isBrand = role === "brand";
  const t = useT();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isBrand}
      aria-label={isBrand ? t.roleToggle.toCreator : t.roleToggle.toBrand}
      onClick={() => {
        const next = isBrand ? "creator" : "brand";
        track("creator_brand_mode_changed", { mode: next });
        onChange(next);
      }}
      className={[
        "inline-flex h-[38px] items-center gap-2 rounded-[var(--radius-token-pill)] pl-[3px] pr-3.5",
        theme === "dark" ? "shadow-[0_0_0_1px_rgba(255,255,255,0.15)]" : "",
      ].join(" ")}
      style={{
        // The copper accent is too light for white 15px bold text, so the dark
        // realm deepens it just enough to clear 4.5:1. Creator stays as approved.
        background:
          theme === "dark" ? "color-mix(in srgb, var(--accent) 78%, #170b02)" : "var(--accent)",
      }}
    >
      <span className="relative h-[32px] w-[54px] shrink-0 rounded-full bg-white/25">
        <span
          className={[
            "absolute top-[3px] flex h-[26px] w-[26px] items-center justify-center rounded-full bg-white text-accent-ink transition-[left] duration-200 ease-out",
            isBrand ? "left-[25px]" : "left-[3px]",
          ].join(" ")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 7L16 12L8 17V7Z" fill="currentColor" />
          </svg>
        </span>
      </span>
      <span className="whitespace-nowrap text-[15px] font-bold uppercase tracking-wide text-white">
        {t.roleToggle.tap}
      </span>
    </button>
  );
}

export type { Role };
