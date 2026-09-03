import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import { getDb } from "@/lib/db";
import { whopWebhookReceipts } from "@/lib/db/schema";
import {
  describeWhopError,
  getWhopCompanyId,
  getWhopEnvironment,
  getWhopWebhookSecret,
} from "./whop-payments";
import { verifyPaymentOwnership } from "./whop-resources";

/* ==========================================================================
   WHOP WEBHOOK RECEIVER — server only.

   Four things happen here, in this order, and the order is the security
   property:

     1. VERIFY the raw bytes against the endpoint's signing secret. Nothing
        below this line runs on an unverified body.
     2. CHECK the event belongs to the configured company.
     3. RECORD the delivery durably, keyed by the Standard Webhooks message id.
        The database decides who wins a race; the application never does.
     4. DISPATCH to a handler.

   Whop delivers AT LEAST ONCE and does not guarantee order, so step 3 is not
   optional bookkeeping — it is the only thing standing between a redelivery
   and a double effect once handlers do real work.

   NOTHING HERE WRITES `financial_ledger`. There is no ClipRewards checkout,
   order or campaign mapping yet, so a `payment.succeeded` cannot be turned
   into revenue, funding or creator earnings without inventing the
   relationship. The handlers below say so explicitly rather than dropping the
   event or guessing.
   ========================================================================== */

/* ------------------------------ event names ------------------------------ */

/**
 * The financial events this build recognises, taken verbatim from the SDK's
 * `WebhookEvent` enum — not guessed. A signed event outside this list is
 * recorded as `unsupported`, which is deterministic and cannot create money.
 */
export const SUPPORTED_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "payment.pending",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "payout.created",
  "payout.updated",
  "payout.reversed",
] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

const SUPPORTED = new Set<string>(SUPPORTED_EVENTS);

export function isSupportedEvent(name: unknown): name is SupportedEvent {
  return typeof name === "string" && SUPPORTED.has(name);
}

/* ------------------------------- outcomes -------------------------------- */

/**
 * What the endpoint should answer. `ack` means Whop should stop retrying;
 * `reject` means refuse the delivery; `retry` means we failed and want it
 * again. A verified event is never silently dropped: every branch produces a
 * named outcome.
 */
export type WebhookOutcome =
  | { ack: true; status: "accepted" | "duplicate" | "awaiting_mapping" | "unsupported" | "rejected_company" }
  | {
      ack: false;
      kind: "unverified" | "unconfigured" | "storage_unavailable" | "processing_failed" | "processing_in_flight";
    };

export type WebhookHeaders = Record<string, string>;

/* ---------------------------- payload reading ---------------------------- */

/**
 * Reads the few fields we keep, defensively. The payload is verified but not
 * schema-checked: Whop can add or reshape fields, and a receiver that throws
 * on an unfamiliar body would turn a harmless product change into an outage.
 */
function readString(source: unknown, ...keys: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 255) return value;
  }
  return null;
}

type Envelope = {
  eventType: string;
  resourceId: string | null;
  companyId: string | null;
};

/** Pulls the delivery envelope out of a verified body. */
export function readEnvelope(body: unknown): Envelope {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.object ?? null) as Record<string, unknown> | null;

  return {
    eventType: readString(root, "event", "type", "event_type") ?? "unknown",
    resourceId: readString(data, "id") ?? readString(root, "id"),
    companyId:
      readString(data, "company_id", "company", "biz_id") ?? readString(root, "company_id"),
  };
}

/**
 * The message id Whop signed. Case-insensitive, because header casing is not
 * guaranteed across proxies.
 */
export function readWebhookId(headers: WebhookHeaders): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "webhook-id" && typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 255);
    }
  }
  return null;
}

/* ----------------------------- verification ------------------------------ */

export type VerifyResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "no_secret" | "invalid_signature" };

/**
 * Verifies the RAW body with the official helper, which implements Standard
 * Webhooks via the `standardwebhooks` package: it reads `webhook-id`,
 * `webhook-timestamp` and `webhook-signature`, enforces the timestamp
 * tolerance window, and compares signatures in constant time. A missing or
 * malformed header, a stale timestamp, a tampered body and a wrong signature
 * all land in the same rejection, which is the point — a caller must not be
 * able to tell them apart.
 *
 * With no secret configured this returns `no_secret` and the endpoint refuses
 * every delivery. There is deliberately no unverified path.
 */
