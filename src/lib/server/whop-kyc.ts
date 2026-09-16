import "server-only";

import { resolvePlatformConfig, type PlatformConfig } from "./whop-accounts";

/* ==========================================================================
   WHOP KYC / ONBOARDING — server only.

   Two responsibilities:
     1. Fetching the KYC / verification state of a connected account from Whop.
     2. Creating a short-lived, Whop-hosted onboarding link so the creator can
        complete KYC without us ever handling identity documents.

   THE LINK ENDPOINT: Whop's SDK examples and Platforms documentation use
   `company_id` to identify the account being onboarded. The generic Account
   Links reference also mentions `account_id`. This module tries `company_id`
   first (the SDK-documented form), and retries with `account_id` only when
   Whop's response explicitly names `company_id` as the rejected field. A
   generic 400 is NOT retried — it would mean the request body has a different
   problem, and a blind retry would not help.

   THE RETURN URL IS NEVER TREATED AS PROOF. The caller decides what happens
   when the creator lands back on our page; this module only mints the URL.
   ========================================================================== */

const API_VERSION_DATE = "2026-09-02-1";

/* -------------------------------------------------------------------------
   Raw HTTP helper — private to this module
   ------------------------------------------------------------------------- */

type RawResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; errorCode: string | null; errorField: string | null };

async function call(
  config: PlatformConfig,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<RawResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        "Api-Version-Date": API_VERSION_DATE,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, errorCode: "network_error", errorField: null };
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const err = (parsed as { error?: { code?: unknown; type?: unknown; param?: unknown; field?: unknown } } | null)?.error;
    const errorCode =
      typeof err?.code === "string" ? err.code :
      typeof err?.type === "string" ? err.type : null;
    const errorField =
      typeof err?.param === "string" ? err.param :
      typeof err?.field === "string" ? err.field : null;
    return { ok: false, status: response.status, errorCode, errorField };
  }

  return { ok: true, body: parsed };
}

/* -------------------------------------------------------------------------
   KYC status
   ------------------------------------------------------------------------- */

export type KycState =
  | "verified"
  | "pending"
  | "action_required"
  | "restricted"
  | "unknown";

export type KycStatus = {
  providerAccountId: string;
  state: KycState;
  /** Raw status string from the provider. */
  providerStatus: string | null;
  /** Actions the creator must take before verification is complete. */
  requiredActions: string[];
  /** Actions that are overdue (provider may restrict payouts). */
  pastDueActions: string[];
};

export type KycStatusResult =
  | { ok: true; kycStatus: KycStatus }
  | { ok: false; reason: "platforms_access_required" | "not_found" | "provider_error" | "unconfigured" };

function parseKycStatus(accountId: string, body: unknown): KycStatus {
  const b = (body ?? {}) as Record<string, unknown>;

  const providerStatus = typeof b.status === "string" ? b.status : null;

  // Whop uses different field shapes depending on account type and API version.
  // Read both array-based and object-based requirement shapes defensively.
  const requiredActions = readStringArray(b, "required_actions", "currently_due", "actions_required");
  const pastDueActions = readStringArray(b, "past_due", "past_due_actions");

  const state = deriveState(providerStatus, requiredActions, pastDueActions);

  return { providerAccountId: accountId, state, providerStatus, requiredActions, pastDueActions };
}

function readStringArray(src: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const val = src[key];
    if (Array.isArray(val)) {
      return val.filter((v): v is string => typeof v === "string");
    }
    // Some Whop responses nest requirements inside an object
    if (val && typeof val === "object") {
      const nested = val as Record<string, unknown>;
      for (const nk of ["currently_due", "past_due", "data"]) {
        if (Array.isArray(nested[nk])) {
          return (nested[nk] as unknown[]).filter((v): v is string => typeof v === "string");
        }
      }
    }
  }
  return [];
}

function deriveState(
  status: string | null,
  required: string[],
  pastDue: string[],
): KycState {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (s === "active" && required.length === 0 && pastDue.length === 0) return "verified";
  if (pastDue.length > 0) return "restricted";
  if (required.length > 0 || s === "pending" || s === "unverified") return "action_required";
  if (s === "active") return "verified";
  if (s === "restricted") return "restricted";
  return "unknown";
}

/**
 * Fetches the current KYC / verification state for a connected account.
 *
 * Called by GET /api/whop/kyc/status. The return is always the provider's
 * current answer — never a cached value — so the creator sees the real state
 * immediately after completing Whop's hosted onboarding.
 */
export async function fetchKycStatus(accountId: string): Promise<KycStatusResult> {
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const result = await call(platform.config, `/accounts/${accountId}`, "GET");
  if (!result.ok) {
    if (result.status === 403) return { ok: false, reason: "platforms_access_required" };
    if (result.status === 404) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "provider_error" };
  }

  return { ok: true, kycStatus: parseKycStatus(accountId, result.body) };
}

/* -------------------------------------------------------------------------
   Account link (KYC / onboarding URL)
   ------------------------------------------------------------------------- */

export type KycLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: "platforms_access_required" | "provider_error" | "provider_rejected" | "unconfigured" | "malformed_response" };

/**
 * Creates a short-lived Whop-hosted onboarding link for the connected account.
 *
 * COMPANY_ID FIRST. Whop's TypeScript SDK and Platforms documentation use
 * `company_id` to identify the account. This function tries that form first.
 * Only if Whop explicitly rejects `company_id` as the wrong field does it
 * retry once with `account_id`. A generic 400 is not retried.
 */
