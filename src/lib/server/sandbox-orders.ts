import "server-only";

import { getWhopEnvironment } from "./whop-payments";
import { findOrCreateSandboxOrder, type CreateOrderResult } from "./payment-orders";

/* ==========================================================================
   SANDBOX TEST ORDERS — integration testing infrastructure. Not a product.

   ClipRewards has no campaign backend yet, so there is no real thing to buy.
   Rather than invent a campaign, a creator or a brand record to make a
   checkout look plausible, this creates a deliberately generic order for a
   fixed amount, labelled for exactly what it is.

   The amount is a server-side constant. Nothing about it is negotiable from a
   request, so there is no "amount" field for a browser to tamper with.
   ========================================================================== */

/** $10.00. Minor units, because money is never a float here. */
export const SANDBOX_TEST_AMOUNT_MINOR = BigInt(1000);
export const SANDBOX_TEST_CURRENCY = "usd";

/** Recorded on the order so its origin is never in doubt later. */
export const SANDBOX_TEST_PURPOSE = "sandbox_integration_test";

/**
 * Whether the sandbox test mechanism exists at all.
 *
 * TWO conditions, both required, and the default is off:
 *
 *   WHOP_ENV === "sandbox"                      the provider environment,
 *                                               itself a fail-closed read
 *   ENABLE_SANDBOX_CHECKOUT_TEST_UI === "true"  an explicit, deliberate opt-in
 *
 * The second exists because the first is not a decision. Leaving WHOP_ENV as
 * `sandbox` on a deployed environment is an easy mistake, and it must not be
 * enough on its own to publish a page that mounts a payment form. Someone has
 * to say yes on purpose, and an unset or misspelled value says no.
 *
 * Deliberately NOT `NODE_ENV !== "production"`: a sandbox key on a deployed
 * preview is a case that should still work, and a production key on a
 * developer's laptop is a case that must not.
 */
export function isSandboxOrderingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getWhopEnvironment(env) === "sandbox" && env.ENABLE_SANDBOX_CHECKOUT_TEST_UI === "true";
}

export type SandboxOrderResult = CreateOrderResult | { ok: false; reason: "not_sandbox" };

/**
 * Returns the one active sandbox test order, creating it only if none exists.
 *
 * The lookup and the insert happen inside a single transaction holding a
 * Postgres advisory lock, so two concurrent requests cannot both decide to
 * create one — see `findOrCreateSandboxOrder`. A browser guard stops an
 * ordinary double-click; this stops a genuine race between processes.
 *
 * An order that has reached `paid` or `cancelled` is never reused: those are
 * finished, and the next test genuinely needs a new order.
 */
export async function createSandboxTestOrder(): Promise<SandboxOrderResult> {
  if (!isSandboxOrderingEnabled()) return { ok: false, reason: "not_sandbox" };

  return findOrCreateSandboxOrder({
    amountMinor: SANDBOX_TEST_AMOUNT_MINOR,
    currency: SANDBOX_TEST_CURRENCY,
    purpose: SANDBOX_TEST_PURPOSE,
  });
}
