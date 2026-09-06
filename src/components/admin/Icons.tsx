import type { IconName } from "@/lib/admin/nav";

const PATHS: Record<IconName, React.ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.1 2.5-5.2 5.5-5.2s5.5 2.1 5.5 5.2" />
      <path d="M16 5.2a3.2 3.2 0 010 5.9M17.5 14.9c1.9.6 3.2 2.3 3.2 4.4" />
    </>
  ),
  campaigns: (
    <>
      <path d="M4 9v6h3.5l6 4V5l-6 4H4z" />
      <path d="M17.5 8.5a5 5 0 010 7" />
    </>
  ),
  revenue: (
    <>
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-1.7-2-2.5-4.5-2.5s-4.5.9-4.5 2.6S9.3 10 12 10.5s4.5 1 4.5 2.9-2 2.6-4.5 2.6-4.5-.8-4.5-2.5" />
    </>
  ),
};

export function NavIcon({ name, size = 17 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {PATHS[name]}
    </svg>
  );
}
