import "server-only";

import { WhopError } from "@whop/sdk";
import { getWhopCompanyId, getWhopPaymentsClient } from "./whop-payments";

/* ==========================================================================
   WHOP LEDGER TRANSFERS — server only.

   THE SINGLE PLACE that creates a provider transfer. No other file may call
   `transfers.create`.

   WHAT A LEDGER TRANSFER IS. The installed SDK describes `type: "ledger"` as
   moving "credit between two Whop balances". It is a balance-to-balance move
   from the ClipRewards platform account to a creator's connected account —
   NOT a payout to their bank. Whop handles the onward payout separately, on
   the creator's own schedule. That distinction matters downstream: receiving
   a ledger transfer does not require the creator to have a bank destination.

   WHY THE SDK AND NOT RAW fetch.
   =============================

   This module previously hand-wrote the request body against remembered
   documentation, and it was wrong in six ways at once — including sending
   `amount` in MINOR units where the API takes MAJOR, which would have moved
   100x the intended sum on every transfer. None of it was a type error,
   because a string literal in a fetch body is not type-checked.

   `client.transfers.create()` takes `CreateTransfersRequest`, so a wrong field
   name, a missing required field, or a use case outside the enum is now a
   build error. That is the real fix here; the field names being right today
   is a consequence of it.

   THE CLIENT IS NEVER BUILT HERE. `getWhopPaymentsClient()` sets `baseUrl`
   explicitly per environment; the SDK's own default is production.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Money at the provider boundary
   ------------------------------------------------------------------------- */

/**
 * USD has exactly two decimal places. Not a guess and not configurable — this
 * module is USD-only by design, and the caller enforces that separately.
 */
const USD_SCALE = BigInt(100);
const USD_DECIMALS = 2;

/**
 * The largest provider amount we will construct, as minor units.
 *
 * `amount` crosses the wire as a JSON number, so the converted major value has
 * to stay exactly representable as a double. Ten billion minor units is
 * $100,000,000 — far above any legitimate transfer and far below the point
 * where a two-decimal value loses precision.
 */
const MAX_TRANSFERABLE_MINOR = BigInt(10_000_000_000);

export type AmountConversion =
  | { ok: true; amount: number }
  | { ok: false; reason: "not_positive" | "too_large" };

/**
 * INTERNAL MINOR UNITS -> PROVIDER MAJOR UNITS.
 *
 * `1000n` becomes `10` (ten dollars), never `1000`. The old code passed minor
 * units straight through, which is the single most expensive kind of bug this
 * codebase could have.
 *
 * The division is done in bigint, so there is no floating point anywhere in
 * the decision. Only the final, already-exact value becomes a number.
 */
export function minorToProviderAmount(minor: bigint): AmountConversion {
  if (typeof minor !== "bigint" || minor <= BigInt(0)) return { ok: false, reason: "not_positive" };
  if (minor > MAX_TRANSFERABLE_MINOR) return { ok: false, reason: "too_large" };

  const whole = minor / USD_SCALE;
  const cents = minor % USD_SCALE;
  // Built from a decimal string rather than by dividing, so the value is the
  // exact two-decimal number and not the nearest double to a quotient.
  const amount = Number(`${whole}.${cents.toString().padStart(USD_DECIMALS, "0")}`);

  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "not_positive" };
  return { ok: true, amount };
}

export type MinorConversion =
  | { ok: true; minor: bigint }
  | { ok: false; reason: "not_a_number" | "not_positive" | "sub_cent" | "too_large" };

/**
 * PROVIDER MAJOR UNITS -> INTERNAL MINOR UNITS.
 *
 * `25.01` becomes `2501n`. A value carrying more precision than a cent is
 * REFUSED rather than rounded: silently turning 25.005 into 2501 or 2500
 * invents half a cent of difference between our books and the provider's, and
 * a reconciler would later report it as a mismatch nobody can explain.
 */
