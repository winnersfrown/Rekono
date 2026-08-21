// Lease abstraction ingestion + CRUD -- mirrors routes/vendorDocuments.js
// (itself mirroring routes/ingestion.js's upload handler and
// routes/invoices.js's list/detail/correct/approve/reject/retry/delete/file
// routes), applied to Lease instead of VendorDocument. Same v1 scope: no
// bulk actions, no duplicate detection, no QuickBooks push -- the core loop
// only, plus the same expiring-soon filter vendor documents have, extended
// to also catch a renewal-option notice deadline coming up -- missing that
// deadline forfeits the option even though the lease itself hasn't expired.
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
import { AuditLog, Lease } from "../models/index.js";
import { serializeAuditLog, serializeLeaseDetail, serializeLeaseListItem } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

async function getOwnedLease(id, orgId) {
  return Lease.findOne({ where: { id, orgId } });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const SORTABLE_FIELDS = {
  created_at: "createdAt",
  expiration_date: "expirationDate",
  renewal_notice_deadline: "renewalNoticeDeadline",
  landlord_name: "landlordName",
  monthly_rent: "monthlyRent",
  overall_confidence: "overallConfidence",
};

const FIELD_TO_ATTR = {
  landlord_name: "landlordName",
  property_address: "propertyAddress",
  commencement_date: "commencementDate",
  expiration_date: "expirationDate",
  renewal_notice_deadline: "renewalNoticeDeadline",
  monthly_rent: "monthlyRent",
  annual_escalation_pct: "annualEscalationPct",
  note: "note",
};

router.get("/api/leases", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    // Case-insensitive substring match against landlord name -- the one
    // field someone would actually recognize a lease by at a glance.
    // Same LOWER(...) approach as vendorDocuments.js/expenses.js's own
    // search.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where[Op.and] = [sequelizeWhere(fn("LOWER", col("landlordName")), { [Op.like]: `%${q.toLowerCase()}%` })];
    }

    // The module's differentiator, extended from vendorDocuments.js's own
    // version of this filter: a lease has two dates worth flagging, not
    // one -- the lease's own expiration, and the (often much earlier)
    // deadline to notify the landlord in order to exercise a renewal
    // option. Either one landing inside the window is worth surfacing. A
    // lease missing both dates entirely is never "expiring".
    const expiringWithinDays = parseInt(req.query.expiring_within_days, 10);
    if (Number.isFinite(expiringWithinDays)) {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() + expiringWithinDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      where[Op.or] = [
        { expirationDate: { [Op.ne]: null, [Op.lte]: cutoffStr } },
        { renewalNoticeDeadline: { [Op.ne]: null, [Op.lte]: cutoffStr } },
      ];
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await Lease.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      items: rows.map(serializeLeaseListItem),
      total: count,
      page,
      page_size: pageSize,
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

router.post("/api/leases/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // Same shared monthly document cap as the other three pipelines'
    // uploads -- see documentUsage.js's comment on why this counts
    // against the same budget rather than its own.
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

    const lease = await Lease.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: req.file.path,
      contentType,
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      leaseId: lease.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: lease.originalFilename },
    });

    jobs.enqueue(lease.id, "lease");

    res.status(201).json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.get("/api/leases/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    res.json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.get("/api/leases/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    res.sendFile(
      lease.storagePath,
      { headers: { "Content-Type": lease.contentType || "application/octet-stream" } },
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

router.get("/api/leases/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    const entries = await AuditLog.findAll({ where: { leaseId: lease.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const correctionSchema = z.object({
  landlord_name: z.string().nullable().optional(),
  property_address: z.string().nullable().optional(),
  commencement_date: z.string().nullable().optional(),
  expiration_date: z.string().nullable().optional(),
  renewal_notice_deadline: z.string().nullable().optional(),
  monthly_rent: z.number().nullable().optional(),
  annual_escalation_pct: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/api/leases/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });

    const changed = {};
    for (const [field, attr] of Object.entries(FIELD_TO_ATTR)) {
      if (!(field in payload) || payload[field] === undefined) continue;
      const newValue = payload[field];
      const oldValue = lease[attr];
      if (String(oldValue ?? "") !== String(newValue ?? "")) {
        changed[field] = { old: oldValue, new: newValue };
        lease[attr] = newValue;
      }
    }

    if (Object.keys(changed).length) {
      await lease.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        leaseId: lease.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.post("/api/leases/:id/approve", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    if (!["extracted", "needs_review"].includes(lease.status)) {
      return res.status(409).json({ detail: `Cannot approve lease in status ${lease.status}` });
    }
    lease.status = "approved";
    await lease.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      leaseId: lease.id,
      action: "approved",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.post("/api/leases/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    lease.status = "rejected";
    await lease.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      leaseId: lease.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.post("/api/leases/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });
    if (lease.status === "approved") {
      return res.status(409).json({ detail: "Cannot retry an already-approved lease." });
    }
    lease.status = "queued";
    lease.errorMessage = "";
    await lease.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      leaseId: lease.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    jobs.enqueue(lease.id, "lease");
    res.json(serializeLeaseDetail(lease));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/leases/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const lease = await getOwnedLease(req.params.id, req.currentUser.orgId);
    if (!lease) return res.status(404).json({ detail: "Lease not found" });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      leaseId: lease.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: lease.originalFilename, status: lease.status },
    });

    if (lease.storagePath) {
      await fs.unlink(lease.storagePath).catch((err) => {
        if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted lease ${lease.id}:`, err.message);
      });
    }

    await lease.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
