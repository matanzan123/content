import "server-only";

import { WhopError, type Whop } from "@whop/sdk";
import { getWhopPaymentsClient } from "./whop-payments";

/* ==========================================================================
   WHOP PAYOUT ACCOUNT STATUS — server only.

   ONE PRODUCT QUESTION: "can this creator receive payouts right now, and if
   not, what is missing?" The second half is the part that was absent before.

   DO NOT CONFUSE KYC WITH PAYOUT READINESS. KYC (Task #10) answers "is the
   identity verified?". This module answers "can money actually move?". A
   creator can be verified and still unable to be paid — most commonly because
   no payout destination has been added.

   FIVE DISTINCT FACTS, deliberately not collapsed into one boolean:

     A. identity verification  — owned by whop-kyc.ts, not re-derived here
     B. account state          — Account.status: `active` or `suspended`
     C. payout destination     — payoutMethods.listPayoutMethod({company_id})
     D. blocking actions       — Account.required_actions[]
     E. payout capability      — Account.capabilities.*_payout / transfer

   WHY THE SDK. The previous version hand-rolled `fetch` and was wrong in ways
   a compiler would have caught: it filtered `required_actions` — an array of
   OBJECTS — as if it were `string[]`, so every blocking action was silently
   discarded; it read a `past_due` field that does not exist on Account, so
   `restricted` was unreachable; and it invented capability names
   (`accept_card_bank`, `crypto`) that are not in the schema. Reading
   `Whop.Account` through `client.accounts.retrieve` makes all of that a build
   error instead of a wrong answer on a creator's dashboard.

   THE CLIENT IS NEVER BUILT HERE. `getWhopPaymentsClient()` sets `baseUrl`
   explicitly from `WHOP_API_BASE_URLS[environment]`; the SDK's own default is
   production. Constructing a client locally is how sandbox traffic ends up
   hitting the live API.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Capabilities
   ------------------------------------------------------------------------- */

/**
 * The capabilities that genuinely move money OUT to a creator's own
 * destination.
 *
 * `transfer` is deliberately EXCLUDED. The SDK documents it as "Transfers to
 * other accounts" — account-to-account movement inside Whop, not a payout to
 * an external destination. Treating it as proof of payout readiness was a
 * false-positive risk, and a false positive here authorises a withdrawal that
 * cannot settle.
 *
 * `crypto_payout` IS included: the SDK documents it as "On-chain payouts to a
 * crypto wallet", which is a real payout rail. Omitting it was a
 * false-negative risk for creators paid that way.
 */
export const PAYOUT_CAPABILITY_KEYS = [
  "standard_payout",
  "instant_payout",
  "crypto_payout",
] as const;

export type PayoutCapabilityKey = (typeof PAYOUT_CAPABILITY_KEYS)[number];

/**
 * The only three states the provider emits. There is no `restricted` — the
 * previous version declared one and nothing could ever produce it.
 */
export type CapabilityState = "active" | "inactive" | "pending";

export type PayoutCapabilities = {
  /** Per-capability state for the payout rails we accept. */
  payout: Record<PayoutCapabilityKey, CapabilityState>;
  /** At least one payout rail is live. */
  anyPayoutActive: boolean;
  /** At least one payout rail is awaiting provider review. */
  anyPayoutPending: boolean;
  /**
   * Account-to-account transfer. Tracked for diagnostics because it is
   * frequently active while payouts are not — which is exactly the state that
   * used to be misreported as ready. Never contributes to readiness.
   */
  transfer: CapabilityState;
};

/* -------------------------------------------------------------------------
   Required actions
   ------------------------------------------------------------------------- */

/**
 * The provider's action tokens, reduced to the reasons the product can act on.
 *
 * BOUNDED ON PURPOSE. The SDK warns that "new values may be added, so handle
 * unknown actions gracefully", so anything unrecognised becomes
 * `action_required` rather than being rendered blind. A provider token is
 * never shown to a creator; it is mapped to copy we control.
 */
export type PayoutBlockReason =
  | "verify_identity"
  | "payout_profile"
  | "payout_method"
  | "information_request"
  | "action_required";

const ACTION_REASONS: Record<string, PayoutBlockReason> = {
  verify_identity: "verify_identity",
  update_payout_profile: "payout_profile",
  reauthorize_payout_methods: "payout_method",
  submit_information_request: "information_request",
};

