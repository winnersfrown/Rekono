// Tax document intake + CRUD -- mirrors routes/leases.js (itself mirroring
// routes/vendorDocuments.js and routes/invoices.js), applied to TaxDocument
// instead of Lease. Same v1 scope: no bulk actions, no duplicate detection,
// no QuickBooks push -- the core loop only.
//
// Two filters replace the leases module's expiring-soon one, because the
// questions people ask of a pile of tax forms are different:
//   * tax_year -- every one of these belongs to exactly one year, and
//     working through them means working through one year at a time.
//   * missing_tin -- a 1099 with no payee TIN on it is the one defect on
//     these forms that has a deadline and a penalty attached (it's what
//     triggers an IRS B-notice and backup withholding), so it's worth its
//     own one-click view rather than being something you notice by reading
//     down a column.
// The list response also carries totals for the filtered set, since "what
// do I report for 2025" is the question the tax_year filter exists to
// answer and a per-page sum would answer a different one.
import multer from "multer";
import { Router } from "express";
import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import * as jobs from "../jobs.js";
import {
  MAX_UPLOAD_BYTES,
  canonicalContentType,
  deleteStoredFile,
  discardRejectedUpload,
  documentUpload,
  saveDocumentUpload,
  sendStoredFile,
} from "../storage.js";
import { AuditLog, TaxDocument } from "../models/index.js";
import { TAX_DOCUMENT_TYPES } from "../models/TaxDocument.js";
import { tinLast4 } from "../extractionTaxDocs.js";
import { serializeAuditLog, serializeTaxDocumentDetail, serializeTaxDocumentListItem } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

async function getOwnedTaxDocument(id, orgId) {
  return TaxDocument.findOne({ where: { id, orgId } });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const SORTABLE_FIELDS = {
  created_at: "createdAt",
  tax_year: "taxYear",
  document_type: "documentType",
  payer_name: "payerName",
  amount: "amount",
  overall_confidence: "overallConfidence",
};

const FIELD_TO_ATTR = {
  document_type: "documentType",
  tax_year: "taxYear",
  payer_name: "payerName",
  recipient_name: "recipientName",
  recipient_tin_last4: "recipientTinLast4",
  amount: "amount",
  federal_tax_withheld: "federalTaxWithheld",
  note: "note",
};

router.get("/api/tax-documents", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.document_type) where.documentType = req.query.document_type;

    const taxYear = parseInt(req.query.tax_year, 10);
    if (Number.isFinite(taxYear)) where.taxYear = taxYear;

    // Empty string is the "no TIN found on this form" marker (see
    // TaxDocument.js) -- the column is NOT NULL with a "" default, so this
    // is a plain equality check rather than an IS NULL one.
    if (req.query.missing_tin === "true") where.recipientTinLast4 = "";

    // Case-insensitive substring match against payer name -- the one field
    // someone would actually recognize a form by at a glance. Same
    // LOWER(...) approach as leases.js/vendorDocuments.js.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where[Op.and] = [sequelizeWhere(fn("LOWER", col("payerName")), { [Op.like]: `%${q.toLowerCase()}%` })];
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await TaxDocument.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // Summed over the whole filtered set rather than just this page, and
    // in JS rather than SQL -- the numbers are FLOATs and the row counts
    // here are small (a year's tax mail, not a year's transactions), so
    // rounding once at the end beats a dialect-specific SUM() that SQLite
    // and Postgres would disagree about.
    const all = await TaxDocument.findAll({
      where,
      attributes: ["documentType", "amount", "federalTaxWithheld", "recipientTinLast4"],
      raw: true,
    });
    const byType = {};
    let amountTotal = 0;
    let withheldTotal = 0;
    let missingTin = 0;
    for (const doc of all) {
      const key = doc.documentType || "Unclassified";
      byType[key] = (byType[key] || 0) + 1;
      amountTotal += doc.amount || 0;
      withheldTotal += doc.federalTaxWithheld || 0;
      if (!doc.recipientTinLast4) missingTin += 1;
    }

    // Every distinct year this org has documents for, so the frontend can
    // offer real years to filter by instead of a free-text box. Scoped to
    // the org only -- deliberately not narrowed by the other filters,
    // since a year selector that hides years as you filter is unusable.
    const yearRows = await TaxDocument.findAll({
      where: { orgId: req.currentUser.orgId, taxYear: { [Op.ne]: null } },
      attributes: ["taxYear"],
      group: ["taxYear"],
      raw: true,
    });
    const taxYears = yearRows.map((r) => r.taxYear).sort((a, b) => b - a);

    res.json({
      items: rows.map(serializeTaxDocumentListItem),
      total: count,
      page,
      page_size: pageSize,
      document_types: TAX_DOCUMENT_TYPES,
      tax_years: taxYears,
      totals: {
        amount: Math.round(amountTotal * 100) / 100,
        federal_tax_withheld: Math.round(withheldTotal * 100) / 100,
        missing_tin: missingTin,
        by_document_type: byType,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Multer errors (e.g. LIMIT_FILE_SIZE) happen inside upload.single() itself
// -- same handling as ingestion.js's handleUpload.
function handleUpload(req, res, next) {
  documentUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const maxMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ detail: `File too large. Maximum size is ${maxMb}MB.` });
    }
    if (err) return next(err);
    next();
  });
}

