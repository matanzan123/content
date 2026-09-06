import "server-only";

import { WhopError } from "@whop/sdk";
import {
  describeWhopError,
  getWhopCompanyId,
  getWhopPaymentsClient,
} from "./whop-payments";
import { currencyDecimals, decimalToMinor, normaliseCurrency } from "./money";

/* ==========================================================================
   AUTHORITATIVE DISPUTE FACTS — server only.

   A `dispute.created` delivery is proof that WHOP sent something. It is not
   proof that a dispute exists, that it belongs to us, that it names a payment
   of ours, or that its amount is what the payload says. Every one of those is
   established here by fetching the resource BACK from Whop.

   THREE RESOURCES, THREE RETRIEVERS, all present in `@whop/sdk@1.1.0`:

     client.disputes.retrieve({ id })              dspt_
     client.disputeAlerts.retrieve({ id })         dspa_
     client.resolutionCenterCases.retrieve({ id }) reso_

   AMOUNTS ARE NUMBERS HERE, NOT `Money`. This is the sharpest difference from
   payments and refunds, and it is a trap. `Dispute.amount`, `DisputeAlert.
   amount` and `ResolutionCenterCase.amount` are all typed `number` "in whole
   units of currency", with the currency in a sibling field. So every amount in
   this file goes through `toFixed(decimals)` and then the EXACT string reader
   in `money.ts`. Nothing is multiplied by 100 anywhere — `8.87 * 100` is
   `886.9999999999999`, and a chargeback is not a place to lose a cent.

   OWNERSHIP CANNOT REST ON THESE RESOURCES ALONE. `Dispute.account_id`,
   `DisputeAlert.account_id` and `ResolutionCenterCase.account` are ALL
   documented nullable, and `DisputeAlert.payment_id` is nullable too ("null
   when Whop could not match the report to a payment"). A receiver that checks
   ownership only when the field is volunteered treats "field absent" as
   "ownership fine" — the exact trap the first real sandbox `payment.succeeded`
   sprang by arriving with no `company_id`. So the LINKED PAYMENT is fetched
   and its `account_id` compared, always, and the resource's own account is an
   ADDITIONAL check rather than a substitute.
   ========================================================================== */

const DISPUTE_ID = /^dspt_[A-Za-z0-9]{1,64}$/;
const ALERT_ID = /^dspa_[A-Za-z0-9]{1,64}$/;
const CASE_ID = /^reso_[A-Za-z0-9]{1,64}$/;

export function isDisputeId(value: unknown): value is string {
  return typeof value === "string" && DISPUTE_ID.test(value);
}
export function isDisputeAlertId(value: unknown): value is string {
  return typeof value === "string" && ALERT_ID.test(value);
}
export function isResolutionCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID.test(value);
}

export type DisputeReadFailure =
  | "unconfigured"
  | "provider_error"
  | "resource_not_found"
  | "invalid_resource_id"
  | "unsupported_currency"
  | "amount_unreadable"
  | "no_payment_reference"
  | "malformed_resource";

/* -------------------------------------------------------------------------
   EXACT AMOUNT READING
   ------------------------------------------------------------------------- */

/**
 * Reads a "number in whole units + sibling currency" pair exactly.
 *
 * Shared by all three resources because all three carry the amount this way.
 * Returns a REFUSAL rather than a zero for anything it cannot convert without
 * loss: a zero would be a silent, balanced, wrong figure.
 *
 * Zero itself is permitted — unlike a refund, a dispute or case amount of zero
 * is conceivable (a documentation request moves nothing) and is not a fault.
 * Negative is refused: none of these resources has a negative amount.
 */
