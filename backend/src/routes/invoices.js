import fs from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { AuditLog, Invoice, LineItem, MatchResult } from "../models/index.js";
import { serializeAuditLog, serializeInvoiceDetail, serializeInvoiceListItem } from "../serializers.js";
import { rememberVendorCorrection } from "../vendorAlias.js";

const router = Router();

async function getOwnedInvoice(invoiceId, orgId, options = {}) {
  const invoice = await Invoice.findOne({
    where: { id: invoiceId, orgId },
    include: [{ model: LineItem, as: "lineItems" }, { model: MatchResult, as: "matchResults" }],
    order: [[{ model: LineItem, as: "lineItems" }, "position", "ASC"]],
    ...options,
  });
  return invoice;
}

router.get("/api/invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;
    const invoices = await Invoice.findAll({ where, order: [["createdAt", "DESC"]] });
    res.json(invoices.map(serializeInvoiceListItem));
  } catch (err) {
    next(err);
  }
});

router.get("/api/invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    res.json(serializeInvoiceDetail(invoice));
  } catch (err) {
    next(err);
  }
});

router.get("/api/invoices/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    res.sendFile(
      invoice.storagePath,
      { headers: { "Content-Type": invoice.contentType || "application/octet-stream" } },
      (err) => {
        if (!err) return;
        // A missing source file is routine on ephemeral hosting (Render's
        // free tier wipes uploads on every restart/redeploy) -- report it as
        // a clean 404 instead of letting the raw ENOENT (which includes the
        // full server-side storage path) fall through to the generic 500
        // handler.
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

router.get("/api/invoices/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    const entries = await AuditLog.findAll({ where: { invoiceId: invoice.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable().optional(),
  unit_price: z.number().nullable().optional(),
  amount: z.number().nullable().optional(),
});

const correctionSchema = z.object({
  vendor_name: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  po_reference: z.string().nullable().optional(),
  subtotal: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  total: z.number().nullable().optional(),
  line_items: z.array(lineItemSchema).nullable().optional(),
});

const FIELD_TO_ATTR = {
  vendor_name: "vendorName",
  invoice_number: "invoiceNumber",
  invoice_date: "invoiceDate",
  due_date: "dueDate",
  currency: "currency",
  po_reference: "poReference",
  subtotal: "subtotal",
  tax: "tax",
  total: "total",
};

router.patch("/api/invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

    const changed = {};
    for (const [field, attr] of Object.entries(FIELD_TO_ATTR)) {
      if (!(field in payload) || payload[field] === undefined) continue;
      const newValue = payload[field];
      const oldValue = invoice[attr];
      if (String(oldValue ?? "") !== String(newValue ?? "")) {
        changed[field] = { old: oldValue, new: newValue };
        invoice[attr] = newValue;
      }
    }

    if (payload.line_items !== undefined && payload.line_items !== null) {
      changed.line_items = { count: payload.line_items.length };
      await LineItem.destroy({ where: { invoiceId: invoice.id } });
      await LineItem.bulkCreate(
        payload.line_items.map((li, i) => ({
          invoiceId: invoice.id,
          position: i,
          description: li.description,
          quantity: li.quantity ?? null,
          unitPrice: li.unit_price ?? null,
          amount: li.amount ?? null,
          confidence: 1.0, // human-entered
        }))
      );
    }

    if (Object.keys(changed).length) {
      await invoice.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });

      // A corrected vendor name is worth remembering for next time -- see
      // vendorAlias.js and pipeline.js's applyVendorAlias. Fire-and-learn:
      // never blocks or fails the correction itself if it can't be stored.
      if (changed.vendor_name?.old) {
        await rememberVendorCorrection(req.currentUser.orgId, changed.vendor_name.old, changed.vendor_name.new);
      }
    }

    const fresh = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    res.json(serializeInvoiceDetail(fresh));
  } catch (err) {
    next(err);
  }
});

router.post("/api/invoices/:id/approve", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (!["extracted", "needs_review"].includes(invoice.status)) {
      return res.status(409).json({ detail: `Cannot approve invoice in status ${invoice.status}` });
    }
    invoice.status = "approved";
    await invoice.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "approved",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeInvoiceDetail(invoice));
  } catch (err) {
    next(err);
  }
});

router.post("/api/invoices/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    invoice.status = "rejected";
    await invoice.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeInvoiceDetail(invoice));
  } catch (err) {
    next(err);
  }
});

// No status restriction -- a user can delete a document at any point in
// its lifecycle (queued, failed, approved, whatever), same as reject.
// Soft delete (Invoice is paranoid, see models/Invoice.js): the row and its
// LineItems/MatchResults/AuditLog history all stay in the database, just
// excluded from every normal query, including this invoice's own audit-log
// endpoint -- consistent with "a deleted invoice is gone from your view,"
// not actually erased. The underlying uploaded file is removed from disk
// (best-effort; a source file already missing on ephemeral storage is
// routine, see the /file route above).
router.delete("/api/invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: invoice.originalFilename, status: invoice.status },
    });

    if (invoice.storagePath) {
      await fs.unlink(invoice.storagePath).catch((err) => {
        if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted invoice ${invoice.id}:`, err.message);
      });
    }

    await invoice.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
