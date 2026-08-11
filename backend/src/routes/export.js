import { Router } from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../auth.js";
import { Invoice, LineItem, MatchResult } from "../models/index.js";

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
      vendor_name: inv.vendorName,
      invoice_number: inv.invoiceNumber,
      invoice_date: inv.invoiceDate,
      due_date: inv.dueDate,
      po_reference: inv.poReference,
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
      original_filename: inv.originalFilename,
      created_at: inv.createdAt.toISOString(),
    };
  });
}

function toCsvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

router.get("/api/export/csv", requireAuth, async (req, res, next) => {
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

router.get("/api/export/xlsx", requireAuth, async (req, res, next) => {
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

export default router;
