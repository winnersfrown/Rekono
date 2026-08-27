// Vendor compliance document ingestion + CRUD -- mirrors routes/expenses.js
// (itself mirroring routes/ingestion.js's upload handler and
// routes/invoices.js's list/detail/correct/approve/reject/retry/delete/file
// routes), applied to VendorDocument instead of ExpenseReceipt. Same v1
// scope: no bulk actions, no duplicate detection, no QuickBooks push -- the
// core loop only, plus one thing unique to this document type: an
// expiring-soon filter, since flagging what's about to lapse is this
// module's whole reason to exist.
import fs from "node:fs/promises";
import multer from "multer";
import { Router } from "express";
import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import * as jobs from "../jobs.js";
import { MAX_UPLOAD_BYTES, canonicalContentType, upload } from "../storage.js";
import { AuditLog, VendorDocument } from "../models/index.js";
import { VENDOR_DOCUMENT_TYPES } from "../models/VendorDocument.js";
import { serializeAuditLog, serializeVendorDocumentDetail, serializeVendorDocumentListItem } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

async function getOwnedDocument(id, orgId) {
  return VendorDocument.findOne({ where: { id, orgId } });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const SORTABLE_FIELDS = {
  created_at: "createdAt",
  expiration_date: "expirationDate",
  vendor_name: "vendorName",
  overall_confidence: "overallConfidence",
};

const FIELD_TO_ATTR = {
  vendor_name: "vendorName",
  document_type: "documentType",
  effective_date: "effectiveDate",
  expiration_date: "expirationDate",
  reference_number: "referenceNumber",
  amount: "amount",
  note: "note",
};

router.get("/api/vendor-documents", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    // Case-insensitive substring match against vendor name -- the one
    // field someone would actually recognize a document by at a glance.
    // Same LOWER(...) approach as invoices.js/expenses.js's own search.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where[Op.and] = [sequelizeWhere(fn("LOWER", col("vendorName")), { [Op.like]: `%${q.toLowerCase()}%` })];
    }

    // The module's differentiator: surface everything expiring within the
    // next N days (or already expired -- expirationDate in the past still
    // matches "<=" a future cutoff). Documents with no expiration date at
    // all (a W-9) are never "expiring", so they're excluded rather than
    // treated as an edge case of the date comparison.
    const expiringWithinDays = parseInt(req.query.expiring_within_days, 10);
    if (Number.isFinite(expiringWithinDays)) {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() + expiringWithinDays);
      where.expirationDate = { [Op.ne]: null, [Op.lte]: cutoff.toISOString().slice(0, 10) };
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await VendorDocument.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      items: rows.map(serializeVendorDocumentListItem),
      total: count,
      page,
      page_size: pageSize,
      document_types: VENDOR_DOCUMENT_TYPES,
    });
  } catch (err) {
    next(err);
  }
});

// Multer errors (e.g. LIMIT_FILE_SIZE) happen inside upload.single() itself
// -- same handling as ingestion.js's handleUpload.
function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const maxMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ detail: `File too large. Maximum size is ${maxMb}MB.` });
    }
    if (err) return next(err);
    next();
  });
}

router.post("/api/vendor-documents/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // Same shared monthly document cap as invoice/receipt uploads -- see
    // documentUsage.js's comment on why this counts against the same
    // budget rather than its own.
    const plan = PLANS[req.currentUser.organization.plan];
    if (plan) {
      const uploadedThisMonth = await documentsUsedThisMonth(req.currentUser.orgId);
      if (uploadedThisMonth >= plan.docCapPerMonth) {
        await fs.rm(req.file.path, { force: true });
        return res.status(402).json({
          detail: `You've reached your ${plan.name} plan's limit of ${plan.docCapPerMonth} documents this month. Upgrade your plan to upload more.`,
          plan_cap_reached: true,
        });
      }
    }

    const contentType = canonicalContentType(req.file.originalname);
    if (!contentType) {
      await fs.rm(req.file.path, { force: true });
      return res.status(422).json({
        detail: `Unsupported file type: ${req.file.originalname} (${req.file.mimetype}). Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp).`,
      });
    }

    const doc = await VendorDocument.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: req.file.path,
      contentType,
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      vendorDocumentId: doc.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: doc.originalFilename },
    });

    jobs.enqueue(doc.id, "vendor_document");

    res.status(201).json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.get("/api/vendor-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    res.json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.get("/api/vendor-documents/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    res.sendFile(
      doc.storagePath,
      { headers: { "Content-Type": doc.contentType || "application/octet-stream" } },
      (err) => {
        if (!err) return;
        if (err.code === "ENOENT") {
          return res.status(404).json({ detail: "This document's source file is no longer available on the server." });
        }
        next(err);
      }
    );
  } catch (err) {
    next(err);
  }
});

router.get("/api/vendor-documents/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    const entries = await AuditLog.findAll({ where: { vendorDocumentId: doc.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const correctionSchema = z.object({
  vendor_name: z.string().nullable().optional(),
  document_type: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
  expiration_date: z.string().nullable().optional(),
  reference_number: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/api/vendor-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });

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
        vendorDocumentId: doc.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/vendor-documents/:id/approve", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    if (!["extracted", "needs_review"].includes(doc.status)) {
      return res.status(409).json({ detail: `Cannot approve document in status ${doc.status}` });
    }
    doc.status = "approved";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      vendorDocumentId: doc.id,
      action: "approved",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/vendor-documents/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    doc.status = "rejected";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      vendorDocumentId: doc.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.post("/api/vendor-documents/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });
    if (doc.status === "approved") {
      return res.status(409).json({ detail: "Cannot retry an already-approved document." });
    }
    doc.status = "queued";
    doc.errorMessage = "";
    await doc.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      vendorDocumentId: doc.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    jobs.enqueue(doc.id, "vendor_document");
    res.json(serializeVendorDocumentDetail(doc));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/vendor-documents/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const doc = await getOwnedDocument(req.params.id, req.currentUser.orgId);
    if (!doc) return res.status(404).json({ detail: "Document not found" });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      vendorDocumentId: doc.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: doc.originalFilename, status: doc.status },
    });

    if (doc.storagePath) {
      await fs.unlink(doc.storagePath).catch((err) => {
        if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted vendor document ${doc.id}:`, err.message);
      });
    }

    await doc.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
