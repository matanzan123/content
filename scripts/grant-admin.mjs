/**
 * Grants or revokes the `admin` custom claim.
 *
 *   node scripts/grant-admin.mjs someone@example.com
 *   node scripts/grant-admin.mjs someone@example.com --revoke
 *
 * Run from a trusted machine with the service account in the environment. The
 * claim is deliberately NOT settable from the product: there is no UI, no API
 * route and no self-service path that can grant it, so a compromised session
 * cannot escalate itself.
 *
 * Existing sessions are revoked on every change, so a removal takes effect on
 * the target's next request rather than whenever their cookie expires.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/** Minimal .env.local reader — this script runs outside Next's env loading. */
function loadEnv() {
  try {
    const file = readFileSync(path.resolve(".env.local"), "utf8");
    // Split on either ending: a CRLF file leaves a trailing \r that JS's `.`
    // will not match, which silently drops every variable on Windows.
    for (const line of file.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Falls through to whatever is already in the environment.
  }
}

loadEnv();

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!email || !email.includes("@")) {
  console.error("usage: node scripts/grant-admin.mjs <email> [--revoke]");
  process.exit(1);
}

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

if (!projectId || !clientEmail || !privateKey) {
  console.error(
    "Missing service account. Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL\n" +
      "and FIREBASE_ADMIN_PRIVATE_KEY (see .env.example).",
  );
  process.exit(1);
}

initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
const auth = getAuth();

const user = await auth.getUserByEmail(email).catch(() => null);
if (!user) {
  console.error(`No Firebase user for ${email}. They must sign in once first.`);
  process.exit(1);
}

// Preserve any other claims already on the account.
const claims = { ...(user.customClaims ?? {}) };
if (revoke) delete claims.admin;
else claims.admin = true;

await auth.setCustomUserClaims(user.uid, claims);
await auth.revokeRefreshTokens(user.uid);

console.log(
  `${revoke ? "Revoked" : "Granted"} admin for ${email} (${user.uid}).\n` +
    "Existing sessions were revoked; they must sign in again.",
);
