import "server-only";

import { getWhopEnvironment } from "./whop-payments";

/* ==========================================================================
   PUBLIC APP URL — server only.

   Where a payment provider sends a buyer back. It has to be an absolute URL
   the provider's servers can reach, which localhost is not, so this cannot be
   derived from the request and cannot be guessed.

   FAIL CLOSED, and specifically: no localhost fallback and no invented domain.
   A checkout that quietly redirects to `http://localhost:3000` after a real
   payment strands the buyer; a checkout that redirects to a domain nobody
   configured is worse. Both are refused before a provider object is created.

   Not `NEXT_PUBLIC_`: the browser never needs it. Every absolute URL built
   from it is assembled on the server, and a client that wants its own origin
   already has `window.location`.
   ========================================================================== */

export type AppUrlResult =
  | { ok: true; origin: string }
  | { ok: false; reason: "missing" | "not_absolute" | "not_https" | "local_host" | "tunnel_in_production" };

/**
 * Hosts that are a developer's machine by another name. A provider cannot
 * reach any of them, so accepting one would produce a checkout that looks
 * configured and breaks at the redirect.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * Tunnel providers. Perfect for sandbox, never right for production: a
 * production redirect through a URL that changes when someone restarts a
 * terminal is a production outage waiting to happen.
 */
const TUNNEL_SUFFIXES = [
  ".ngrok-free.dev",
  ".ngrok-free.app",
  ".ngrok.io",
  ".ngrok.app",
  ".trycloudflare.com",
  ".loca.lt",
  ".serveo.net",
];

function isTunnel(hostname: string): boolean {
  return TUNNEL_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Resolves the public origin, or says exactly why it cannot.
 *
 * Returns an ORIGIN — scheme and host only, no path and no trailing slash — so
 * callers concatenate a known-shaped string rather than guessing whether to
 * add a separator.
 */
export function resolveAppPublicUrl(
  env: Record<string, string | undefined> = process.env,
  environment: "sandbox" | "production" | null = getWhopEnvironment(env),
): AppUrlResult {
  const raw = env.APP_PUBLIC_URL?.trim();
  if (!raw) return { ok: false, reason: "missing" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_absolute" };
  }

  // HTTPS only. A provider redirect carries a session back across the public
  // internet, and browsers strip a referrer on an https→http downgrade anyway.
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };

  const hostname = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname)) return { ok: false, reason: "local_host" };

  // A tunnel is the right answer in sandbox and the wrong one in production.
  if (environment === "production" && isTunnel(hostname)) {
    return { ok: false, reason: "tunnel_in_production" };
  }

  return { ok: true, origin: url.origin };
}

/** The origin, or null. Callers must treat null as "cannot build a return URL". */
export function getAppPublicUrl(env: Record<string, string | undefined> = process.env): string | null {
  const result = resolveAppPublicUrl(env);
  return result.ok ? result.origin : null;
}

export function isAppPublicUrlConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return resolveAppPublicUrl(env).ok;
}

/** Locales a return URL may be built for. A closed set, so a path cannot be injected. */
const LOCALES = new Set(["en", "he"]);

/**
 * The URL Whop returns a buyer to after a redirect-based payment.
 *
 * The locale is preserved so a Hebrew buyer does not land on an English page,
 * and it is checked against the closed set above rather than interpolated —
 * an unrecognised value falls back to `en` instead of becoming a path segment.
 *
 * `order_id` is OUR id, and the page it lands on re-loads the order from the
 * database. Nothing in this URL is treated as proof of anything.
 */
export function buildCheckoutReturnUrl(
  orderId: string,
  locale: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const origin = getAppPublicUrl(env);
  if (!origin) return null;
  const safeLocale = LOCALES.has(locale) ? locale : "en";
  return `${origin}/${safeLocale}/checkout/sandbox/complete?order_id=${encodeURIComponent(orderId)}`;
}
