import { requireUser } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getProfile, saveProfile } from "@/lib/server/users";

/* ==========================================================================
   ONBOARDING PROFILE — durable answers, so a reload or a second device
   returns the user to the step they were on.

   The wizard previously kept this in `localStorage` only, which meant signing
   in on another machine restarted onboarding from nothing. The same fields are
   persisted here; no new profile schema was invented.

   COMPLETING A PROFILE GRANTS NOTHING. `saveProfile` stamps
   `onboarding_completed_at` and then recomputes progress, which is
   structurally incapable of producing an approval.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 32_768;

/** Accepts only known fields. An unexpected key is dropped, never stored. */
function readProfileBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  return {
    fullName: str(b.fullName),
    bio: str(b.bio),
    photoUrl: str(b.photoUrl),
    languages: arr(b.languages),
    creatorType: str(b.creatorType),
    referralSource: str(b.referralSource),
    socials: arr(b.socials),
    companyName: str(b.companyName),
    lastStep: typeof b.lastStep === "number" ? b.lastStep : 0,
    complete: b.complete === true,
  };
}

export async function GET(request: Request) {
  const gate = await requireUser(request);
  if (gate.denied) return gate.response;

  return Response.json(
    {
      profile: await getProfile(gate.context.uid as string),
      role: gate.context.user?.role ?? null,
      status: gate.context.user?.approvalStatus ?? null,
      stage: gate.context.stage,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const gate = await requireUser(request);
  if (gate.denied) return gate.response;

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  }

  let input;
  try {
    input = readProfileBody(await request.json());
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await saveProfile(gate.context.uid as string, input);
  if (!result.ok) {
    const status = result.reason === "already_decided" ? 409 : 500;
    return Response.json({ error: result.reason }, { status, headers: NO_STORE });
  }

  return Response.json(
    { ok: true, status: result.user.approvalStatus },
    { headers: NO_STORE },
  );
}
