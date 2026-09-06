import "server-only";

/* ==========================================================================
   THE REFUND LIFECYCLE — one place where a provider refund state becomes ours.

   THE PROVIDER IS AUTHORITATIVE, AND THE EVENT NAME IS NOT. This is the same
   rule `payment-lifecycle.ts` states for payments, and it matters more here:
   Whop has exactly TWO refund webhook events, `refund.created` and
   `refund.updated`, and neither of them names an outcome. A refund that failed
   arrives as `refund.updated`, and so does one that succeeded. Deciding
   anything from the event name would be deciding from a name that carries no
   information at all.

   THE CONTRACT, verified against BOTH the installed SDK
   (`@whop/sdk@1.1.0` -> `Refund.Status` / `RefundStatuses`, five values) and
   the published reference (docs.whop.com/api-reference/refunds). The two
   agree exactly:

       pending           the processor has accepted it and is moving the money
       requires_action   stalled awaiting something before it can proceed
       succeeded         the money reached the buyer  <- the only completed one
       failed            the processor could not return it
       canceled          it was called off before completing

   REFUNDS ARE NOT SYNCHRONOUS. This is a real lifecycle, not a formality:
   `POST /payments/{id}/refund` returns the updated PAYMENT, and the refund
   resource it creates begins at `pending`. A refund's outcome genuinely
   arrives later, and this module exists because of that.

   THE VOCABULARY TRAP, and it is the mirror image of the payment one: for a
   PAYMENT the event is `payment.succeeded` and the resource says `paid`; for a
   REFUND the resource says `succeeded` and there is no event of that name.
   ========================================================================== */

/** Every `status` a Whop refund can carry. */
export const WHOP_REFUND_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type WhopRefundStatus = (typeof WHOP_REFUND_STATUSES)[number];

/**
 * What a provider refund status means for us, reduced to four cases.
 *
 * `unknown` is a real outcome and not a tidy-up: Whop may add a status, and
 * the safe reading of one we have never seen is "we do not know", which
 * completes nothing and fails nothing. Every caller that has to choose groups
 * it with `in_flight` — see `postsAccounting`.
 */
export type RefundPhase = "completed" | "in_flight" | "terminal_unrefunded" | "unknown";

/**
 * The one completed state. `succeeded` is the ONLY status that may produce a
 * refund posting; under everything else no money we can prove has moved.
 */
const COMPLETED: ReadonlySet<string> = new Set(["succeeded"]);

/**
 * The refund is still moving. `requires_action` is here rather than with the
 * failures on purpose: it is stalled, not abandoned, and a refund waiting on a
 * step may still complete. Calling it failed would be a guess, and in the
 * direction that hides a liability we still owe.
 */
const IN_FLIGHT: ReadonlySet<string> = new Set(["pending", "requires_action"]);

/** The processor stopped, and nothing was returned to the buyer. */
const TERMINAL_UNREFUNDED: ReadonlySet<string> = new Set(["failed", "canceled"]);

export function classifyRefundStatus(status: unknown): RefundPhase {
  if (typeof status !== "string") return "unknown";
  const value = status.trim().toLowerCase();
  if (COMPLETED.has(value)) return "completed";
  if (IN_FLIGHT.has(value)) return "in_flight";
  if (TERMINAL_UNREFUNDED.has(value)) return "terminal_unrefunded";
  return "unknown";
}

/**
 * WHETHER THIS PHASE MAY WRITE MONEY. Exactly one may.
 *
 * A named function rather than an inline `=== "completed"` at each call site,
 * because this is the most consequential predicate in the refund build: a
 * pending refund that posted would take money out of the ledger the processor
 * may yet decline to move, and a failed refund that posted would take out
 * money that was never returned at all.
 */
export function postsAccounting(phase: RefundPhase): boolean {
  return phase === "completed";
}

/* -------------------------------------------------------------------------
   OUR OWN REFUND STATE
   ------------------------------------------------------------------------- */

/**
 * The local lifecycle status, stored on `payment_refunds`.
 *
 * THREE VALUES, not five. We do not mirror Whop's vocabulary: `pending` and
 * `requires_action` mean the same thing to us (no accounting, keep watching),
 * and so do `failed` and `canceled` (no accounting, stop watching). The raw
 * provider status is stored ALONGSIDE this in `provider_status`, so nothing is
 * lost by the reduction and an operator still sees exactly what Whop said.
 */
export type RefundStatus = "pending" | "completed" | "failed";

