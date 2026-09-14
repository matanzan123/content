import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-guard";
import { getAppPublicUrl } from "@/lib/server/app-url";
import {
  buildGoogleAuthorizeUrl,
  createGoogleState,
  resolveGoogleOAuthConfig,
} from "@/lib/server/google-oauth";
import { createOAuthState, currentEnvironment } from "@/lib/server/google-calendar-connection";

/* ==========================================================================
   CONNECT THE CLIPREWARDS INTERVIEW GOOGLE ACCOUNT.

   ADMINISTRATOR ONLY, AND INTERNAL. This authorises ONE company account that
   will own every interview event. It is not a creator-facing flow and has no
   connection to anyone's Firebase identity: the tokens belong to ClipRewards,
   not to the administrator who clicked.

   A GET THAT REDIRECTS, deliberately, unlike the Whop connect endpoint. This
   is opened by an operator in a browser tab rather than called by a page, and
   `requireAdmin` reads an httpOnly session cookie that a cross-site page
   cannot cause to be sent with a top-level navigation it initiates — the
   admin cookie is `SameSite=Strict`.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const environment = currentEnvironment();
  if (!environment) {
    return Response.json({ error: "unconfigured" }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const config = resolveGoogleOAuthConfig();
  if (!config.ok) {
    return Response.json(
      { error: "unconfigured", reason: config.reason },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const state = createGoogleState();
  const stored = await createOAuthState({ state, adminUid: admin.uid, environment });
  if (!stored) {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  // `prompt=consent` every time: Google omits the refresh token on a repeat
  // authorisation without it, and a connection with no refresh token dies
  // silently an hour later.
  const authorizeUrl = buildGoogleAuthorizeUrl({ config: config.config, state });

  const response = NextResponse.redirect(authorizeUrl);
  response.headers.set("cache-control", "no-store");
  // Binds the callback to the browser that started the flow, exactly as the
  // Whop link flow does. Lax, because the callback is a top-level navigation
  // back from Google.
  const isHttps = (getAppPublicUrl() ?? "https://").startsWith("https://");
  response.headers.append(
    "set-cookie",
    [
      `cr_google_link=${state}`,
      "Path=/api/google",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=600",
      ...(isHttps ? ["Secure"] : []),
    ].join("; "),
  );
  return response;
}