/**
 * One blocking or pending action, stripped to what the product needs.
 *
 * `cta`, `cta_label`, `description`, `title` and `icon_url` are NOT carried:
 * they are free-form provider copy and an external URL, and rendering either
 * would put untranslated, unreviewed text and an uncontrolled link in front of
 * a creator. `blocked_capabilities` is kept because it is a list of capability
 * names — bounded data that explains WHICH rail is blocked.
 */
export type NormalizedAction = {
  reason: PayoutBlockReason;
  /** `required` = act now; `pending` = under provider review. */
  status: "required" | "pending";
  blockedCapabilities: string[];
};

function normalizeActions(actions: Whop.Account["required_actions"]): NormalizedAction[] {
  if (!Array.isArray(actions)) return [];
  const out: NormalizedAction[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const token = typeof action.action === "string" ? action.action : "";
    const status = action.status === "pending" ? "pending" : "required";
    const blocked = Array.isArray(action.blocked_capabilities)
      ? action.blocked_capabilities.filter((c: unknown): c is string => typeof c === "string")
      : [];
    out.push({ reason: ACTION_REASONS[token] ?? "action_required", status, blockedCapabilities: blocked });
  }
  return out;
}

/* -------------------------------------------------------------------------
   Payout destinations
   ------------------------------------------------------------------------- */

/**
 * What the payout-method read produced.
 *
 * `not_attempted` is gone as a resting value — it used to be a hardcoded
 * literal that made a never-executed call look like a known limitation. Every
 * value here is now the result of an actual attempt.
 */
export type DestinationOutcome = "ok" | "forbidden" | "unavailable";

export type DestinationSummary = {
  outcome: DestinationOutcome;
  /** Payout methods the provider returned. Zero is a meaningful answer. */
  count: number;
  /**
   * Methods whose `destination` is non-null. The SDK documents that field as
   * "Null if not yet configured", so this is the deterministic test for a
   * destination a payout could actually land in — a half-finished method row
   * is not a usable destination.
   */
  configuredCount: number;
  /** Bounded category tokens only (`bank_wire`, `crypto`, …). No PII. */
  categories: string[];
};

/* -------------------------------------------------------------------------
   Status
   ------------------------------------------------------------------------- */

export type PayoutReadiness =
  /** Money can move now. */
  | "ready"
  /** Provider is reviewing; nothing for the creator to do. */
  | "pending"
  /** The creator must do something, and we know what. */
  | "action_required"
  /** Everything else is fine but there is nowhere to send the money. */
  | "destination_missing"
  /** The provider has suspended the account. */
  | "restricted"
  /** No payout rail and no explanation — onboarding simply is not done. */
  | "not_ready"
  /** We could not get a trustworthy answer. */
  | "unknown";

export type PayoutStatus = {
  providerAccountId: string;
  /** The single gate a withdrawal may consult. True only for `ready`. */
  canReceivePayout: boolean;
  readiness: PayoutReadiness;
  /** Why not, when not. Empty when ready. Ordered most-blocking first. */
  reasons: PayoutBlockReason[];
  capabilities: PayoutCapabilities;
  actions: NormalizedAction[];
  destinations: DestinationSummary;
  /** `active` | `suspended` | null, per the SDK. Never free-form. */
  accountStatus: string | null;
  /** Whether the provider gave a suspension reason. The TEXT is never carried. */
  hasStatusReason: boolean;
};

export type PayoutStatusResult =
  | { ok: true; status: PayoutStatus }
  | { ok: false; reason: "platforms_access_required" | "not_found" | "provider_error" | "unconfigured" };

/* -------------------------------------------------------------------------
   Derivation
   ------------------------------------------------------------------------- */

function readCapabilities(account: Whop.Account): PayoutCapabilities {
  const caps = (account.capabilities ?? {}) as Record<string, unknown>;
  const state = (key: string): CapabilityState => {
    const v = caps[key];
    return v === "active" || v === "pending" ? v : "inactive";
  };

  const payout = {} as Record<PayoutCapabilityKey, CapabilityState>;
  let anyPayoutActive = false;
  let anyPayoutPending = false;
  for (const key of PAYOUT_CAPABILITY_KEYS) {
    const s = state(key);
    payout[key] = s;
    if (s === "active") anyPayoutActive = true;
    if (s === "pending") anyPayoutPending = true;
  }

  return { payout, anyPayoutActive, anyPayoutPending, transfer: state("transfer") };
}

