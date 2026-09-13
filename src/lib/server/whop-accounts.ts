import "server-only";

import { resolveWhopPayments, WHOP_API_BASE_URLS, type WhopEnvironmentName } from "./whop-payments";

/* ==========================================================================
   WHOP ACCOUNTS (PLATFORMS) — server only.

   The one place a CONNECTED ACCOUNT is created: an Account (`biz_…`) owned by
   a creator and parented to the ClipRewards platform account.

   THE CREDENTIAL DECIDES WHAT GETS CREATED, and that is the whole safety
   story of this module. `POST /accounts` with the platform's Account API key
   creates a CHILD of that account; the same endpoint with a user's OAuth
   access token creates a STANDALONE company belonging to nobody but them.
   This module therefore takes no token parameter at all — it reads the API key
   from configuration and has no way to be handed a user credential by mistake.
   A creator's OAuth token is used for identity in `whop-oauth.ts` and must
   never reach this file.

   IT IS NEVER IMPORTED BY A CLIENT COMPONENT. `server-only` turns any such
   import into a build error rather than a leaked API key.

   FAIL CLOSED ON ENVIRONMENT. The base URL comes from `WHOP_ENV` through the
   same resolver the payments client uses; a missing or unrecognised value
   creates nothing at all, rather than defaulting to production.

   WHAT THIS MODULE DOES NOT DO: no account links, no KYC, no verification, no
   payout accounts, no transfers, no balances. Those are later tasks and would
   need their own endpoints, scopes and review.
   ========================================================================== */

/** Whop's own version pin. Sent explicitly so a server-side default cannot move under us. */
const API_VERSION_DATE = "2026-09-02-1";

export type PlatformConfig = {
  environment: WhopEnvironmentName;
  baseUrl: string;
  apiKey: string;
};

export type PlatformConfigResult =
  | { ok: true; config: PlatformConfig }
  | { ok: false; reason: "missing_api_key" | "missing_environment" | "invalid_environment" | "unavailable" };

/**
 * Resolves the platform credentials.
 *
 * Deliberately built on `resolveWhopPayments`, so identity, payments and
 * platform calls cannot end up pointed at different Whop environments — one
 * variable decides for all of them.
 */
export function resolvePlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfigResult {
  const payments = resolveWhopPayments(env);
  if (!payments.ok) {
    if (payments.reason === "missing_api_key") return { ok: false, reason: "missing_api_key" };
    if (payments.reason === "missing_environment") return { ok: false, reason: "missing_environment" };
    if (payments.reason === "invalid_environment") return { ok: false, reason: "invalid_environment" };
    // A company-id problem is not this module's concern, but it still means the
    // configuration is not trustworthy enough to create accounts from.
    return { ok: false, reason: "unavailable" };
  }

  const apiKey = env.WHOP_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "missing_api_key" };

  return {
    ok: true,
    config: {
      environment: payments.config.environment,
      baseUrl: WHOP_API_BASE_URLS[payments.config.environment],
      apiKey,
    },
  };
}

/* -------------------------------------------------------------------------
   The provider model, narrowed to what this task needs
   ------------------------------------------------------------------------- */

export type WhopAccount = {
  /** Prefixed `biz_`. */
  id: string;
  /** The platform account this hangs from. Null means a STANDALONE company. */
  parentAccountId: string | null;
  status: string | null;
  onboardingType: string | null;
  country: string | null;
  title: string | null;
};

export type AccountFailure =
  /** The API key is not allowed to create child accounts — Platforms access. */
  | "platforms_access_required"
  /** Authentication itself was rejected. */
  | "provider_unauthorized"
  /** Whop rejected the request body. */
  | "provider_rejected"
  /** Reachable, but the answer was not an Account we can trust. */
  | "malformed_response"
  /** A STANDALONE account came back. Recorded nowhere; see the caller. */
  | "standalone_account_returned"
  | "network_error"
  | "unconfigured";

export type AccountResult =
  | { ok: true; account: WhopAccount }
  | { ok: false; reason: AccountFailure; detail?: string };

/** `biz_` and something after it. Checked here and again by the database. */
export function isWhopAccountId(value: unknown): value is string {
  return typeof value === "string" && /^biz_[A-Za-z0-9]{4,}$/.test(value);
}

