import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { consumeAuthorization, linkWhopIdentity } from "@/lib/server/whop-connections";
import { exchangeCode, fetchUserinfo, resolveOAuthConfig } from "@/lib/server/whop-oauth";

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

function back(request: Request, path: string, outcome: Outcome) {
  const url = new URL(path, request.url);
  url.searchParams.set("whop", outcome);
  const response = NextResponse.redirect(url);
  response.cookies.set(LINK_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const store = await cookies();
  const cookieState = store.get(LINK_COOKIE)?.value ?? null;

  // The person declined at Whop, or the provider reported an error. Either
  // way there is nothing to link and nothing to explain in detail.
  if (params.get("error")) return back(request, "/onboarding", "cancelled");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back(request, "/onboarding", "failed");

  // Same browser as the one that started this flow.
  if (!cookieState || cookieState !== state) return back(request, "/onboarding", "mismatch");

  // One-time, atomic, expiry evaluated by the database.
  const pending = await consumeAuthorization(state);
  if (!pending) return back(request, "/onboarding", "expired");

  const config = resolveOAuthConfig();
  if (!config.ok) return back(request, pending.returnPath, "unavailable");

  const exchanged = await exchangeCode({
    config: config.config,
    code,
    codeVerifier: pending.codeVerifier,
  });
  if (!exchanged.ok) return back(request, pending.returnPath, "failed");

  const identity = await fetchUserinfo(exchanged.tokens.accessToken);
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