/**
 * THE READINESS DECISION, in blocking order.
 *
 * Ordered so the most disqualifying fact wins. The rule that matters most:
 * READY REQUIRES THE ABSENCE OF EVERY BLOCKER, not the presence of one good
 * signal. The previous version returned ready on an active capability alone,
 * which meant a creator with a live rail AND an outstanding required action
 * was reported ready — and #15 withdrawals gate on exactly this boolean.
 */
function derive(
  account: Whop.Account,
  capabilities: PayoutCapabilities,
  actions: NormalizedAction[],
  destinations: DestinationSummary,
): { readiness: PayoutReadiness; reasons: PayoutBlockReason[] } {
  // 1. Suspension outranks everything. The SDK documents `status` as exactly
  //    `active` or `suspended`, so this is a bounded test, not a guess.
  if (account.status === "suspended") {
    return { readiness: "restricted", reasons: ["action_required"] };
  }

  const blocking = actions.filter((a) => a.status === "required");
  const underReview = actions.filter((a) => a.status === "pending");

  // 2. Anything the creator must do now. Never ready while one of these exists.
  if (blocking.length > 0) {
    return { readiness: "action_required", reasons: dedupe(blocking.map((a) => a.reason)) };
  }

  // 3. A destination read we could not trust. Saying "ready" here would be a
  //    guess about the one fact we failed to establish.
  if (destinations.outcome !== "ok") {
    return { readiness: "unknown", reasons: [] };
  }

  // 4. Nowhere to send money. Distinct from "not_ready" so the card can say so.
  if (destinations.configuredCount === 0) {
    return { readiness: "destination_missing", reasons: ["payout_method"] };
  }

  // 5. Provider is still reviewing — the creator has nothing to do but wait.
  if (underReview.length > 0 || capabilities.anyPayoutPending) {
    return { readiness: "pending", reasons: dedupe(underReview.map((a) => a.reason)) };
  }

  // 6. Everything clear and a live rail.
  if (capabilities.anyPayoutActive) return { readiness: "ready", reasons: [] };

  // 7. Destination present, nothing blocking, but no rail is live. Onboarding
  //    is incomplete in a way the provider has not itemised for us.
  return { readiness: "not_ready", reasons: [] };
}

function dedupe(values: PayoutBlockReason[]): PayoutBlockReason[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------
   Provider reads
   ------------------------------------------------------------------------- */

type Client = NonNullable<ReturnType<typeof getWhopPaymentsClient>>;

/**
 * Lists payout destinations for the creator's own company.
 *
 * `company_id` is the server-resolved `biz_` id — the same one the account was
 * fetched with. Only the FIRST page is read: this answers "is there at least
 * one usable destination", and paging further would add provider calls without
 * changing that answer.
 *
 * Nothing identifying is retained. `account_reference` (masked bank digits),
 * `institution_name`, `nickname`, and the destination's `name` and
 * `country_code` are all left behind; only the bounded `category` token and
 * two counts survive.
 */
async function readDestinations(client: Client, companyId: string): Promise<DestinationSummary> {
  try {
    const page = await client.payoutMethods.listPayoutMethod({ company_id: companyId, first: 25 });
    const items: Whop.PayoutMethodListItem[] = Array.isArray(page?.data) ? page.data : [];
    const configured = items.filter((m) => m && m.destination != null);
    const categories = [
      ...new Set(
        configured
          .map((m): string | undefined => m.destination?.category)
          .filter((c): c is string => typeof c === "string"),
      ),
    ];
    return { outcome: "ok", count: items.length, configuredCount: configured.length, categories };
  } catch (error) {
    const status = error instanceof WhopError ? error.statusCode : undefined;
    // 403 is its own outcome: it means the key lacks the payout-methods scope,
    // which is an operator problem, not a creator problem. Reporting it as
    // "no destinations" would blame the creator for our configuration.
    return {
      outcome: status === 403 ? "forbidden" : "unavailable",
      count: 0,
      configuredCount: 0,
      categories: [],
    };
  }
}

/**
 * The authoritative payout readiness for one connected account.
 *
 * `accountId` MUST be the creator's own `biz_` id, resolved server-side from
 * their session and the running environment. Never a browser-supplied value,
 * and never the platform parent account.
 */
export async function fetchPayoutStatus(accountId: string): Promise<PayoutStatusResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  let account: Whop.Account;
  try {
    account = await client.accounts.retrieve({ id: accountId });
  } catch (error) {
    logPayoutDiagnostic(accountId, { kind: "account_error", error });
    return { ok: false, reason: classify(error) };
  }

  if (!account || typeof account !== "object") {
    return { ok: false, reason: "provider_error" };
  }

  const capabilities = readCapabilities(account);
  const actions = normalizeActions(account.required_actions);
  const destinations = await readDestinations(client, accountId);
  const { readiness, reasons } = derive(account, capabilities, actions, destinations);

  const status: PayoutStatus = {
    providerAccountId: accountId,
    canReceivePayout: readiness === "ready",
    readiness,
    reasons,
    capabilities,
    actions,
    destinations,
    accountStatus: typeof account.status === "string" ? account.status : null,
    // The TEXT is never carried: the SDK calls it "language safe to show the
    // account owner", but it is free-form provider prose, so it is neither
    // translated nor reviewed. Its presence is the only fact kept.
    hasStatusReason: typeof account.status_reason === "string" && account.status_reason.length > 0,
  };

  logPayoutDiagnostic(accountId, { kind: "status", account, status });

  return { ok: true, status };
}

