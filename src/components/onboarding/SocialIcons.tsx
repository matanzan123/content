import type { SocialPlatform } from "./types";

const PATHS: Record<SocialPlatform, React.ReactNode> = {
  YouTube: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="4.5" fill="currentColor" />
      <path d="M10.2 9.1l5 2.9-5 2.9V9.1z" fill="#fff" />
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
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5.2" fill="currentColor" />
      <circle cx="12" cy="12" r="3.9" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="16.9" cy="7.1" r="1.15" fill="#fff" />
    </>
  ),
  X: (
    <path
      d="M17.2 3h3.1l-6.8 7.8L21.5 21h-6.2l-4.9-6.4L4.7 21H1.6l7.3-8.3L2 3h6.4l4.4 5.8L17.2 3zm-1.1 16.1h1.7L7.9 4.8H6.1l10 14.3z"
      fill="currentColor"
    />
  ),
  Facebook: (
    <>
      <circle cx="12" cy="12" r="9.2" fill="currentColor" />
      <path
        d="M13.4 21.1v-6.5h2.2l.4-2.6h-2.6v-1.6c0-.7.2-1.2 1.3-1.2h1.4V6.9a17 17 0 0 0-2-.1c-2 0-3.4 1.2-3.4 3.5V12H8.5v2.6h2.2v6.5h2.7z"
        fill="#fff"
      />
    </>
  ),
};

export function SocialIcon({ platform }: { platform: SocialPlatform }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {PATHS[platform]}
    </svg>
  );
}

export function WhopMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.6 7.4h3.6l2.3 6 2.3-6h3.4l-4.3 10.2H6.9L2.6 7.4zM13.2 7.4h3.6l2.3 6 2.3-6h.9l-4.6 10.2h-3.1L13.2 7.4z"
        fill="currentColor"
      />
    </svg>
  );
}