router.post("/api/tax-documents/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // Same shared monthly document cap as the other four pipelines'
    // uploads -- see documentUsage.js's comment on why this counts
    // against the same budget rather than its own.
    const plan = PLANS[req.currentUser.organization.plan];
    if (plan) {
      const uploadedThisMonth = await documentsUsedThisMonth(req.currentUser.orgId);
      if (uploadedThisMonth >= plan.docCapPerMonth) {
        await discardRejectedUpload(req.file);
        return res.status(402).json({
          detail: `You've reached your ${plan.name} plan's limit of ${plan.docCapPerMonth} documents this month. Upgrade your plan to upload more.`,
          plan_cap_reached: true,
        });
      }
    }

    const contentType = canonicalContentType(req.file.originalname);
    if (!contentType) {
      await discardRejectedUpload(req.file);
      return res.status(422).json({
        detail: `Unsupported file type: ${req.file.originalname} (${req.file.mimetype}). Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp).`,
      });
    }

    const doc = await TaxDocument.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: await saveDocumentUpload(req.file, contentType),
      contentType,
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      taxDocumentId: doc.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: doc.originalFilename },
    });

    jobs.enqueue(doc.id, "tax_document");

    res.status(201).json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.get("/api/tax-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    res.json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.get("/api/tax-documents/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    await sendStoredFile(doc.storagePath, doc.contentType, res, next);
  } catch (err) {
    next(err);
  }
});

router.get("/api/tax-documents/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    const entries = await AuditLog.findAll({ where: { taxDocumentId: doc.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const correctionSchema = z.object({
  document_type: z.enum(TAX_DOCUMENT_TYPES).nullable().optional(),
  tax_year: z.number().int().nullable().optional(),
  payer_name: z.string().nullable().optional(),
  recipient_name: z.string().nullable().optional(),
  recipient_tin_last4: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  federal_tax_withheld: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/api/tax-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });

    // A reviewer correcting the TIN naturally types what's printed on the
    // form -- the whole number. Narrowing it here means the full SSN never
    // reaches the database through the correction path either, which would
    // otherwise be a hole straight through the reason the column only ever
    // holds four digits (see TaxDocument.js). An empty string stays empty:
    // that's how a reviewer records "this form genuinely has no TIN on
    // it", which the missing_tin filter exists to surface.
    if (typeof payload.recipient_tin_last4 === "string" && payload.recipient_tin_last4.trim() !== "") {
      const narrowed = tinLast4(payload.recipient_tin_last4);
      // Fewer than four digits can't be narrowed to anything meaningful.
      // Silently storing "" would look identical to "no TIN on this form"
      // and would quietly move the document into the missing-TIN queue,
      // so say what's wrong instead.
      if (!narrowed) {
        return res.status(422).json({
          detail: "Enter at least the last four digits of the recipient's taxpayer ID, or leave it blank if the form doesn't show one.",
        });
      }
      payload.recipient_tin_last4 = narrowed;
    }

    const changed = {};
    for (const [field, attr] of Object.entries(FIELD_TO_ATTR)) {
      if (!(field in payload) || payload[field] === undefined) continue;
      const newValue = payload[field];
      const oldValue = doc[attr];
      if (String(oldValue ?? "") !== String(newValue ?? "")) {
        changed[field] = { old: oldValue, new: newValue };
        doc[attr] = newValue;
      }
    }

    if (Object.keys(changed).length) {
      await doc.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        taxDocumentId: doc.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/tax-documents/:id/approve", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    if (!["extracted", "needs_review"].includes(doc.status)) {
      return res.status(409).json({ detail: `Cannot approve tax document in status ${doc.status}` });
    }
    doc.status = "approved";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      taxDocumentId: doc.id,
      action: "approved",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/tax-documents/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    doc.status = "rejected";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      taxDocumentId: doc.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/tax-documents/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });
    if (doc.status === "approved") {
      return res.status(409).json({ detail: "Cannot retry an already-approved tax document." });
    }
    doc.status = "queued";
    doc.errorMessage = "";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      taxDocumentId: doc.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    jobs.enqueue(doc.id, "tax_document");
    res.json(serializeTaxDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/tax-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedTaxDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Tax document not found" });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      taxDocumentId: doc.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: doc.originalFilename, status: doc.status },
    });

    await deleteStoredFile(doc.storagePath, `tax document ${doc.id}`);

    await doc.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
