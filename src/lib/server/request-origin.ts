import "server-only";

import { getAppPublicUrl } from "./app-url";

/* ==========================================================================
   SAME-ORIGIN CHECK for state-changing sandbox requests.

   This endpoint creates provider objects, so a page on another site should not
   be able to trigger it in a visitor's browser. A full CSRF token system would
   be disproportionate for a sandbox test route; an Origin check is not, and it
   closes the obvious cross-site trigger.

   WHAT IS TRUSTED: `Origin` and `Referer` are set by the browser and cannot be
   forged by page script. `Host`, `X-Forwarded-Host` and friends are attacker-
   influenced and are NOT consulted — the allow-list comes from our own
   configuration instead.

   FAIL CLOSED, including on a MISSING Origin. Per the Fetch standard a
   browser attaches `Origin` to every request whose method is not GET or HEAD,
   same-origin ones included — so a genuine browser POST from our own page
   always carries it. Refusing a POST without one therefore costs no legitimate
   browser traffic, and this endpoint has no non-browser callers.

   The cost is that `curl` must now send `-H "Origin: <configured origin>"`.
   That is a deliberate trade: a header a person adds on purpose is cheaper
   than a permanently open door on an endpoint that creates provider objects.
   ========================================================================== */

/** Local development hosts. Not reachable from another person's browser. */
const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://localhost:3000",
];

export type OriginCheck =
  | { ok: true; reason: "same_origin" }
  | { ok: false; reason: "untrusted_origin" | "missing_origin" };

/** Origins allowed to trigger a state change. Configuration only. */
export function trustedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const configured = getAppPublicUrl(env);
  return configured ? [configured, ...LOCAL_ORIGINS] : [...LOCAL_ORIGINS];
}

export function checkRequestOrigin(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): OriginCheck {
  const allowed = trustedOrigins(env);

  const origin = headers.get("origin");
  if (origin) {
    return allowed.includes(origin)
      ? { ok: true, reason: "same_origin" }
      : { ok: false, reason: "untrusted_origin" };
  }

  // No Origin. Fall back to Referer's origin when one is present, since a
  // cross-site form post carries a referer even where origin is omitted.
  const referer = headers.get("referer");
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      return allowed.includes(refererOrigin)
        ? { ok: true, reason: "same_origin" }
        : { ok: false, reason: "untrusted_origin" };
    } catch {
      return { ok: false, reason: "untrusted_origin" };
    }
  }

  // Neither header. A browser would have sent one, so this is not a browser.
  return { ok: false, reason: "missing_origin" };
}
