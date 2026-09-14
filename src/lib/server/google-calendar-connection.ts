import "server-only";

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { googleCalendarConnections, googleOauthStates } from "@/lib/db/schema";
import { decryptGoogleToken, encryptGoogleToken, isGoogleEncryptionConfigured } from "./google-crypto";
import {
  GOOGLE_CALENDAR_SCOPE,
  refreshGoogleAccessToken,
  resolveGoogleOAuthConfig,
  type GoogleOAuthConfig,
} from "./google-oauth";
import { getWhopEnvironment } from "./whop-payments";

/* ==========================================================================
   THE INTERVIEW CALENDAR CONNECTION — storage and token lifecycle.

   ONE ACTIVE CONNECTION PER ENVIRONMENT, held by a partial unique index.
   Reconnecting revokes the previous row rather than editing it, so it stays
   visible that the account changed and when.

   AAD BINDS EACH CIPHERTEXT TO ITS ROW. The connection id is the additional
   authenticated data, so a token blob copied into another row fails to
   decrypt rather than decrypting into the wrong connection.

   REFRESH IS SERIALISED BY A ROW LOCK. Google does not rotate refresh tokens
   on this grant, so a concurrent refresh is not destructive the way Whop's
   is — but two callers racing would still burn quota and could write an older
   access token over a newer one, so `SELECT … FOR UPDATE` decides.
   ========================================================================== */

/** Ten minutes: long enough for consent, short enough to matter. */
export const GOOGLE_STATE_TTL_SECONDS = 10 * 60;
/** Refresh a little before expiry so a request never races the clock. */
const REFRESH_SKEW_SECONDS = 120;

export type Environment = "sandbox" | "production";

/** The environment this integration is operating in, or null when unset. */
export function currentEnvironment(
  env: Record<string, string | undefined> = process.env,
): Environment | null {
  return getWhopEnvironment(env);
}

export type ConnectionSummary = {
  id: string;
  environment: Environment;
  accountEmail: string | null;
  scopes: string;
  connectedAt: Date;
  lastRefreshedAt: Date | null;
  accessTokenExpiresAt: Date | null;
  connectedByUid: string | null;
};

/* -------------------------------------------------------------------------
   OAuth state — one-time and expiring
   ------------------------------------------------------------------------- */

export async function createOAuthState(input: {
  state: string;
  adminUid: string;
  environment: Environment;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    await db.insert(googleOauthStates).values({
      state: input.state,
      adminUid: input.adminUid,
      environment: input.environment,
      expiresAt: sql`now() + make_interval(secs => ${GOOGLE_STATE_TTL_SECONDS})`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Consumes a state exactly once.
 *
 * `DELETE … RETURNING` with the expiry in the predicate, so a replay, an
 * expired flow and a forged value are all the same refusal — decided by the
 * database rather than by a read-then-delete that another request could
 * interleave with.
 */
export async function consumeOAuthState(
  state: string,
): Promise<{ adminUid: string; environment: Environment } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .delete(googleOauthStates)
      .where(and(eq(googleOauthStates.state, state), sql`${googleOauthStates.expiresAt} > now()`))
      .returning();
    return row ? { adminUid: row.adminUid, environment: row.environment } : null;
  } catch {
    return null;
  }
}

/** Housekeeping for states nobody completed. */
export async function purgeExpiredOAuthStates(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .delete(googleOauthStates)
    .where(lt(googleOauthStates.expiresAt, sql`now()`))
    .returning({ state: googleOauthStates.state });
  return rows.length;
}

/* -------------------------------------------------------------------------
   The connection itself
   ------------------------------------------------------------------------- */

export type SaveResult =
  | { ok: true; connection: ConnectionSummary; replacedPrevious: boolean }
  | { ok: false; reason: "unconfigured" | "encryption_unavailable" | "no_refresh_token" | "storage_error" };

/**
 * Records a newly authorised connection, replacing any previous one.
 *
 * A REFRESH TOKEN IS REQUIRED. Google omits it when an account re-authorises
 * a scope it has already granted unless `prompt=consent` is sent — and a
 * connection with only an access token silently stops working an hour later.
 * Refusing here turns that into an immediate, explainable error.
 */
export async function saveConnection(input: {
  environment: Environment;
  adminUid: string;
  refreshToken: string | null;
  accessToken: string | null;
  expiresInSeconds: number | null;
  scopes: string;
  accountEmail?: string | null;
}): Promise<SaveResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };
  if (!isGoogleEncryptionConfigured()) return { ok: false, reason: "encryption_unavailable" };
  // Narrowed here so the rest of this function works with a value that is
  // known to exist, rather than re-asserting it at the encryption call.
  const refreshToken = input.refreshToken;
  if (!refreshToken) return { ok: false, reason: "no_refresh_token" };

  try {
    return await db.transaction(async (tx) => {
      const retired = await tx
        .update(googleCalendarConnections)
        .set({
          revokedAt: sql`now()`,
          refreshTokenCiphertext: null,
          accessTokenCiphertext: null,
        })
        .where(
          and(
            eq(googleCalendarConnections.environment, input.environment),
            isNull(googleCalendarConnections.revokedAt),
          ),
        )
        .returning({ id: googleCalendarConnections.id });

      // The row id is the AAD, so it has to exist before the ciphertext does.
      const [created] = await tx
        .insert(googleCalendarConnections)
        .values({
          environment: input.environment,
          scopes: input.scopes,
          connectedByUid: input.adminUid,
          accountEmail: input.accountEmail ?? null,
          refreshTokenCiphertext: "v1.pending",
        })
        .returning();

      const refreshCiphertext = encryptGoogleToken(refreshToken, created.id);
      const accessCiphertext = input.accessToken
        ? encryptGoogleToken(input.accessToken, created.id)
        : null;
      if (!refreshCiphertext) throw new Error("encryption_unavailable");

      const [stored] = await tx
        .update(googleCalendarConnections)
        .set({
          refreshTokenCiphertext: refreshCiphertext,
          accessTokenCiphertext: accessCiphertext,
          accessTokenExpiresAt:
            input.expiresInSeconds && input.expiresInSeconds > 0
              ? sql`now() + make_interval(secs => ${input.expiresInSeconds})`
              : null,
        })
        .where(eq(googleCalendarConnections.id, created.id))
        .returning();

      return {
        ok: true,
        connection: toSummary(stored),
        replacedPrevious: retired.length > 0,
      } as SaveResult;
    });
  } catch {
    return { ok: false, reason: "storage_error" };
  }
}

