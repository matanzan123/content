import "server-only";

/* ==========================================================================
   THE DISPUTE LIFECYCLE — one place where provider dispute state becomes ours.

   THE PROVIDER IS AUTHORITATIVE, AND THE EVENT NAME IS NOT. Whop has exactly
   two dispute events, `dispute.created` and `dispute.updated`, and neither
   names an outcome: a dispute that was won and one that was lost both arrive
   as `dispute.updated`. Every decision below is made from `dispute.status` as
   re-fetched from Whop.

   TWO STATUS VOCABULARIES, BOTH REAL, AND THE DIFFERENCE MATTERS.

   The modern `Dispute` resource (`disputes.retrieve`, and the `dispute.*`
   webhook payloads) carries `Dispute.Status`, five values:

       needs_response   awaiting our evidence
       under_review     with the processor; also what a dispute past its
                        evidence deadline reports
       won              funds stayed with us
       lost             funds went back to the buyer
       closed           ended without a ruling

   The SDK ALSO exports `DisputeStatuses`, nine values, which adds the
   inquiry/early-warning phase and a catch-all:

       warning_needs_response, warning_under_review, warning_closed, other

   Both are genuine parts of the current contract — the published guide
   describes the `warning_*` set as the early-warning phase — so this module
   recognises all nine rather than pretending the shorter list is the whole
   vocabulary. What it does NOT do is treat them alike: see `classify`.

   THE INQUIRY DISTINCTION IS FINANCIAL, and it is the reason the warning
   states are modelled at all. `Dispute.inquiry` is documented as: "Whether
   this is a pre-dispute inquiry rather than a formal chargeback. Inquiries
   follow the same lifecycle but move no funds unless one escalates."

   So an inquiry can reach `won` or `lost` and still have moved nothing. That
   is exactly the trap this build must not fall into, and it is why NO status
   in this file is allowed to imply an accounting posting. Dispute money is
   never inferred from a status; it is read from the provider's own ledger.
   See `accounting/whop-dispute-posting.ts`.
   ========================================================================== */

/** The five values the modern `Dispute` resource can carry. */
export const WHOP_DISPUTE_STATUSES = [
  "needs_response",
  "under_review",
  "won",
  "lost",
  "closed",
] as const;

export type WhopDisputeStatus = (typeof WHOP_DISPUTE_STATUSES)[number];

/**
 * The four additional values the SDK's broader `DisputeStatuses` enum carries.
 *
 * Recognised, stored, and deliberately NOT collapsed into the five above: a
 * `warning_under_review` is an inquiry the issuer has not escalated, and
 * calling it `under_review` would erase the distinction between a chargeback
 * and a question about one.
 */
export const WHOP_DISPUTE_WARNING_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "other",
] as const;

/** Every value either enum can produce. */
export const ALL_WHOP_DISPUTE_STATUSES = [
  ...WHOP_DISPUTE_STATUSES,
  ...WHOP_DISPUTE_WARNING_STATUSES,
] as const;

/**
 * What a provider dispute status means for us.
 *
 * `unknown` is a real outcome, not a fallback for tidiness: Whop may add a
 * status, and the safe reading of one we have never seen is "we do not know",
 * which resolves nothing.
 */
export type DisputePhase = "open" | "warning" | "resolved" | "unknown";

/** The dispute is live and its outcome is undecided. */
const OPEN: ReadonlySet<string> = new Set(["needs_response", "under_review"]);

/**
 * An inquiry or early warning. Separated from `open` because these move no
 * funds unless one escalates, and an operator triaging a queue needs to see
 * which of their disputes are actually at risk.
 */
const WARNING: ReadonlySet<string> = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
]);

/**
 * The processor has finished. NOTE that this says nothing about whether money
 * moved — `won`, `lost` and `closed` are all resolutions, and an inquiry that
 * reaches `lost` may have moved nothing at all.
 */
const RESOLVED: ReadonlySet<string> = new Set(["won", "lost", "closed"]);

