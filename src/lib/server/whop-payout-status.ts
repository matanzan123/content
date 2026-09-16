import "server-only";

import { resolvePlatformConfig } from "./whop-accounts";

/* ==========================================================================
   WHOP PAYOUT ACCOUNT STATUS — server only.

   DO NOT CONFUSE KYC WITH PAYOUT-READINESS. KYC (Task #10) answers "has the
   creator's identity been verified?" Payout readiness (this module) answers
   "can the provider actually move money to the creator right now?"

   A creator may be KYC-verified but still not payout-ready if they have not:
     - added a bank account or payout method
     - completed any remaining onboarding steps specific to payouts
     - received the capabilities the provider assigns after review

   These are different states and must be tracked and surfaced separately.

   SOURCE OF TRUTH: GET /accounts/{id}.

   `GET /payout_methods?account_id=...` returned 403 in sandbox — the platform
   API key does not have that scope, or the endpoint requires a different
   credential. Until that changes, the payout-readiness model is derived
   entirely from the account object the platform key CAN fetch. This is
   deliberate and documented: the fallback is known, not accidental.

   CAPABILITIES OBSERVED IN SANDBOX (child account before KYC):
     accept_card_bank: "active"    — accept incoming payments: YES
     standard_payout:  "inactive"  — send money to bank:       NO
     instant_payout:   "inactive"  — instant payout:           NO
     transfer:         "inactive"  — inter-account transfer:   NO
     crypto:           "inactive"  — crypto payout:            NO
     card_issuing:     "inactive"  — card issuing:             NO

   `canReceivePayout` is true only when at least ONE outbound capability is
   "active". "active" on accept_card_bank alone is NOT sufficient — that only
   means the creator can be charged, not paid.
   ========================================================================== */

const API_VERSION_DATE = "2026-09-02-1";

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

/**
 * The outbound capabilities that allow a creator to receive money.
 * Any value outside "active" is treated as inactive.
 */
export const OUTBOUND_CAPABILITY_KEYS = [
  "standard_payout",
  "instant_payout",
  "transfer",
] as const;

export type OutboundCapabilityKey = (typeof OUTBOUND_CAPABILITY_KEYS)[number];

export type CapabilityState = "active" | "inactive" | "pending" | "restricted" | "unknown";

export type AccountCapabilities = {
  /** The raw capability map from the provider. */
  raw: Record<string, string>;
  /** Whether any outbound payout capability is active. */
  anyOutboundActive: boolean;
  /** Per-capability resolved states for the keys we care about. */
  outbound: Record<OutboundCapabilityKey, CapabilityState>;
};

export type PayoutReadiness =
  | "ready"
  /** Payout capability exists but is pending provider review. */
  | "pending"
  /** Provider has restricted payouts — action required. */
  | "restricted"
  /** No active outbound capability yet (pre-KYC / onboarding incomplete). */
  | "not_ready"
  /** Could not determine — provider returned no capability data. */
  | "unknown";

export type PayoutStatus = {
  providerAccountId: string;
  /** Whether the account can receive payouts right now. */
  canReceivePayout: boolean;
  readiness: PayoutReadiness;
  capabilities: AccountCapabilities;
  /** Provider-reported requirements still blocking payouts. */
  pendingRequirements: string[];
  pastDueRequirements: string[];
  /**
   * Whether `GET /payout_methods` was attempted and what happened.
   * Tracked explicitly so an operator can see this is a known limitation,
   * not a silent gap.
   */
  payoutMethodsScope: "not_attempted" | "success" | "forbidden" | "error";
};

export type PayoutStatusResult =
  | { ok: true; status: PayoutStatus }
  | { ok: false; reason: "platforms_access_required" | "not_found" | "provider_error" | "unconfigured" };

/* -------------------------------------------------------------------------
   Raw fetch
   ------------------------------------------------------------------------- */

async function fetchAccount(
  baseUrl: string,
  apiKey: string,
  accountId: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/accounts/${accountId}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "Api-Version-Date": API_VERSION_DATE,
      },
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0 };
  }

  if (!response.ok) return { ok: false, status: response.status };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: true, body };
}

/* -------------------------------------------------------------------------
   Parsing
   ------------------------------------------------------------------------- */

