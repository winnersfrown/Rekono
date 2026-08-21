import { Router } from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { ExpenseReceipt, Invoice, LineItem, MatchResult } from "../models/index.js";

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

export default router;
