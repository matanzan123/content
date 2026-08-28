import type { Platform } from "@/data/campaigns";

/**
 * Single-colour glyphs. These sit on light chips in the creator realm and dark
 * chips in the brand realm, so they draw in `currentColor` only — no knocked-out
 * shapes that would need to match the background.
 */
const PATHS: Record<Platform, React.ReactNode> = {
  YouTube: (
    <>
      <rect x="2.6" y="5.4" width="18.8" height="13.2" rx="4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.4 9.4l4.7 2.6-4.7 2.6V9.4z" fill="currentColor" />
    </>
  ),
  TikTok: (
    <path
      d="M13.6 3h2.5c.2 1.8 1.3 3.2 3.1 3.5v2.6a6.4 6.4 0 0 1-3.1-.9v5.5a5.2 5.2 0 1 1-5.2-5.2c.3 0 .5 0 .8.1v2.7a2.6 2.6 0 1 0 1.9 2.5V3z"
      fill="currentColor"
    />
  ),
  Instagram: (
    <>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.7" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.8" cy="7.2" r="1.1" fill="currentColor" />
    </>
  ),
  X: (
    <path
      d="M17.2 3h3.1l-6.8 7.8L21.5 21h-6.2l-4.9-6.4L4.7 21H1.6l7.3-8.3L2 3h6.4l4.4 5.8L17.2 3zm-1.1 16.1h1.7L7.9 4.8H6.1l10 14.3z"
      fill="currentColor"
    />
  ),
  Facebook: (
    <path
      d="M13.2 21v-8h2.4l.5-3h-2.9V8.4c0-.9.3-1.5 1.6-1.5h1.5V4.2A21 21 0 0 0 14 4c-2.3 0-3.8 1.4-3.8 3.9V10H7.7v3h2.5v8h3z"
      fill="currentColor"
    />
  ),
};

export function PlatformIcon({ platform, size = 16 }: { platform: Platform; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {PATHS[platform]}
    </svg>
  );
}
