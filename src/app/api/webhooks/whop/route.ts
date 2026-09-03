import {
  processVerifiedWebhook,
  readWebhookId,
  verifyWebhook,
  type WebhookHeaders,
} from "@/lib/server/whop-webhooks";

/* ==========================================================================
   WHOP WEBHOOK ENDPOINT

   Public by necessity — Whop's servers call it — so the body is hostile until
   the signature says otherwise.

   THE RAW BODY IS READ WITH `request.text()` AND VERIFIED BEFORE IT IS
   PARSED. The signature covers the exact bytes Whop sent; `request.json()`
   would reparse and re-serialise them, and verifying a re-serialised body is
   verifying something else. There is no path here that reads JSON first.

   Responses follow Whop's retry contract rather than being uniformly terse:
   a 2xx stops redelivery, anything else invites it. So a valid-but-unmapped
   event is acknowledged (retrying changes nothing), while a storage failure is
   a 500 (retrying is exactly right).
   ========================================================================== */

/** `standardwebhooks` and the postgres driver need Node, not the Edge runtime. */
export const runtime = "nodejs";
/** A webhook must never be served from a cache. */
export const dynamic = "force-dynamic";

/** Whop deliveries are small. Anything larger is not one. */
const MAX_BODY_BYTES = 1_048_576;

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, string>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  const headers: WebhookHeaders = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "unreadable_body" }, 400);
  }

  // Nothing below this line runs on an unverified body.
  const verified = verifyWebhook(rawBody, headers);
  if (!verified.ok) {
    // An unsigned or wrongly signed delivery is never acknowledged. The reason
    // is deliberately coarse: a prober must not learn whether the endpoint has
    // a secret, which header was wrong, or how stale a timestamp was.
    const status = verified.reason === "no_secret" ? 503 : 401;
    return json({ error: "unverified" }, status);
  }

  // The id Whop signed, not one taken from the body. It is the deduplication
  // key, so it must come from the material the signature covered.
  const webhookId = readWebhookId(headers);
  if (!webhookId) return json({ error: "unverified" }, 401);

  const outcome = await processVerifiedWebhook(webhookId, verified.body);

  if (outcome.ack) {
    // 200 with a named outcome. Every one of these means "do not send it
    // again": the event was recorded, and a redelivery would reach the same
    // conclusion. `awaiting_mapping` is not a silent discard — the receipt
    // records that the event arrived and is waiting on business logic.
    return json({ status: outcome.status }, 200);
  }

  // Not acknowledged, so Whop redelivers. Used only where a later attempt
  // could genuinely succeed.
  //
  // `processing_in_flight` is 503 rather than 500: another instance holds a
  // live lease on this exact delivery. Acknowledging would let Whop stop
  // retrying an event whose owner might still die mid-handler; asking for it
  // again brings it back once the lease has been released or gone stale.
  const status = outcome.kind === "processing_in_flight" ? 503 : 500;
  return json({ error: outcome.kind }, status);
}

/**
 * Whop only ever POSTs here. Answering anything else keeps the endpoint from
 * being a probe target that reveals whether it exists.
 */
export async function GET() {
  return json({ error: "method_not_allowed" }, 405);
}
