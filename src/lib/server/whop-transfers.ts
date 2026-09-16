import "server-only";

import type { PlatformConfig } from "./whop-accounts";

/* ==========================================================================
   WHOP TRANSFER API — server only.

   THE SINGLE PLACE that calls Whop's transfer endpoint. No other file in this
   codebase may call POST /transfers or any equivalent payout primitive.

   WHAT "TRANSFER" MEANS HERE: moving funds from the ClipRewards platform
   account balance to a creator's connected Whop account (`biz_…`). This is
   a platform-to-child move, not a direct bank transfer — Whop then handles
   the onward payout to the creator's bank account, on their schedule and
   through their own settlement cycle.

   IDEMPOTENCY: every call includes an `Idempotency-Key` header (UUID v4).
   Whop uses it to deduplicate retries: a second call with the same key returns
   the original response. We store this key in `creator_transfers` BEFORE
   calling, so a crash between the DB write and the API call leaves a `pending`
   row we can detect and alert on — and a safe retry (same key) rather than a
   double payment.

   WHAT THIS MODULE DOES NOT DO:
   - Does NOT write to the DB. That is `creator-transfers.ts`.
   - Does NOT check payout readiness. That is `whop-payout-status.ts`.
   - Does NOT validate amounts. That is `creator-transfers.ts`.
   - Does NOT retry. A caller with the same idempotency key may call again;
     this module just calls Whop once and returns what it gets.

   TRANSFER API SHAPE (as documented by Whop Platforms):
   POST /transfers
   {
     "destination_account_id": "biz_...",  // the creator's child account
     "amount": 1000,                        // minor units (cents for USD)
     "currency": "usd",
     "description": "..."                   // optional, shown in Whop dashboard
   }
   Response on success:
   {
     "id": "tr_...",         // the provider transfer id
     "status": "pending",    // or "completed" if instant
     "amount": 1000,
     "currency": "usd"
   }

   NOTE: The exact field name for the destination may be `destination`,
   `destination_account_id`, or `account_id` depending on the API version.
   This module tries `destination_account_id` first (the documented form) and
   documents the fallback. If Whop changes the field name, this is the only
   place to update.
   ========================================================================== */

const API_VERSION_DATE = "2026-09-02-1";

/* -------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------- */

export type TransferRequest = {
  /** The creator's Whop account, prefixed `biz_`. */
  destinationAccountId: string;
  /** Minor units. 1000 = $10.00 USD. MUST be a positive integer. */
  amountMinor: bigint;
  /** Lowercase ISO 4217. Currently always "usd". */
  currency: string;
  /** Human-readable. Shown in Whop's dashboard. Never a secret or a UID. */
  description: string;
  /**
   * The idempotency key for this transfer attempt. UUID v4.
   * Written to `creator_transfers` before this call. Must be unique per
   * intended payment — NOT per retry (a retry should use the SAME key).
   */
  idempotencyKey: string;
};

export type TransferResponse = {
  /** The provider's own id for this transfer, prefixed `tr_` or similar. */
  providerTransferId: string;
  /** `pending` | `completed` — Whop may settle instantly in sandbox. */
  providerStatus: string;
  /** Amount Whop confirmed. Should match our request; log a warning if not. */
  confirmedAmountMinor: bigint | null;
};

export type WhopTransferResult =
  | { ok: true; transfer: TransferResponse }
  | { ok: false; reason: WhopTransferFailureReason; retryable: boolean };

export type WhopTransferFailureReason =
  | "platforms_access_required"  // 403 — wrong scope or key
  | "account_not_found"          // 404 — biz_ doesn't exist under our platform
  | "insufficient_funds"         // 402 / specific error code
  | "account_not_ready"          // capabilities not active
  | "amount_too_small"           // below Whop minimum
  | "amount_too_large"           // above Whop maximum
  | "provider_rejected"          // other 4xx — not retryable
  | "provider_error"             // 5xx — retryable
  | "network_error"              // no response — retryable
  | "malformed_response";        // 2xx but no id in body

/* -------------------------------------------------------------------------
   HTTP call
   ------------------------------------------------------------------------- */

export async function callWhopTransfer(
  config: PlatformConfig,
  req: TransferRequest,
): Promise<WhopTransferResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/transfers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "Idempotency-Key": req.idempotencyKey,
        "Api-Version-Date": API_VERSION_DATE,
      },
      body: JSON.stringify({
        destination_account_id: req.destinationAccountId,
        amount: Number(req.amountMinor),
        currency: req.currency,
        description: req.description,
      }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network_error", retryable: true };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return { ok: false, ...classifyError(response.status, body) };
  }

  const parsed = parseTransferResponse(body);
  if (!parsed) return { ok: false, reason: "malformed_response", retryable: false };
  return { ok: true, transfer: parsed };
}

/* -------------------------------------------------------------------------
   Parsing
   ------------------------------------------------------------------------- */

function parseTransferResponse(body: unknown): TransferResponse | null {
  const b = (body ?? {}) as Record<string, unknown>;

  // Whop may use `id` or `transfer_id`
  const id =
    typeof b.id === "string" ? b.id :
    typeof b.transfer_id === "string" ? b.transfer_id : null;

  if (!id) return null;

  const status =
    typeof b.status === "string" ? b.status : "pending";

  const rawAmount =
    typeof b.amount === "number" ? b.amount :
    typeof b.amount_minor === "number" ? b.amount_minor : null;

  return {
    providerTransferId: id,
    providerStatus: status,
    confirmedAmountMinor: rawAmount !== null ? BigInt(Math.round(rawAmount)) : null,
  };
}

function classifyError(
  status: number,
  body: unknown,
): { reason: WhopTransferFailureReason; retryable: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const err = (b.error ?? {}) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : "";
  const type = typeof err.type === "string" ? err.type : "";

  if (status === 403) return { reason: "platforms_access_required", retryable: false };
  if (status === 404) return { reason: "account_not_found", retryable: false };
  if (status === 402) return { reason: "insufficient_funds", retryable: false };

  if (status === 400 || status === 422) {
    if (code.includes("insufficient") || type.includes("insufficient")) {
      return { reason: "insufficient_funds", retryable: false };
    }
    if (code.includes("not_ready") || code.includes("capability")) {
      return { reason: "account_not_ready", retryable: false };
    }
    if (code.includes("amount_too_small") || code.includes("minimum")) {
      return { reason: "amount_too_small", retryable: false };
    }
    if (code.includes("amount_too_large") || code.includes("maximum")) {
      return { reason: "amount_too_large", retryable: false };
    }
    return { reason: "provider_rejected", retryable: false };
  }

  if (status >= 500) return { reason: "provider_error", retryable: true };
  return { reason: "provider_error", retryable: false };
}
