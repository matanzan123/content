import "server-only";

import type { AnalyticsEvent, ClientEvent, DeviceCategory, UserType } from "./schema";

/* ==========================================================================
   SERVER-SIDE EVENT ENRICHMENT

   Everything a visitor could lie about is decided here, not accepted from the
   request body: country, device, browser, referrer host, and identity.

   PRIVACY: the raw IP is never read into a stored field. Geography comes from
   a header the hosting platform attaches after it has already seen the IP, so
   we get a country without ever holding the address ourselves. No external
   geolocation service is called.
   ========================================================================== */

/**
 * Trusted geo headers, in priority order. These are set by the edge before the
 * request reaches application code; a client-supplied copy cannot override
 * them on Vercel or Cloudflare. On a platform that sets neither, country stays
 * null and the dashboard reports "unknown" rather than guessing.
 */
const COUNTRY_HEADERS = ["x-vercel-ip-country", "cf-ipcountry"] as const;
const REGION_HEADERS = ["x-vercel-ip-country-region", "cf-region-code"] as const;

function readFirstHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value && value !== "XX") return value;
  }
  return null;
}

/** ISO 3166-1 alpha-2 only, so a malformed header cannot widen the field. */
function normaliseCountry(value: string | null): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function normaliseRegion(value: string | null): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(code) ? code : null;
}

/**
 * Coarse device class from client hints where available, falling back to a
 * narrow user-agent test. The full user-agent string is never stored — it is
 * high-entropy enough to help fingerprint a visitor.
 */
function deviceCategory(headers: Headers): DeviceCategory {
  const mobileHint = headers.get("sec-ch-ua-mobile");
  if (mobileHint === "?1") return "mobile";

  const ua = headers.get("user-agent") ?? "";
  if (!ua) return "unknown";
  if (/\bTablet\b|\biPad\b/i.test(ua)) return "tablet";
  if (/\bMobi|Android.*Mobile|iPhone|iPod\b/i.test(ua)) return "mobile";
  if (mobileHint === "?0") return "desktop";
  return /Macintosh|Windows NT|X11|CrOS/i.test(ua) ? "desktop" : "unknown";
}

/** Browser family only — a closed list, so nothing unexpected is stored. */
function browserFamily(headers: Headers): string | null {
  const ua = headers.get("user-agent") ?? "";
  if (!ua) return null;
  if (/\bEdg\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bFirefox\//.test(ua)) return "Firefox";
  if (/\bChrome\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua)) return "Safari";
  return "Other";
}

/**
 * Referrer HOST, never the full URL. A referring URL's path and query can
 * carry someone else's personal data, and we have no use for it.
 */
function referrerHost(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.length > 253 ? null : host;
  } catch {
    return null;
  }
}

/** UTM values are attacker-controlled; clamp hard and keep them opaque. */
function utm(value: string | null): string | null {
  if (!value) return null;
  const clean = value.trim().slice(0, 64);
  return /^[\w.\-+% ]+$/.test(clean) ? clean : null;
}

export type EnrichContext = {
  headers: Headers;
  /** Verified uid, or null. Never taken from the request body. */
  userId: string | null;
  userType: UserType;
  /** Whether the browser reported having no prior visitor id. */
  isNewVisitor: boolean;
  /** Query string of the page the event happened on, for UTM extraction. */
  search?: string;
};

export function enrichEvent(client: ClientEvent, ctx: EnrichContext): AnalyticsEvent {
  const params = new URLSearchParams(ctx.search ?? "");
  return {
    ...client,
    event_id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    is_new_visitor: ctx.isNewVisitor,
    user_id: ctx.userId,
    user_type: ctx.userType,
    country: normaliseCountry(readFirstHeader(ctx.headers, COUNTRY_HEADERS)),
    region: normaliseRegion(readFirstHeader(ctx.headers, REGION_HEADERS)),
    device_category: deviceCategory(ctx.headers),
    browser_family: browserFamily(ctx.headers),
    referrer_host: referrerHost(ctx.headers.get("referer")),
    utm_source: utm(params.get("utm_source")),
    utm_medium: utm(params.get("utm_medium")),
    utm_campaign: utm(params.get("utm_campaign")),
    utm_content: utm(params.get("utm_content")),
    utm_term: utm(params.get("utm_term")),
  };
}
