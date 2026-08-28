import Link from "next/link";
import type { Role } from "./RoleToggle";

const NAV = [
  { label: "Discover", href: "/discover" },
  { label: "Become a Creator", href: "/onboarding?type=creator" },
  { label: "For Brands", href: "/brand" },
  { label: "Blog", href: "/blog" },
];

const PAGES = [
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Service", href: "/terms" },
  { label: "Brand Kit", href: "/brand-kit" },
  { label: "Careers", href: "/careers" },
];

const SOCIALS = [
  { label: "X", href: "https://x.com" },
  { label: "Instagram", href: "https://instagram.com" },
  { label: "Discord", href: "https://discord.com" },
];

function SocialIcon({ label }: { label: string }) {
  const paths: Record<string, React.ReactNode> = {
    X: <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
    Instagram: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="16.6" cy="7.4" r="1" fill="currentColor" />
      </>
    ),
    Discord: <path d="M6 16C6 16 8 17.5 12 17.5C16 17.5 18 16 18 16M8 9.5C8 9.5 9 9 12 9C15 9 16 9.5 16 9.5M6 8C6 8 6.5 6 8 5.5C8 5.5 9 5 12 5C15 5 16 5.5 16 5.5C17.5 6 18 8 18 8C19 10 19 15 18 17C18 17 16.5 18.5 14.5 18.5L13.5 16.5M6 8C5 10 5 15 6 17C6 17 7.5 18.5 9.5 18.5L10.5 16.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  };
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-ink-inverse transition-colors hover:bg-white/20">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        {paths[label]}
      </svg>
    </span>
  );
}

export function Footer({ role }: { role: Role }) {
  const isBrand = role === "brand";
  const cta = isBrand ? { label: "Launch a Campaign", href: "/onboarding?type=brand" } : { label: "Become a Creator", href: "/onboarding?type=creator" };
  const description = isBrand
    ? "Launch campaigns, discover creators, and pay only for verified results — trusted by 200+ growing brands scaling organic reach."
    : "Create, post, and get paid for content that performs — trusted by tens of thousands of creators and hundreds of growing brands.";

  return (
    <footer className="relative overflow-hidden bg-surface-inverse pt-20">
      <div className="relative mx-auto max-w-[1240px] px-6">
        <div className="grid grid-cols-1 gap-12 pb-16 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent text-white">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M4 12L10 6M4 12L10 18M4 12H20" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="font-[var(--font-display)] text-[13px] font-extrabold uppercase leading-[1.05] tracking-tight text-ink-inverse">
                Clip
                <br />
                Rewards
              </span>
            </div>
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-ink-inverse-soft">
              {description}
            </p>
            <Link
              href={cta.href}
              className="mt-5 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-white px-5 py-2.5 text-[13px] font-bold text-ink transition-colors hover:bg-white/90"
            >
              {cta.label}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <div className="mt-6 flex gap-2">
              {SOCIALS.map((s) => (
                <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label}>
                  <SocialIcon label={s.label} />
                </a>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-inverse-soft">Navigation</p>
            <ul className="mt-4 space-y-2.5">
              {NAV.map((item) => (
                <li key={item.label}>
                  <Link href={item.href} className="text-[13.5px] text-ink-inverse-soft transition-colors hover:text-ink-inverse">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-inverse-soft">Pages</p>
            <ul className="mt-4 space-y-2.5">
              {PAGES.map((item) => (
                <li key={item.label}>
                  <Link href={item.href} className="text-[13.5px] text-ink-inverse-soft transition-colors hover:text-ink-inverse">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-inverse-soft">Status</p>
            <div className="mt-4 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-[13.5px] text-ink-inverse-soft">All systems operational</span>
            </div>
            <p className="mt-4 text-[13.5px] text-ink-inverse-soft">
              {isBrand ? "180+ campaigns live right now" : "6,200+ creators active right now"}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-start justify-between gap-3 border-t border-white/10 py-6 sm:flex-row sm:items-center">
          <p className="text-[12.5px] text-ink-inverse-soft">© {new Date().getFullYear()} ClipRewards. All rights reserved.</p>
          <p className="text-[12.5px] text-ink-inverse-soft">Placeholder branding — independent build, not affiliated with any third party.</p>
        </div>
      </div>

      <div className="relative select-none overflow-hidden" style={{ height: 140 }}>
        <p
          className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap font-[var(--font-display)] font-black tracking-tight"
          style={{
            fontSize: "min(15vw, 180px)",
            background: "linear-gradient(90deg, var(--accent-violet), var(--accent), var(--accent-cyan))",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            opacity: 0.9,
          }}
        >
          CLIPREWARDS
        </p>
      </div>
    </footer>
  );
}
