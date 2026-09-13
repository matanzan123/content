import "server-only";

import { createHash, randomBytes } from "node:crypto";

/* ==========================================================================
   WHOP OAUTH 2.1 / OIDC — server only.

   This replaces a legacy flow that had no PKCE, no nonce, targeted the retired
   `api/v5` endpoints, and — most importantly — was not tied to a signed-in
   ClipRewards user at all. Anyone could start it, and what came back was a
   username in a cookie belonging to nobody.

   THIS IS LINKING, NOT LOGIN. Firebase decides who someone is. A completed
   flow here records that the signed-in user also controls a Whop identity, and
   nothing more. No code path turns a Whop token into a ClipRewards session.

   ENDPOINTS ARE ENVIRONMENT-SPECIFIC, and this module used to claim otherwise.
   Whop serves OAuth from a sandbox host as well as a production one, and AN
   APP EXISTS IN EXACTLY ONE OF THEM: an app created at sandbox.whop.com is
   unknown to the production host, which refuses its client_id outright. The
   host is therefore resolved from `WHOP_ENV`, the same variable and the same
   two names the payments client uses, so identity and money cannot end up
   pointed at different environments.
   ========================================================================== */

/**
 * The only two environments that exist, and the only two OAuth hosts.
 *
 * Mirrors `WHOP_API_BASE_URLS` in `whop-payments.ts` deliberately: one pattern
 * for every Whop host in the codebase, and no implicit production default.
 */
export const WHOP_OAUTH_BASE_URLS = {
  sandbox: "https://sandbox-api.whop.com/oauth",
  production: "https://api.whop.com/oauth",
} as const;

export type WhopOAuthEnvironment = keyof typeof WHOP_OAUTH_BASE_URLS;

export type WhopOAuthEndpoints = {
  authorize: string;
  token: string;
  userinfo: string;
  revoke: string;
};

/** All four endpoints from one base, so none can be left on another host. */
export function whopOAuthEndpoints(environment: WhopOAuthEnvironment): WhopOAuthEndpoints {
  const base = WHOP_OAUTH_BASE_URLS[environment];
  return {
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    userinfo: `${base}/userinfo`,
    revoke: `${base}/revoke`,
  };
}

/**
 * The only scopes this application asks for.
 *
 * `openid` for the subject, `profile` for a display handle, `email` because
 * Whop returns it with that scope — but see `WhopIdentity`: the email is never
 * stored and never used to match a user. Kept minimal deliberately; a browser
 * cannot widen it, because it is a constant here rather than a parameter.
 */
export const WHOP_OAUTH_SCOPES = "openid profile email";

type Env = Record<string, string | undefined>;

export type OAuthConfig = {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  /** Which Whop the app lives in. Never defaulted. */
  environment: WhopOAuthEnvironment;
  /** Resolved from `environment`, so every call uses one host. */
  endpoints: WhopOAuthEndpoints;
};

export type ConfigResult =
  | { ok: true; config: OAuthConfig }
  | {
      ok: false;
      reason:
        | "missing_client_id"
        | "missing_redirect_uri"
        | "invalid_redirect_uri"
        | "missing_environment"
        | "invalid_environment";
    };

/**
 * Reads OAuth configuration.
 *
 * `client_secret` is OPTIONAL: with PKCE the token exchange does not require
 * it, and a public-client flow avoids keeping a long-lived secret at all. It
 * is still read and sent when present, because a confidential client that
 * omits it would be rejected.
 *
 * The redirect URI must be absolute HTTPS and must match what is registered
 * with Whop exactly — it is read from configuration, never from a request, so
 * an open-redirect through this parameter is not expressible.
 */
export function resolveOAuthConfig(env: Env = process.env): ConfigResult {
  const clientId = env.WHOP_CLIENT_ID?.trim();
  if (!clientId) return { ok: false, reason: "missing_client_id" };

  const redirectUri = env.WHOP_REDIRECT_URI?.trim();
  if (!redirectUri) return { ok: false, reason: "missing_redirect_uri" };

  try {
    const url = new URL(redirectUri);
    // Whop redirects a browser here after consent; http would strip the
    // authorization code's confidentiality in transit.
    if (url.protocol !== "https:") return { ok: false, reason: "invalid_redirect_uri" };
  } catch {
    return { ok: false, reason: "invalid_redirect_uri" };
  }

  /*
   * The environment is matched EXACTLY against the two known names, and its
   * absence is a refusal rather than an implied production. Guessing here is
   * how a sandbox app ends up asking the live host to recognise it — which is
   * precisely the `client_id is invalid` this rule now prevents.
   */
  const environment = env.WHOP_ENV?.trim();
  if (!environment) return { ok: false, reason: "missing_environment" };
  if (environment !== "sandbox" && environment !== "production") {
    return { ok: false, reason: "invalid_environment" };
  }

  const clientSecret = env.WHOP_CLIENT_SECRET?.trim() || null;
  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      redirectUri,
      environment,
      endpoints: whopOAuthEndpoints(environment),
    },
  };
}

export function isOAuthConfigured(env: Env = process.env): boolean {
  return resolveOAuthConfig(env).ok;
}

/* ------------------------------- PKCE ------------------------------------ */

/** Base64url without padding, as RFC 7636 requires. */
function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A code verifier: 43–128 characters of unreserved ASCII. 32 random bytes
 * base64url-encode to 43, the minimum the spec allows and ample entropy.
 */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/**
 * S256 only. The `plain` method exists in the spec and is worthless — it
 * offers no protection if the authorization request is observed — so it is not
 * implemented here at all rather than being available to select.
 */
export function codeChallengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** State and nonce: 32 random bytes each, from the CSPRNG. */
export function createRandomToken(): string {
  return base64url(randomBytes(32));
}

