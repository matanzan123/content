/* ==========================================================================
   PAYOUT PORTAL — the two decisions the card makes, as pure functions.

   NOT a server module: no `server-only` import, no secrets, no provider call.
   These run in the browser as part of WhopPayoutStatusCard.

   WHY THEY LIVE HERE RATHER THAN INLINE IN THE CARD.

   Both are product rules that are easy to get quietly wrong and impossible to
   assert from outside a React tree:

     - offering a "set up payouts" button to an account the provider has
       SUSPENDED sends the creator into a flow that cannot help them;
     - navigating to whatever came back in `url` — without checking the
       request actually succeeded and the value is an https string — is how a
       null, a relative path or a `javascript:` URL becomes a redirect.

   Inline in the component, a test can only re-type the same expression and
   watch its own copy pass. Extracted, the test calls the function the product
   calls. Nothing else moved: the card still owns rendering and state.
   ========================================================================== */

/** Server-derived payout readiness. Mirrors PayoutReadiness on the server. */
export type PortalReadiness =
  | "ready"
  | "pending"
  | "action_required"
  | "destination_missing"
  | "restricted"
  | "not_ready"
  | "unknown";

/**
 * Whether to offer the hosted payout-setup button.
 *
 * Withheld in exactly two cases, for opposite reasons:
 *
 *   - `ready`      — nothing to set up.
 *   - `restricted` — the provider has suspended the account. Whop's portal
 *                    cannot lift a suspension, so the button would lead
 *                    somewhere that cannot help. The card shows the support
 *                    hint instead. A button that cannot work is worse than no
 *                    button, because it spends the creator's trust.
 *
 * Every other state — including `unknown` — offers it: when we could not
 * establish readiness, letting the creator try is better than stranding them.
 */
export function shouldOfferPortal(readiness: PortalReadiness): boolean {
  return readiness !== "ready" && readiness !== "restricted";
}

/**
 * What to do with the portal route's answer.
 *
 * `navigate` is returned ONLY for an https URL from a successful response.
 * Anything else is an error carrying a dictionary KEY — never provider text —
 * which the card resolves against the payout error copy, falling back to the
 * generic `portal` string for a token we have no specific copy for.
 */
export type PortalOutcome =
  | { kind: "navigate"; url: string }
  | { kind: "error"; key: string };

export function resolvePortalOutcome(
  ok: boolean,
  body: { url?: unknown; error?: unknown } | null,
): PortalOutcome {
  const key = typeof body?.error === "string" && body.error ? body.error : "portal";
  if (!ok) return { kind: "error", key };

  const url = body?.url;
  // A 200 that did not carry a usable link is a failure, not a redirect.
  // `https:` is required: a relative path would leave the app silently, and a
  // `javascript:` value would execute.
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return { kind: "error", key: "portal" };
  }
  return { kind: "navigate", url };
}
