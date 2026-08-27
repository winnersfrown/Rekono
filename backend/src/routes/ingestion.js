import multer from "multer";
import { Router } from "express";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import * as jobs from "../jobs.js";
import { MAX_UPLOAD_BYTES, canonicalContentType, discardRejectedUpload, documentUpload, saveDocumentUpload } from "../storage.js";
import { AuditLog, Invoice } from "../models/index.js";
import { serializeInvoiceDetail } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

// Multer errors (e.g. LIMIT_FILE_SIZE) happen inside upload.single() itself,
// before the route handler's own try/catch ever runs -- handled here with
// its own callback instead of letting Express's next(err) carry it to the
// generic 500 handler, so an oversized file gets a clear, specific message
// instead of looking like a server crash.
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

router.post("/api/invoices/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
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
        await discardRejectedUpload(req.file);
        return res.status(402).json({
          detail: `You've reached your ${plan.name} plan's limit of ${plan.docCapPerMonth} documents this month. Upgrade your plan to upload more.`,
          plan_cap_reached: true,
        });
      }
    }

    // Never trust the multipart request's own declared Content-Type for
    // what gets stored/served back -- see canonicalContentType's own
    // comment in storage.js for why. A null here means neither the
    // extension nor the declared type matched anything on the allowlist.
    const contentType = canonicalContentType(req.file.originalname);
    if (!contentType) {
      await discardRejectedUpload(req.file);
      return res.status(422).json({
        detail: `Unsupported file type: ${req.file.originalname} (${req.file.mimetype}). Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp).`,
      });
    }

    const invoice = await Invoice.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: await saveDocumentUpload(req.file, contentType),
      contentType,
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
