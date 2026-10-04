import "server-only";

import { resolvePlatformConfig, type PlatformConfig } from "./whop-accounts";

/* ==========================================================================
   WHOP KYC / ONBOARDING — server only.

   ONE responsibility: reading the KYC / verification state of a connected
   account from Whop. Nothing here is cached — the creator must see the real
   state the moment they return from Whop's hosted flow.

   MINTING THE HOSTED LINK LIVES IN `whop-account-links.ts`. It used to live
   here too, hand-rolled, and it was wrong in five different ways against the
   installed SDK contract. Both hosted flows — `account_onboarding` and
   `payouts_portal` — are now one typed SDK call in that module, so the
   compiler enforces the request shape. Do not reintroduce a request body for
   account links here.

   THE RETURN URL IS NEVER TREATED AS PROOF that KYC succeeded. Whatever the
   creator did at Whop, the authoritative answer comes from `fetchKycStatus`.
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

  /*
   * Current Whop Account responses expose `required_actions` as OBJECTS:
   * { action, status, blocked_capabilities, ... }.
   *
   * Identity verification is deliberately separated from payout readiness.
   * Payout-profile and payout-method actions belong to WhopPayoutStatusCard,
   * not to the KYC card.
   */
  const identity = readIdentityActions(b);

  // Legacy shapes are retained defensively for older API responses.
  const legacyRequired = readStringArray(b, "currently_due", "actions_required")
    .filter(isIdentityAction);
  const legacyPastDue = readStringArray(b, "past_due", "past_due_actions")
    .filter(isIdentityAction);

  const requiredActions = dedupeStrings([
    ...identity.required,
    ...legacyRequired,
  ]);
  const pendingActions = dedupeStrings(identity.pending);
  const pastDueActions = dedupeStrings(legacyPastDue);

  const state = deriveState(
    providerStatus,
    requiredActions,
    pastDueActions,
    pendingActions,
  );

  return {
    providerAccountId: accountId,
    state,
    providerStatus,
    requiredActions,
    pastDueActions,
  };
}

function isIdentityAction(action: string): boolean {
  return action === "verify_identity";
}

function readIdentityActions(src: Record<string, unknown>): {
  required: string[];
  pending: string[];
} {
  const raw = src.required_actions;
  if (!Array.isArray(raw)) return { required: [], pending: [] };

  const required: string[] = [];
  const pending: string[] = [];

  for (const item of raw) {
    // Defensive compatibility with an older string-array response.
    if (typeof item === "string") {
      if (isIdentityAction(item)) required.push(item);
      continue;
    }

    if (!item || typeof item !== "object") continue;

    const action = item as Record<string, unknown>;
    const token = typeof action.action === "string" ? action.action : null;
    if (!token || !isIdentityAction(token)) continue;

    if (action.status === "pending") {
      pending.push(token);
    } else {
      required.push(token);
    }
  }

  return {
    required: dedupeStrings(required),
    pending: dedupeStrings(pending),
  };
}

function readStringArray(src: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const val = src[key];

    if (Array.isArray(val)) {
      return val.filter((v): v is string => typeof v === "string");
    }

    if (val && typeof val === "object") {
      const nested = val as Record<string, unknown>;
      for (const nk of ["currently_due", "past_due", "data"]) {
        if (Array.isArray(nested[nk])) {
          return (nested[nk] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          );
        }
      }
    }
  }

  return [];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function deriveState(
  status: string | null,
  required: string[],
  pastDue: string[],
  pendingIdentity: string[],
): KycState {
  const s = status?.toLowerCase() ?? null;

  if (pastDue.length > 0 || s === "restricted") return "restricted";

  if (required.length > 0) return "action_required";

  if (pendingIdentity.length > 0 || s === "pending") return "pending";

  if (s === "unverified") return "action_required";

  /*
   * `active` only means verified here AFTER identity-specific required/pending
   * actions have been ruled out. It is not, by itself, proof of KYC.
   */
  if (s === "active") return "verified";

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
   Re-export config resolver so routes don't import from two modules
   ------------------------------------------------------------------------- */

export { resolvePlatformConfig };
