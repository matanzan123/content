import "server-only";

import type { KycState } from "./whop-kyc";

/* ==========================================================================
   KYC STATE MAPPING — server only.

   Maps the raw provider KYC state to the copy and action codes the UI reads.
   The UI never receives raw provider strings — only closed-set tokens that
   the dictionaries know how to render.
   ========================================================================== */

export type KycUiState =
  | { status: "verified" }
  | { status: "pending" }
  | { status: "action_required"; actions: string[] }
  | { status: "restricted"; actions: string[] }
  | { status: "unknown" };

/**
 * Maps provider KYC state to the shape the UI card renders.
 *
 * `actions` are provider-returned action codes (e.g. `verify_identity`).
 * They are passed to the dictionary; any unrecognised code renders as a
 * generic "action required" message so new provider codes degrade safely.
 */
export function resolveKycUiState(
  state: KycState,
  requiredActions: string[],
  pastDueActions: string[],
): KycUiState {
  switch (state) {
    case "verified":
      return { status: "verified" };
    case "pending":
      return { status: "pending" };
    case "restricted":
      return { status: "restricted", actions: [...pastDueActions, ...requiredActions] };
    case "action_required":
      return { status: "action_required", actions: requiredActions };
    case "unknown":
    default:
      return { status: "unknown" };
  }
}