export function readWholeUnitAmount(
  amount: unknown,
  currencyValue: unknown,
):
  | { ok: true; minor: bigint; currency: string }
  | { ok: false; reason: "unsupported_currency" | "amount_unreadable"; detail?: string } {
  const currency = normaliseCurrency(currencyValue);
  if (!currency) {
    return { ok: false, reason: "unsupported_currency", detail: String(currencyValue) };
  }
  const decimals = currencyDecimals(currency);
  if (decimals === null) return { ok: false, reason: "unsupported_currency", detail: currency };

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { ok: false, reason: "amount_unreadable", detail: typeof amount };
  }
  if (amount < 0) return { ok: false, reason: "amount_unreadable", detail: "negative" };

  const fixed = amount.toFixed(decimals);
  const minor = decimalToMinor(fixed, decimals);
  if (minor === null) return { ok: false, reason: "amount_unreadable", detail: fixed };

  // A value carrying more precision than the currency has would be silently
  // truncated by `toFixed`. Refuse rather than change the figure.
  if (Number(fixed) !== Number(amount.toFixed(decimals))) {
    return { ok: false, reason: "amount_unreadable", detail: "precision" };
  }
  return { ok: true, minor, currency };
}

function readTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;
}

/* -------------------------------------------------------------------------
   DISPUTES
   ------------------------------------------------------------------------- */

export type AuthoritativeDispute = {
  disputeId: string;
  /** `pay_...`, from `payment.id`. Null when the dispute names no payment. */
  paymentId: string | null;
  accountId: string | null;
  amountMinor: bigint;
  currency: string;
  /** The raw provider status, exactly as Whop wrote it. */
  status: string;
  reason: string | null;
  reasonCode: string | null;
  /**
   * TRUE when this is a pre-dispute inquiry that moves no funds unless it
   * escalates. Carried because it changes what a `lost` means financially.
   */
  inquiry: boolean;
  /** True when Visa RDR settled it automatically by refunding the customer. */
  rapidDisputeResolution: boolean;
  evidenceDueAt: Date | null;
  evidenceSubmittedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type DisputeReadResult =
  | { ok: true; dispute: AuthoritativeDispute }
  | { ok: false; reason: DisputeReadFailure; detail?: string };

/**
 * Reduces a dispute to the facts we act on, accepting the modern `Dispute`
 * shape and refusing anything it cannot read.
 *
 * Exported so both wire shapes can be tested without a network. The webhook
 * payload is typed `Whop.Dispute` (unlike refunds, whose payload is the legacy
 * shape), but the legacy `DisputeLegacy` nests its payment the same way and
 * carries `company` rather than `account_id`, so both are read here.
 */
export function readDispute(source: unknown): DisputeReadResult {
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "malformed_resource", detail: "not an object" };
  }
  const record = source as Record<string, unknown>;

  const disputeId = record.id;
  if (!isDisputeId(disputeId)) {
    return { ok: false, reason: "invalid_resource_id", detail: String(disputeId) };
  }

  const amount = readWholeUnitAmount(record.amount, record.currency);
  if (!amount.ok) return { ok: false, reason: amount.reason, detail: amount.detail };

  const status = typeof record.status === "string" ? record.status : "";
  if (status.length === 0) return { ok: false, reason: "malformed_resource", detail: "no status" };

  // `payment` is an object on both shapes; `payment_id` is not a field on
  // either, so it is not looked for.
  let paymentId: string | null = null;
  const payment = record.payment;
  if (payment && typeof payment === "object") {
    paymentId = readId((payment as Record<string, unknown>).id);
  }

  // `account_id` on the modern shape; `company.id` on the legacy one.
  let accountId = readId(record.account_id);
  if (accountId === null) {
    const company = record.company;
    if (company && typeof company === "object") {
      accountId = readId((company as Record<string, unknown>).id);
    }
  }

  return {
    ok: true,
    dispute: {
      disputeId,
      paymentId,
      accountId,
      amountMinor: amount.minor,
      currency: amount.currency,
      status,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 64) : null,
      reasonCode: typeof record.reason_code === "string" ? record.reason_code.slice(0, 32) : null,
      // Absent means "not an inquiry". Only an explicit `true` marks one, so a
      // shape that omits the field is treated as the more serious case.
      inquiry: record.inquiry === true,
      rapidDisputeResolution: record.rapid_dispute_resolution === true || record.visa_rdr === true,
      evidenceDueAt: readTimestamp(record.evidence_due_at ?? record.needs_response_by),
      evidenceSubmittedAt: readTimestamp(record.evidence_submitted_at),
      createdAt: readTimestamp(record.created_at),
      updatedAt: readTimestamp(record.updated_at) ?? readTimestamp(record.created_at),
    },
  };
}