export function classifyDisputeStatus(status: unknown): DisputePhase {
  if (typeof status !== "string") return "unknown";
  const value = status.trim().toLowerCase();
  if (OPEN.has(value)) return "open";
  if (WARNING.has(value)) return "warning";
  if (RESOLVED.has(value)) return "resolved";
  // `other` is Whop's own catch-all for a code it has not categorised. It is
  // a KNOWN value with an UNKNOWN meaning, which is exactly `unknown`.
  return "unknown";
}

/* -------------------------------------------------------------------------
   OUR OWN DISPUTE STATE
   ------------------------------------------------------------------------- */

/**
 * The local lifecycle status, stored on `payment_disputes`.
 *
 * FIVE VALUES, chosen so the set is small, stable and decision-shaped. The raw
 * provider status is stored ALONGSIDE in `provider_status`, so nothing is lost
 * by the reduction and an operator still sees exactly what Whop said.
 *
 *   warning   an inquiry / early-warning phase dispute
 *   open      a formal dispute awaiting an outcome
 *   won       resolved in our favour
 *   lost      resolved against us
 *   closed    resolved with no ruling either way
 */
export type DisputeStatus = "warning" | "open" | "won" | "lost" | "closed";

export function targetDisputeStatus(
  phase: DisputePhase,
  providerStatus: string,
): DisputeStatus {
  const value = providerStatus.trim().toLowerCase();
  switch (phase) {
    case "resolved":
      if (value === "won") return "won";
      if (value === "lost") return "lost";
      return "closed";
    case "warning":
      return "warning";
    case "open":
      return "open";
    case "unknown":
      // An unrecognised status has not resolved anything, and the fail-safe
      // direction is "still open": nothing is marked won, lost or closed on a
      // guess, and the dispute stays visible in the open queue.
      return "open";
  }
}

/**
 * THE ABSORBING STATES. Once a dispute is here, no provider event moves it.
 *
 * Whop does not order its deliveries, so a `dispute.updated` carrying an
 * earlier `needs_response` snapshot can and does arrive after the one that
 * reported `won`. Letting that reopen the dispute would leave a resolved
 * chargeback sitting in the open queue forever.
 *
 * All three resolutions absorb, not just `won` and `lost`. `closed` is a
 * genuine terminal ruling-free ending, and a stale `under_review` arriving
 * after it is exactly as wrong as one arriving after `lost`.
 *
 * This is enforced in SQL, not here: the downgrade statement in
 * `payment-disputes.ts` carries the same rule in its WHERE clause. The set
 * below is what the rest of the code reasons with, and the tests assert the
 * two agree.
 */
export const ABSORBING_DISPUTE_STATUSES: ReadonlySet<DisputeStatus> = new Set([
  "won",
  "lost",
  "closed",
]);

export function isDisputeAbsorbing(status: DisputeStatus): boolean {
  return ABSORBING_DISPUTE_STATUSES.has(status);
}

export function isDisputeTransitionAllowed(
  from: DisputeStatus,
  to: DisputeStatus,
): boolean {
  if (from === to) return true;
  return !isDisputeAbsorbing(from);
}

/**
 * The transitions this build will ever ask for, as a table, so a reader can
 * check the rules without following three call sites. Used by the tests.
 */
export const DISPUTE_TRANSITION_RULES: {
  from: DisputeStatus;
  to: DisputeStatus;
  allowed: boolean;
  why: string;
}[] = [
  { from: "warning", to: "open", allowed: true, why: "the inquiry escalated" },
  { from: "warning", to: "closed", allowed: true, why: "the inquiry ended" },
  { from: "open", to: "won", allowed: true, why: "the processor ruled for us" },
  { from: "open", to: "lost", allowed: true, why: "the processor ruled against us" },
  { from: "open", to: "closed", allowed: true, why: "ended without a ruling" },
  { from: "open", to: "warning", allowed: true, why: "provider truth may correct us" },
  { from: "won", to: "open", allowed: false, why: "a stale event must not reopen it" },
  { from: "won", to: "lost", allowed: false, why: "a stale event must not flip it" },
  { from: "lost", to: "open", allowed: false, why: "a stale event must not reopen it" },
  { from: "lost", to: "won", allowed: false, why: "a stale event must not flip it" },
  { from: "closed", to: "open", allowed: false, why: "a stale event must not reopen it" },
];

