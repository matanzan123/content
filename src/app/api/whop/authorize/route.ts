import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  WHOP_AUTHORIZE_URL,
  WHOP_SCOPES,
  WHOP_STATE_COOKIE,
  isWhopConfigured,
  whopConfig,
} from "@/lib/whop";

function fail(request: Request, message: string) {
  const url = new URL("/onboarding", request.url);
  url.searchParams.set("whop", message);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  if (!isWhopConfigured()) {
    return fail(
      request,
      "Whop isn't configured yet — add WHOP_CLIENT_ID, WHOP_CLIENT_SECRET and WHOP_REDIRECT_URI to .env.local."
    );
  }

  const { clientId, redirectUri } = whopConfig();
  const state = crypto.randomUUID();

  const authorize = new URL(WHOP_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", WHOP_SCOPES);
  authorize.searchParams.set("state", state);

  const store = await cookies();
  store.set(WHOP_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authorize);
}
