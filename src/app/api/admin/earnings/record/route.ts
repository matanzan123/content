import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { recordCreatorEarning } from "@/lib/server/creator-earnings";
import { resolvePlatformConfig } from "@/lib/server/whop-accounts";
import { checkRateLimit } from "@/lib/server/rate-limit";

/**
 * $1,000,000 in minor units.
 *
 * A CEILING, NOT A BUSINESS RULE. This endpoint mints an obligation the
 * platform then owes, and `Number.isInteger` alone accepts 1e15 as happily as
 * it accepts 5000. One mistyped amount would credit a creator a sum no
 * withdrawal cap downstream would question, because every one of those caps
 * limits what LEAVES rather than what is owed. Refusing here is the only place
 * the typo is still cheap.
 */
const MAX_GROSS_MINOR = 100_000_000;

/* ==========================================================================
   POST /api/admin/earnings/record

   Records a creator earning from a settled brand payment.

   THE AMOUNT AND CURRENCY ARE NOT INPUTS. They are read from the payment's
   posted `payment_settled` transaction: the suspense credit it created, which
   is economically `total - tax`, and the provider's settlement currency. This
   endpoint used to take both from the body — an admin could allocate any figure
   they typed, in the only currency the route would accept, against a settlement
   that said something else entirely. A taxed payment allocated at its `total`
   would have paid creator and platform out of money owed to a tax authority.

   Body (JSON):
     firebase_uid    string  — target creator
     whop_payment_id string  — the Whop payment that settled
     order_id?       string  — ASSERTION: must match the order the settlement
                               was posted against, when it named one
     gross_minor?    number  — ASSERTION ONLY: compared against the settlement's
                               suspense credit. A mismatch is a 409, never a
                               silently-ignored value and never the amount used
     currency?       string  — ASSERTION ONLY: compared against the settlement's
                               currency. Any supported currency, not just USD
     settled_at?     string  — ISO 8601; defaults to now if omitted. The hold
                               clock only; not a money figure
     description?    string  — label in the journal

   Guards:
     1. ADMIN-ONLY via withAdminApi (Firebase admin custom claim)
     2. Request origin check (same-origin / CSRF guard)
     3. Rate limited per admin
     4. The settlement journal is the authority for amount and currency
     5. Dry-run not supported — all calls write a real row
        (idempotency handles repeated calls for the same payment)
   ========================================================================== */

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return withAdminApi(async (adminCtx) => {
    // RATE LIMITED PER ADMIN, not per IP: the identity that matters here is
    // the authenticated admin, and a shared office IP would otherwise let one
    // admin's runaway script exhaust everyone else's budget. Keyed the same
    // way as the transfer and withdrawal routes so the three read alike.
    const rl = await checkRateLimit(`admin:earnings_record:${adminCtx.uid}`, 60);
    if (!rl.ok) return { error: "rate_limited" };

    const firebaseUid = body.firebase_uid;
    const whopPaymentId = body.whop_payment_id;
    const grossRaw = body.gross_minor;
    const currencyRaw = body.currency;

    if (typeof firebaseUid !== "string" || !firebaseUid) return { error: "missing_firebase_uid" };
    if (typeof whopPaymentId !== "string" || !whopPaymentId) return { error: "missing_whop_payment_id" };

    /* `gross_minor` AND `currency` ARE NOW ASSERTIONS, kept for compatibility
     * with existing callers and validated exactly as strictly as before. What
     * changed is what they are FOR: they are compared against the settlement and
     * a disagreement is refused, rather than being used as the amount.
     *
     * Both are optional. A caller that omits them gets the settlement's figures,
     * which is the correct behaviour and the one new callers should use. */
    let expectedGrossAmountMinor: bigint | undefined;
    if (grossRaw !== undefined && grossRaw !== null) {
      // `Number.isInteger` is the NaN and Infinity guard as well as the integer
      // one: both are numbers, neither is an integer, and both would otherwise
      // reach `BigInt()` and throw inside the handler rather than returning a
      // clean 400. The upper bound is the part it does not give us.
      if (
        typeof grossRaw !== "number" ||
        !Number.isInteger(grossRaw) ||
        grossRaw <= 0 ||
        grossRaw > MAX_GROSS_MINOR
      ) {
        return { error: "invalid_gross_minor" };
      }
      expectedGrossAmountMinor = BigInt(grossRaw);
    }

    /* NO LONGER USD-ONLY. The settlement's own currency decides, so a EUR or JPY
     * payment is allocatable in the currency it settled in. The old
     * `currency !== "usd"` refusal made a correctly-settled non-USD payment
     * permanently unallocatable, and the literal `"usd"` passed onward from here
     * would have mislabelled it if it had got through. */
    let expectedCurrency: string | undefined;
    if (currencyRaw !== undefined && currencyRaw !== null) {
      if (typeof currencyRaw !== "string" || !currencyRaw.trim()) {
        return { error: "invalid_currency" };
      }
      expectedCurrency = currencyRaw;
    }

    const paymentSettledAt = body.settled_at
      ? new Date(body.settled_at as string)
      : new Date();

    if (isNaN(paymentSettledAt.getTime())) return { error: "invalid_settled_at" };

    const platform = resolvePlatformConfig();
    if (!platform.ok) return { error: "platform_unavailable" };

    await writeAudit({
      adminUid: adminCtx.uid,
      adminEmail: adminCtx.email,
      action: "record_creator_earning",
      targetType: "user",
      targetId: firebaseUid,
      // The ASSERTED figures are audited as what the admin claimed, which is
      // worth keeping precisely because they are no longer what gets used.
      metadata: {
        whopPaymentId,
        asserted_gross_minor: expectedGrossAmountMinor?.toString() ?? null,
        asserted_currency: expectedCurrency ?? null,
      },
    });

    const result = await recordCreatorEarning({
      firebaseUid,
      whopPaymentId,
      orderId: typeof body.order_id === "string" ? body.order_id : undefined,
      expectedGrossAmountMinor,
      expectedCurrency,
      environment: platform.config.environment,
      paymentSettledAt,
      description: typeof body.description === "string" ? body.description : undefined,
    });

    if (!result.ok) {
      /* A NAMED 4xx FOR THE REFUSALS THAT ARE THE CALLER'S TO FIX.
       *
       * An asserted figure that disagrees with the settlement is a CONFLICT
       * between what the caller believes and what the books record — 409 says
       * that, where the wrapper's default 200-with-an-error would let a script
       * treat a refused allocation as a successful one. The settlement-state
       * refusals are 409 for the same reason: the request is well-formed and the
       * ledger is simply not in a state that can be allocated.
       *
       * `withAdminApi` passes a `Response` through untouched, so the status
       * chosen here is the status the client sees. */
      const conflict: Record<string, true> = {
        gross_mismatch: true,
        currency_assertion_failed: true,
        order_mismatch: true,
        settlement_not_found: true,
        ambiguous_settlement: true,
        unsupported_currency: true,
        currency_mismatch: true,
        suspense_unreadable: true,
        already_allocated: true,
      };
      if (conflict[result.reason]) {
        return Response.json(
          { error: result.reason, detail: result.detail },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
      // Infrastructure failures keep the wrapper's existing shape.
      return { error: result.reason };
    }
    return { ok: true, earning_id: result.earningId, already_recorded: result.alreadyRecorded };
  });
}