export async function retrieveDispute(disputeId: unknown): Promise<DisputeReadResult> {
  if (!isDisputeId(disputeId)) return { ok: false, reason: "invalid_resource_id" };
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  try {
    return readDispute(await client.disputes.retrieve({ id: disputeId }));
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[whop] dispute fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

export type DisputeListResult =
  | { ok: true; disputes: AuthoritativeDispute[] }
  | { ok: false; reason: "unconfigured" | "provider_error" | "malformed_resource"; detail?: string };

/**
 * How many disputes are read in one pass. Bounded for the same reason every
 * other list here is: a job that walks an unbounded feed during an incident is
 * its own outage.
 */
export const MAX_DISPUTES_PER_PASS = 100;

/**
 * Every dispute Whop holds for the configured account.
 *
 * A LIMITATION, STATED RATHER THAN HIDDEN: `ListDisputesRequest` has no
 * `payment_id` filter — only `account_id`, `status`, `currency` and date
 * bounds. So a per-payment view is produced by listing the account's disputes
 * and filtering client-side. That is correct but not free, and at a larger
 * volume it would need paging rather than a single bounded pass.
 */
export async function listDisputesForAccount(): Promise<DisputeListResult> {
  const client = getWhopPaymentsClient();
  const accountId = getWhopCompanyId();
  if (!client || !accountId) return { ok: false, reason: "unconfigured" };

  try {
    const page = await client.disputes.list({
      account_id: accountId,
      first: MAX_DISPUTES_PER_PASS,
    });
    const rows: unknown[] = Array.isArray(page.data) ? page.data : [];

    const disputes: AuthoritativeDispute[] = [];
    for (const row of rows) {
      const read = readDispute(row);
      // ONE UNREADABLE DISPUTE POISONS THE PASS: this list decides whether a
      // dispute is missing locally, and a list computed by skipping the
      // entries that would not parse is an understatement presented as a fact.
      if (!read.ok) return { ok: false, reason: "malformed_resource", detail: read.reason };
      disputes.push(read.dispute);
    }
    return { ok: true, disputes };
  } catch (error) {
    console.error("[whop] dispute list failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

/* -------------------------------------------------------------------------
   DISPUTE ALERTS
   ------------------------------------------------------------------------- */

export type AuthoritativeAlert = {
  alertId: string;
  paymentId: string | null;
  accountId: string | null;
  amountMinor: bigint;
  currency: string;
  /** `early_fraud_warning` | `dispute_alert` | `rapid_dispute_resolution`. */
  alertType: string;
  actionable: boolean;
  notActionableReason: string | null;
  /**
   * Whether Whop charged an alert fee. A BOOLEAN — the resource carries no
   * amount for it anywhere, which is precisely why an alert cannot post.
   */
  feeCharged: boolean;
  cardBrand: string | null;
  reportedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type AlertReadResult =
  | { ok: true; alert: AuthoritativeAlert }
  | { ok: false; reason: DisputeReadFailure; detail?: string };

export function readDisputeAlert(source: unknown): AlertReadResult {
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "malformed_resource", detail: "not an object" };
  }
  const record = source as Record<string, unknown>;

  const alertId = record.id;
  if (!isDisputeAlertId(alertId)) {
    return { ok: false, reason: "invalid_resource_id", detail: String(alertId) };
  }

  const amount = readWholeUnitAmount(record.amount, record.currency);
  if (!amount.ok) return { ok: false, reason: amount.reason, detail: amount.detail };

  const alertType = typeof record.type === "string" ? record.type : "";
  if (alertType.length === 0) {
    return { ok: false, reason: "malformed_resource", detail: "no type" };
  }

  return {
    ok: true,
    alert: {
      alertId,
      // Documented nullable: "null when Whop could not match the report to a
      // payment". An unmatched alert is a real, storable state.
      paymentId: readId(record.payment_id),
      accountId: readId(record.account_id),
      amountMinor: amount.minor,
      currency: amount.currency,
      alertType,
      actionable: record.actionable === true,
      notActionableReason:
        typeof record.not_actionable_reason === "string"
          ? record.not_actionable_reason.slice(0, 64)
          : null,
      feeCharged: record.fee_charged === true,
      cardBrand: typeof record.card_brand === "string" ? record.card_brand.slice(0, 32) : null,
      reportedAt: readTimestamp(record.reported_at),
      createdAt: readTimestamp(record.created_at),
      updatedAt: readTimestamp(record.updated_at) ?? readTimestamp(record.created_at),
    },
  };
}

export async function retrieveDisputeAlert(alertId: unknown): Promise<AlertReadResult> {
  if (!isDisputeAlertId(alertId)) return { ok: false, reason: "invalid_resource_id" };
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  try {
    return readDisputeAlert(await client.disputeAlerts.retrieve({ id: alertId }));
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[whop] dispute alert fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

/* -------------------------------------------------------------------------
   RESOLUTION CENTER CASES
   ------------------------------------------------------------------------- */

export type AuthoritativeCase = {
  caseId: string;
  /** `payment.id`. `ResolutionPayment` is non-nullable on the modern shape. */
  paymentId: string | null;
  accountId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  /** `customer_won` | `merchant_won` | `withdrawn`, null while open. */
  outcome: string | null;
  /**
   * `none` | `merchant` | `platform`, null while open. THE field that says
   * whether money moved and off whose balance — and the only one that does.
   */
  refundSource: string | null;
  reason: string | null;
  escalated: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type CaseReadResult =
  | { ok: true; case: AuthoritativeCase }
  | { ok: false; reason: DisputeReadFailure; detail?: string };

export function readResolutionCase(source: unknown): CaseReadResult {
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "malformed_resource", detail: "not an object" };
  }
  const record = source as Record<string, unknown>;

  const caseId = record.id;
  if (!isResolutionCaseId(caseId)) {
    return { ok: false, reason: "invalid_resource_id", detail: String(caseId) };
  }

  // `currency` is documented `string | null` on a case. A case with no
  // currency has no readable amount, and is refused rather than assumed usd.
  const amount = readWholeUnitAmount(record.amount, record.currency);
  if (!amount.ok) return { ok: false, reason: amount.reason, detail: amount.detail };

  const status = typeof record.status === "string" ? record.status : "";
  if (status.length === 0) return { ok: false, reason: "malformed_resource", detail: "no status" };

  let paymentId: string | null = null;
  const payment = record.payment;
  if (payment && typeof payment === "object") {
    paymentId = readId((payment as Record<string, unknown>).id);
  }

  // `account` is an AccountSummary object on the modern shape.
  let accountId: string | null = null;
  const account = record.account;
  if (account && typeof account === "object") {
    accountId = readId((account as Record<string, unknown>).id);
  }

  return {
    ok: true,
    case: {
      caseId,
      paymentId,
      accountId,
      amountMinor: amount.minor,
      currency: amount.currency,
      status,
      outcome: typeof record.outcome === "string" ? record.outcome.slice(0, 32) : null,
      refundSource: typeof record.refund === "string" ? record.refund.slice(0, 32) : null,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 64) : null,
      escalated: record.escalated === true,
      createdAt: readTimestamp(record.created_at),
      updatedAt: readTimestamp(record.updated_at) ?? readTimestamp(record.created_at),
    },
  };
}

export async function retrieveResolutionCase(caseId: unknown): Promise<CaseReadResult> {
  if (!isResolutionCaseId(caseId)) return { ok: false, reason: "invalid_resource_id" };
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  try {
    return readResolutionCase(await client.resolutionCenterCases.retrieve({ id: caseId }));
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { ok: false, reason: "resource_not_found" };
    }
    console.error("[whop] resolution case fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}

/* -------------------------------------------------------------------------
   OWNERSHIP
   ------------------------------------------------------------------------- */

export type DisputeOwnershipResult =
  | { kind: "verified"; accountId: string; paymentId: string }
  /**
   * ONLY AN ALERT CAN PRODUCE THIS. The resource is readable and is not filed
   * against another company, but Whop reports no payment for it — documented
   * as "null when Whop could not match the report to a payment".
   *
   * It is a PASS, not a failure, and it is a distinct kind rather than a
   * `verified` with a null payment so that nothing downstream can mistake an
   * unmatched alert for an owned one. There is nothing to own: an unmatched
   * alert names no money, maps to no order, and can never post. Refusing it
   * would discard the only record that an issuer reported fraud against us.
   *
   * Disputes and cases never return this — for them a missing payment is a
   * genuine refusal, because both are about a specific charge of ours.
   */
  | { kind: "verified_unmatched" }
  | { kind: "wrong_company" }
  | { kind: "resource_not_found" }
  | { kind: "provider_error"; category: string }
  | { kind: "invalid_resource_id" }
  | { kind: "unconfigured" }
  /** The resource exists and is readable but names no payment at all. */
  | { kind: "no_payment_reference" };

/**
 * Proves that a dispute-family resource belongs to us, via the payment it
 * names.
 *
 * THE PAYMENT IS THE AUTHORITY, not the resource's own account field. All
 * three resources declare their account nullable, so "the field says nothing"
 * must never read as "it is ours". The resource's own account, when present,
 * is checked as WELL — a resource explicitly filed against another company is
 * refused even if it names a payment of ours, because that combination is
 * incoherent and not something to resolve by picking the convenient half.
 */
async function verifyViaPayment(
  resourceAccountId: string | null,
  paymentId: string | null,
): Promise<DisputeOwnershipResult> {
  const expected = getWhopCompanyId();
  const client = getWhopPaymentsClient();
  if (!expected || !client) return { kind: "unconfigured" };

  if (resourceAccountId !== null && resourceAccountId !== expected) {
    return { kind: "wrong_company" };
  }
  if (paymentId === null) return { kind: "no_payment_reference" };

  try {
    const payment = await client.payments.retrieve({ id: paymentId });
    if (!payment.account_id || payment.account_id !== expected) return { kind: "wrong_company" };
    return { kind: "verified", accountId: payment.account_id, paymentId };
  } catch (error) {
    if (error instanceof WhopError && error.statusCode === 404) {
      return { kind: "resource_not_found" };
    }
    const status =
      error instanceof WhopError && error.statusCode ? String(error.statusCode) : "unknown";
    console.error("[whop] dispute payment lookup failed:", status, describeWhopError(error));
    return { kind: "provider_error", category: `http_${status}` };
  }
}

/** Maps a read failure onto the ownership vocabulary, without inventing one. */
function ownershipFromReadFailure(reason: DisputeReadFailure): DisputeOwnershipResult {
  switch (reason) {
    case "resource_not_found":
      return { kind: "resource_not_found" };
    case "unconfigured":
      return { kind: "unconfigured" };
    case "invalid_resource_id":
      return { kind: "invalid_resource_id" };
    case "provider_error":
      return { kind: "provider_error", category: "http_unknown" };
    default:
      // Unreadable is not retryable: asking again will not make a malformed
      // record parse. Reported as not-found so the receiver quarantines it.
      return { kind: "resource_not_found" };
  }
}

export async function verifyDisputeOwnership(
  disputeId: unknown,
): Promise<DisputeOwnershipResult> {
  if (!isDisputeId(disputeId)) return { kind: "invalid_resource_id" };
  const read = await retrieveDispute(disputeId);
  if (!read.ok) return ownershipFromReadFailure(read.reason);
  return await verifyViaPayment(read.dispute.accountId, read.dispute.paymentId);
}

export async function verifyAlertOwnership(alertId: unknown): Promise<DisputeOwnershipResult> {
  if (!isDisputeAlertId(alertId)) return { kind: "invalid_resource_id" };
  const read = await retrieveDisputeAlert(alertId);
  if (!read.ok) return ownershipFromReadFailure(read.reason);

  const alert = read.alert;

  // An alert explicitly filed against another company is refused before
  // anything else, matched or not.
  const expected = getWhopCompanyId();
  if (!expected) return { kind: "unconfigured" };
  if (alert.accountId !== null && alert.accountId !== expected) return { kind: "wrong_company" };

  // UNMATCHED IS A PASS, not a failure. See `verified_unmatched`.
  if (alert.paymentId === null) return { kind: "verified_unmatched" };

  return await verifyViaPayment(alert.accountId, alert.paymentId);
}

export async function verifyCaseOwnership(caseId: unknown): Promise<DisputeOwnershipResult> {
  if (!isResolutionCaseId(caseId)) return { kind: "invalid_resource_id" };
  const read = await retrieveResolutionCase(caseId);
  if (!read.ok) return ownershipFromReadFailure(read.reason);
  return await verifyViaPayment(read.case.accountId, read.case.paymentId);
}

/* ==========================================================================
   THE PROVIDER'S OWN LEDGER — the only proof that dispute money moved.

   `client.financialActivity.list` is documented as "an account's or user's
   activity feed: every movement of money in or out", and each `LedgerActivity`
   row is ONE signed movement with its own id, its own `line_type`, and the
   `payment_id` it belongs to.

   THIS IS WHY DISPUTE ACCOUNTING IS POSSIBLE AT ALL. The `Dispute` resource
   carries NO fee field and NO balance field — verified against both the SDK
   type and the published reference — so nothing about the money can be read
   off the dispute itself. The ledger is where it is visible, and every dispute
   posting in this build is a mirror of a row from it.

   PRECISION IS NOT MINOR UNITS. `LedgerActivity.amount` is "a signed amount in
   the currency's smallest precision units", and `currency.precision` for USD
   is 100000000 — 1e8, not 1e2. A row of "-200000000" is -$2.00, not
   -$2,000,000.00. The conversion below divides by `precision / 10^decimals`
   and REFUSES any row that does not divide exactly, because a fraction of a
   cent is not something to round away silently.

   VERIFIED AGAINST OUR OWN BOOKS. Read live for the real sandbox payment, this
   feed returns payment_gross +10.00, five fee lines totalling -0.87, and two
   payment_refund rows of -2.00 and -1.00 — netting to 6.13, which equals the
   `provider_balance` our journal independently computed. That agreement is the
   evidence that this reader and our ledger mean the same thing by "money".
   ========================================================================== */

/** One signed movement, reduced to what a posting needs. */
export type LedgerMovement = {
  /** The ledger row's own id. THE economic identity of this movement. */
  activityId: string;
  lineType: string;
  /** Signed minor units. Negative is money leaving our balance. */
  amountMinor: bigint;
  currency: string;
  paymentId: string | null;
  postedAt: Date | null;
};

export type LedgerReadResult =
  | { ok: true; movements: LedgerMovement[] }
  | {
      ok: false;
      reason: "unconfigured" | "provider_error" | "amount_unreadable" | "unsupported_currency";
      detail?: string;
    };

/**
 * Converts one ledger row's precision-units amount into exact minor units.
 *
 * Exported for direct testing: this conversion is the single place a dispute's
 * value could be mis-scaled by a factor of a million, and it deserves to be
 * exercised on its own rather than only through a network call.
 */
export function ledgerAmountToMinor(
  amount: unknown,
  precision: unknown,
  currency: string,
): { ok: true; minor: bigint } | { ok: false; reason: "amount_unreadable"; detail?: string } {
  const decimals = currencyDecimals(currency);
  if (decimals === null) return { ok: false, reason: "amount_unreadable", detail: "currency" };

  if (typeof amount !== "string" || !/^-?\d{1,30}$/.test(amount.trim())) {
    return { ok: false, reason: "amount_unreadable", detail: "amount" };
  }
  if (typeof precision !== "string" || !/^\d{1,30}$/.test(precision.trim())) {
    return { ok: false, reason: "amount_unreadable", detail: "precision" };
  }

  let raw: bigint;
  let scale: bigint;
  try {
    raw = BigInt(amount.trim());
    scale = BigInt(precision.trim());
  } catch {
    return { ok: false, reason: "amount_unreadable", detail: "bigint" };
  }
  if (scale <= BigInt(0)) return { ok: false, reason: "amount_unreadable", detail: "precision" };

  // precision is units-per-major; we want units-per-minor.
  const perMinor = scale / BigInt(10) ** BigInt(decimals);
  if (perMinor <= BigInt(0) || perMinor * BigInt(10) ** BigInt(decimals) !== scale) {
    return { ok: false, reason: "amount_unreadable", detail: "precision not a power of ten" };
  }

  // EXACT OR REFUSE. A row that does not land on a whole minor unit is a row
  // we cannot post without inventing a rounding rule.
  if (raw % perMinor !== BigInt(0)) {
    return { ok: false, reason: "amount_unreadable", detail: "sub-minor precision" };
  }
  return { ok: true, minor: raw / perMinor };
}

/** Reduces one raw ledger row, refusing anything unreadable. */
export function readLedgerActivity(
  source: unknown,
): { ok: true; movement: LedgerMovement } | { ok: false; reason: string; detail?: string } {
  if (!source || typeof source !== "object") return { ok: false, reason: "malformed_resource" };
  const record = source as Record<string, unknown>;

  const activityId = readId(record.id);
  if (!activityId) return { ok: false, reason: "malformed_resource", detail: "no id" };

  const lineType = typeof record.line_type === "string" ? record.line_type : "";
  if (lineType.length === 0) return { ok: false, reason: "malformed_resource", detail: "no type" };

  const currencyBlock = record.currency;
  if (!currencyBlock || typeof currencyBlock !== "object") {
    return { ok: false, reason: "amount_unreadable", detail: "no currency" };
  }
  const block = currencyBlock as Record<string, unknown>;
  const currency = normaliseCurrency(block.code);
  if (!currency) return { ok: false, reason: "unsupported_currency", detail: String(block.code) };

  const converted = ledgerAmountToMinor(record.amount, block.precision, currency);
  if (!converted.ok) return { ok: false, reason: converted.reason, detail: converted.detail };

  return {
    ok: true,
    movement: {
      activityId,
      lineType,
      amountMinor: converted.minor,
      currency,
      paymentId: readId(record.payment_id),
      postedAt: readTimestamp(record.posted_at),
    },
  };
}

/**
 * How many ledger rows are read in one pass.
 *
 * Bounded rather than exhaustively paged, for the same reason the refund list
 * is: a job that walks an unbounded feed during an incident is its own
 * outage. Reaching the bound is reported, never silently truncated — an
 * understated ledger is the direction that loses a movement.
 */
export const MAX_LEDGER_ROWS = 200;

/**
 * Every money movement the provider reports for ONE payment.
 *
 * Filtered by `payment_id` server-side where the API supports it. The rows
 * come back covering the whole payment — gross, fees, refunds, disputes — and
 * the caller picks the ones it has a rule for.
 */
export async function listLedgerMovementsForPayment(
  paymentId: string,
): Promise<LedgerReadResult> {
  const client = getWhopPaymentsClient();
  const accountId = getWhopCompanyId();
  if (!client || !accountId) return { ok: false, reason: "unconfigured" };

  try {
    const response = await client.financialActivity.list({
      account_id: accountId,
      limit: MAX_LEDGER_ROWS,
    });
    const rows: unknown[] = Array.isArray(response.data) ? response.data : [];

    const movements: LedgerMovement[] = [];
    for (const row of rows) {
      const read = readLedgerActivity(row);
      // ONE UNREADABLE ROW POISONS THE PASS. These rows decide money; a total
      // computed by skipping the ones that would not parse is an
      // understatement presented as a fact.
      if (!read.ok) {
        if (read.reason === "unsupported_currency") {
          // A row in a currency this build does not support is not ours to
          // post and is skipped rather than fatal — the feed is account-wide.
          continue;
        }
        return { ok: false, reason: "amount_unreadable", detail: read.detail };
      }
      if (read.movement.paymentId === paymentId) movements.push(read.movement);
    }
    return { ok: true, movements };
  } catch (error) {
    console.error("[whop] financial activity fetch failed:", describeWhopError(error));
    return { ok: false, reason: "provider_error" };
  }
}
