import "server-only";

import { createHash, randomBytes } from "node:crypto";

/* ==========================================================================
   GOOGLE OAUTH — server only, for ONE internal account.

   This authorises the dedicated ClipRewards interview Google account, once,
   by an administrator. It is NOT a sign-in mechanism and never becomes one:
   nothing here produces a ClipRewards session, and the resulting tokens
   belong to the company, not to whoever happened to click Connect.

   SCOPE IS A CONSTANT, not a parameter. `calendar.events` is the narrowest
   scope that can create an event with a Meet conference; a browser cannot
   widen it because it is not read from anywhere a browser can reach.

   OFFLINE ACCESS is requested because the refresh token is the whole point —
   an interview booked on Friday must still get a calendar event on Monday
   without an administrator being present.
   ========================================================================== */

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** The only scope this integration asks for, ever. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export const GOOGLE_OAUTH_ENDPOINTS = {
  authorize: AUTH_BASE,
  token: TOKEN_ENDPOINT,
  revoke: REVOKE_ENDPOINT,
} as const;

type Env = Record<string, string | undefined>;

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleConfigResult =
  | { ok: true; config: GoogleOAuthConfig }
  | {
      ok: false;
      reason:
        | "missing_client_id"
        | "missing_client_secret"
        | "missing_redirect_uri"
        | "invalid_redirect_uri";
    };

/**
 * Reads the Google OAuth configuration.
 *
 * The redirect URI must be absolute HTTPS and must match what is registered
 * in the Google Cloud console character for character. It is read from
 * configuration and never from a request, so it cannot be steered.
 */
export function resolveGoogleOAuthConfig(env: Env = process.env): GoogleConfigResult {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  if (!clientId) return { ok: false, reason: "missing_client_id" };

  // Google's web-application client is confidential: the exchange is refused
  // without the secret, so a missing one is a refusal rather than a PKCE-style
  // fallback.
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  if (!clientSecret) return { ok: false, reason: "missing_client_secret" };

  const redirectUri = env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (!redirectUri) return { ok: false, reason: "missing_redirect_uri" };
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:") return { ok: false, reason: "invalid_redirect_uri" };
  } catch {
    return { ok: false, reason: "invalid_redirect_uri" };
  }

  return { ok: true, config: { clientId, clientSecret, redirectUri } };
}

export function isGoogleOAuthConfigured(env: Env = process.env): boolean {
  return resolveGoogleOAuthConfig(env).ok;
}

/** 32 random bytes from the CSPRNG, base64url. */
export function createGoogleState(): string {
  return randomBytes(32).toString("base64url");
}

/** Used to name a conference request without echoing an identifier. */
export function stableRequestId(seed: string): string {
  return createHash("sha256").update(`cliprewards:meet:${seed}`).digest("hex").slice(0, 32);
}

/**
 * The URL an administrator is sent to.
 *
 * `access_type=offline` asks for a refresh token. `prompt=consent` forces
 * Google to ISSUE one: it omits the refresh token on a repeat authorisation
 * of an account that has already granted the scope, which is the single most
 * common way an integration ends up with an access token that expires in an
 * hour and nothing to renew it with.
 */
export function buildGoogleAuthorizeUrl(input: {
  config: GoogleOAuthConfig;
  state: string;
  /** True when a refresh token must be issued even on a re-authorisation. */
  forceConsent?: boolean;
}): string {
  const url = new URL(GOOGLE_OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "false");
  if (input.forceConsent !== false) url.searchParams.set("prompt", "consent");
  return url.toString();
}

export type GoogleTokenSet = {
  accessToken: string;
  /** Absent on a re-authorisation without `prompt=consent`. */
  refreshToken: string | null;
  expiresInSeconds: number | null;
  scope: string | null;
};

export type GoogleTokenResult =
  | { ok: true; tokens: GoogleTokenSet }
  | { ok: false; reason: "provider_rejected" | "invalid_grant" | "malformed_response" | "network_error" };

function readTokens(body: unknown): GoogleTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || b.access_token.length === 0) return null;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null,
    expiresInSeconds: typeof b.expires_in === "number" ? b.expires_in : null,
    scope: typeof b.scope === "string" ? b.scope : null,
  };
}

/**
 * POSTs to Google's token endpoint, form-encoded as the spec requires.
 *
 * `invalid_grant` is separated from every other refusal because it is
 * terminal: an expired, revoked or already-used grant will never succeed on a
 * retry, and the connection has to be re-established by a person.
 */
async function tokenRequest(params: Record<string, string>): Promise<GoogleTokenResult> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_ENDPOINTS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    return { ok: false, reason: error === "invalid_grant" ? "invalid_grant" : "provider_rejected" };
  }

  const tokens = readTokens(body);
  return tokens ? { ok: true, tokens } : { ok: false, reason: "malformed_response" };
}

export async function exchangeGoogleCode(input: {
  config: GoogleOAuthConfig;
  code: string;
}): Promise<GoogleTokenResult> {
  return tokenRequest({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
  });
}

/**
 * Exchanges the refresh token for a new access token.
 *
 * Google does NOT rotate refresh tokens on this grant, so unlike the Whop
 * flow there is no new credential to persist — only the access token and its
 * expiry. The stored refresh token is left exactly as it is.
 */
export async function refreshGoogleAccessToken(input: {
  config: GoogleOAuthConfig;
  refreshToken: string;
}): Promise<GoogleTokenResult> {
  return tokenRequest({
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
  });
}

/** Best effort, and never blocking: a disconnect must work offline too. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(GOOGLE_OAUTH_ENDPOINTS.revoke, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
