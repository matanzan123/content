import { createWhopCheckoutForOrder } from "@/lib/server/whop-checkout";
import { getPaymentOrder, isOrderId } from "@/lib/server/payment-orders";
import { createSandboxTestOrder, isSandboxOrderingEnabled } from "@/lib/server/sandbox-orders";
import { buildCheckoutSession, getCheckoutSession } from "@/lib/server/checkout-session";
import { checkRequestOrigin } from "@/lib/server/request-origin";

/* ==========================================================================
   SANDBOX CHECKOUT API — testing infrastructure, sandbox only.

     POST { action: "start", locale? }        -> reuse-or-create an order AND
                                                 its checkout, returning the
                                                 session the embed needs
     GET  ?order_id=…                         -> the same session for an order
                                                 that already exists

   THE BROWSER NAMES AN ORDER AND NOTHING ELSE. There is no amount, currency,
   company, plan, session or payment field in any request — the values in the
   response are read from the order row. A `ch_`/`plan_`/`pay_`/`biz_` value
   sent by a caller is not read anywhere in this file.

   Every response is an explicit DTO assembled field by field. No provider
   object is ever spread into JSON, so a balance, buyer record or billing
   address cannot leak through a field we forgot to strip.

   Outside sandbox the route answers 404 before parsing anything.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Both request shapes are tiny. Anything larger is not one of ours. */
const MAX_BODY_BYTES = 2048;

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** A 404, byte for byte, whatever the reason. */
function notFound() {
  return json({ error: "not_found" }, 404);
}

/** Maps an internal reason to a status. No provider text ever escapes. */
function sessionStatus(reason: string): number {
  if (reason === "order_not_found") return 404;
  if (reason === "already_paid" || reason === "order_closed" || reason === "no_checkout") return 409;
  if (reason === "unconfigured" || reason === "missing_return_url") return 503;
  if (reason === "malformed_provider_reference" || reason === "environment_mismatch") return 409;
  return 400;
}

function readLocale(value: unknown): "en" | "he" {
  return value === "he" ? "he" : "en";
}

export async function POST(request: Request) {
  // The environment gate comes first, before the body is even read.
  if (!isSandboxOrderingEnabled()) return notFound();

  // This action creates provider objects, so it must not be triggerable by a
  // page on another site.
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  if (request.headers.get("content-type")?.includes("application/json") !== true) {
    return json({ error: "invalid_request" }, 415);
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request" }, 400);
  }

  const action = (body as { action?: unknown }).action;
  // A display preference only. Narrowed to the two known values, so it can
  // never become a path segment in the return URL.
  const locale = readLocale((body as { locale?: unknown }).locale);

  if (action !== "start") return json({ error: "invalid_request" }, 400);

  // Reuse-or-create. An untouched test order is handed back rather than
  // duplicated, so a double-click or a refresh cannot accumulate orders.
  const created = await createSandboxTestOrder();
  if (!created.ok) {
    const status = created.reason === "not_sandbox" ? 404 : 503;
    return json({ error: created.reason === "not_sandbox" ? "not_found" : "unavailable" }, status);
  }

  const order = created.order;

  // An order that already carries a checkout returns it untouched — no second
  // provider object for the same order, ever.
  if (order.whopCheckoutId && order.whopPlanId) {
    const existing = buildCheckoutSession(order, locale);
    return existing.ok
      ? json({ ...existing.session, reused: true }, 200)
      : json({ error: existing.reason }, sessionStatus(existing.reason));
  }

  const result = await createWhopCheckoutForOrder(order.orderId, locale);
  if (!result.ok) {
    const status =
      result.reason === "order_not_found" ? 404
      : result.reason === "already_paid" || result.reason === "not_eligible" ? 409
      : result.reason === "provider_error" || result.reason === "unconfigured" || result.reason === "missing_public_url" ? 503
      : 400;
    return json({ error: result.reason }, status);
  }

  // Re-read the order so the DTO is built from stored state, not from the
  // provider response we just received.
  const session = await getCheckoutSession(order.orderId, locale);
  return session.ok
    ? json({ ...session.session, reused: result.reused }, 200)
    : json({ error: session.reason }, sessionStatus(session.reason));
}

/**
 * The session for an order that already exists — how a refreshed page recovers
 * without creating anything. Read-only, and it reports what the DATABASE says,
 * never what a redirect's query string claims.
 */
export async function GET(request: Request) {
  if (!isSandboxOrderingEnabled()) return notFound();

  const url = new URL(request.url);
  const orderId = url.searchParams.get("order_id");
  if (!isOrderId(orderId)) return json({ error: "invalid_request" }, 400);

  const locale = readLocale(url.searchParams.get("locale"));
  const order = await getPaymentOrder(orderId);
  if (!order) return notFound();

  const session = buildCheckoutSession(order, locale);
  if (!session.ok) {
    // A paid or closed order is not an error to the page — it is the answer.
    if (session.reason === "already_paid" || session.reason === "order_closed") {
      return json({ order_id: order.orderId, status: order.status, settled: order.paidAt !== null }, 200);
    }
    return json({ error: session.reason }, sessionStatus(session.reason));
  }
  return json({ ...session.session, reused: true }, 200);
}
