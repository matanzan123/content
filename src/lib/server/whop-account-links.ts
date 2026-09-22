import "server-only";

import { WhopError } from "@whop/sdk";
import { cookies } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  localePath,
  type Locale,
} from "@/i18n/config";
import { getWhopPaymentsClient } from "./whop-payments";
import { isWhopAccountId } from "./whop-accounts";

/* ==========================================================================
   WHOP ACCOUNT LINKS — the ONE place a hosted account link is minted.

   Whop mints two kinds of hosted link for a sub-merchant, and they are the
   same API call with a different `use_case`:

     - `account_onboarding` — the hosted KYC / identity flow.
     - `payouts_portal`     — the hosted bank-account / payout settings UI.

   THEY ARE NOT INTERCHANGEABLE. Sending a creator to the payouts portal when
   they still need to prove their identity is a dead end, and vice versa. The
   use case is therefore a required argument here, never a default.

   WHY THE SDK AND NOT RAW fetch.
   =============================

   This module previously existed twice, by hand, and both copies were wrong
   against the installed contract: the wrong path (`/accounts/links` and
   `/accounts/{id}/links` instead of `account_links`), the wrong field name
   (`type` instead of `use_case`), a value that is not in the enum at all
   (`account_update`), a required field missing entirely (`refresh_url`), and
   a retry on an `account_id` field that the installed SDK does not define.

   Hand-written request bodies cannot be type-checked, so none of that was
   caught by the compiler. `client.accountLinks.create()` takes
   `CreateAccountLinksRequest`, so every one of those mistakes is now a build
   error rather than a runtime 400. That is the real fix; the endpoint being
   correct today is a consequence of it.

   THE BASE URL STAYS EXPLICIT. `getWhopPaymentsClient()` constructs the SDK
   client with `baseUrl` set from `WHOP_API_BASE_URLS[environment]`. The SDK's
   own default is production, so a client built without that would quietly send
   sandbox traffic to the live API. Reusing that constructor is what keeps
   environment isolation intact here — this module never builds its own client.

   THE COMPANY ID IS NEVER THE CALLER'S. Routes resolve it from the database
   with the session uid AND the trusted environment before calling in. This
   module additionally re-checks its shape: a `biz_` id read out of a row is
   still a string that could be wrong, and the request it is about to be
   spent on is one that moves a real person through identity verification.
   ========================================================================== */

/** The two hosted flows Whop offers for a sub-merchant. */
export type AccountLinkUseCase = "account_onboarding" | "payouts_portal";

export type AccountLinkFailure =
  /** The platform scope this call needs is not granted to the API key. */
  | "platforms_access_required"
  /** Whop understood the request and refused it. Not retryable as-is. */
  | "provider_rejected"
  /** The account id names nothing Whop can see. */
  | "not_found"
  /** Network, 5xx, timeout — retryable. */
  | "provider_error"
  /** Whop answered 2xx with something that is not a usable link. */
  | "malformed_response"
  /** Our own configuration is unusable: no key, no environment, no app URL. */
  | "unconfigured"
  /** The resolved company id is not a well-formed Whop business id. */
  | "invalid_account_id";

export type AccountLinkResult =
  | { ok: true; url: string; expiresAt: string | null }
  | { ok: false; reason: AccountLinkFailure };

/* -------------------------------------------------------------------------
   Redirect URLs — built here, never accepted from a caller
   ------------------------------------------------------------------------- */

/**
 * The locale to send the creator back into.
 *
 * Read from the locale cookie the middleware already maintains, and validated
 * against the supported set before use. That matters: this value becomes part
 * of a URL we hand to a third party to redirect a browser to, so the only
 * acceptable inputs are the two we ship. Anything else — absent cookie,
 * tampered cookie, a locale we dropped — falls back to the default rather
 * than being echoed into a redirect.
 */
async function resolveLocale(): Promise<Locale> {
  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    // `cookies()` throws outside a request scope. The default is correct there.
    return DEFAULT_LOCALE;
  }
}

