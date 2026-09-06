import "server-only";

import type { PaymentOrderStatus } from "./payment-orders";

/* ==========================================================================
   THE PAYMENT LIFECYCLE — one place where provider state becomes our state.

   THE PROVIDER IS AUTHORITATIVE, AND THE EVENT NAME IS NOT.

   That distinction is the whole module. A delivery called `payment.failed`
   tells us only that Whop once observed a failure; by the time we read it the
   payment may have been retried and collected. Whop guarantees at-least-once
   delivery and no ordering, so the name on the envelope is a hint about what
   to go and look at, never a fact about where the money is. Every decision
   below is made from `payment.status` as re-fetched from Whop.

   THE CONTRACT, verified against BOTH the installed SDK enum
   (`@whop/sdk` → `ReceiptStatus`) and the published reference
   (docs.whop.com/api-reference/payments/payment.md). The two agree exactly:

       draft          not yet issued
       open           issued, collection outstanding
       authorized     funds held, not captured
       pending        a settlement rail is clearing
       paid           the money moved            <- the only settled state
       void           ended without collecting
       uncollectible  given up on
       unresolved     under dispute/resolution; the money state is ambiguous

   `substatus` (`FriendlyReceiptStatus`, 29 values) is the dashboard's
   human-facing reading and folds in refunds and disputes. It is deliberately
   NOT used to decide an order's state: it mixes concerns this build does not
   implement, and a `refunded` substatus on a `paid` payment must not make an
   order look unpaid before refunds exist.
   ========================================================================== */

/** Every `status` a Whop payment can carry. */
export const WHOP_PAYMENT_STATUSES = [
  "draft",
  "open",
  "authorized",
  "pending",
  "paid",
  "void",
  "uncollectible",
  "unresolved",
] as const;

export type WhopPaymentStatus = (typeof WHOP_PAYMENT_STATUSES)[number];

/**
 * What a provider status means for us, reduced to four cases.
 *
 * `unknown` is a real outcome, not a fallback for tidiness: Whop may add a
 * status, and the safe reading of a status we have never seen is "we do not
 * know", which settles nothing and fails nothing.
 */
export type ProviderPhase = "settled" | "in_flight" | "terminal_unpaid" | "unknown";

/** The one settled state. Note the vocabulary trap: the EVENT is
 * `payment.succeeded`, the RESOURCE says `paid`. */
const SETTLED: ReadonlySet<string> = new Set(["paid"]);

/**
 * Collection is still possible. `unresolved` is here on purpose — a payment
 * under dispute may have collected and may yet be reversed, and calling that
 * "failed" would be a guess in the direction that loses information.
 */
const IN_FLIGHT: ReadonlySet<string> = new Set([
  "draft",
  "open",
  "authorized",
  "pending",
  "unresolved",
]);

/** Whop has stopped trying and no money was collected. */
const TERMINAL_UNPAID: ReadonlySet<string> = new Set(["void", "uncollectible"]);

export function classifyProviderStatus(status: unknown): ProviderPhase {
  if (typeof status !== "string") return "unknown";
  const value = status.trim().toLowerCase();
  if (SETTLED.has(value)) return "settled";
  if (IN_FLIGHT.has(value)) return "in_flight";
  if (TERMINAL_UNPAID.has(value)) return "terminal_unpaid";
  return "unknown";
}

/* -------------------------------------------------------------------------
   ORDER STATE
   ------------------------------------------------------------------------- */

/**
 * ABSORBING STATES. Once an order is here, no provider event moves it.
 *
 *   `paid`      — a verified payment settled it. Whop does not order its
 *                 deliveries, so a `payment.failed` for an earlier attempt
 *                 routinely arrives after the `payment.succeeded` that
 *                 collected. Letting that downgrade the order would un-pay a
 *                 customer who has been charged.
 *   `cancelled` — OUR decision that the order is abandoned. A provider event
 *                 about a payment against a cancelled order is a fact worth
 *                 recording, but it is not permission to revive the order.
 *
 * This is enforced in SQL, not here: every downgrade statement in
 * `payment-orders.ts` carries `status <> 'paid'` and `status <> 'cancelled'`
 * in its WHERE clause. The set below is what the rest of the code reasons
 * with, and the tests assert the two agree.
 */
export const ABSORBING_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set([
  "paid",
  "cancelled",
]);

export function isAbsorbing(status: PaymentOrderStatus): boolean {
  return ABSORBING_ORDER_STATUSES.has(status);
}

/**
 * Where an order should end up given ONLY the provider's own status.
 *
 * Note what is not a parameter: the event name. `payment.created`,
 * `payment.pending` and `payment.failed` all produce the same answer when the
 * provider reports the same status, which is the point — the final state
 * depends on provider truth and not on which delivery happened to arrive.
 *
 * `unknown` maps to `payment_pending`: an unrecognised status means collection
 * has not been ruled out, and the fail-safe direction is "still in flight".
 * Nothing is settled and nothing is failed on a guess.
 */