function readAccount(body: unknown): WhopAccount | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isWhopAccountId(b.id)) return null;

  const parent = b.parent_account;
  const parentId =
    parent && typeof parent === "object" && isWhopAccountId((parent as Record<string, unknown>).id)
      ? ((parent as Record<string, unknown>).id as string)
      : null;

  return {
    id: b.id,
    parentAccountId: parentId,
    status: typeof b.status === "string" ? b.status : null,
    onboardingType: typeof b.onboarding_type === "string" ? b.onboarding_type : null,
    country: typeof b.country === "string" ? b.country : null,
    title: typeof b.title === "string" ? b.title : null,
  };
}

/**
 * Maps an HTTP status onto a reason a caller can act on.
 *
 * `403` IS ITS OWN OUTCOME. Access to the Platforms API is granted by Whop per
 * account, so "you may not create child accounts" is an ordinary configuration
 * state for this product — not a bug, not a crash, and not something to retry.
 * It gets its own name so the route can report it truthfully.
 */
function failureFor(status: number): AccountFailure {
  if (status === 401) return "provider_unauthorized";
  if (status === 403) return "platforms_access_required";
  return "provider_rejected";
}

async function request(
  config: PlatformConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: AccountFailure; detail?: string }> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        "Api-Version-Date": API_VERSION_DATE,
        ...(init.body ? { "content-type": "application/json" } : {}),
        // Whop accepts an idempotency key on these endpoints; a retry of the
        // same logical creation therefore replays rather than provisioning a
        // second account.
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
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
    // The provider's own message can quote the request, so only its stable
    // error CODE is carried — never a free-text description.
    const error = (body as { error?: { code?: unknown; type?: unknown } } | null)?.error;
    const detail =
      typeof error?.code === "string"
        ? error.code
        : typeof error?.type === "string"
          ? error.type
          : undefined;
    return { ok: false, reason: failureFor(response.status), detail };
  }

  return { ok: true, body };
}

/**
 * The platform account this API key acts as.
 *
 * Read from the provider rather than from configuration, so the parent a
 * created account is checked against is the one the credential actually owns.
 * Nothing about the platform's identity is hard-coded in this repository.
 */
export async function getPlatformAccount(config: PlatformConfig): Promise<AccountResult> {
  const result = await request(config, "/accounts/me", { method: "GET" });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  const account = readAccount(result.body);
  return account ? { ok: true, account } : { ok: false, reason: "malformed_response" };
}

export type CreateConnectedAccountInput = {
  /** The creator's own email, resolved server-side from Firebase. */
  email: string;
  /** Display name. Omitted when nothing trustworthy is known. */
  title?: string;
  /** ISO 3166-1 alpha-2. Omitted so Whop inherits the parent's country. */
  country?: string;
  /** Binds the account back to ClipRewards. Never client-supplied. */
  metadata: Record<string, string>;
  /** Stable per creator, so a retry replays instead of creating a second. */
  idempotencyKey: string;
};

/**
 * Creates a connected account under the platform account the API key owns.
 *
 * VALIDATED AGAINST THE EXPECTED PARENT. A response whose `parent_account` is
 * absent, or is some other account, is refused rather than stored: that shape
 * means a standalone company was created, which is a different object with
 * different ownership and must never be recorded as a creator's connected
 * account.
 */
export async function createConnectedAccount(
  config: PlatformConfig,
  expectedParentId: string,
  input: CreateConnectedAccountInput,
): Promise<AccountResult> {
  const body: Record<string, unknown> = {
    email: input.email,
    metadata: input.metadata,
  };
  if (input.title) body.title = input.title;
  if (input.country) body.country = input.country;

  const result = await request(config, "/accounts", {
    method: "POST",
    body,
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  const account = readAccount(result.body);
  if (!account) return { ok: false, reason: "malformed_response" };

  if (!account.parentAccountId || account.parentAccountId !== expectedParentId) {
    // Reported with the id so an operator can reconcile a real object that
    // exists at the provider but is not the thing we asked for.
    return { ok: false, reason: "standalone_account_returned", detail: account.id };
  }

  return { ok: true, account };
}
