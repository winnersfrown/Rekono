import fs from "node:fs/promises";
import { Router } from "express";
import { requireAuth } from "../auth.js";
import * as jobs from "../jobs.js";
import { isSupported, upload } from "../storage.js";
import { AuditLog, Invoice } from "../models/index.js";
import { serializeInvoiceDetail } from "../serializers.js";

const router = Router();

router.post("/api/invoices/upload", requireAuth, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
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