/**
 * The app's public origin, proved to be an absolute HTTPS URL.
 *
 * Whop redirects a browser to these, so http:// or a relative path is not
 * merely untidy — a hosted flow cannot return the creator anywhere useful.
 * Returning null makes the caller fail closed with `unconfigured` instead of
 * minting a link that strands them.
 */
function resolveAppOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APP_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Where the creator lands, and where they are sent if the hosted session dies.
 *
 * BOTH POINT AT THE LOCALIZED DASHBOARD, because that is the only page that
 * renders `WhopVerificationCard` and `WhopPayoutStatusCard`. The previous KYC
 * return url pointed at `/onboarding` with no locale, so returning from Whop
 * landed on a page with no verification card on it and the `?step=` refresh
 * trigger was never read by anything.
 *
 * `return_url` and `refresh_url` deliberately differ only in the step token:
 *
 *   - `return_url` is "the creator came back", for any reason, finished or
 *     abandoned. It is a TRIGGER TO RE-READ STATUS, never proof of success.
 *   - `refresh_url` is "the hosted session expired before they finished".
 *     Whop sends the browser here to be issued a fresh link. Landing on the
 *     dashboard shows the card in its real state with its start button, which
 *     mints a new link on click — so the restart path is the button that is
 *     already there, and no extra route is needed.
 */
function redirectUrls(origin: string, locale: Locale, useCase: AccountLinkUseCase) {
  const step = useCase === "account_onboarding" ? "kyc" : "payout";
  const dashboard = `${origin}${localePath(locale, "/dashboard")}`;
  return {
    returnUrl: `${dashboard}?step=${step}_return`,
    refreshUrl: `${dashboard}?step=${step}_refresh`,
  };
}

/* -------------------------------------------------------------------------
   The one call
   ------------------------------------------------------------------------- */

/**
 * Mints one short-lived hosted account link for a connected sub-merchant.
 *
 * `companyId` MUST be the creator's own connected `biz_…` account, resolved
 * server-side from their session and the running environment. Passing the
 * platform's own company id here would onboard the platform account.
 *
 * Returns a discriminated failure rather than throwing: every caller is an API
 * route that has to turn this into a status code, and an exception would have
 * to be unwrapped into the same shape anyway.
 */
export async function createAccountLink(
  companyId: string,
  useCase: AccountLinkUseCase,
): Promise<AccountLinkResult> {
  // A row is not a guarantee. This id is about to be spent on a flow that
  // walks a real person through identity verification.
  if (!isWhopAccountId(companyId)) return { ok: false, reason: "invalid_account_id" };

  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "unconfigured" };

  const origin = resolveAppOrigin();
  if (!origin) return { ok: false, reason: "unconfigured" };

  const locale = await resolveLocale();
  const { returnUrl, refreshUrl } = redirectUrls(origin, locale, useCase);

  try {
    // Typed by `CreateAccountLinksRequest`. A wrong field name, a missing
    // required field, or a use case outside the enum is a compile error.
    const link = await client.accountLinks.create({
      company_id: companyId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      use_case: useCase,
    });

    const url = typeof link?.url === "string" ? link.url : null;
    if (!url || !url.startsWith("https://")) {
      return { ok: false, reason: "malformed_response" };
    }

    return {
      ok: true,
      url,
      // Carried through because it costs nothing and lets a caller reason
      // about staleness. Not persisted — a link is spent on the next click.
      expiresAt: typeof link?.expires_at === "string" ? link.expires_at : null,
    };
  } catch (error) {
    return { ok: false, reason: classify(error) };
  }
}

/**
 * Maps a provider failure to our closed set.
 *
 * The error is never logged or returned: an SDK error can quote the request it
 * made, and that request carried the Authorization header. Only the status
 * code is read.
 */
function classify(error: unknown): AccountLinkFailure {
  const status = error instanceof WhopError ? error.statusCode : undefined;
  if (status === 403) return "platforms_access_required";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "provider_rejected";
  return "provider_error";
}

/* -------------------------------------------------------------------------
   Exposed for tests only
   ------------------------------------------------------------------------- */

/** @internal — URL construction, asserted directly by whop-kyc-test. */
export const __testing = { resolveAppOrigin, redirectUrls };
