import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { whopConnections, whopOauthStates } from "@/lib/db/schema";
import { decryptToken, encryptToken, isTokenEncryptionConfigured } from "./token-crypto";

/* ==========================================================================
   WHOP CONNECTION STORE — server only.

   Two responsibilities: the short-lived record of an authorization in flight,
   and the durable link between a ClipRewards user and a Whop identity.

   Every uniqueness rule that matters is a DATABASE constraint, not a check in
   this file. An application check loses to a concurrent request; a partial
   unique index does not.
   ========================================================================== */

/** How long a person has to finish consenting. Short on purpose. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export type PendingAuthorization = {
  state: string;
  firebaseUid: string;
  codeVerifier: string;
  returnPath: string;
};

export type WhopConnection = {
  firebaseUid: string;
  whopUserId: string;
  whopUsername: string | null;
  scopes: string;
  tokenExpiresAt: Date | null;
  connectedAt: Date;
  revokedAt: Date | null;
};

/* ----------------------------- in-flight state --------------------------- */

/**
 * Records an authorization about to start.
 *
 * The verifier is encrypted before it touches the database, bound to the uid
 * that will own the link.
 */
export async function createAuthorization(input: {
  state: string;
  firebaseUid: string;
  codeVerifier: string;
  returnPath: string;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const ciphertext = encryptToken(input.codeVerifier, input.firebaseUid);
  // No key, no flow. Starting an authorization we could not finish securely
  // would strand the user at a callback that has to refuse them.
  if (!ciphertext) return false;

  try {
    await db.insert(whopOauthStates).values({
      state: input.state,
      firebaseUid: input.firebaseUid,
      codeVerifierCiphertext: ciphertext,
      returnPath: input.returnPath,
      expiresAt: sql`now() + make_interval(secs => ${OAUTH_STATE_TTL_SECONDS})`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Consumes a state exactly once.
 *
 * `DELETE … RETURNING` in one statement is what makes replay impossible: the
 * second arrival of the same authorization code finds no row, whatever order
 * the requests arrive in and whichever process handles them. Expiry is
 * evaluated by Postgres, so a slow client cannot win by having a fast clock.
 *
 * Returns null for unknown, already-used and expired alike — a caller has no
 * safe use for the distinction, and telling them apart helps only a prober.
 */
export async function consumeAuthorization(state: string): Promise<PendingAuthorization | null> {
  const db = getDb();
  if (!db || typeof state !== "string" || state.length < 20 || state.length > 200) return null;

  const [row] = await db
    .delete(whopOauthStates)
    .where(and(eq(whopOauthStates.state, state), sql`${whopOauthStates.expiresAt} > now()`))
    .returning();

  if (!row) return null;

  const codeVerifier = decryptToken(row.codeVerifierCiphertext, row.firebaseUid);
  if (!codeVerifier) return null;

  return {
    state: row.state,
    firebaseUid: row.firebaseUid,
    codeVerifier,
    returnPath: row.returnPath,
  };
}

/** Housekeeping for authorizations nobody finished. Safe to run any time. */
export async function purgeExpiredAuthorizations(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const removed = await db
    .delete(whopOauthStates)
    .where(sql`${whopOauthStates.expiresAt} <= now()`)
    .returning({ state: whopOauthStates.state });
  return removed.length;
}

/* ------------------------------ connections ------------------------------ */

export type LinkResult =
  | { ok: true; connection: WhopConnection; replacedPrevious: boolean }
  | {
      ok: false;
      reason:
        | "storage_unavailable"
        | "encryption_unavailable"
        | "whop_identity_taken"
        | "storage_error";
    };

/**
 * Links a Whop identity to a ClipRewards user.
 *
 * THE ANTI-TAKEOVER RULE: if this Whop identity is already linked to a
 * DIFFERENT user, the link is refused. Enforced twice over — checked here for
 * a clear answer, and enforced by `uniq_whop_connection_active_whop_user` in
 * the database so a concurrent pair of requests cannot both win.
 *
 * Re-linking the same identity to the same user is allowed and simply
 * refreshes the credentials: someone reconnecting after a token expiry should
 * not have to disconnect first.
 */
export async function linkWhopIdentity(input: {
  firebaseUid: string;
  whopUserId: string;
  whopUsername: string | null;
  scopes: string;
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
}): Promise<LinkResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "storage_unavailable" };
  if (!isTokenEncryptionConfigured()) return { ok: false, reason: "encryption_unavailable" };

  const accessCiphertext = encryptToken(input.accessToken, input.firebaseUid);
  const refreshCiphertext = input.refreshToken
    ? encryptToken(input.refreshToken, input.firebaseUid)
    : null;
  if (!accessCiphertext || (input.refreshToken && !refreshCiphertext)) {
    return { ok: false, reason: "encryption_unavailable" };
  }

  const expiresAt =
    input.expiresInSeconds && input.expiresInSeconds > 0
      ? sql`now() + make_interval(secs => ${input.expiresInSeconds})`
      : null;

  try {
    return await db.transaction(async (tx) => {
      const [claimedElsewhere] = await tx
        .select({ firebaseUid: whopConnections.firebaseUid })
        .from(whopConnections)
        .where(and(eq(whopConnections.whopUserId, input.whopUserId), isNull(whopConnections.revokedAt)));

      if (claimedElsewhere && claimedElsewhere.firebaseUid !== input.firebaseUid) {
        return { ok: false, reason: "whop_identity_taken" } as LinkResult;
      }

      // Retire any existing active link for this user. Keeping it as history
      // rather than deleting it means a disconnect/reconnect sequence stays
      // auditable.
      const retired = await tx
        .update(whopConnections)
        .set({ revokedAt: sql`now()`, accessTokenCiphertext: null, refreshTokenCiphertext: null })
        .where(and(eq(whopConnections.firebaseUid, input.firebaseUid), isNull(whopConnections.revokedAt)))
        .returning({ id: whopConnections.id });

      const [created] = await tx
        .insert(whopConnections)
        .values({
          firebaseUid: input.firebaseUid,
          whopUserId: input.whopUserId,
          whopUsername: input.whopUsername,
          scopes: input.scopes,
          accessTokenCiphertext: accessCiphertext,
          refreshTokenCiphertext: refreshCiphertext,
          tokenExpiresAt: expiresAt,
        })
        .returning();

      return {
        ok: true,
        connection: toConnection(created),
        replacedPrevious: retired.length > 0,
      } as LinkResult;
    });
  } catch {
    // The partial unique index rejects a race that got past the read above.
    return { ok: false, reason: "storage_error" };
  }
}

/** The active link for a user, or null. Never returns token material. */
export async function getActiveConnection(firebaseUid: string): Promise<WhopConnection | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(whopConnections)
    .where(and(eq(whopConnections.firebaseUid, firebaseUid), isNull(whopConnections.revokedAt)));
  return row ? toConnection(row) : null;
}

/**
 * The decrypted access token for a user's own connection.
 *
 * Separate from `getActiveConnection` on purpose: status reads happen all over
 * the application and must not carry credentials, so obtaining one is an
 * explicit act with the uid as the only key.
 */
export async function getAccessTokenFor(firebaseUid: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(whopConnections)
    .where(and(eq(whopConnections.firebaseUid, firebaseUid), isNull(whopConnections.revokedAt)));
  if (!row?.accessTokenCiphertext) return null;
  return decryptToken(row.accessTokenCiphertext, firebaseUid);
}

export type DisconnectResult =
  | { ok: true; revokedToken: string | null }
  | { ok: false; reason: "storage_unavailable" | "not_connected" };

/**
 * Revokes a user's own link.
 *
 * Scoped to the caller's uid, so a request cannot disconnect anybody else —
 * the uid comes from a verified ID token and never from the request body.
 *
 * Credentials are cleared in the same statement that marks the row revoked,
 * and the access token is handed back once so the caller can attempt provider
 * revocation. It is not readable afterwards.
 */
export async function disconnectWhop(firebaseUid: string): Promise<DisconnectResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "storage_unavailable" };

  const [row] = await db
    .update(whopConnections)
    .set({ revokedAt: sql`now()`, accessTokenCiphertext: null, refreshTokenCiphertext: null })
    .where(and(eq(whopConnections.firebaseUid, firebaseUid), isNull(whopConnections.revokedAt)))
    .returning();

  if (!row) return { ok: false, reason: "not_connected" };

  // `returning()` gives the pre-update row's ciphertext in Postgres only for
  // the columns as written, so read what we cleared from the returned row.
  const ciphertext = row.accessTokenCiphertext;
  return { ok: true, revokedToken: ciphertext ? decryptToken(ciphertext, firebaseUid) : null };
}