export function providerAmountToMinor(amount: unknown): MinorConversion {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { ok: false, reason: "not_a_number" };
  }
  if (amount <= 0) return { ok: false, reason: "not_positive" };

  // toFixed then compare: if rounding to cents changed the value, the provider
  // sent a sub-cent amount we cannot represent.
  const fixed = amount.toFixed(USD_DECIMALS);
  if (Number(fixed) !== amount) return { ok: false, reason: "sub_cent" };

  const [whole, cents] = fixed.split(".");
  const minor = BigInt(whole) * USD_SCALE + BigInt(cents);
  if (minor > MAX_TRANSFERABLE_MINOR) return { ok: false, reason: "too_large" };
  return { ok: true, minor };
}

/* -------------------------------------------------------------------------
   Provider status
   ------------------------------------------------------------------------- */

/**
 * The ONLY three statuses a Whop transfer has, per the installed SDK.
 *
 * `paid`, `completed` and `reversed` were previously treated as transfer
 * statuses. None of them exists on this resource — they belong to other Whop
 * objects — and acting on them meant acting on states the provider never
 * sends.
 */
export const PROVIDER_TRANSFER_STATUSES = ["processing", "succeeded", "failed"] as const;
export type ProviderTransferStatus = (typeof PROVIDER_TRANSFER_STATUSES)[number];

export function isProviderTransferStatus(v: unknown): v is ProviderTransferStatus {
  return typeof v === "string" && (PROVIDER_TRANSFER_STATUSES as readonly string[]).includes(v);
}

/* -------------------------------------------------------------------------
   Result types
   ------------------------------------------------------------------------- */

export type ProviderTransfer = {
  providerTransferId: string;
  status: ProviderTransferStatus;
  /** What the provider says it moved, converted back to minor units. */
  confirmedAmountMinor: bigint | null;
  currency: string | null;
  /** Machine-readable code when the provider reports a failure. */
  failureCode: string | null;
};

/**
 * A failure that is DEFINITIVE: the provider understood us and refused. No
 * money moved, and it is safe to compensate the ledger.
 */
export type DefiniteFailure =
  | "platforms_access_required"
  | "account_not_found"
  | "insufficient_funds"
  | "invalid_amount"
  | "provider_rejected"
  | "malformed_response"
  | "amount_unrepresentable";

/**
 * A failure that is AMBIGUOUS: we do not know whether the provider created the
 * transfer. Treating this as failure is how money moves twice — the record
 * must stay recoverable and be resolved by retrieve or an idempotent retry.
 */
export type AmbiguousFailure = "network_error" | "timeout" | "provider_error";

export type TransferResult =
  | { ok: true; transfer: ProviderTransfer }
  | { ok: false; outcome: "definite"; reason: DefiniteFailure }
  | { ok: false; outcome: "ambiguous"; reason: AmbiguousFailure };

export type CreateLedgerTransferInput = {
  /** The creator's connected `biz_` account. Resolved server-side. */
  destinationId: string;
  /** Internal minor units. Converted to major at the boundary. */
  amountMinor: bigint;
  /** Lowercase ISO 4217. USD only today. */
  currency: string;
  /** The PERSISTED idempotency key for this transfer. Never freshly minted. */
  idempotenceKey: string;
  /** Short note shown in Whop's dashboard. Never a secret or a uid. */
  notes: string;
};

/* -------------------------------------------------------------------------
   Create
   ------------------------------------------------------------------------- */

/**
 * Creates ONE ledger transfer from the platform account to a creator.
 *
 * `origin_id` is the platform company from `WHOP_COMPANY_ID` — server
 * configuration, never a caller's value. `destination_id` is supplied by the
 * caller, which has already resolved it from the creator's session and the
 * trusted environment.
 *
 * The idempotence key is passed through UNCHANGED. Whop documents that
 * "retrying with the same key returns the original transfer ... instead of
 * moving money twice", which is only true if the key is stable across retries
 * — so this module refuses to invent one.
 */
