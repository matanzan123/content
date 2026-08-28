/**
 * Whop OAuth config. The repo ships without credentials, so every route checks
 * `isWhopConfigured` first and reports a setup hint instead of a 500.
 */
export const WHOP_AUTHORIZE_URL = "https://whop.com/oauth";
export const WHOP_TOKEN_URL = "https://api.whop.com/api/v5/oauth/token";
export const WHOP_ME_URL = "https://api.whop.com/api/v5/me";

export const WHOP_SCOPES = "openid profile email";

export const WHOP_SESSION_COOKIE = "cr_whop";
export const WHOP_STATE_COOKIE = "cr_whop_state";

export function whopConfig() {
  return {
    clientId: process.env.WHOP_CLIENT_ID ?? "",
    clientSecret: process.env.WHOP_CLIENT_SECRET ?? "",
    redirectUri: process.env.WHOP_REDIRECT_URI ?? "",
  };
}

export function isWhopConfigured() {
  const { clientId, clientSecret, redirectUri } = whopConfig();
  return Boolean(clientId && clientSecret && redirectUri);
}
