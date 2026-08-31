// Shared by ingestion.js/routes/expenses.js (upload-time cap enforcement)
// and routes/auth.js (surfacing "X of Y documents used" in the dashboard
// sidebar) -- pulled out on its own so all of them always agree on exactly
// what counts and which window, rather than risking copies of this logic
// drifting apart.
import { Op } from "sequelize";
import { Check, ExpenseReceipt, Invoice, Lease, TaxDocument, VendorDocument } from "./models/index.js";

export function startOfCurrentMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// One shared cap across every document type -- an org's plan bounds total
// OCR/LLM spend for the month, not invoices/receipts/vendor documents
// separately, so each one counts against the exact same budget rather than
// needing its own cap/plan dimension.
export async function documentsUsedThisMonth(orgId) {
  const where = { orgId, createdAt: { [Op.gte]: startOfCurrentMonthUtc() } };
  // Every model here is paranoid (soft-delete) -- every other query on them
  // should exclude a deleted row, but this one deliberately doesn't. The
  // cap exists to bound how many documents get OCR'd/sent to the LLM in a
  // month, a cost already incurred at upload time; a document a user
  // deletes afterward still consumed that budget, so it must keep counting
  // or "delete and re-upload" would be a free way around the plan's
  // monthly cap.
  const [invoiceCount, receiptCount, vendorDocCount, leaseCount, taxDocCount, checkCount] = await Promise.all([
    Invoice.count({ where, paranoid: false }),
    ExpenseReceipt.count({ where, paranoid: false }),
    VendorDocument.count({ where, paranoid: false }),
    Lease.count({ where, paranoid: false }),
    TaxDocument.count({ where, paranoid: false }),
    Check.count({ where, paranoid: false }),
  ]);
  return invoiceCount + receiptCount + vendorDocCount + leaseCount + taxDocCount + checkCount;
}