/* ==========================================================================
   A NOTE ON `nonce`, AND WHAT IT DOES NOT DO HERE.

   The authorization request below sends a `nonce`, because Whop documents it
   as a parameter of the authorize call. It buys this application NOTHING, and
   pretending otherwise would be worse than omitting it.

   A nonce defends one thing: an id_token replayed into a client that trusts
   the token's contents. This flow never reads an id_token. Identity comes from
   a server-to-server call to `/oauth/userinfo`, made with an access token this
   server obtained itself moments earlier — there is no client-side assertion
   to replay, so there is nothing for a nonce to bind.

   What actually protects this flow is elsewhere: PKCE binds the code to this
   client, and the one-time `state` row binds the callback to the user and the
   browser that started it.

   It is therefore generated fresh per request and NOT stored: keeping it in
   the database would imply a verification step that does not exist. If a
   future change starts consuming an id_token, that change must verify the
   signature, issuer, audience and expiry AND compare the nonce — and must
   store it here to do so. Decoding a JWT without verifying it is not
   verification.
   ========================================================================== */

/**
 * Builds the authorization URL.
 *
 * Every security-relevant parameter is fixed by the server: client id, scopes
 * and redirect URI come from configuration; state, nonce and the challenge are
 * freshly generated. The caller supplies none of them, so there is no
 * parameter a browser can influence.
 */
export function buildAuthorizeUrl(input: {
  config: OAuthConfig;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.config.endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("scope", WHOP_OAUTH_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/* --------------------------- token exchange ------------------------------ */

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds from now. Whop issues one-hour access tokens. */
  expiresIn: number | null;
  scope: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: "provider_rejected" | "malformed_response" | "network_error" };

function readTokenSet(body: unknown): TokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || b.access_token.length === 0) return null;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null,
    expiresIn: typeof b.expires_in === "number" ? b.expires_in : null,
    scope: typeof b.scope === "string" ? b.scope : null,
  };
}

/**
 * Exchanges an authorization code for tokens.
 *
 * The code verifier proves this is the same client that started the flow, so a
 * code stolen from the redirect is useless without it — which is the whole
 * point of PKCE.
 *
 * Failures are categories. A provider error body can quote the request, and
 * the request carries the code and the verifier.
 */
export async function exchangeCode(input: {
  config: OAuthConfig;
  code: string;
  codeVerifier: string;
}): Promise<ExchangeResult> {
  const payload: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.config.redirectUri,
    client_id: input.config.clientId,
    code_verifier: input.codeVerifier,
  };
  if (input.config.clientSecret) payload.client_secret = input.config.clientSecret;

  let response: Response;
  try {
    response = await fetch(input.config.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) return { ok: false, reason: "provider_rejected" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed_response" };
  }

  const tokens = readTokenSet(body);
  return tokens ? { ok: true, tokens } : { ok: false, reason: "malformed_response" };
}

/**
 * Refreshes an access token.
 *
 * Whop ROTATES refresh tokens: the response carries a new one and the old
 * stops working. A caller must therefore persist the new token in the same
 * operation that uses it, and must not run two refreshes for one connection
 * concurrently — the loser would persist a token the provider has already
 * retired. `whop-connections` serialises this with a row lock.
 */
export async function refreshTokens(input: {
  config: OAuthConfig;
  refreshToken: string;
}): Promise<ExchangeResult> {
  const payload: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
  };
  if (input.config.clientSecret) payload.client_secret = input.config.clientSecret;

  let response: Response;
  try {
    response = await fetch(input.config.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (!response.ok) return { ok: false, reason: "provider_rejected" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed_response" };
  }
  const tokens = readTokenSet(body);
  return tokens ? { ok: true, tokens } : { ok: false, reason: "malformed_response" };
}

/* ------------------------------ userinfo --------------------------------- */

/**
 * The identity we keep.
 *
 * `sub` is the whole point — it is provider-issued and stable, and it is the
 * only field this application joins on. A display handle is kept for the UI.
 *
 * THE EMAIL IS DELIBERATELY ABSENT from this type. Whop returns one with the
 * `email` scope, and reading it into a field would invite someone to match on
 * it later. The Firebase email and the Whop email are allowed to differ, and
 * neither establishes ownership of anything.
 */
export type WhopIdentity = {
  sub: string;
  username: string | null;
};

export type UserinfoResult =
  | { ok: true; identity: WhopIdentity }
  | { ok: false; reason: "provider_rejected" | "malformed_response" | "network_error" };

export async function fetchUserinfo(input: {
  config: OAuthConfig;
  accessToken: string;
}): Promise<UserinfoResult> {
  let response: Response;
  try {
    response = await fetch(input.config.endpoints.userinfo, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (!response.ok) return { ok: false, reason: "provider_rejected" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed_response" };
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const sub = typeof b.sub === "string" ? b.sub.trim() : "";
  if (!sub || sub.length > 255) return { ok: false, reason: "malformed_response" };

  const rawName = b.preferred_username ?? b.name;
  const username =
    typeof rawName === "string" && rawName.length > 0 && rawName.length <= 120 ? rawName : null;

  return { ok: true, identity: { sub, username } };
}

/**
 * Best-effort revocation at the provider.
 *
 * Reported but never blocking: a disconnect must succeed locally even if Whop
 * is unreachable, because the alternative is a user unable to unlink an
 * account they no longer control.
 */
export async function revokeToken(input: {
  config: OAuthConfig;
  token: string;
}): Promise<boolean> {
  try {
    const payload: Record<string, string> = {
      token: input.token,
      client_id: input.config.clientId,
    };
    if (input.config.clientSecret) payload.client_secret = input.config.clientSecret;

    const response = await fetch(input.config.endpoints.revoke, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}
