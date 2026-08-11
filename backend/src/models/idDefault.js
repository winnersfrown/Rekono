import crypto from "node:crypto";

// hex32 ids, matching the Python backend's uuid4().hex format.
export function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}