export function verifyWebhook(rawBody: string, headers: WebhookHeaders): VerifyResult {
  const secret = getWhopWebhookSecret();
  if (!secret) return { ok: false, reason: "no_secret" };

  try {
    return { ok: true, body: unwrapWebhook(rawBody, { headers, key: secret }) };
  } catch (error) {
    // Never log the error itself: a verification failure can quote the
    // signature material it was comparing.
    if (error instanceof WebhookVerificationError || error instanceof Error) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: false, reason: "invalid_signature" };
  }
}

/* ------------------------- handler boundary (no money) -------------------- */

/**
 * What a handler can report today. `business_mapping_not_implemented` is an
 * honest terminal state, not a failure: the event is understood and recorded,
 * and there is simply no ClipRewards order to attach it to yet.
 */
export type HandlerResult =
  | { kind: "business_mapping_not_implemented" }
  | { kind: "handled" }
  | { kind: "failed"; category: string };

/**
 * The seam the next phase fills in. Each handler will eventually resolve the
 * Whop resource to a ClipRewards campaign or order and write ONE
 * `financial_ledger` row, idempotently, keyed on the provider reference. None
 * of them writes anything today, and none may until that mapping exists —
 * revenue attributed to a campaign nobody can name is worse than no revenue.
 */
export async function handleWhopPaymentSucceeded(): Promise<HandlerResult> {
  return { kind: "business_mapping_not_implemented" };
}

export async function handleWhopPaymentFailed(): Promise<HandlerResult> {
  return { kind: "business_mapping_not_implemented" };
}

export async function handleWhopRefundCreated(): Promise<HandlerResult> {
  return { kind: "business_mapping_not_implemented" };
}

export async function handleWhopDisputeCreated(): Promise<HandlerResult> {
  return { kind: "business_mapping_not_implemented" };
}

export async function handleWhopPayoutUpdated(): Promise<HandlerResult> {
  return { kind: "business_mapping_not_implemented" };
}

/**
 * Events whose resource must be proved to belong to us BEFORE any handler
 * runs. These are the ones that will eventually move money.
 *
 * The other supported events name refunds, disputes and payouts — different
 * resource types with their own lookups. They cannot write money today either,
 * and each will join this gate as its own resolver is written. None of them
 * may be connected to `financial_ledger` before that happens.
 */
const OWNERSHIP_GATED = new Set<string>(["payment.succeeded", "payment.failed", "payment.pending"]);

const HANDLERS: Record<SupportedEvent, () => Promise<HandlerResult>> = {
  "payment.succeeded": handleWhopPaymentSucceeded,
  "payment.failed": handleWhopPaymentFailed,
  "payment.pending": handleWhopPaymentFailed,
  "refund.created": handleWhopRefundCreated,
  "refund.updated": handleWhopRefundCreated,
  "dispute.created": handleWhopDisputeCreated,
  "dispute.updated": handleWhopDisputeCreated,
  "payout.created": handleWhopPayoutUpdated,
  "payout.updated": handleWhopPayoutUpdated,
  "payout.reversed": handleWhopPayoutUpdated,
};

/* ------------------------------ processing -------------------------------- */

/**
 * States a delivery never needs to be processed from again. Reaching one of
 * these is what releases the processing lease.
 */
export const TERMINAL_STATUSES = [
  "processed",
  "awaiting_mapping",
  "unsupported",
  "rejected_company",
] as const;

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/**
 * How long an instance may hold a delivery before another may take it over.
 *
 * A serverless function that has not finished in this long is dead, not slow:
 * platform execution limits are far shorter. The window only has to exceed the
 * longest legitimate handler run, and every value below it trades a stuck
 * webhook for a possible double execution — so it is deliberately generous.
 */
export const PROCESSING_LEASE_SECONDS = 5 * 60;

