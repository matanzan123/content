import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { createAuthorization } from "@/lib/server/whop-connections";
import { isTokenEncryptionConfigured } from "@/lib/server/token-crypto";
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  createCodeVerifier,
  createRandomToken,
  resolveOAuthConfig,
} from "@/lib/server/whop-oauth";

/* ==========================================================================
   START "CONNECT WHOP".

   POST, authenticated, and it returns a URL rather than redirecting — a GET
   that redirects to a provider can be triggered by any page that can make the
   browser navigate, which is how the legacy flow could be started by someone
   who was not signed in at all.

   THE USER IS ESTABLISHED HERE AND NOWHERE ELSE. The uid comes from a verified
   Firebase ID token and is written into the authorization row. The callback,
   which has no session of its own, reads it back from there. That is why this
   endpoint is the security boundary for the whole flow.

   The browser supplies nothing that matters: not the client id, not the
   scopes, not the redirect URI, not a uid. The only accepted input is which
   page to return to, and that is matched against a fixed list.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024;
const NO_STORE = { "cache-control": "no-store" };

/** Matches the state row's TTL, so cookie and row expire together. */
const LINK_COOKIE_MAX_AGE = 600;

/** Return destinations, as a closed set. An arbitrary path is an open redirect. */
const RETURN_PATHS: Record<string, string> = {
  onboarding: "/onboarding",
  settings: "/onboarding",
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  // APPROVAL GATE. Whop connection belongs AFTER ClipRewards has approved the
  // applicant, not during onboarding.
  //
  // The previous flow reached this endpoint from the last step of the
  // onboarding wizard, so anyone who had merely signed in with Google could
  // start linking a Whop account before ClipRewards had spoken to them. That
  // ordering is now enforced on the SERVER: `requireWhopEligible` admits only
  // an approved creator or brand — not a pending applicant, not a rejected
  // one, and not an administrator, who has no Whop account of their own to
  // link.
  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const auth = { ok: true as const, user: { uid: gate.context.uid as string } };

  const config = resolveOAuthConfig();
  if (!config.ok) return json({ error: "unavailable" }, 503);
  // Without the encryption key the flow cannot store a verifier or a token, so
  // it must not be started at all.
  if (!isTokenEncryptionConfigured()) return json({ error: "unavailable" }, 503);

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let returnKey = "onboarding";
  if (length > 0) {
    try {
      const body = (await request.json()) as { return_to?: unknown } | null;
      if (typeof body?.return_to === "string" && body.return_to in RETURN_PATHS) {
        returnKey = body.return_to;
      }
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
  }

  const state = createRandomToken();
  const nonce = createRandomToken();
  const codeVerifier = createCodeVerifier();

  const stored = await createAuthorization({
    state,
    firebaseUid: auth.user.uid,
    codeVerifier,
    returnPath: RETURN_PATHS[returnKey],
  });
  if (!stored) return json({ error: "unavailable" }, 503);

  const authorizeUrl = buildAuthorizeUrl({
    config: config.config,
    state,
    nonce,
    codeChallenge: codeChallengeFor(codeVerifier),
  });

  const response = json({ authorize_url: authorizeUrl }, 200);

  // Binds the callback to the browser that started the flow. If a second
  // person begins their own connection in this browser, this is overwritten
  // and the first state no longer matches.
  //
  // SameSite=Lax, not Strict: the callback is a top-level GET navigation from
  // whop.com, and Strict would withhold the cookie on exactly that request —
  // every link would fail as a mismatch.
  //
  // Secure follows the actual scheme. Always setting it looks stricter but is
  // worse: a browser silently DROPS a Secure cookie on http://localhost, so
  // local development would fail at the callback with no cookie and no clue.
  const isHttps = new URL(request.url).protocol === "https:";
  const attributes = [
    `cr_whop_link=${state}`,
    "Path=/api/whop",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${LINK_COOKIE_MAX_AGE}`,
    ...(isHttps ? ["Secure"] : []),
  ];
  response.headers.append("set-cookie", attributes.join("; "));
  return response;
}