export async function createKycLink(
  accountId: string,
  returnUrl: string,
): Promise<KycLinkResult> {
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const url = await tryCreateLink(platform.config, { company_id: accountId }, returnUrl);
  if (url.ok) return url;

  // Retry with account_id ONLY when Whop explicitly names company_id as the
  // rejected field. A generic 400 stays as-is.
  if (
    url.shouldRetryWithAccountId ||
    (url.raw.status === 400 && url.raw.errorField === "company_id")
  ) {
    const retry = await tryCreateLink(platform.config, { account_id: accountId }, returnUrl);
    if (retry.ok) return retry;
    return mapLinkFailure(retry.raw);
  }

  return mapLinkFailure(url.raw);
}

type LinkAttempt =
  | { ok: true; url: string }
  | { ok: false; shouldRetryWithAccountId: boolean; raw: RawResult & { ok: false } };

async function tryCreateLink(
  config: PlatformConfig,
  idField: { company_id: string } | { account_id: string },
  returnUrl: string,
): Promise<LinkAttempt> {
  const result = await call(config, "/accounts/links", "POST", {
    ...idField,
    type: "account_onboarding",
    return_url: returnUrl,
  });

  if (!result.ok) {
    // Whop explicitly told us to use the other id field
    const shouldRetry =
      result.status === 400 &&
      "company_id" in idField &&
      (result.errorField === "account_id" || result.errorCode === "account_id_required");
    return { ok: false, shouldRetryWithAccountId: shouldRetry, raw: result };
  }

  const body = result.body as Record<string, unknown> | null;
  const url =
    typeof body?.url === "string" && body.url.startsWith("https://") ? body.url : null;

  if (!url) return { ok: false, shouldRetryWithAccountId: false, raw: { ...result, ok: false, status: 0, errorCode: "malformed_response", errorField: null } };
  return { ok: true, url };
}

function mapLinkFailure(raw: RawResult & { ok: false }): KycLinkResult {
  if (raw.status === 403) return { ok: false, reason: "platforms_access_required" };
  if (raw.errorCode === "malformed_response") return { ok: false, reason: "malformed_response" };
  if (raw.status === 400) return { ok: false, reason: "provider_rejected" };
  return { ok: false, reason: "provider_error" };
}

/* -------------------------------------------------------------------------
   Payout portal link (bank account / payout method management)
   ------------------------------------------------------------------------- */

export type PayoutPortalLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: "platforms_access_required" | "provider_error" | "provider_rejected" | "unconfigured" | "malformed_response" };

/**
 * Creates a short-lived Whop-hosted link for managing payout settings
 * (adding or changing a bank account).
 *
 * THIS IS NOT KYC. Use createKycLink for identity verification.
 * This link opens Whop's payout/bank account management UI.
 *
 * Uses `type: "account_update"` — the Whop link type for updating an existing
 * account's settings (including payout methods). Falls back to `account_id`
 * only when Whop explicitly rejects the `company_id` field, same as KYC.
 *
 * The link is never stored. The caller returns it immediately to the client
 * which navigates there. Raw banking details never reach ClipRewards.
 */
export async function createPayoutPortalLink(
  accountId: string,
  returnUrl: string,
): Promise<PayoutPortalLinkResult> {
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const url = await tryCreatePortalLink(platform.config, { company_id: accountId }, returnUrl);
  if (url.ok) return url;

  if (
    url.shouldRetryWithAccountId ||
    (url.raw.status === 400 && url.raw.errorField === "company_id")
  ) {
    const retry = await tryCreatePortalLink(platform.config, { account_id: accountId }, returnUrl);
    if (retry.ok) return retry;
    return mapPortalLinkFailure(retry.raw);
  }

  return mapPortalLinkFailure(url.raw);
}

async function tryCreatePortalLink(
  config: PlatformConfig,
  idField: { company_id: string } | { account_id: string },
  returnUrl: string,
): Promise<LinkAttempt> {
  const result = await call(config, "/accounts/links", "POST", {
    ...idField,
    type: "account_update",
    return_url: returnUrl,
  });

  if (!result.ok) {
    const shouldRetry =
      result.status === 400 &&
      "company_id" in idField &&
      (result.errorField === "account_id" || result.errorCode === "account_id_required");
    return { ok: false, shouldRetryWithAccountId: shouldRetry, raw: result };
  }

  const body = result.body as Record<string, unknown> | null;
  const url =
    typeof body?.url === "string" && body.url.startsWith("https://") ? body.url : null;

  if (!url) return { ok: false, shouldRetryWithAccountId: false, raw: { ...result, ok: false, status: 0, errorCode: "malformed_response", errorField: null } };
  return { ok: true, url };
}

function mapPortalLinkFailure(raw: RawResult & { ok: false }): PayoutPortalLinkResult {
  if (raw.status === 403) return { ok: false, reason: "platforms_access_required" };
  if (raw.errorCode === "malformed_response") return { ok: false, reason: "malformed_response" };
  if (raw.status === 400) return { ok: false, reason: "provider_rejected" };
  return { ok: false, reason: "provider_error" };
}

/* -------------------------------------------------------------------------
   Re-export config resolver so routes don't import from two modules
   ------------------------------------------------------------------------- */

export { resolvePlatformConfig };
