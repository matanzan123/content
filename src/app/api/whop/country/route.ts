import { requireWhopEligible } from "@/lib/server/access";
import { getConnectedAccount } from "@/lib/server/connected-accounts";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getProfile, setPayoutCountry } from "@/lib/server/users";
import { resolvePlatformConfig } from "@/lib/server/whop-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 1024;

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;

  const firebaseUid = gate.context.uid as string;

  const platform = resolvePlatformConfig();
  if (!platform.ok) {
    return json({ error: "unavailable", reason: platform.reason }, 503);
  }

  const profile = await getProfile(firebaseUid);
  const existing = await getConnectedAccount(firebaseUid, platform.config.environment);

  return json({
    country_code: profile?.countryCode ?? null,
    locked: existing !== null,
  });
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return json({ error: "forbidden" }, 403);
  }

  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;

  const firebaseUid = gate.context.uid as string;

  const platform = resolvePlatformConfig();
  if (!platform.ok) {
    return json({ error: "unavailable", reason: platform.reason }, 503);
  }

  const existing = await getConnectedAccount(firebaseUid, platform.config.environment);
  if (existing) {
    return json({ error: "country_locked" }, 409);
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const raw =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).country_code
      : null;

  if (typeof raw !== "string") {
    return json({ error: "invalid_country" }, 400);
  }

  const result = await setPayoutCountry(firebaseUid, raw);

  if (!result.ok) {
    const status =
      result.reason === "invalid_country"
        ? 400
        : result.reason === "profile_not_found"
          ? 409
          : 503;

    return json({ error: result.reason }, status);
  }

  return json({
    ok: true,
    country_code: result.countryCode,
  });
}