export async function createLedgerTransfer(
  input: CreateLedgerTransferInput,
): Promise<TransferResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: "definite", reason: "provider_rejected" };

  const originId = getWhopCompanyId();
  if (!originId) return { ok: false, outcome: "definite", reason: "provider_rejected" };

  if (!input.idempotenceKey) {
    // Refusing beats moving money with no retry protection.
    return { ok: false, outcome: "definite", reason: "provider_rejected" };
  }

  const converted = minorToProviderAmount(input.amountMinor);
  if (!converted.ok) {
    return { ok: false, outcome: "definite", reason: "amount_unrepresentable" };
  }

  try {
    // Typed by `CreateTransfersRequest`. A wrong field name or a missing
    // required field is a compile error, not a wrong payment.
    const response = await client.transfers.create({
      type: "ledger",
      origin_id: originId,
      destination_id: input.destinationId,
      amount: converted.amount,
      currency: input.currency,
      idempotence_key: input.idempotenceKey,
      notes: input.notes,
    });

    const parsed = parseTransfer(response);
    if (!parsed) return { ok: false, outcome: "definite", reason: "malformed_response" };
    return { ok: true, transfer: parsed };
  } catch (error) {
    return { ok: false, ...classify(error) };
  }
}

/* -------------------------------------------------------------------------
   Retrieve — the authoritative status source
   ------------------------------------------------------------------------- */

/**
 * Reads the current state of a transfer we already created.
 *
 * This is how an ambiguous outcome is resolved and how a `processing` transfer
 * is followed to completion. The SDK says `processing` means the leg is still
 * executing and to poll until it resolves, so the provider — not a webhook
 * guess — is the authority on a transfer's lifecycle.
 */
export async function retrieveTransfer(providerTransferId: string): Promise<TransferResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: "definite", reason: "provider_rejected" };

  try {
    const response = await client.transfers.retrieve({ id: providerTransferId });
    const parsed = parseTransfer(response);
    if (!parsed) return { ok: false, outcome: "definite", reason: "malformed_response" };
    return { ok: true, transfer: parsed };
  } catch (error) {
    return { ok: false, ...classify(error) };
  }
}

/* -------------------------------------------------------------------------
   Parsing and classification
   ------------------------------------------------------------------------- */

function parseTransfer(response: unknown): ProviderTransfer | null {
  const b = (response ?? {}) as Record<string, unknown>;

  const id = typeof b.id === "string" && b.id ? b.id : null;
  if (!id) return null;

  // An unrecognised status is NOT coerced to success. The caller leaves the
  // record recoverable rather than inventing an outcome.
  if (!isProviderTransferStatus(b.status)) return null;

  const amount = providerAmountToMinor(b.amount);

  return {
    providerTransferId: id,
    status: b.status,
    confirmedAmountMinor: amount.ok ? amount.minor : null,
    currency: typeof b.currency === "string" ? b.currency : null,
    failureCode: typeof b.failure_code === "string" ? b.failure_code : null,
  };
}

/**
 * Splits provider errors into DEFINITE and AMBIGUOUS.
 *
 * The split is the whole point: a 4xx means the provider read the request and
 * refused, so nothing moved and the ledger can be compensated. A 5xx, a
 * timeout or a dropped socket means we do not know — the transfer may exist.
 * Compensating there would credit back money that actually left.
 *
 * The error is never logged or returned: an SDK error's `message` embeds the
 * whole response body, and the body can quote the request. Only the status is
 * read.
 */
function classify(
  error: unknown,
): { outcome: "definite"; reason: DefiniteFailure } | { outcome: "ambiguous"; reason: AmbiguousFailure } {
  const status = error instanceof WhopError ? error.statusCode : undefined;

  if (status === 403) return { outcome: "definite", reason: "platforms_access_required" };
  if (status === 404) return { outcome: "definite", reason: "account_not_found" };
  if (status === 402) return { outcome: "definite", reason: "insufficient_funds" };
  if (status === 400 || status === 422) return { outcome: "definite", reason: "invalid_amount" };
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
    return { outcome: "definite", reason: "provider_rejected" };
  }

  // 429 and 5xx are retryable and therefore ambiguous: the provider may have
  // accepted before failing to answer.
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return { outcome: "ambiguous", reason: "provider_error" };
  }

  return { outcome: "ambiguous", reason: "network_error" };
}
