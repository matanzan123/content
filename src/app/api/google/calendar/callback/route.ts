import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAppPublicUrl } from "@/lib/server/app-url";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localePath } from "@/i18n/config";
import {
  exchangeGoogleCode,
  GOOGLE_CALENDAR_SCOPE,
  resolveGoogleOAuthConfig,
} from "@/lib/server/google-oauth";
import { consumeOAuthState, saveConnection } from "@/lib/server/google-calendar-connection";

/* ==========================================================================
   GOOGLE OAUTH CALLBACK.

   This request arrives from Google with no session of its own, so it cannot
   ask who the caller is. It does not need to: the state row written when the
   flow started records the administrator who began it, and that row was only
   created behind `requireAdmin`.

   THE STATE IS CONSUMED EXACTLY ONCE by a `DELETE … RETURNING` inside
   Postgres, with expiry in the predicate. A replay, an expired flow and a
   forged value are the same refusal. The browser cookie must match it too,
   which is what rejects a state belonging to another in-flight flow.

   THE RETURN ORIGIN IS CONFIGURED, NEVER DERIVED. `APP_PUBLIC_URL` refuses a
   localhost value, and no forwarded host header is consulted — trusting one
   here would turn this redirect into an open redirect.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINK_COOKIE = "cr_google_link";

/** Outcomes the admin page may show. A closed set — never provider text. */
type Outcome =
  | "connected"
  | "cancelled"
  | "expired"
  | "mismatch"
  | "no_refresh_token"
  | "unavailable"
  | "failed";

async function back(request: Request, outcome: Outcome) {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const configured = getAppPublicUrl();
  const url = new URL(localePath(locale, "/admin/applicants"), configured ?? request.url);
  url.searchParams.set("google", outcome);

  const response = NextResponse.redirect(url);
  response.cookies.set(LINK_COOKIE, "", { path: "/", maxAge: 0 });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const store = await cookies();
  const cookieState = store.get(LINK_COOKIE)?.value ?? null;

  // The operator declined at Google, or Google reported an error. Either way
  // there is nothing to connect and nothing worth quoting.
  if (params.get("error")) return back(request, "cancelled");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back(request, "failed");
  if (!cookieState || cookieState !== state) return back(request, "mismatch");

  const pending = await consumeOAuthState(state);
  if (!pending) return back(request, "expired");

  const config = resolveGoogleOAuthConfig();
  if (!config.ok) return back(request, "unavailable");

  const exchanged = await exchangeGoogleCode({ config: config.config, code });
  if (!exchanged.ok) return back(request, "failed");

  const saved = await saveConnection({
    environment: pending.environment,
    adminUid: pending.adminUid,
    refreshToken: exchanged.tokens.refreshToken,
    accessToken: exchanged.tokens.accessToken,
    expiresInSeconds: exchanged.tokens.expiresInSeconds,
    scopes: exchanged.tokens.scope ?? GOOGLE_CALENDAR_SCOPE,
  });

  if (!saved.ok) {
    // Its own outcome, because the fix is specific: Google withholds the
    // refresh token when an account re-authorises a scope it has already
    // granted, and recovering means removing ClipRewards from that account's
    // third-party access and connecting again.
    return back(request, saved.reason === "no_refresh_token" ? "no_refresh_token" : "unavailable");
  }

  return back(request, "connected");
}