// Overloaded so a caller that has already ruled out `settled` gets a type that
// cannot be `paid`. Settling an order is a different operation with different
// guarantees — it attaches a payment id under a unique index — and the types
// should not let the two be confused.
export function targetOrderStatus(phase: "settled"): "paid";
export function targetOrderStatus(
  phase: Exclude<ProviderPhase, "settled">,
): "payment_pending" | "failed";
export function targetOrderStatus(
  phase: ProviderPhase,
): "paid" | "payment_pending" | "failed";
export function targetOrderStatus(
  phase: ProviderPhase,
): "paid" | "payment_pending" | "failed" {
  switch (phase) {
    case "settled":
      return "paid";
    case "terminal_unpaid":
      return "failed";
    case "in_flight":
    case "unknown":
      return "payment_pending";
  }
}

/**
 * Whether moving an order from `from` to `to` is permitted.
 *
 * Deliberately NOT a rank comparison. `failed → payment_pending` is a legal
 * and common move (Whop retried the charge), and so is
 * `payment_pending → failed`; a monotonic score would forbid one of them and
 * would be a model of a lifecycle this provider does not have. The real rule
 * is narrow and exact: two states absorb, everything else is reachable from
 * everything else on authoritative evidence.
 */
export function isTransitionAllowed(
  from: PaymentOrderStatus,
  to: PaymentOrderStatus,
): boolean {
  if (from === to) return true;
  // `paid` may still be re-confirmed by a later delivery; that is idempotent,
  // not a transition.
  if (isAbsorbing(from)) return false;
  return true;
}

/**
 * The transitions this build will ever ask for, as a table, so a reader can
 * check the rules without following three call sites. Used by the tests.
 */
export const TRANSITION_RULES: {
  from: PaymentOrderStatus;
  to: PaymentOrderStatus;
  allowed: boolean;
  why: string;
}[] = [
  { from: "created", to: "paid", allowed: true, why: "provider collected" },
  { from: "created", to: "payment_pending", allowed: true, why: "charge in flight" },
  { from: "created", to: "failed", allowed: true, why: "provider gave up" },
  { from: "checkout_created", to: "paid", allowed: true, why: "provider collected" },
  { from: "checkout_created", to: "failed", allowed: true, why: "provider gave up" },
  { from: "payment_pending", to: "paid", allowed: true, why: "settlement cleared" },
  { from: "payment_pending", to: "failed", allowed: true, why: "provider gave up" },
  { from: "failed", to: "paid", allowed: true, why: "a later attempt collected" },
  { from: "failed", to: "payment_pending", allowed: true, why: "provider retried" },
  { from: "paid", to: "failed", allowed: false, why: "would un-pay a charged customer" },
  { from: "paid", to: "payment_pending", allowed: false, why: "settled is final" },
  { from: "paid", to: "created", allowed: false, why: "settled is final" },
  { from: "paid", to: "cancelled", allowed: false, why: "settled is final" },
  { from: "cancelled", to: "paid", allowed: false, why: "abandoned by us; do not revive" },
  { from: "cancelled", to: "payment_pending", allowed: false, why: "abandoned by us" },
  { from: "cancelled", to: "failed", allowed: false, why: "abandoned by us" },
];

/* -------------------------------------------------------------------------
   DELIVERY CLASSIFICATION
   ------------------------------------------------------------------------- */

/**
 * Why a lookup did not produce an answer, and whether asking again could.
 *
 * The distinction that matters operationally: an OUTAGE is a reason to try
 * again, and a DEFINITIVE answer is not. Treating them alike is how a
 * malformed id gets retried until Whop gives up, and how a real outage gets
 * acknowledged as if it had been handled.
 */
export type LookupFailure =
  | "provider_error"
  | "unconfigured"
  | "resource_not_found"
  | "invalid_resource_id";

/** Retrying these can change the answer: the provider was unreachable. */
export const RETRYABLE_LOOKUP_FAILURES: ReadonlySet<LookupFailure> = new Set<LookupFailure>([
  "provider_error",
  "unconfigured",
]);

/**
 * How many times a DEFINITIVE-looking failure is still retried before we stop
 * asking.
 *
 * Not zero, because a 404 immediately after a payment is created is a real and
 * transient thing — read-your-writes across a provider's replicas is not
 * guaranteed. Not unbounded, because an id that genuinely does not exist on
 * this environment (a production id reaching a sandbox key, say) will never
 * start existing, and retrying it forever leaves a receipt churning and hides
 * the real signal.
 *
 * `invalid_resource_id` is exempt and never retried: a value that fails a
 * shape check cannot become well-formed.
 */
export const MAX_DEFINITIVE_LOOKUP_ATTEMPTS = 3;

export function shouldRetryLookup(failure: LookupFailure, deliveryCount: number): boolean {
  if (RETRYABLE_LOOKUP_FAILURES.has(failure)) return true;
  if (failure === "invalid_resource_id") return false;
  return deliveryCount < MAX_DEFINITIVE_LOOKUP_ATTEMPTS;
}
