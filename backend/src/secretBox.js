// Encrypts sensitive values (QuickBooks OAuth tokens today -- see
// models/Organization.js's getter/setter on quickbooksAccessToken/
// quickbooksRefreshToken) before they're stored, so a database compromise
// alone (leaked connection string, SQL injection, insider access) doesn't
// also hand over live credentials into a customer's real accounting system.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to
// decrypt instead of silently returning corrupted data. The key is derived
// from SECRET_KEY via HKDF rather than reusing its raw bytes directly --
// key separation, so this encryption's key material is independent of
// what signs JWTs, even though both trace back to the same root secret.
import crypto from "node:crypto";
import { settings } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

let cachedKey = null;

function encryptionKey() {
  if (!cachedKey) {
    cachedKey = Buffer.from(crypto.hkdfSync("sha256", settings.secretKey, "", "rekono-secret-box", 32));
  }
  return cachedKey;
}

// Packed as "iv:authTag:ciphertext" (each base64) -- self-contained, so
// decrypt needs nothing but this string and SECRET_KEY.
export function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(":");
}

export function decrypt(packed) {
  if (packed == null || packed === "") return packed;
  const parts = packed.split(":");
  if (parts.length !== 3) {
    // A value written before this encryption existed (plaintext already in
    // the database) or anything else that isn't our own packed format --
    // never crash a read over this, since a stuck-forever 500 on every
    // QuickBooks-connected org is worse than surfacing a token that then
    // fails auth normally and prompts a reconnect.
    return packed;
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return packed;
  }
}