/* -------------------------------------------------------------------------
   DISPUTE REASONS
   ------------------------------------------------------------------------- */

/**
 * Whop's normalised dispute reasons, verbatim from `Dispute.Reason`. Stored so
 * an operator can tell a fraud chargeback from a "product not received" one —
 * they need different evidence and different operational responses.
 */
export const WHOP_DISPUTE_REASONS = [
  "fraudulent",
  "unrecognized",
  "declined_authorization",
  "product_not_received",
  "product_unacceptable",
  "subscription_canceled",
  "credit_not_processed",
  "duplicate",
  "processing_error",
  "documentation_request",
  "bank_cannot_process",
  "other",
] as const;

export type WhopDisputeReason = (typeof WHOP_DISPUTE_REASONS)[number];

/* ==========================================================================
   DISPUTE ALERTS — a different subject, deliberately modelled apart.

   AN ALERT IS NOT A DISPUTE. It is an issuer's early report that one may be
   coming, and Whop's own field descriptions are explicit that the two are
   different objects with different consequences. Treating an alert as a
   dispute would double-count every chargeback that arrives with a warning.

   THREE TYPES, verbatim from `DisputeAlert.Type`, and their documented
   financial meaning:

     early_fraud_warning      a fraud report on a settled payment (Visa TC40 /
                              Mastercard SAFE). Refunding still avoids the
                              chargeback. "Whop never charges a fee for one."
     dispute_alert            a pre-dispute notice from the issuer's alert
                              network, "which Whop pays for and passes on as a
                              fee".
     rapid_dispute_resolution a Visa RDR case the network already closed by
                              refunding the payment. Nothing left to act on.

   THE ONLY MONEY AN ALERT CAN MOVE IS A FEE, and the resource says only
   WHETHER one was charged (`fee_charged: boolean`) — never how much. There is
   no amount field for it anywhere on the alert. So an alert NEVER produces a
   journal entry from its own fields; if a fee was really charged it appears as
   a `dispute_alert_fee` line on the provider's ledger, and that line is what
   gets posted. See `accounting/whop-dispute-posting.ts`.

   `DisputeAlert.amount` is the amount the ISSUER reported for the underlying
   transaction. It is not money moving, and it is documented as possibly
   differing from the payment's own amount. It is stored for triage and is
   never posted.
   ========================================================================== */

export const WHOP_DISPUTE_ALERT_TYPES = [
  "early_fraud_warning",
  "dispute_alert",
  "rapid_dispute_resolution",
] as const;

export type WhopDisputeAlertType = (typeof WHOP_DISPUTE_ALERT_TYPES)[number];

/** Why refunding can no longer avoid a chargeback, verbatim from the SDK. */
export const WHOP_ALERT_NOT_ACTIONABLE_REASONS = [
  "network_resolved",
  "payment_unmatched",
  "payment_not_captured",
  "payment_disputed",
  "payment_refunded",
] as const;

/**
 * An alert's local state, reduced to the only question that matters
 * operationally: can refunding still avoid the chargeback?
 *
 *   actionable      yes — a human could still act
 *   not_actionable  no — the window closed, for the recorded reason
 */
export type DisputeAlertStatus = "actionable" | "not_actionable";

export function targetAlertStatus(actionable: unknown): DisputeAlertStatus {
  // Anything other than an explicit `true` is treated as not actionable. A
  // missing or malformed flag must not invite someone to act on a window that
  // may have closed.
  return actionable === true ? "actionable" : "not_actionable";
}

/**
 * WHETHER AN ALERT MAY EVER PRODUCE ACCOUNTING ON ITS OWN. It may not.
 *
 * A named constant rather than an implicit absence, so the rule is greppable
 * and the tests can assert it directly.
 */
