import { Router } from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { ExpenseReceipt, Invoice, Lease, LineItem, MatchResult, TaxDocument, VendorDocument } from "../models/index.js";

const router = Router();

const COLUMNS = [
  "invoice_id",
  "status",
  "vendor_name",
  "invoice_number",
  "invoice_date",
  "due_date",
  "po_reference",
  "currency",
  "subtotal",
  "tax",
  "total",
  "line_item_count",
  "extraction_method",
  "overall_confidence",
  "cross_check_passed",
  "match_status",
  "match_score",
  "original_filename",
  "created_at",
];

// Prevents CSV/Excel "formula injection": a cell whose text starts with
// =, +, -, or @ gets parsed and executed as a formula by Excel/Sheets/
// LibreOffice when the file is opened, not shown as plain text -- a
// realistic attack chain for exactly this kind of AP-automation product
// (a malicious vendor name or filename, exported by the org's own finance
// team, executed the moment they open it in Excel). vendor_name,
// invoice_number, po_reference, and original_filename all ultimately come
// from an uploaded document or a human correction, so none of them can be
// trusted not to start with one of those characters. A leading apostrophe
// is the standard mitigation: Excel treats it as "this cell is text" and
// doesn't display the apostrophe itself.
function sanitizeSpreadsheetCell(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

async function buildRows(orgId) {
  const invoices = await Invoice.findAll({
    where: { orgId },
    include: [{ model: LineItem, as: "lineItems" }],
    order: [["createdAt", "DESC"]],
  });

  const latestMatchByInvoice = new Map();
  const matches = await MatchResult.findAll({
    include: [{ model: Invoice, attributes: [], where: { orgId }, required: true }],
    order: [["createdAt", "ASC"]],
  });
  for (const mr of matches) {
    latestMatchByInvoice.set(mr.invoiceId, mr); // last write wins -> most recent run
  }

  return invoices.map((inv) => {
    const match = latestMatchByInvoice.get(inv.id);
    return {
      invoice_id: inv.id,
      status: inv.status,
      vendor_name: sanitizeSpreadsheetCell(inv.vendorName),
      invoice_number: sanitizeSpreadsheetCell(inv.invoiceNumber),
      invoice_date: inv.invoiceDate,
      due_date: inv.dueDate,
      po_reference: sanitizeSpreadsheetCell(inv.poReference),
      currency: inv.currency,
      subtotal: inv.subtotal,
      tax: inv.tax,
      total: inv.total,
      line_item_count: (inv.lineItems || []).length,
      extraction_method: inv.extractionMethod,
      overall_confidence: inv.overallConfidence,
      cross_check_passed: inv.crossCheckPassed,
      match_status: match ? match.status : "",
      match_score: match ? match.score : null,
      original_filename: sanitizeSpreadsheetCell(inv.originalFilename),
      created_at: inv.createdAt.toISOString(),
    };
  });
}

function toCsvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

router.get("/api/export/csv", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildRows(req.currentUser.orgId);
    const lines = [COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(COLUMNS.map((c) => toCsvValue(row[c])).join(","));
    }
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=rekono_invoices.csv");
    res.send(lines.join("\n") + (rows.length ? "\n" : ""));
  } catch (err) {
    next(err);
  }
});

