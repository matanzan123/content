import "server-only";

import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/* ==========================================================================
   FIREBASE ADMIN — server only.

   This module is the only place a service account is ever touched. The
   `server-only` import above turns any accidental import from a client
   component into a build error rather than a leaked private key.

   DENY BY DEFAULT is the whole contract here: if the credentials are absent,
   malformed, or the SDK cannot initialise, every accessor returns null and the
   admin guard refuses access. There is deliberately no development fallback —
   a missing service account must never mean "let everyone in".
   ========================================================================== */

const APP_NAME = "cliprewards-admin";

/**
 * Private keys are stored in env with literal "\n" sequences, because most
 * hosting dashboards cannot hold a real newline in a single-line value.
 */
function readPrivateKey(): string | null {
  const raw = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
  if (!raw) return null;
  const key = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return key.includes("BEGIN PRIVATE KEY") ? key : null;
}

type Credentials = { projectId: string; clientEmail: string; privateKey: string };

function readCredentials(): Credentials | null {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = readPrivateKey();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

/**
 * True when the server can verify identities at all. Used to report
 * configuration state — never as a reason to skip a check.
 */
export function isAdminSdkConfigured(): boolean {
  return readCredentials() !== null;
}

let cached: App | null = null;

function getAdminApp(): App | null {
  if (cached) return cached;
  const credentials = readCredentials();
  if (!credentials) return null;

  try {
    const existing = getApps().find((a) => a.name === APP_NAME);
    cached = existing ?? initializeApp({ credential: cert(credentials) }, APP_NAME);
    return cached;
  } catch {
    // A malformed key throws here. Staying null keeps the guard closed.
    try {
      cached = getApp(APP_NAME);
      return cached;
    } catch {
      return null;
    }
  }
}

/** Returns null when identity cannot be verified. Callers must treat that as a denial. */
export function getAdminAuth(): Auth | null {
  const app = getAdminApp();
  return app ? getAuth(app) : null;
}

/** Returns null when the Admin SDK is not configured. */
export function getAdminFirestore(): Firestore | null {
  const app = getAdminApp();
  return app ? getFirestore(app) : null;
}
