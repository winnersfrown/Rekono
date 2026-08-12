import fs from "node:fs/promises";
import { Router } from "express";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import * as jobs from "../jobs.js";
import { isSupported, upload } from "../storage.js";
import { AuditLog, Invoice } from "../models/index.js";
import { serializeInvoiceDetail } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

router.post("/api/invoices/upload", requireAuth, requireActivePlan, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // requireActivePlan already guarantees org.plan is set to one of
    // plans.js's known keys before this handler ever runs, so `plan` here
    // should never be undefined in practice -- the `if (plan)` guard just
    // means an unrecognized value fails open on enforcement rather than
    // crashing the upload outright, since that's a data-integrity bug to
    // fix, not something an uploading user should be blocked by.
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

    if (!isSupported(req.file.originalname, req.file.mimetype)) {
      await fs.rm(req.file.path, { force: true });
      return res.status(422).json({
        detail: `Unsupported file type: ${req.file.originalname} (${req.file.mimetype}). Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp).`,
      });
    }

    const invoice = await Invoice.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: req.file.path,
      contentType: req.file.mimetype || "application/octet-stream",
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: invoice.originalFilename },
    });

    jobs.enqueue(invoice.id);

    res.status(201).json(serializeInvoiceDetail(invoice));
  } catch (err) {
    next(err);
  }
});

export default router;