function readCapabilities(body: unknown): Record<string, string> {
  const b = (body ?? {}) as Record<string, unknown>;

  // Whop may return capabilities as a nested object or as top-level fields.
  // Try both shapes defensively.
  const cap = b.capabilities ?? b.account_capabilities ?? null;
  if (cap && typeof cap === "object" && !Array.isArray(cap)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(cap as Record<string, unknown>)) {
      if (typeof v === "string") result[k] = v;
    }
    if (Object.keys(result).length > 0) return result;
  }

  // Fallback: scan top-level keys for known capability names
  const result: Record<string, string> = {};
  const knownKeys = [
    "standard_payout", "instant_payout", "transfer",
    "accept_card_bank", "crypto", "card_issuing",
  ];
  for (const key of knownKeys) {
    if (typeof b[key] === "string") result[key] = b[key] as string;
  }
  return result;
}

function resolveCapabilityState(raw: string | undefined): CapabilityState {
  if (!raw) return "unknown";
  const v = raw.toLowerCase();
  if (v === "active") return "active";
  if (v === "pending") return "pending";
  if (v === "restricted") return "restricted";
  if (v === "inactive") return "inactive";
  return "unknown";
}

function parseCapabilities(raw: Record<string, string>): AccountCapabilities {
  const outbound = {} as Record<OutboundCapabilityKey, CapabilityState>;
  let anyOutboundActive = false;

  for (const key of OUTBOUND_CAPABILITY_KEYS) {
    const state = resolveCapabilityState(raw[key]);
    outbound[key] = state;
    if (state === "active") anyOutboundActive = true;
  }

  return { raw, anyOutboundActive, outbound };
}

function deriveReadiness(
  capabilities: AccountCapabilities,
  pendingRequirements: string[],
  pastDueRequirements: string[],
): PayoutReadiness {
  if (pastDueRequirements.length > 0) return "restricted";
  if (capabilities.anyOutboundActive && pendingRequirements.length === 0) return "ready";
  // Any outbound pending = waiting for provider review
  const anyPending = OUTBOUND_CAPABILITY_KEYS.some(
    (k) => capabilities.outbound[k] === "pending",
  );
  if (anyPending || pendingRequirements.length > 0) return "pending";
  if (!capabilities.anyOutboundActive) return "not_ready";
  return "unknown";
}

function readStringArray(b: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const val = b[key];
    if (Array.isArray(val)) {
      return val.filter((v): v is string => typeof v === "string");
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
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

/* -------------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------------- */

/**
 * Fetches the authoritative payout readiness for a connected account.
 *
 * NEVER equate this with KYC status. A verified creator may still have
 * inactive payout capabilities if they have not completed provider-specific
 * payout setup (adding a bank account, accepting payout terms, etc.).
 *
 * Source: GET /accounts/{id}. Capabilities are parsed from the response.
 * GET /payout_methods was attempted and returned 403 in sandbox — this is
 * tracked in payoutMethodsScope so operators can see it is a known gap.
 */
export async function fetchPayoutStatus(accountId: string): Promise<PayoutStatusResult> {
  const platform = resolvePlatformConfig();
  if (!platform.ok) return { ok: false, reason: "unconfigured" };

  const { baseUrl, apiKey } = platform.config;

  const result = await fetchAccount(baseUrl, apiKey, accountId);
  if (!result.ok) {
    if (result.status === 403) return { ok: false, reason: "platforms_access_required" };
    if (result.status === 404) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "provider_error" };
  }

  const b = (result.body ?? {}) as Record<string, unknown>;
  const rawCapabilities = readCapabilities(result.body);
  const capabilities = parseCapabilities(rawCapabilities);
  const pendingRequirements = readStringArray(b, "required_actions", "currently_due");
  const pastDueRequirements = readStringArray(b, "past_due", "past_due_actions");
  const readiness = deriveReadiness(capabilities, pendingRequirements, pastDueRequirements);

  return {
    ok: true,
    status: {
      providerAccountId: accountId,
      canReceivePayout: readiness === "ready",
      readiness,
      capabilities,
      pendingRequirements,
      pastDueRequirements,
      // GET /payout_methods returned 403 in sandbox — documented, not retried.
      payoutMethodsScope: "not_attempted",
    },
  };
}
