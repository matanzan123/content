import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { consumeAuthorization, linkWhopIdentity } from "@/lib/server/whop-connections";
import { exchangeCode, fetchUserinfo, resolveOAuthConfig } from "@/lib/server/whop-oauth";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localePath } from "@/i18n/config";
import { getAppPublicUrl } from "@/lib/server/app-url";

/* ==========================================================================
   OAUTH CALLBACK.

   This request arrives with no session — it is a top-level redirect from
   Whop — so it cannot ask who the caller is. It does not need to: the
   authorization row written at the start of the flow already says whose link
   this is, and that row was created from a verified Firebase ID token.

   THE STATE IS CONSUMED EXACTLY ONCE, by a `DELETE … RETURNING` inside
   Postgres. A replayed code finds no row. An expired one finds no row. A
   forged one finds no row. All three are the same refusal.

   The browser cookie set at the start must match the state in the URL. That is
   what rejects a state belonging to somebody else's in-flight flow, which is
   the user-switch case.

   Every failure lands the person back on a page with a short reason. None of
   the reasons quotes the provider, the code, or the verifier.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINK_COOKIE = "cr_whop_link";

/** Outcomes the return page may show. A closed set — never provider text. */
type Outcome =
  | "connected"
  | "cancelled"
  | "expired"
  | "mismatch"
  | "already_linked"
  | "unavailable"
  | "failed";

/**
 * Where the visitor is sent back to.
 *
 * THE ORIGIN COMES FROM CONFIGURATION, NOT FROM THE REQUEST. This used to be
 * `new URL(path, request.url)`, which is correct only when the app is reached
 * directly. Behind a tunnel or any reverse proxy, Next reconstructs
 * `request.url` from the forwarded scheme and the upstream host — so a flow
 * that began at a public HTTPS origin ended up redirected to
 * `https://localhost:3000`, which no browser can load.
 *
 * `getAppPublicUrl()` reads `APP_PUBLIC_URL` and REFUSES a localhost value
 * outright, so this cannot regress to a local origin even if someone
 * misconfigures it. Forwarding headers are deliberately not consulted:
 * `X-Forwarded-Host` is attacker-supplied, and trusting it here would turn
 * this redirect into an open redirect.
 *
 * The request's own origin remains the fallback for plain local development,
 * where there is no public URL to configure and none is needed.
 */
function back(request: Request, path: string, outcome: Outcome) {
  const configured = getAppPublicUrl();
  // Only ever a path. An absolute value here would override the base entirely,
  // so it is rejected rather than resolved — the stored return path is built
  // from a closed map, and this keeps that true even if that ever changes.
  const safePath = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const url = new URL(safePath, configured ?? request.url);
  url.searchParams.set("whop", outcome);
  const response = NextResponse.redirect(url);
  response.cookies.set(LINK_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const store = await cookies();
  const cookieState = store.get(LINK_COOKIE)?.value ?? null;

  /*
   * WHERE A FAILURE LANDS, BEFORE THERE IS A STORED RETURN PATH.
   *
   * A successful flow returns to the localised path written at `connect` time.
   * These three refusals happen before that row is read — or because there is
   * no row — so the language comes from the visitor's own locale cookie, the
   * same one the middleware maintains. Falling back to English for everyone
   * would drop a Hebrew user into an English page at the exact moment
   * something went wrong.
   */
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const fallback = localePath(isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE, "/dashboard");

  // The person declined at Whop, or the provider reported an error. Either
  // way there is nothing to link and nothing to explain in detail.
  if (params.get("error")) return back(request, fallback, "cancelled");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back(request, fallback, "failed");

  // Same browser as the one that started this flow.
  if (!cookieState || cookieState !== state) return back(request, fallback, "mismatch");

  // One-time, atomic, expiry evaluated by the database.
  const pending = await consumeAuthorization(state);
  if (!pending) return back(request, fallback, "expired");

  const config = resolveOAuthConfig();
  if (!config.ok) return back(request, pending.returnPath, "unavailable");

  const exchanged = await exchangeCode({
    config: config.config,
    code,
    codeVerifier: pending.codeVerifier,
  });
  if (!exchanged.ok) return back(request, pending.returnPath, "failed");

  const identity = await fetchUserinfo({
    config: config.config,
    accessToken: exchanged.tokens.accessToken,
  });
  if (!identity.ok) return back(request, pending.returnPath, "failed");

  // The join key is the OIDC subject. No email is read, stored or compared.
  const linked = await linkWhopIdentity({
    firebaseUid: pending.firebaseUid,
    whopUserId: identity.identity.sub,
    whopUsername: identity.identity.username,
    scopes: exchanged.tokens.scope ?? "openid profile email",
    accessToken: exchanged.tokens.accessToken,
    refreshToken: exchanged.tokens.refreshToken,
    expiresInSeconds: exchanged.tokens.expiresIn,
  });

  if (!linked.ok) {
    if (linked.reason === "whop_identity_taken") {
      return back(request, pending.returnPath, "already_linked");
    }
    return back(request, pending.returnPath, "unavailable");
  }

  return back(request, pending.returnPath, "connected");
}