function toSummary(row: typeof googleCalendarConnections.$inferSelect): ConnectionSummary {
  return {
    id: row.id,
    environment: row.environment,
    accountEmail: row.accountEmail,
    scopes: row.scopes,
    connectedAt: row.connectedAt,
    lastRefreshedAt: row.lastRefreshedAt,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    connectedByUid: row.connectedByUid,
  };
}

/** The active connection's SAFE metadata. Never returns token material. */
export async function getConnectionSummary(
  environment: Environment,
): Promise<ConnectionSummary | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(googleCalendarConnections)
    .where(
      and(
        eq(googleCalendarConnections.environment, environment),
        isNull(googleCalendarConnections.revokedAt),
      ),
    );
  return row ? toSummary(row) : null;
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; connectionId: string }
  | {
      ok: false;
      reason: "not_connected" | "unconfigured" | "reconnect_required" | "provider_error";
    };

/**
 * Returns a usable access token for the interview calendar, refreshing first
 * if it is at or near expiry.
 *
 * `invalid_grant` is TERMINAL and revokes the connection: a refresh token
 * Google no longer accepts — expired under a Testing publishing status,
 * revoked in the account's security settings, or superseded — will never work
 * again, and retrying only makes the failure less legible. The integration
 * then reports itself disconnected, which is the state a person can act on.
 */
export async function getCalendarAccessToken(
  environment: Environment,
  config?: GoogleOAuthConfig,
): Promise<AccessTokenResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "unconfigured" };

  const resolved = config ? { ok: true as const, config } : resolveGoogleOAuthConfig();
  if (!resolved.ok) return { ok: false, reason: "unconfigured" };
  if (!isGoogleEncryptionConfigured()) return { ok: false, reason: "unconfigured" };

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(googleCalendarConnections)
        .where(
          and(
            eq(googleCalendarConnections.environment, environment),
            isNull(googleCalendarConnections.revokedAt),
          ),
        )
        .for("update");

      if (!row) return { ok: false, reason: "not_connected" } as AccessTokenResult;

      const expiresAt = row.accessTokenExpiresAt?.getTime() ?? null;
      const stillFresh = expiresAt !== null && expiresAt - Date.now() > REFRESH_SKEW_SECONDS * 1000;

      if (stillFresh && row.accessTokenCiphertext) {
        const token = decryptGoogleToken(row.accessTokenCiphertext, row.id);
        if (token) {
          return { ok: true, accessToken: token, connectionId: row.id } as AccessTokenResult;
        }
      }

      if (!row.refreshTokenCiphertext) {
        return { ok: false, reason: "reconnect_required" } as AccessTokenResult;
      }
      const refreshToken = decryptGoogleToken(row.refreshTokenCiphertext, row.id);
      if (!refreshToken) return { ok: false, reason: "reconnect_required" } as AccessTokenResult;

      const refreshed = await refreshGoogleAccessToken({
        config: resolved.config,
        refreshToken,
      });

      if (!refreshed.ok) {
        if (refreshed.reason === "invalid_grant") {
          await tx
            .update(googleCalendarConnections)
            .set({
              revokedAt: sql`now()`,
              accessTokenCiphertext: null,
              refreshTokenCiphertext: null,
            })
            .where(eq(googleCalendarConnections.id, row.id));
          return { ok: false, reason: "reconnect_required" } as AccessTokenResult;
        }
        return { ok: false, reason: "provider_error" } as AccessTokenResult;
      }

      // Google does not rotate the refresh token on this grant, so only the
      // access token and its expiry are written back.
      const ciphertext = encryptGoogleToken(refreshed.tokens.accessToken, row.id);
      if (!ciphertext) return { ok: false, reason: "unconfigured" } as AccessTokenResult;

      await tx
        .update(googleCalendarConnections)
        .set({
          accessTokenCiphertext: ciphertext,
          accessTokenExpiresAt:
            refreshed.tokens.expiresInSeconds && refreshed.tokens.expiresInSeconds > 0
              ? sql`now() + make_interval(secs => ${refreshed.tokens.expiresInSeconds})`
              : null,
          lastRefreshedAt: sql`now()`,
        })
        .where(eq(googleCalendarConnections.id, row.id));

      return {
        ok: true,
        accessToken: refreshed.tokens.accessToken,
        connectionId: row.id,
      } as AccessTokenResult;
    });
  } catch {
    return { ok: false, reason: "provider_error" };
  }
}

/** Records the organizer address once an event reveals it. Best effort. */
export async function rememberAccountEmail(connectionId: string, email: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .update(googleCalendarConnections)
      .set({ accountEmail: email })
      .where(
        and(eq(googleCalendarConnections.id, connectionId), isNull(googleCalendarConnections.accountEmail)),
      );
  } catch {
    // Cosmetic only — never worth failing a provisioning over.
  }
}

/** The scope this integration expects to hold. */
export function hasRequiredScope(scopes: string): boolean {
  return scopes.split(/[\s,]+/).includes(GOOGLE_CALENDAR_SCOPE);
}
