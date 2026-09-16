import { requireWhopEligible } from "@/lib/server/access";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { getAdminAuth } from "@/lib/server/firebase-admin";
import { getActiveConnection } from "@/lib/server/whop-connections";
import { getConnectedAccount, recordConnectedAccount } from "@/lib/server/connected-accounts";
import {
  createConnectedAccount,
  findConnectedAccountByUid,
  getPlatformAccount,
  resolvePlatformConfig,
} from "@/lib/server/whop-accounts";

/* ==========================================================================
   PROVISION THE CREATOR'S CONNECTED ACCOUNT.

   Creates ONE Whop Account (`biz_…`) as a child of the ClipRewards platform
   account and binds it to the calling creator. That is the whole of this
   endpoint: no KYC, no account link, no payout account, no transfer.

   THE REQUEST BODY IS NOT READ, AT ALL. There is no uid, no Whop user id, no
   parent account, no environment and no metadata parameter — so "act on
   another creator's behalf" is not something a caller can express, rather than
   something a check has to catch. Ownership comes from the verified session
   and from the OAuth connection already stored for it.

   THE CREATOR'S OAUTH TOKEN IS NEVER USED HERE. `POST /accounts` with a user
   token creates a STANDALONE company; with the platform API key it creates a
   child. This route only ever reaches the provider through `whop-accounts.ts`,
   which takes no token parameter.

   IDEMPOTENT IN THREE LAYERS: a local pre-check, an `Idempotency-Key` on the
   provider call, and a unique index that resolves a race by handing both
   callers the same row.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** ISO 3166-1 alpha-2, and nothing else. Optional — see below. */
function readConfiguredCountry(): string | null {
  const raw = process.env.WHOP_CONNECTED_ACCOUNT_COUNTRY?.trim();
  if (!raw) return null;
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) return json({ error: "forbidden" }, 403);

  // The same gate Whop connection uses: an approved creator or brand, decided
  // from the product role and approval status.
  const gate = await requireWhopEligible(request);
  if (gate.denied) return gate.response;
  const firebaseUid = gate.context.uid as string;

  const platform = resolvePlatformConfig();
  if (!platform.ok) return json({ error: "unavailable", reason: platform.reason }, 503);
  const { environment } = platform.config;

  /* --- 1. Already provisioned? Then nothing is created. ---------------- */
  const existing = await getConnectedAccount(firebaseUid, environment);
  if (existing) {
    return json(
      {
        ok: true,
        created: false,
        account: {
          whop_account_id: existing.whopAccountId,
          environment: existing.environment,
          status: existing.status,
          onboarding_type: existing.onboardingType,
        },
      },
      200,
    );
  }

  /* --- 2. Task #8 builds on Task #7: no identity, no account. ---------- */
  const connection = await getActiveConnection(firebaseUid);
  if (!connection) return json({ error: "whop_identity_required" }, 409);

  /* --- 3. Platform account (needed for reconciliation and creation). --- */
  const parent = await getPlatformAccount(platform.config);
  if (!parent.ok) {
    const status = parent.reason === "platforms_access_required" ? 403 : 502;
    return json({ error: parent.reason }, status);
  }

  /* --- 4. Reconcile: account may exist at Whop but not in our DB. ----- */
  const found = await findConnectedAccountByUid(platform.config, parent.account.id, firebaseUid);
  if (found.ok) {
    const stored = await recordConnectedAccount({
      firebaseUid,
      whopAccountId: found.account.id,
      whopUserId: found.account.whopUserId,
      parentAccountId: found.account.parentAccountId as string,
      environment,
      status: found.account.status,
      onboardingType: found.account.onboardingType,
    });
    if (!stored.ok) return json({ error: stored.reason }, 503);
    return json(
      {
        ok: true,
        created: stored.created,
        reconciled: true,
        account: {
          whop_account_id: stored.account.whopAccountId,
          environment: stored.account.environment,
          status: stored.account.status,
          onboarding_type: stored.account.onboardingType,
        },
      },
      200,
    );
  }
  if (found.reason !== "not_found") {
    return json({ error: found.reason }, 502);
  }

  /* --- 5. Inputs, every one of them resolved on the server. ------------ */
  const auth = getAdminAuth();
  if (!auth) return json({ error: "unavailable", reason: "unconfigured" }, 503);

  let email: string | null = null;
  try {
    const record = await auth.getUser(firebaseUid);
    email = record.email ?? null;
  } catch {
    email = null;
  }
  // Whop requires an owner email for API-key account creation, and the only
  // trustworthy source is Firebase — never a request body.
  if (!email) return json({ error: "email_unavailable" }, 409);

  /*
   * COUNTRY IS NOT INVENTED. No profile field records one today, so rather
   * than guessing a jurisdiction for a financial account, this sends the value
   * only when an operator has configured one and otherwise omits the field —
   * Whop then inherits the parent account's country, which is its documented
   * behaviour for connected accounts.
   */
  const country = readConfiguredCountry();

  // Display name from data the server already holds. Omitted when nothing
  // trustworthy exists; Whop falls back to the owner's email.
  const title = gate.context.profile?.fullName?.trim() || connection.whopUsername || undefined;

  /* --- 6. Create, with a key stable for this creator and environment. -- */
  const created = await createConnectedAccount(platform.config, parent.account.id, {
    email,
    title,
    country: country ?? undefined,
    metadata: {
      // Binds the provider object back to us, and is what Task #9 will read
      // when reconciling an account that already exists at Whop.
      firebase_uid: firebaseUid,
      whop_user_id: connection.whopUserId,
      source: "cliprewards",
    },
    idempotencyKey: `cliprewards:connected-account:${environment}:${firebaseUid}`,
  });

  if (!created.ok) {
    // PLATFORMS ACCESS IS A SUPPORTED STATE, not a crash: Whop grants it per
    // account, so an unapproved platform is reported plainly and changes
    // nothing locally.
    if (created.reason === "platforms_access_required") {
      return json({ error: "platforms_access_required" }, 403);
    }
    if (created.reason === "standalone_account_returned") {
      // A real object exists at the provider but is NOT a child of ours, so it
      // is deliberately not recorded. An operator must reconcile it.
      return json({ error: "standalone_account_returned" }, 502);
    }
    const status = created.reason === "provider_unauthorized" ? 502 : 502;
    return json({ error: created.reason }, status);
  }

  /* --- 7. Persist; a lost race reads back the winner. ------------------ */
  const stored = await recordConnectedAccount({
    firebaseUid,
    whopAccountId: created.account.id,
    whopUserId: connection.whopUserId,
    parentAccountId: created.account.parentAccountId as string,
    environment,
    status: created.account.status,
    onboardingType: created.account.onboardingType,
  });
  if (!stored.ok) return json({ error: stored.reason }, 503);

  return json(
    {
      ok: true,
      created: stored.created,
      account: {
        whop_account_id: stored.account.whopAccountId,
        environment: stored.account.environment,
        status: stored.account.status,
        onboarding_type: stored.account.onboardingType,
      },
    },
    stored.created ? 201 : 200,
  );
}
