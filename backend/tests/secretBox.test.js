import * as secretBox from "../src/secretBox.js";

test("round-trips a plaintext value through encrypt/decrypt", () => {
  const packed = secretBox.encrypt("super-secret-refresh-token");
  expect(packed).not.toBe("super-secret-refresh-token");
  expect(secretBox.decrypt(packed)).toBe("super-secret-refresh-token");
});

test("two encryptions of the same plaintext produce different ciphertext (random IV)", () => {
  const a = secretBox.encrypt("same-value");
  const b = secretBox.encrypt("same-value");
  expect(a).not.toBe(b);
  expect(secretBox.decrypt(a)).toBe("same-value");
  expect(secretBox.decrypt(b)).toBe("same-value");
});

test("null/undefined/empty string pass through unchanged in both directions", () => {
  expect(secretBox.encrypt(null)).toBeNull();
  expect(secretBox.encrypt(undefined)).toBeUndefined();
  expect(secretBox.encrypt("")).toBe("");
  expect(secretBox.decrypt(null)).toBeNull();
  expect(secretBox.decrypt(undefined)).toBeUndefined();
  expect(secretBox.decrypt("")).toBe("");
});

test("decrypting a tampered ciphertext does not throw or return corrupted plaintext", () => {
  const packed = secretBox.encrypt("original-token");
  const [iv, authTag, ciphertext] = packed.split(":");
  const tampered = [iv, authTag, Buffer.from("tampered-data").toString("base64")].join(":");
  // GCM's auth tag check fails on the swapped ciphertext -- caught inside
  // decrypt, which falls back to returning the packed string as-is rather
  // than throwing, same as the "not our format" fallback below.
  expect(secretBox.decrypt(tampered)).toBe(tampered);
});

test("a value that predates encryption (plain string, no packed format) passes through unchanged", () => {
  // Backward-compat: a token written before this module existed is a bare
  // string with no ':' -- decrypt must return it as-is (so the app keeps
  // working against it until it's next refreshed/re-saved and picks up
  // encryption going forward) rather than throwing.
  expect(secretBox.decrypt("a-plaintext-legacy-token")).toBe("a-plaintext-legacy-token");
});