/**
 * EVERY receipt timestamp comes from Postgres, never from this process.
 *
 * `received_at` already defaulted to the database's `now()`. When
 * `processed_at` was stamped with a JS `Date`, the two came from different
 * clocks — the first real delivery recorded a receipt processed 229ms BEFORE
 * it arrived, purely from skew between this machine and Neon. A lifecycle that
 * can run backwards is not one anybody can reason about, and the lease
 * comparison inherited the same flaw: a local clock running fast would expire
 * a lease that was still live.
 */
const dbNow = sql`now()`;

/**
 * Records and dispatches ONE verified delivery.
 *
 * ACQUISITION IS ATOMIC, IN TWO SHAPES, AND NEVER A READ-THEN-DECIDE:
 *
 *   1. `insert … on conflict (webhook_id) do nothing … returning` — a first
 *      delivery. A returned row means we own it; nothing returned means the
 *      row already exists.
 *   2. `update … where webhook_id = $1 and (retryable) … returning` — a
 *      redelivery. The eligibility test lives in the WHERE clause, so Postgres
 *      takes a row lock and evaluates it against the committed state. Two
 *      instances racing on the same `failed` receipt cannot both match: the
 *      loser re-reads the row the winner just committed, sees `received` with
 *      a fresh lease, and its WHERE no longer holds.
 *
 * A row only reaches a terminal status after its handler has actually
 * returned. `failed` is not terminal, so a redelivery may retry it. Neither is
 * a `received` row whose lease has expired — that is an instance that died
 * mid-handler, and without that rule a verified payment would be stuck in
 * `received` forever.
 *
 * A delivery that arrives while another instance holds a LIVE lease is not
 * acknowledged. Answering 2xx there would let Whop stop retrying an event
 * whose owner may still crash; a non-2xx brings it back after the lease has
 * either been released or gone stale.
 */
