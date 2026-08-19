// Shared by routes/integrations.js (records a remembered account whenever a
// human corrects or confirms a suggested one, and checks memory before
// calling the LLM for a fresh suggestion) -- same normalization/shape as
// vendorAlias.js, kept as its own module for the same reason: one place
// both call sites agree on, rather than two copies that could drift apart.
import { VendorExpenseAccount } from "./models/index.js";

function normalize(name) {
  return (name || "").trim().toLowerCase();
}

// Most recent correction wins for a given vendor, same reasoning as
// rememberVendorCorrection -- which account a vendor's invoices belong
// under can itself change (a re-org of the chart of accounts, a vendor
// whose spend category changed).
export async function rememberVendorExpenseAccount(orgId, vendorName, expenseAccountId, expenseAccountName) {
  const vendor = normalize(vendorName);
  if (!vendor || !expenseAccountId) return;

  const [entry] = await VendorExpenseAccount.findOrCreate({
    where: { orgId, vendorName: vendor },
    defaults: { expenseAccountId, expenseAccountName: expenseAccountName || "" },
  });
  if (entry.expenseAccountId !== expenseAccountId || entry.expenseAccountName !== expenseAccountName) {
    entry.expenseAccountId = expenseAccountId;
    entry.expenseAccountName = expenseAccountName || "";
    await entry.save();
  }
}

export async function lookupVendorExpenseAccount(orgId, vendorName) {
  const vendor = normalize(vendorName);
  if (!vendor) return null;
  return VendorExpenseAccount.findOne({ where: { orgId, vendorName: vendor } });
}
