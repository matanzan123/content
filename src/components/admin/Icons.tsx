import type { IconName } from "@/lib/admin/nav";

/**
 * Sidebar iconography — one 24×24 stroke set drawn here rather than pulled
 * from a package, so the whole admin surface ships a few hundred bytes of
 * geometry instead of an icon dependency.
 *
 * Every icon is decorative: the label beside it is the accessible name, so
 * these are hidden from assistive technology.
 */
const PATHS: Record<IconName, React.ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
    </>
  ),
  revenue: (
    <>
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-1.7-2-2.5-4.5-2.5s-4.5.9-4.5 2.6S9.3 10 12 10.5s4.5 1 4.5 2.9-2 2.6-4.5 2.6-4.5-.8-4.5-2.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.1 2.5-5.2 5.5-5.2s5.5 2.1 5.5 5.2" />
      <path d="M16 5.2a3.2 3.2 0 010 5.9M17.5 14.9c1.9.6 3.2 2.3 3.2 4.4" />
    </>
  ),
  activity: <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />,
  geography: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.5 3.6 5.6 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.6-3.6-9S9.6 5.5 12 3z" />
    </>
  ),
  traffic: (
    <>
      <path d="M3 17l5.5-6 4 4L21 6" />
      <path d="M15.5 6H21v5.5" />
    </>
  ),
  pages: (
    <>
      <path d="M6 3h8l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <path d="M14 3v5h5M8.5 13h7M8.5 17h5" />
    </>
  ),
  funnels: <path d="M3.5 4.5h17l-6.5 8v7l-4 2v-9z" />,
  events: (
    <>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21" />
    </>
  ),
  campaigns: (
    <>
      <path d="M4 9v6h3.5l6 4V5l-6 4H4z" />
      <path d="M17.5 8.5a5 5 0 010 7" />
    </>
  ),
  creators: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M10.5 9.5l5 2.5-5 2.5z" />
    </>
  ),
  brands: (
    <>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M9.5 20v-6h5v6" />
    </>
  ),
  audit: (
    <>
      <path d="M7 3h10a1 1 0 011 1v16a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <path d="M9.5 8h5M9.5 12h5M9.5 16h3" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.8" />
      <rect x="3" y="13" width="18" height="7" rx="1.8" />
      <path d="M6.5 7.5h.01M6.5 16.5h.01" />
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
