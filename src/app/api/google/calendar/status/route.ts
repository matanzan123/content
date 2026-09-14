import { withAdminApi } from "@/lib/server/admin-guard";
import { isGoogleEncryptionConfigured } from "@/lib/server/google-crypto";
import { isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import {
  currentEnvironment,
  getConnectionSummary,
  hasRequiredScope,
} from "@/lib/server/google-calendar-connection";

/* ==========================================================================
   INTERVIEW CALENDAR STATUS — administrators only.

   SAFE METADATA ONLY. No token, no ciphertext, no client secret, no refresh
   material: a status endpoint that can leak a credential is a credential
   endpoint in disguise. Everything here is something an operator could read
   off the Google account page anyway.
   ========================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withAdminApi(async () => {
    const environment = currentEnvironment();
    const configured = isGoogleOAuthConfigured() && isGoogleEncryptionConfigured();

    if (!environment) {
      return { configured: false, connected: false, reason: "missing_environment" };
    }

    const connection = await getConnectionSummary(environment);
    if (!connection) return { configured, connected: false, environment };

    return {
      configured,
      connected: true,
      environment,
      account_email: connection.accountEmail,
      scopes: connection.scopes,
      scope_ok: hasRequiredScope(connection.scopes),
      connected_at: connection.connectedAt.toISOString(),
      last_refreshed_at: connection.lastRefreshedAt?.toISOString() ?? null,
      access_token_expires_at: connection.accessTokenExpiresAt?.toISOString() ?? null,
    };
  });
}
