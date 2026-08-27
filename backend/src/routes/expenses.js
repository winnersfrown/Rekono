// Expense receipt ingestion + CRUD -- mirrors routes/ingestion.js's upload
// handler and routes/invoices.js's list/detail/correct/approve/reject/
// retry/delete/file routes, applied to ExpenseReceipt instead of Invoice.
// Deliberately v1-scoped: no bulk actions, no quick-review queue, no
// duplicate detection, no QuickBooks push -- the same core loop the
// invoice pipeline started with, before those grew on top of it one at a
// time.
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
import { AuditLog, ExpenseReceipt } from "../models/index.js";
import { EXPENSE_CATEGORIES } from "../models/ExpenseReceipt.js";
import { serializeAuditLog, serializeExpenseReceiptDetail, serializeExpenseReceiptListItem } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

async function getOwnedReceipt(id, orgId) {
  return ExpenseReceipt.findOne({ where: { id, orgId } });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const SORTABLE_FIELDS = {
  created_at: "createdAt",
  amount: "amount",
  merchant_name: "merchantName",
  overall_confidence: "overallConfidence",
};

const FIELD_TO_ATTR = {
  merchant_name: "merchantName",
  receipt_date: "receiptDate",
  category: "category",
  currency: "currency",
  tax: "tax",
  amount: "amount",
  note: "note",
};

router.get("/api/expenses", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    // Case-insensitive substring match against merchant name -- the one
    // field someone would actually recognize a receipt by at a glance.
    // Same LOWER(...) approach as invoices.js's own search (see its
    // comment) so this works the same in dev/CI (SQLite) and production
    // (Postgres).
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where[Op.and] = [sequelizeWhere(fn("LOWER", col("merchantName")), { [Op.like]: `%${q.toLowerCase()}%` })];
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await ExpenseReceipt.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      items: rows.map(serializeExpenseReceiptListItem),
      total: count,
      page,
      page_size: pageSize,
      categories: EXPENSE_CATEGORIES,
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

router.post("/api/expenses/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // Same shared monthly document cap as invoice uploads -- see
    // documentUsage.js's comment on why a receipt counts against the same
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

    const receipt = await ExpenseReceipt.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: req.file.path,
      contentType,
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      receiptId: receipt.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: receipt.originalFilename },
    });

    jobs.enqueue(receipt.id, "expense");

    res.status(201).json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.get("/api/expenses/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    res.json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.get("/api/expenses/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    res.sendFile(
      receipt.storagePath,
      { headers: { "Content-Type": receipt.contentType || "application/octet-stream" } },
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

router.get("/api/expenses/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    const entries = await AuditLog.findAll({ where: { receiptId: receipt.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const correctionSchema = z.object({
  merchant_name: z.string().nullable().optional(),
  receipt_date: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  tax: z.number().nullable().optional(),
  amount: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/api/expenses/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });

    const changed = {};
    for (const [field, attr] of Object.entries(FIELD_TO_ATTR)) {
      if (!(field in payload) || payload[field] === undefined) continue;
      const newValue = payload[field];
      const oldValue = receipt[attr];
      if (String(oldValue ?? "") !== String(newValue ?? "")) {
        changed[field] = { old: oldValue, new: newValue };
        receipt[attr] = newValue;
      }
    }

    if (Object.keys(changed).length) {
      await receipt.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        receiptId: receipt.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.post("/api/expenses/:id/approve", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    if (!["extracted", "needs_review"].includes(receipt.status)) {
      return res.status(409).json({ detail: `Cannot approve receipt in status ${receipt.status}` });
    }
    receipt.status = "approved";
    await receipt.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      receiptId: receipt.id,
      action: "approved",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.post("/api/expenses/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    receipt.status = "rejected";
    await receipt.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      receiptId: receipt.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.post("/api/expenses/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });
    if (receipt.status === "approved") {
      return res.status(409).json({ detail: "Cannot retry an already-approved receipt." });
    }
    receipt.status = "queued";
    receipt.errorMessage = "";
    await receipt.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      receiptId: receipt.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    jobs.enqueue(receipt.id, "expense");
    res.json(serializeExpenseReceiptDetail(receipt));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/expenses/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const receipt = await getOwnedReceipt(req.params.id, req.currentUser.orgId);
    if (!receipt) return res.status(404).json({ detail: "Receipt not found" });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      receiptId: receipt.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: receipt.originalFilename, status: receipt.status },
    });

    if (receipt.storagePath) {
      await fs.unlink(receipt.storagePath).catch((err) => {
        if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted receipt ${receipt.id}:`, err.message);
      });
    }

    await receipt.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
