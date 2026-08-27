"use client";

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

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isBrand}
      aria-label={`Switch to ${isBrand ? "creator" : "brand"} view`}
      onClick={() => onChange(isBrand ? "creator" : "brand")}
      className={[
        "inline-flex h-[38px] items-center gap-2 rounded-[var(--radius-token-pill)] bg-accent pl-[3px] pr-3.5",
        theme === "dark" ? "shadow-[0_0_0_1px_rgba(255,255,255,0.15)]" : "",
      ].join(" ")}
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
        Tap
      </span>
    </button>
  );
}

export type { Role };