function toConnection(row: typeof whopConnections.$inferSelect): WhopConnection {
  return {
    firebaseUid: row.firebaseUid,
    whopUserId: row.whopUserId,
    whopUsername: row.whopUsername,
    scopes: row.scopes,
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
  };
}

/* --------------------------- refresh rotation ---------------------------- */

export type RefreshOutcome =
  | { ok: true; accessToken: string; refreshed: boolean }
  | { ok: false; reason: "not_connected" | "reconnect_required" | "provider_error" | "unavailable" };

/** Refresh a little before expiry, so a request never races the clock. */
const REFRESH_SKEW_SECONDS = 120;

/**
 * Returns a usable access token for a user's own connection, refreshing it
 * first if it is at or near expiry.
 *
 * WHOP ROTATES REFRESH TOKENS: each use returns a new one and retires the old.
 * That makes a concurrent refresh actively dangerous — two callers would each
 * exchange the same token, one would succeed, and the loser would overwrite
 * the winner's fresh token with one the provider has already retired. The
 * connection would then be unrecoverable without a full reconnect.
 *
 * The fix is a row lock, not a mutex: `SELECT … FOR UPDATE` inside a
 * transaction serialises every caller across every process. Whoever gets the
 * lock re-reads expiry inside it, so the second caller finds the token already
 * refreshed and simply uses it rather than refreshing again.
 *
 * `invalid_grant` — a refresh token the provider no longer accepts — is
 * terminal. The connection is revoked and its credentials cleared, which
 * surfaces to the user as "not connected" and prompts a reconnect. Retrying a
 * rejected grant only burns the remaining credential.
 */