export const ALERTS_ARE_OPERATIONAL_ONLY = true as const;

/* ==========================================================================
   RESOLUTION CENTER CASES — a third subject, again modelled apart.

   A CASE IS NOT A REFUND AND NOT A DISPUTE. It is Whop's own mediation
   process, which may END in a refund or escalate into a chargeback — and when
   it does, Whop emits that real financial resource separately. The money
   therefore belongs to the refund (`rf_`) or the dispute (`dspt_`), never to
   the case.

   THE FIELD THAT MAKES THIS SAFE is `ResolutionCenterCase.refund`, documented
   as "Whether money moved and off whose balance: `none`, `merchant`, or
   `platform` (Whop refunded the customer and the merchant kept the funds)" and
   explicitly "Independent of `outcome` — a case the merchant won can still
   carry a platform refund."

   Read that carefully and two rules follow:

     1. `outcome` NEVER implies money. A `customer_won` case with
        `refund: none` moved nothing.
     2. `refund: platform` means WHOP paid, not us. Posting it against our
        provider balance would book someone else's expense as ours.

   So a case posts nothing, ever. It is recorded, linked to its payment, and
   used by reconciliation to check that a case claiming `refund: merchant` has
   a corresponding real refund in our books. That check is the whole point of
   storing cases at all.
   ========================================================================== */

export const WHOP_CASE_STATUSES = [
  "awaiting_merchant",
  "awaiting_customer",
  "under_review",
  "closed",
] as const;

export type WhopCaseStatus = (typeof WHOP_CASE_STATUSES)[number];

export const WHOP_CASE_OUTCOMES = ["customer_won", "merchant_won", "withdrawn"] as const;

export type WhopCaseOutcome = (typeof WHOP_CASE_OUTCOMES)[number];

/** Whose balance a case's refund came off, when one happened at all. */
export const WHOP_CASE_REFUND_SOURCES = ["none", "merchant", "platform"] as const;

export type WhopCaseRefundSource = (typeof WHOP_CASE_REFUND_SOURCES)[number];

export const WHOP_CASE_REASONS = [
  "fraudulent",
  "product_not_received",
  "not_as_described",
  "product_unacceptable",
  "subscription_canceled",
] as const;

/** Our reduction: open, or closed. The outcome is stored separately. */
export type CaseStatus = "open" | "closed";

export function targetCaseStatus(providerStatus: unknown): CaseStatus {
  return typeof providerStatus === "string" && providerStatus.trim().toLowerCase() === "closed"
    ? "closed"
    : "open";
}

/** `closed` absorbs, for the same out-of-order reason disputes do. */
export function isCaseAbsorbing(status: CaseStatus): boolean {
  return status === "closed";
}

/**
 * WHETHER A CASE MAY EVER PRODUCE ACCOUNTING ON ITS OWN. It may not.
 *
 * See the module header: the money belongs to the refund or dispute resource
 * Whop emits separately, and `refund: platform` is not our money at all.
 */
export const CASES_ARE_OPERATIONAL_ONLY = true as const;

/**
 * Whether a case CLAIMS that money came off OUR balance.
 *
 * Not a posting rule — a reconciliation input. When this is true there should
 * be a real refund or dispute in our books for the same payment, and when it
 * is not there should not be. That comparison is what catches a mediated
 * refund we never recorded.
 */
export function caseClaimsMerchantRefund(refundSource: unknown): boolean {
  return refundSource === "merchant";
}

/* -------------------------------------------------------------------------
   LOOKUP FAILURES
   ------------------------------------------------------------------------- */

/**
 * Why a dispute-family lookup did not produce an answer. Mirrors the payment
 * and refund sides deliberately: the operational distinction is identical — an
 * OUTAGE can be retried and a DEFINITIVE answer cannot.
 */
export type DisputeLookupFailure =
  | "provider_error"
  | "unconfigured"
  | "resource_not_found"
  | "invalid_resource_id";
