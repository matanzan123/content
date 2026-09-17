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
  applicants: (
    <>
      <path d="M6.5 3.8h11a1.7 1.7 0 011.7 1.7v13a1.7 1.7 0 01-1.7 1.7h-11a1.7 1.7 0 01-1.7-1.7v-13A1.7 1.7 0 016.5 3.8z" />
      <path d="M9 8.5h6M9 12h6" />
      <path d="M9.2 15.6l1.4 1.4 3-3" />
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
  finance: (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="18" cy="18" r="3" />
      <path d="M18 16.5v1.5l1 1" />
    </>
  ),
  migration: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
      <path d="M10 6.5h2.5a2 2 0 012 2V10" />
      <path d="M14 9l2.5 1-2.5 1" />
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
