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
import { getWhopAppClient, redactWhopSecrets } from "./whop-payments";
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
  | { ok: true; url: string }
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

  const client = getWhopAppClient();
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

    // ONLY the url. The response also carries `expires_at`, and it is
    // deliberately dropped: no caller ever read it, nothing persists a link,
    // and a link is spent on the next click. Plumbing a value nobody consumes
    // invites a future reader to assume something depends on it.
    return { ok: true, url };
  } catch (error) {
    logProviderRejection(useCase, error);
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

/* -------------------------------------------------------------------------
   Development-only diagnostics
   ------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS AND WHY IT IS SHAPED LIKE THIS.
 *
 * A real sandbox call returned 502 `provider_rejected` and the server log said
 * only `POST /api/whop/kyc/start 502` — Whop's own explanation was being
 * thrown away by the catch above. Without it there is nothing to act on.
 *
 * WHAT MUST NOT BE LOGGED, and why each is a real hazard here:
 *
 *   - `error.message`. Looks harmless; is not. The SDK BUILDS the message by
 *     appending `Body: ${toJson(body)}` (see WhopError.js `buildMessage`), so
 *     logging it is a full unfiltered body dump wearing a string's clothes.
 *   - `error.rawResponse`. The Response object, headers included.
 *   - `error.cause`. Arbitrary nested shape, may carry the request.
 *   - The error object itself, or any spread/JSON.stringify of it.
 *   - The minted link URL, which is a bearer credential for the hosted flow.
 *
 * So nothing is dumped. Named scalars are lifted out of the parsed provider
 * body one at a time, each truncated, then passed through the same credential
 * scrubber the rest of the codebase uses as a second line of defence. A field
 * that is not on the allowlist cannot reach the log by any path.
 */
type SafeProviderDetail = {
  status: number | null;
  requestId: string | null;
  code: string | null;
  type: string | null;
  message: string | null;
  field: string | null;
  validation: string[];
};

const MAX_LEN = 300;

/** A short, scrubbed scalar — or null. Anything non-scalar is dropped. */
function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return redactWhopSecrets(trimmed.slice(0, MAX_LEN));
}

function readAllowlisted(body: unknown): Omit<SafeProviderDetail, "status" | "requestId"> {
  const root = (body ?? {}) as Record<string, unknown>;
  // Whop has used both a top-level error object and a flat envelope.
  const err = (root.error && typeof root.error === "object" ? root.error : root) as Record<string, unknown>;

  // Per-field validation failures — the detail that actually names what Whop
  // disliked. Only `field`/`param`/`code`/`message` are read off each entry.
  const validation: string[] = [];
  const list = Array.isArray(root.errors) ? root.errors : Array.isArray(err.errors) ? err.errors : [];
  for (const entry of list.slice(0, 10)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const where = safeString(e.field) ?? safeString(e.param) ?? "?";
    const what = safeString(e.code) ?? safeString(e.message) ?? "?";
    validation.push(`${where}: ${what}`);
  }

  return {
    code: safeString(err.code),
    type: safeString(err.type),
    message: safeString(err.message),
    field: safeString(err.param) ?? safeString(err.field),
    validation,
  };
}

/**
 * Extracts the allowlisted detail from a provider failure.
 *
 * Exported for tests: the leak assertions run against this, not against
 * console output, so they cannot pass by accident when logging is off.
 */
export function describeProviderRejection(error: unknown): SafeProviderDetail {
  const whopError = error instanceof WhopError ? error : null;
  return {
    status: typeof whopError?.statusCode === "number" ? whopError.statusCode : null,
    // Read through the SDK getter, which pulls `x-request-id` off the RESPONSE
    // headers. This is Whop's own correlation id — the one to quote in a
    // support ticket — and never anything we sent.
    requestId: safeString(whopError?.requestId),
    ...readAllowlisted(whopError?.body),
  };
}

/**
 * Prints the detail in development only.
 *
 * Production stays silent: these lines are for a developer watching a terminal
 * during sandbox bring-up, and a log aggregator is exactly the place a
 * provider body should not accumulate.
 */
function logProviderRejection(useCase: AccountLinkUseCase, error: unknown): void {
  if (process.env.NODE_ENV === "production") return;

  const d = describeProviderRejection(error);
  const parts = [
    `use_case=${useCase}`,
    `status=${d.status ?? "?"}`,
    d.requestId ? `request_id=${d.requestId}` : null,
    d.code ? `code=${d.code}` : null,
    d.type ? `type=${d.type}` : null,
    d.field ? `field=${d.field}` : null,
    d.message ? `message=${d.message}` : null,
    d.validation.length ? `validation=[${d.validation.join("; ")}]` : null,
  ].filter(Boolean);

  console.error(`[whop:account_links] rejected — ${parts.join(" ")}`);
}

/** @internal — URL construction, asserted directly by whop-kyc-test. */
export const __testing = { resolveAppOrigin, redirectUrls };