router.get("/api/export/xlsx", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildRows(req.currentUser.orgId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Invoices");
    sheet.columns = COLUMNS.map((c) => ({ header: c, key: c }));
    sheet.addRows(rows);

    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.set("Content-Disposition", "attachment; filename=rekono_invoices.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

const EXPENSE_COLUMNS = [
  "receipt_id",
  "status",
  "merchant_name",
  "receipt_date",
  "category",
  "currency",
  "tax",
  "amount",
  "extraction_method",
  "overall_confidence",
  "original_filename",
  "created_at",
];

async function buildExpenseRows(orgId) {
  const receipts = await ExpenseReceipt.findAll({
    where: { orgId },
    order: [["createdAt", "DESC"]],
  });

  return receipts.map((r) => ({
    receipt_id: r.id,
    status: r.status,
    merchant_name: sanitizeSpreadsheetCell(r.merchantName),
    receipt_date: r.receiptDate,
    category: r.category,
    currency: r.currency,
    tax: r.tax,
    amount: r.amount,
    extraction_method: r.extractionMethod,
    overall_confidence: r.overallConfidence,
    original_filename: sanitizeSpreadsheetCell(r.originalFilename),
    created_at: r.createdAt.toISOString(),
  }));
}

router.get("/api/export/expenses/csv", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildExpenseRows(req.currentUser.orgId);
    const lines = [EXPENSE_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(EXPENSE_COLUMNS.map((c) => toCsvValue(row[c])).join(","));
    }
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=rekono_expenses.csv");
    res.send(lines.join("\n") + (rows.length ? "\n" : ""));
  } catch (err) {
    next(err);
  }
});

router.get("/api/export/expenses/xlsx", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildExpenseRows(req.currentUser.orgId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");
    sheet.columns = EXPENSE_COLUMNS.map((c) => ({ header: c, key: c }));
    sheet.addRows(rows);

    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.set("Content-Disposition", "attachment; filename=rekono_expenses.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

const VENDOR_DOCUMENT_COLUMNS = [
  "document_id",
  "status",
  "vendor_name",
  "document_type",
  "effective_date",
  "expiration_date",
  "reference_number",
  "amount",
  "extraction_method",
  "overall_confidence",
  "original_filename",
  "created_at",
];

async function buildVendorDocumentRows(orgId) {
  const docs = await VendorDocument.findAll({
    where: { orgId },
    order: [["createdAt", "DESC"]],
  });

  return docs.map((d) => ({
    document_id: d.id,
    status: d.status,
    vendor_name: sanitizeSpreadsheetCell(d.vendorName),
    document_type: d.documentType,
    effective_date: d.effectiveDate,
    expiration_date: d.expirationDate,
    reference_number: sanitizeSpreadsheetCell(d.referenceNumber),
    amount: d.amount,
    extraction_method: d.extractionMethod,
    overall_confidence: d.overallConfidence,
    original_filename: sanitizeSpreadsheetCell(d.originalFilename),
    created_at: d.createdAt.toISOString(),
  }));
}

router.get("/api/export/vendor-documents/csv", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildVendorDocumentRows(req.currentUser.orgId);
    const lines = [VENDOR_DOCUMENT_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(VENDOR_DOCUMENT_COLUMNS.map((c) => toCsvValue(row[c])).join(","));
    }
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=rekono_vendor_documents.csv");
    res.send(lines.join("\n") + (rows.length ? "\n" : ""));
  } catch (err) {
    next(err);
  }
});

router.get("/api/export/vendor-documents/xlsx", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildVendorDocumentRows(req.currentUser.orgId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Vendor Documents");
    sheet.columns = VENDOR_DOCUMENT_COLUMNS.map((c) => ({ header: c, key: c }));
    sheet.addRows(rows);

    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.set("Content-Disposition", "attachment; filename=rekono_vendor_documents.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

const LEASE_COLUMNS = [
  "lease_id",
  "status",
  "landlord_name",
  "property_address",
  "commencement_date",
  "expiration_date",
  "renewal_notice_deadline",
  "monthly_rent",
  "annual_escalation_pct",
  "extraction_method",
  "overall_confidence",
  "original_filename",
  "created_at",
];

async function buildLeaseRows(orgId) {
  const leases = await Lease.findAll({
    where: { orgId },
    order: [["createdAt", "DESC"]],
  });

  return leases.map((l) => ({
    lease_id: l.id,
    status: l.status,
    landlord_name: sanitizeSpreadsheetCell(l.landlordName),
    property_address: sanitizeSpreadsheetCell(l.propertyAddress),
    commencement_date: l.commencementDate,
    expiration_date: l.expirationDate,
    renewal_notice_deadline: l.renewalNoticeDeadline,
    monthly_rent: l.monthlyRent,
    annual_escalation_pct: l.annualEscalationPct,
    extraction_method: l.extractionMethod,
    overall_confidence: l.overallConfidence,
    original_filename: sanitizeSpreadsheetCell(l.originalFilename),
    created_at: l.createdAt.toISOString(),
  }));
}

router.get("/api/export/leases/csv", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildLeaseRows(req.currentUser.orgId);
    const lines = [LEASE_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(LEASE_COLUMNS.map((c) => toCsvValue(row[c])).join(","));
    }
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=rekono_leases.csv");
    res.send(lines.join("\n") + (rows.length ? "\n" : ""));
  } catch (err) {
    next(err);
  }
});

router.get("/api/export/leases/xlsx", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildLeaseRows(req.currentUser.orgId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Leases");
    sheet.columns = LEASE_COLUMNS.map((c) => ({ header: c, key: c }));
    sheet.addRows(rows);

    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.set("Content-Disposition", "attachment; filename=rekono_leases.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// recipient_tin_last4 rather than a full TIN column, deliberately -- see
// TaxDocument.js. An export is exactly the moment a full SSN would leave
// the app for an unmanaged spreadsheet on someone's laptop, and four
// digits is enough to line a row up against the source document.
const TAX_DOCUMENT_COLUMNS = [
  "tax_document_id",
  "status",
  "document_type",
  "tax_year",
  "payer_name",
  "recipient_name",
  "recipient_tin_last4",
  "amount",
  "federal_tax_withheld",
  "extraction_method",
  "overall_confidence",
  "original_filename",
  "created_at",
];

async function buildTaxDocumentRows(orgId) {
  const docs = await TaxDocument.findAll({
    where: { orgId },
    order: [["createdAt", "DESC"]],
  });

  return docs.map((t) => ({
    tax_document_id: t.id,
    status: t.status,
    document_type: t.documentType,
    tax_year: t.taxYear,
    payer_name: sanitizeSpreadsheetCell(t.payerName),
    recipient_name: sanitizeSpreadsheetCell(t.recipientName),
    recipient_tin_last4: t.recipientTinLast4,
    amount: t.amount,
    federal_tax_withheld: t.federalTaxWithheld,
    extraction_method: t.extractionMethod,
    overall_confidence: t.overallConfidence,
    original_filename: sanitizeSpreadsheetCell(t.originalFilename),
    created_at: t.createdAt.toISOString(),
  }));
}

router.get("/api/export/tax-documents/csv", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildTaxDocumentRows(req.currentUser.orgId);
    const lines = [TAX_DOCUMENT_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(TAX_DOCUMENT_COLUMNS.map((c) => toCsvValue(row[c])).join(","));
    }
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=rekono_tax_documents.csv");
    res.send(lines.join("\n") + (rows.length ? "\n" : ""));
  } catch (err) {
    next(err);
  }
});

router.get("/api/export/tax-documents/xlsx", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const rows = await buildTaxDocumentRows(req.currentUser.orgId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tax Documents");
    sheet.columns = TAX_DOCUMENT_COLUMNS.map((c) => ({ header: c, key: c }));
    sheet.addRows(rows);

    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.set("Content-Disposition", "attachment; filename=rekono_tax_documents.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

export default router;
