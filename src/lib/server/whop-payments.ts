import "server-only";

import { WhopClient } from "@whop/sdk";

/* ==========================================================================
   WHOP PAYMENTS — server only.

   This is the ONE place the marketplace's money credentials are read. It
   covers payments, refunds and creator payouts.

   It is NOT the creator account-linking flow. That is Whop OAuth, lives in
   `src/lib/whop.ts`, uses a different credential entirely
   (WHOP_CLIENT_ID / WHOP_CLIENT_SECRET / WHOP_REDIRECT_URI) and its own
   cookies. The two must not be conflated: an OAuth client id identifies our
   app to a creator, while the company API key below can act AS the company.

   `server-only` makes an import from a client component a build error, so the
   API key can never reach a browser bundle.

   FAIL CLOSED. Every unresolved or malformed value returns a reason and no
   client at all. Nothing here falls back to a default, and in particular
   nothing falls back to production — see `WHOP_API_BASE_URLS`.
   ========================================================================== */

/**
 * The only two environments that exist, and the only two base URLs.
 *
 * This map is the isolation boundary. The SDK's own default is production
 * (`https://api.whop.com/api/v1`), and it is applied whenever neither
 * `baseUrl` nor `environment` is passed to the client — so a caller who
 * forgets silently moves real money. `getWhopPaymentsClient` therefore always
 * passes an explicit `baseUrl` resolved from here, never relying on the SDK
 * default.
 */
export const WHOP_API_BASE_URLS = {
  sandbox: "https://sandbox-api.whop.com/api/v1",
  production: "https://api.whop.com/api/v1",
} as const;

export type WhopEnvironmentName = keyof typeof WHOP_API_BASE_URLS;

export type WhopPaymentsConfig = {
  environment: WhopEnvironmentName;
  /** Resolved from `WHOP_API_BASE_URLS`. Always explicit, never a default. */
  baseUrl: string;
  companyId: string;
};

/**
 * Why payments are unavailable. Each value is safe to log and safe to show an
 * administrator: none of them can carry a credential.
 */
export type WhopPaymentsUnavailable =
  | "missing_api_key"
  | "missing_company_id"
  | "missing_environment"
  | "invalid_environment"
  | "invalid_company_id";

export type WhopPaymentsState =
  | { ok: true; config: WhopPaymentsConfig }
  | { ok: false; reason: WhopPaymentsUnavailable };

/** Whop company identifiers are prefixed. A value without it is a mistake. */
const COMPANY_ID_PREFIX = "biz_";

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the payments configuration, or says precisely why it cannot.
 *
 * Pure and env-injectable so the rules below can be asserted without touching
 * the real process environment.
 *
 * `WHOP_ENV` is matched EXACTLY against the two known names. A typo like
 * "Production" or "sandbox " is rejected rather than normalised: guessing what
 * an operator meant is how a test key ends up pointed at a live company. An
 * absent value is likewise a refusal, never an implied production.
 */
export function resolveWhopPayments(env: Env = process.env): WhopPaymentsState {
  const apiKey = read(env, "WHOP_API_KEY");
  const companyId = read(env, "WHOP_COMPANY_ID");
  const environment = read(env, "WHOP_ENV");

  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!companyId) return { ok: false, reason: "missing_company_id" };
  if (!environment) return { ok: false, reason: "missing_environment" };

  if (environment !== "sandbox" && environment !== "production") {
    return { ok: false, reason: "invalid_environment" };
  }

  if (!companyId.startsWith(COMPANY_ID_PREFIX) || companyId.length <= COMPANY_ID_PREFIX.length) {
    return { ok: false, reason: "invalid_company_id" };
  }

  return {
    ok: true,
    config: {
      environment,
      baseUrl: WHOP_API_BASE_URLS[environment],
      companyId,
    },
  };
}

/**
 * True when a payments call could be made at all. Report-only — never a reason
 * to skip a check, and never a claim that Whop actually answered. Proving the
 * credentials work takes a request.
 *
 * Deliberately distinct from `isWhopConfigured()` in `src/lib/whop.ts`, which
 * answers the same question about creator OAuth and is unaffected by this.
 */
export function isWhopPaymentsConfigured(env: Env = process.env): boolean {
  return resolveWhopPayments(env).ok;
}

/** The active environment, or null when configuration is unusable. */
export function getWhopEnvironment(env: Env = process.env): WhopEnvironmentName | null {
  const state = resolveWhopPayments(env);
  return state.ok ? state.config.environment : null;
}

/** The configured company id, or null. Not a secret, but not a default either. */
export function getWhopCompanyId(env: Env = process.env): string | null {
  const state = resolveWhopPayments(env);
  return state.ok ? state.config.companyId : null;
}

let cached: { baseUrl: string; client: WhopClient } | null = null;

/**
 * The payments client, or null when configuration is unusable.
 *
 * Null is the honest answer and callers must treat it as "payments are not
 * available" — never as an empty result. Cached per base URL so a process can
 * never keep serving a client built for the other environment.
 */
export function getWhopPaymentsClient(env: Env = process.env): WhopClient | null {
  const state = resolveWhopPayments(env);
  if (!state.ok) return null;

  const apiKey = read(env, "WHOP_API_KEY");
  if (!apiKey) return null;

  if (cached && cached.baseUrl === state.config.baseUrl) return cached.client;

  const client = new WhopClient({
    token: apiKey,
    // Explicit, always. Omitting this hands the request to the SDK's
    // production default.
    baseUrl: state.config.baseUrl,
  });
  cached = { baseUrl: state.config.baseUrl, client };
  return client;
}

/**
 * The endpoint signing secret for inbound webhooks, or null.
 *
 * A SEPARATE credential from the API key: the key authenticates calls we make
 * outward, this proves a delivery came from Whop. Neither substitutes for the
 * other, and an endpoint with no secret can verify nothing — so callers must
 * treat null as "reject every delivery", never as "skip verification".
 */
export function getWhopWebhookSecret(env: Env = process.env): string | null {
  return read(env, "WHOP_WEBHOOK_SECRET");
}

/** Whether inbound deliveries can be verified at all. Report-only. */
export function isWhopWebhookConfigured(env: Env = process.env): boolean {
  return getWhopWebhookSecret(env) !== null;
}

/**
 * Removes every Whop credential from any text before it is logged or surfaced.
 *
 * An SDK error can quote a request, and a request carries an Authorization
 * header; a verification error can quote a signing secret. One careless
 * `console.error(error)` is all it takes to write a live credential into a log
 * aggregator that a much wider group can read.
 */
export function redactWhopSecrets(text: string, env: Env = process.env): string {
  let out = text;
  for (const name of ["WHOP_API_KEY", "WHOP_WEBHOOK_SECRET"]) {
    const secret = read(env, name);
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * A message safe to log for a failed Whop call: the error's own text with any
 * credential removed, and nothing else from the response body.
 */
export function describeWhopError(error: unknown, env: Env = process.env): string {
  const raw = error instanceof Error ? error.message : "unknown error";
  return redactWhopSecrets(raw, env);
}
