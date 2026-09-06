import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/* ==========================================================================
   AUTHENTICATED ENCRYPTION for OAuth token material — server only.

   OAuth access and refresh tokens are bearer credentials for someone else's
   Whop account. They are stored encrypted so that a database dump, a log of a
   query, or a read-only replica does not hand an attacker working credentials.

   AES-256-GCM, so the ciphertext is authenticated as well as secret: a
   tampered row fails to decrypt rather than decrypting to something else.

   ADDITIONAL AUTHENTICATED DATA binds each ciphertext to the row it belongs
   to. Moving a blob from one user's row to another's makes the tag fail, so a
   database write cannot silently reassign a token to a different person.

   A DEDICATED KEY. `WHOP_OAUTH_TOKEN_ENCRYPTION_KEY` is not the API key and
   not the webhook secret: those rotate on their own schedules, and rotating
   one must not make stored tokens unreadable — or, worse, tempt someone to
   keep a compromised key alive because data depends on it.

   FAIL CLOSED. No key, a short key, a malformed key: encryption refuses. There
   is no plaintext fallback, because a fallback is the path every leaked-token
   incident actually takes.
   ========================================================================== */

/** v1 marks the scheme, so a future algorithm change is detectable per row. */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type KeyResult =
  | { ok: true; key: Buffer }
  | { ok: false; reason: "missing" | "malformed" | "wrong_length" };

/**
 * Reads the encryption key. Base64, decoding to exactly 32 bytes.
 *
 * Generate one with: openssl rand -base64 32
 */
export function readEncryptionKey(env: Record<string, string | undefined> = process.env): KeyResult {
  const raw = env.WHOP_OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return { ok: false, reason: "missing" };

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Buffer.from is lenient with non-base64 input, so the length check is what
  // actually rejects a typo'd or truncated key.
  if (key.length !== KEY_BYTES) return { ok: false, reason: "wrong_length" };
  return { ok: true, key };
}

export function isTokenEncryptionConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readEncryptionKey(env).ok;
}

/**
 * Encrypts token material. `aad` binds the ciphertext to its owner — pass the
 * Firebase uid the token belongs to.
 *
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64. Null when the key is
 * unusable; callers must treat that as "cannot store a token" and refuse the
 * operation rather than storing anything.
 */
export function encryptToken(
  plaintext: string,
  aad: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const keyResult = readEncryptionKey(env);
  if (!keyResult.ok) return null;
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, keyResult.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
  } catch {
    return null;
  }
}

/**
 * Decrypts token material, or null.
 *
 * Null covers every failure the same way — wrong key, wrong owner, tampered
 * row, unknown version — because a caller has no safe use for the distinction
 * and an error message that explains which check failed is a hint to whoever
 * is probing.
 */
export function decryptToken(
  envelope: string,
  aad: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const keyResult = readEncryptionKey(env);
  if (!keyResult.ok) return null;
  if (typeof envelope !== "string") return null;

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;

    const decipher = createDecipheriv(ALGORITHM, keyResult.key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
