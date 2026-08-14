// Shared by routes/invoices.js (records a new alias whenever a human
// corrects a vendor name) and pipeline.js (applies known aliases to future
// extractions) -- pulled out on its own so both agree on the exact same
// normalization, rather than risking two copies drifting apart.
import { VendorAlias } from "./models/index.js";

function normalize(name) {
  return (name || "").trim().toLowerCase();
}

// Only worth remembering when there was something to correct -- a blank
// original just means the field wasn't filled in yet, not that a specific
// misread value should be mapped away. Most recent correction wins for a
// given raw value, since a vendor's "true" name might itself change.
export async function rememberVendorCorrection(orgId, rawVendorName, canonicalVendorName) {
  const raw = normalize(rawVendorName);
  const canonical = (canonicalVendorName || "").trim();
  if (!raw || !canonical) return;

  const [alias] = await VendorAlias.findOrCreate({
    where: { orgId, rawVendorName: raw },
    defaults: { canonicalVendorName: canonical },
  });
  if (alias.canonicalVendorName !== canonical) {
    alias.canonicalVendorName = canonical;
    await alias.save();
  }
}

export async function lookupVendorAlias(orgId, rawVendorName) {
  const raw = normalize(rawVendorName);
  if (!raw) return null;
  return VendorAlias.findOne({ where: { orgId, rawVendorName: raw } });
}
