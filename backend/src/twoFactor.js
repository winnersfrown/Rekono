// TOTP + backup-code logic behind optional 2FA (routes/auth.js's
// /api/auth/2fa/* routes). Pulled out of the route file the same way
// billing.js's createCheckoutSession and quickbooks.js's helpers are, so
// it's directly unit-testable without needing a real authenticator app.
import crypto from "node:crypto";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";

const ISSUER = "Rekono";
const BACKUP_CODE_COUNT = 8;

export function generateTotpSecret() {
  return generateSecret();
}

export function totpUri(secret, email) {
  return generateURI({ issuer: ISSUER, label: email, secret });
}

// ±1 time step (30s) of drift tolerance -- the standard allowance most
// authenticator-backed services use. Phone clocks drift slightly, and a
// code entered right at a 30-second boundary can otherwise land on the
// wrong side of it.
//
// otplib's verify() throws (TokenLengthError) rather than returning
// { valid: false } for anything that isn't 6 digits -- which is exactly
// what happens every time this is tried with a backup code first (see
// routes/auth.js's /2fa/verify, which always tries TOTP before falling
// back to a backup code). Without this catch, submitting a backup code
// would 500 instead of falling through.
export async function verifyTotpCode(secret, code) {
  if (!secret || !code) return false;
  try {
    const result = await verifyTotp({ secret, token: String(code).trim(), epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}

// Dashes/spaces and case are just for human readability -- normalized away
// before hashing so "abcde-2h8k9" and "ABCDE2H8K9" hash identically.
function normalizeBackupCode(code) {
  return String(code)
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function hashBackupCode(code) {
  return crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

// No 0/O/1/I -- these get written down or saved somewhere, not typed from
// memory like a TOTP code, so avoiding characters that are easy to
// transcribe wrong is worth more here than a slightly larger alphabet.
const BACKUP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateBackupCode() {
  let code = "";
  for (let i = 0; i < 10; i++) {
    if (i === 5) code += "-";
    code += BACKUP_CODE_ALPHABET[crypto.randomInt(BACKUP_CODE_ALPHABET.length)];
  }
  return code;
}

// Returns both halves: `codes` are shown to the user exactly once (the
// enable/regenerate routes hand them back in the response body and never
// again), `hashes` are what actually gets persisted on User.totpBackupCodeHashes.
export function generateBackupCodes() {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  return { codes, hashes: codes.map(hashBackupCode) };
}

// Returns the remaining hash list with the matched code's hash removed
// (single-use), or null if `code` doesn't match any current backup code.
export function consumeBackupCode(hashes, code) {
  const hash = hashBackupCode(code);
  const idx = (hashes || []).indexOf(hash);
  if (idx === -1) return null;
  return [...hashes.slice(0, idx), ...hashes.slice(idx + 1)];
}
