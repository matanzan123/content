import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  WHOP_ME_URL,
  WHOP_SESSION_COOKIE,
  WHOP_STATE_COOKIE,
  WHOP_TOKEN_URL,
  isWhopConfigured,
  whopConfig,
} from "@/lib/whop";

function back(request: Request, message: string) {
  const url = new URL("/onboarding", request.url);
  url.searchParams.set("whop", message);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  if (!isWhopConfigured()) return back(request, "Whop isn't configured on this server.");

  const params = new URL(request.url).searchParams;
  const denied = params.get("error");
  if (denied) return back(request, "Whop authorization was cancelled.");

  const code = params.get("code");
  const state = params.get("state");
  const store = await cookies();
  const expectedState = store.get(WHOP_STATE_COOKIE)?.value;
  store.delete(WHOP_STATE_COOKIE);

  if (!code) return back(request, "Whop didn't return an authorization code.");
  if (!state || !expectedState || state !== expectedState) {
    return back(request, "Whop sign-in expired — please try again.");
  }

  const { clientId, clientSecret, redirectUri } = whopConfig();

  const tokenRes = await fetch(WHOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) return back(request, "Whop rejected the token exchange.");
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return back(request, "Whop didn't return an access token.");

  const meRes = await fetch(WHOP_ME_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return back(request, "Couldn't read your Whop profile.");
  const me = (await meRes.json()) as { username?: string; id?: string };

  store.set(
    WHOP_SESSION_COOKIE,
    JSON.stringify({ username: me.username ?? me.id ?? "whop-user" }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    }
  );

  return back(request, "connected");
}