export async function processVerifiedWebhook(
  webhookId: string,
  body: unknown,
): Promise<WebhookOutcome> {
  const db = getDb();
  // Fail closed: with no database we cannot deduplicate, and processing an
  // event we cannot record is how a redelivery becomes a double effect.
  if (!db) return { ack: false, kind: "storage_unavailable" };

  const environment = getWhopEnvironment();
  if (!environment) return { ack: false, kind: "unconfigured" };

  const { eventType, resourceId, companyId } = readEnvelope(body);

  // A verified event for someone else's company is quarantined, not processed.
  // It is still acknowledged: the signature was valid, so retrying it would
  // only repeat the same conclusion.
  const expectedCompany = getWhopCompanyId();
  const wrongCompany = Boolean(companyId && expectedCompany && companyId !== expectedCompany);

  const supported = isSupportedEvent(eventType);
  const initialStatus = wrongCompany ? "rejected_company" : supported ? "received" : "unsupported";

  // (1) First delivery. The primary key decides the winner, not the caller.
  const claimed = await db
    .insert(whopWebhookReceipts)
    .values({
      webhookId,
      eventType,
      resourceId,
      companyId,
      environment,
      status: initialStatus,
      claimedAt: initialStatus === "received" ? dbNow : null,
      processedAt: initialStatus === "received" ? null : dbNow,
    })
    .onConflictDoNothing({ target: whopWebhookReceipts.webhookId })
    .returning({ webhookId: whopWebhookReceipts.webhookId });

  if (claimed.length === 0) {
    // (2) Redelivery. One statement decides ownership AND counts the delivery:
    // eligible only when the previous attempt failed, or when it claimed the
    // row and then died without releasing it.
    const reclaimed = await db
      .update(whopWebhookReceipts)
      .set({
        status: "received",
        claimedAt: dbNow,
        failureCategory: null,
        deliveryCount: sql`${whopWebhookReceipts.deliveryCount} + 1`,
      })
      .where(
        and(
          eq(whopWebhookReceipts.webhookId, webhookId),
          or(
            eq(whopWebhookReceipts.status, "failed"),
            and(
              eq(whopWebhookReceipts.status, "received"),
              or(
                isNull(whopWebhookReceipts.claimedAt),
                // Compared entirely inside Postgres, so the lease window is
                // measured against the same clock that stamped it.
                sql`${whopWebhookReceipts.claimedAt} < now() - make_interval(secs => ${PROCESSING_LEASE_SECONDS})`,
              ),
            ),
          ),
        ),
      )
      .returning({ webhookId: whopWebhookReceipts.webhookId });

    if (reclaimed.length === 0) {
      // Not eligible: either already terminal, or someone holds a live lease.
      // Count the delivery and read the status in the SAME statement, so the
      // answer cannot be stale by the time it is used.
      const [current] = await db
        .update(whopWebhookReceipts)
        .set({ deliveryCount: sql`${whopWebhookReceipts.deliveryCount} + 1` })
        .where(eq(whopWebhookReceipts.webhookId, webhookId))
        .returning({ status: whopWebhookReceipts.status });

      // Terminal: the work is done, and repeating it is exactly what must not
      // happen. Acknowledge so Whop stops.
      if (current && TERMINAL.has(current.status)) return { ack: true, status: "duplicate" };

      // In flight elsewhere, or the row vanished under us. Do NOT acknowledge:
      // ask for the delivery again once the lease has resolved either way.
      return { ack: false, kind: "processing_in_flight" };
    }
    // Reclaimed: we now own a previously failed or abandoned delivery.
  }

  if (wrongCompany) return { ack: true, status: "rejected_company" };
  if (!supported) return { ack: true, status: "unsupported" };

  // AUTHORITATIVE OWNERSHIP, before any handler.
  //
  // The payload's own `company_id` is a courtesy, not evidence — the first
  // real sandbox delivery omitted it entirely. For every event that will one
  // day move money, the resource is fetched back from Whop and its owning
  // account compared to ours. This sits between the receipt and the dispatch
  // so a future handler cannot run without it having passed: the only route to
  // `HANDLERS` is through this gate.
  if (OWNERSHIP_GATED.has(eventType)) {
    const ownership = await verifyPaymentOwnership(resourceId);

    if (ownership.kind !== "verified") {
      // Whop signed it, but it is not ours: quarantine terminally. Retrying
      // would reach the same answer.
      if (ownership.kind === "wrong_company") {
        await db
          .update(whopWebhookReceipts)
          .set({
            status: "rejected_company",
            failureCategory: "ownership_mismatch",
            processedAt: dbNow,
            claimedAt: null,
          })
          .where(eq(whopWebhookReceipts.webhookId, webhookId));
        return { ack: true, status: "rejected_company" };
      }

      // Could not PROVE ownership — the lookup failed, the id was malformed,
      // or credentials are missing. Fail closed and keep the receipt
      // retryable: an unprovable payment must never reach a money handler, and
      // must never be quietly acknowledged as done either.
      await db
        .update(whopWebhookReceipts)
        .set({ status: "failed", failureCategory: ownership.kind, claimedAt: null })
        .where(eq(whopWebhookReceipts.webhookId, webhookId));
      return { ack: false, kind: "processing_failed" };
    }
  }

  try {
    const result = await HANDLERS[eventType]();

    if (result.kind === "failed") {
      await db
        .update(whopWebhookReceipts)
        .set({ status: "failed", failureCategory: result.category, claimedAt: null })
        .where(eq(whopWebhookReceipts.webhookId, webhookId));
      return { ack: false, kind: "processing_failed" };
    }

    const status = result.kind === "handled" ? "processed" : "awaiting_mapping";
    await db
      .update(whopWebhookReceipts)
      .set({ status, processedAt: dbNow, failureCategory: null, claimedAt: null })
      .where(eq(whopWebhookReceipts.webhookId, webhookId));

    return { ack: true, status: status === "processed" ? "accepted" : "awaiting_mapping" };
  } catch (error) {
    // The category is a label, never the message — an SDK or driver error can
    // quote a request, and a request carries credentials.
    await db
      .update(whopWebhookReceipts)
      .set({ status: "failed", failureCategory: "handler_exception", claimedAt: null })
      .where(eq(whopWebhookReceipts.webhookId, webhookId));
    console.error("[whop] webhook handler failed:", describeWhopError(error));
    return { ack: false, kind: "processing_failed" };
  }
}
