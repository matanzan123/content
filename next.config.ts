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

/**
 * CSP directive list.
 *
 * script-src uses 'unsafe-inline' because Next.js App Router embeds inline
 * hydration scripts that cannot yet be covered by a per-request nonce without
 * middleware changes. The other directives still block object injection,
 * base-tag hijacking, and clickjacking, and restrict outbound connections.
 *
 * When nonce-based CSP is added, remove 'unsafe-inline' from script-src and
 * thread the nonce through the middleware → layout chain.
 */
const isDev = process.env.NODE_ENV !== "production";

const CSP = [
  "default-src 'self'",
  // React dev mode needs eval for callstack reconstruction; never in production.
  // apis.google.com: Firebase signInWithPopup loads gapi from there.
  `script-src 'self' 'unsafe-inline' https://apis.google.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // googleusercontent: Google account avatars (Firebase photoURL).
  "img-src 'self' data: blob: https://i.pravatar.cc https://picsum.photos https://*.googleusercontent.com",
  `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com https://apis.google.com${isDev ? " ws: wss:" : ""}`,
  // firebaseapp.com: Firebase Auth iframe. whop.com: checkout embed iframe.
  "frame-src https://*.firebaseapp.com https://accounts.google.com https://apis.google.com https://whop.com https://*.whop.com",
  "object-src 'none'",
  "base-uri 'self'",
  // Preferred over X-Frame-Options in modern browsers; both are set for compatibility.
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "picsum.photos" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Belt-and-suspenders with frame-ancestors in CSP; covers older browsers.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Allows the Firebase Auth Google Sign-In popup to communicate back.
          // same-origin would silently break the Google popup flow.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Content-Security-Policy", value: CSP },
          // HSTS: only meaningful over HTTPS, so skip in dev where secure: false.
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
