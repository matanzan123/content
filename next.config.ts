import type { NextConfig } from "next";

/**
 * Origins allowed to request dev-only assets.
 *
 * Next blocks cross-origin requests to `/_next/*` in development by default.
 * Serving the dev server through a tunnel trips that: the HTML renders (it is
 * a normal page request) but every JS chunk comes back 403, so React never
 * hydrates and the page is a screenshot — buttons present, nothing happens,
 * and no error the user can see.
 *
 * The host is derived from APP_PUBLIC_URL rather than hardcoded, so rotating
 * the tunnel needs no code change, and an unset or malformed value simply
 * allows nothing extra. This affects development only; production serves
 * static assets normally and ignores it.
 */
function devOrigins(): string[] {
  const raw = process.env.APP_PUBLIC_URL?.trim();
  if (!raw) return [];
  try {
    const { hostname } = new URL(raw);
    return hostname ? [hostname] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "picsum.photos" },
    ],
  },
};

export default nextConfig;