export async function getUsableAccessToken(
  firebaseUid: string,
  refresh: (refreshToken: string) => Promise<
    | { ok: true; tokens: { accessToken: string; refreshToken: string | null; expiresIn: number | null } }
    | { ok: false; reason: string }
  >,
): Promise<RefreshOutcome> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unavailable" };

  try {
    return await db.transaction(async (tx) => {
      // The lock is taken before anything is read, so the decision to refresh
      // and the write that follows are one indivisible step.
      const [row] = await tx
        .select()
        .from(whopConnections)
        .where(and(eq(whopConnections.firebaseUid, firebaseUid), isNull(whopConnections.revokedAt)))
        .for("update");

      if (!row) return { ok: false, reason: "not_connected" } as RefreshOutcome;
      if (!row.accessTokenCiphertext) return { ok: false, reason: "reconnect_required" } as RefreshOutcome;

      const expiresAt = row.tokenExpiresAt ? row.tokenExpiresAt.getTime() : null;
      const stillFresh =
        expiresAt === null || expiresAt - Date.now() > REFRESH_SKEW_SECONDS * 1000;

      if (stillFresh) {
        const token = decryptToken(row.accessTokenCiphertext, firebaseUid);
        return token
          ? ({ ok: true, accessToken: token, refreshed: false } as RefreshOutcome)
          : ({ ok: false, reason: "reconnect_required" } as RefreshOutcome);
      }

      // Expired or nearly so, and we hold the lock.
      if (!row.refreshTokenCiphertext) {
        return { ok: false, reason: "reconnect_required" } as RefreshOutcome;
      }
      const refreshToken = decryptToken(row.refreshTokenCiphertext, firebaseUid);
      if (!refreshToken) return { ok: false, reason: "reconnect_required" } as RefreshOutcome;

      const result = await refresh(refreshToken);

      if (!result.ok) {
        // A grant the provider rejects is spent. Revoke rather than retry.
        if (result.reason === "invalid_grant" || result.reason === "provider_rejected") {
          await tx
            .update(whopConnections)
            .set({
              revokedAt: sql`now()`,
              accessTokenCiphertext: null,
              refreshTokenCiphertext: null,
            })
            .where(eq(whopConnections.id, row.id));
          return { ok: false, reason: "reconnect_required" } as RefreshOutcome;
        }
        // A network blip leaves the connection intact for the next attempt.
        return { ok: false, reason: "provider_error" } as RefreshOutcome;
      }

      const nextAccess = encryptToken(result.tokens.accessToken, firebaseUid);
      const nextRefresh = result.tokens.refreshToken
        ? encryptToken(result.tokens.refreshToken, firebaseUid)
        : row.refreshTokenCiphertext;
      if (!nextAccess) return { ok: false, reason: "unavailable" } as RefreshOutcome;

      await tx
        .update(whopConnections)
        .set({
          accessTokenCiphertext: nextAccess,
          refreshTokenCiphertext: nextRefresh,
          tokenExpiresAt:
            result.tokens.expiresIn && result.tokens.expiresIn > 0
              ? sql`now() + make_interval(secs => ${result.tokens.expiresIn})`
              : null,
          lastRefreshedAt: sql`now()`,
        })
        .where(eq(whopConnections.id, row.id));

      return { ok: true, accessToken: result.tokens.accessToken, refreshed: true } as RefreshOutcome;
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