export function targetRefundStatus(phase: RefundPhase): RefundStatus {
  switch (phase) {
    case "completed":
      return "completed";
    case "terminal_unrefunded":
      return "failed";
    case "in_flight":
    case "unknown":
      // An unrecognised status has not ruled completion out, and the fail-safe
      // direction is "still moving": nothing is posted, and nothing is filed
      // as finished.
      return "pending";
  }
}

/**
 * THE ABSORBING STATE. Once a refund is `completed`, no provider event moves
 * it.
 *
 *   `completed` — a refund Whop reported as `succeeded` has been accounted
 *                 for. Whop does not order its deliveries, so a
 *                 `refund.updated` carrying an earlier `pending` snapshot can
 *                 and does arrive after the one that reported `succeeded`.
 *                 Letting that downgrade the row would leave a refund posting
 *                 in the ledger with no operational record saying it
 *                 completed — precisely the state reconciliation exists to
 *                 flag.
 *
 * `failed` is deliberately NOT absorbing. It is a terminal PROVIDER state but
 * not an irreversible LOCAL one: if Whop ever reports `succeeded` for a refund
 * we recorded as failed, the provider is right and we are wrong, and the row
 * must be able to move. The money question is settled separately and safely —
 * the posting is idempotent on the refund's own id, so converging a
 * mis-recorded refund posts once and only once.
 *
 * This is enforced in SQL, not here: the downgrade statement in
 * `payment-refunds.ts` carries `status <> 'completed'` in its WHERE clause.
 * The set below is what the rest of the code reasons with, and the tests
 * assert the two agree.
 */
export const ABSORBING_REFUND_STATUSES: ReadonlySet<RefundStatus> = new Set(["completed"]);

export function isRefundAbsorbing(status: RefundStatus): boolean {
  return ABSORBING_REFUND_STATUSES.has(status);
}

/**
 * The transitions this build will ever ask for, as a table, so a reader can
 * check the rules without following three call sites. Used by the tests.
 */
export const REFUND_TRANSITION_RULES: {
  from: RefundStatus;
  to: RefundStatus;
  allowed: boolean;
  why: string;
}[] = [
  { from: "pending", to: "completed", allowed: true, why: "the processor returned the money" },
  { from: "pending", to: "failed", allowed: true, why: "the processor gave up" },
  { from: "pending", to: "pending", allowed: true, why: "still moving; idempotent" },
  { from: "failed", to: "completed", allowed: true, why: "provider truth beats our record" },
  { from: "failed", to: "pending", allowed: true, why: "provider reports it moving again" },
  { from: "completed", to: "pending", allowed: false, why: "a stale snapshot must not un-refund" },
  { from: "completed", to: "failed", allowed: false, why: "a stale snapshot must not un-refund" },
  { from: "completed", to: "completed", allowed: true, why: "redelivery; idempotent" },
];

export function isRefundTransitionAllowed(from: RefundStatus, to: RefundStatus): boolean {
  if (from === to) return true;
  return !isRefundAbsorbing(from);
}

/* -------------------------------------------------------------------------
   FAILURE REASONS
   ------------------------------------------------------------------------- */

/**
 * Whop's normalised failure vocabulary, taken verbatim from the SDK's
 * `Refund.FailureReason`. Stored so an operator can tell a refund that failed
 * because the buyer's card is gone from one that failed because the charge is
 * already disputed — those need different human responses, and collapsing them
 * into "failed" throws away the part that says which.
 *
 * `charge_disputed` is the one to watch: it means the money is moving through
 * a DISPUTE instead, which this build deliberately does not implement. It is
 * recorded and reported, never acted on.
 */
export const WHOP_REFUND_FAILURE_REASONS = [
  "bank_declined",
  "expired_or_canceled_card",
  "lost_or_stolen_card",
  "insufficient_funds",
  "charge_disputed",
  "not_refundable",
  "merchant_request",
  "unknown",
] as const;

export type WhopRefundFailureReason = (typeof WHOP_REFUND_FAILURE_REASONS)[number];

export function isRefundFailureReason(value: unknown): value is WhopRefundFailureReason {
  return (
    typeof value === "string" &&
    (WHOP_REFUND_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------
   LOOKUP FAILURES
   ------------------------------------------------------------------------- */

/**
 * Why a refund lookup did not produce an answer. Mirrors the payment side's
 * `LookupFailure` deliberately: the operational distinction is identical — an
 * OUTAGE can be retried and a DEFINITIVE answer cannot — and the two lists
 * being the same shape is what lets the webhook receiver treat both resource
 * kinds through one retry rule.
 */
export type RefundLookupFailure =
  | "provider_error"
  | "unconfigured"
  | "resource_not_found"
  | "invalid_resource_id";