function classify(error: unknown): "platforms_access_required" | "not_found" | "provider_error" {
  const status = error instanceof WhopError ? error.statusCode : undefined;
  if (status === 403) return "platforms_access_required";
  if (status === 404) return "not_found";
  return "provider_error";
}

/* -------------------------------------------------------------------------
   Development-only diagnostics
   ------------------------------------------------------------------------- */

/**
 * Prints the bounded facts behind a readiness answer, in development only.
 *
 * SHAPED BY WHAT MUST NOT APPEAR. A payout account is the richest source of
 * PII the provider holds — `address`, `business_representative`,
 * `email`, `phone` — and a payout METHOD carries masked bank digits and an
 * institution name. None of it is read here. Neither is `error.message`: the
 * SDK builds that string by appending the whole response body to it, so it is
 * a body dump in disguise. Only the status code is taken from an error.
 *
 * Everything printed is an enum token, a capability name, a count, or a
 * boolean. `status_reason` is free-form, so only its PRESENCE is reported.
 */
type Diagnostic =
  | { kind: "account_error"; error: unknown }
  | { kind: "status"; account: Whop.Account; status: PayoutStatus };

function logPayoutDiagnostic(accountId: string, d: Diagnostic): void {
  if (process.env.NODE_ENV === "production") return;

  if (d.kind === "account_error") {
    const code = d.error instanceof WhopError ? d.error.statusCode : undefined;
    const requestId = d.error instanceof WhopError ? d.error.requestId : undefined;
    console.error(
      `[whop:payout_status] account read failed — status=${code ?? "?"}` +
        (requestId ? ` request_id=${requestId}` : ""),
    );
    return;
  }

  const { account, status } = d;
  const caps = Object.entries(status.capabilities.payout)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const acts = status.actions
    .map((a) => `${a.reason}/${a.status}${a.blockedCapabilities.length ? `(${a.blockedCapabilities.join("|")})` : ""}`)
    .join(";");
  // The raw provider tokens too, so an unmapped action is visible as itself
  // rather than hiding behind the generic reason it degrades to.
  const rawTokens = Array.isArray(account.required_actions)
    ? account.required_actions
        .map((a: { action?: unknown }) => (a && typeof a.action === "string" ? a.action : "?"))
        .join("|")
    : "";

  console.error(
    `[whop:payout_status] ${accountId} — readiness=${status.readiness}` +
      ` account_status=${status.accountStatus ?? "null"}` +
      ` has_status_reason=${status.hasStatusReason}` +
      ` payout_caps=[${caps}] transfer=${status.capabilities.transfer}` +
      ` destinations=${status.destinations.outcome}/${status.destinations.configuredCount}of${status.destinations.count}` +
      (status.destinations.categories.length ? ` categories=[${status.destinations.categories.join("|")}]` : "") +
      (acts ? ` actions=[${acts}]` : " actions=[none]") +
      (rawTokens ? ` raw_action_tokens=[${rawTokens}]` : "") +
      (status.reasons.length ? ` reasons=[${status.reasons.join("|")}]` : ""),
  );
}
