import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/* ==========================================================================
   AUTHENTICATED ENCRYPTION for Google OAuth token material — server only.

   Same scheme as `token-crypto.ts` — AES-256-GCM, versioned envelope, AAD
   binding — under a SEPARATE KEY, and that separation is the point rather
   than an accident.

   WHY A SECOND KEY. The Whop key protects credentials for a creator's own
   Whop account; this one protects a refresh token for the ClipRewards
   INTERVIEW GOOGLE ACCOUNT, which can create and modify calendar events for
   the company. They have different blast radii and different rotation
   reasons: rotating the Whop key must not force a Google reconnection, and a
   compromise of one must not hand over the other.

   ADDITIONAL AUTHENTICATED DATA binds each ciphertext to the connection it
   belongs to, so a blob cannot be moved between rows and still decrypt.

   FAIL CLOSED. No key, a short key, a malformed key: encryption refuses and
   the integration reports itself unconfigured. There is no plaintext path.
   ========================================================================== */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type GoogleKeyResult =
  | { ok: true; key: Buffer }
  | { ok: false; reason: "missing" | "malformed" | "wrong_length" };

/**
 * Reads the Google token encryption key. Base64, decoding to exactly 32 bytes.
 *
 * Generate one with: openssl rand -base64 32
 */
export function readGoogleEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): GoogleKeyResult {
  const raw = env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return { ok: false, reason: "missing" };

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // `Buffer.from` is lenient with non-base64 input, so the length check is
  // what actually rejects a truncated or mistyped key.
  if (key.length !== KEY_BYTES) return { ok: false, reason: "wrong_length" };
  return { ok: true, key };
}

export function isGoogleEncryptionConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readGoogleEncryptionKey(env).ok;
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Null when unavailable. */
export function encryptGoogleToken(
  plaintext: string,
  aad: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const keyResult = readGoogleEncryptionKey(env);
  if (!keyResult.ok) return null;
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, keyResult.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  } catch {
    return null;
  }
}

/** Null on any failure — wrong key, tampered row, or a moved ciphertext. */
export function decryptGoogleToken(
  envelope: string,
  aad: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const keyResult = readGoogleEncryptionKey(env);
  if (!keyResult.ok) return null;
  if (typeof envelope !== "string") return null;

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, keyResult.key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
