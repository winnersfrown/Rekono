// Vendors: the AP counterpart to routes/receivables.js's customer
// endpoints. vendors.js owns the identity logic; this is the HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PAYABLE_INVOICE_STATUS, amountPaidCents, invoiceTotalCents } from "../accountsPayable.js";
import { VendorError, mergeVendors, normalizeVendorName } from "../vendors.js";
import { AuditLog, Invoice, Vendor, VendorAlias } from "../models/index.js";

const router = Router();

function serializeVendor(v, extra = {}) {
  return {
    id: v.id,
    name: v.name,
    email: v.email,
    payment_terms_days: v.paymentTermsDays,
    notes: v.notes,
    active: v.active,
    auto_created: v.autoCreated,
    ...extra,
  };
}

// The vendor list carries how much is outstanding against each, because
// that's the number that tells you whether a suspected duplicate is worth
// merging -- a vendor with nothing owed is noise, one with a balance is a
// reporting problem.
router.get("/api/vendors", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = { orgId };
    if (req.query.active === "true") where.active = true;

    const [vendors, invoices] = await Promise.all([
      Vendor.findAll({ where, order: [["name", "ASC"]] }),
      Invoice.scope("withSamples").findAll({ where: { orgId, status: PAYABLE_INVOICE_STATUS } }),
    ]);

    const outstandingByVendor = new Map();
    const billsByVendor = new Map();
    for (const invoice of invoices) {
      if (!invoice.vendorId) continue;
      const outstanding = invoiceTotalCents(invoice) - (await amountPaidCents(invoice.id));
      billsByVendor.set(invoice.vendorId, (billsByVendor.get(invoice.vendorId) || 0) + 1);
      if (outstanding > 0) {
        outstandingByVendor.set(invoice.vendorId, (outstandingByVendor.get(invoice.vendorId) || 0) + outstanding);
      }
    }

    const aliases = await VendorAlias.findAll({ where: { orgId, vendorId: { [Op.ne]: null } } });
    const aliasesByVendor = new Map();
    for (const a of aliases) {
      if (!aliasesByVendor.has(a.vendorId)) aliasesByVendor.set(a.vendorId, []);
      aliasesByVendor.get(a.vendorId).push(a.rawVendorName);
    }

    res.json({
      items: vendors.map((v) =>
        serializeVendor(v, {
          bill_count: billsByVendor.get(v.id) || 0,
          amount_outstanding: (outstandingByVendor.get(v.id) || 0) / 100,
          // The other spellings that now resolve to this vendor -- what a
          // merge leaves behind, and the only visible record of it.
          aliases: aliasesByVendor.get(v.id) || [],
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

const vendorSchema = z.object({
  name: z.string().min(1).max(256),
  email: z.string().email().or(z.literal("")).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(4096).optional(),
});

router.post("/api/vendors", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = vendorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    // Compared on the normalized name rather than the raw one, so this
    // catches "Acme Inc." against an existing "  ACME Inc. " -- the case
    // normalization *can* settle. The ones it can't are what merge is for.
    const normalized = normalizeVendorName(parsed.data.name);
    const existing = (await Vendor.findAll({ where: { orgId } })).find(
      (v) => normalizeVendorName(v.name) === normalized
    );
    if (existing) return res.status(409).json({ detail: `A vendor named "${existing.name}" already exists.` });

    const vendor = await Vendor.create({
      orgId,
      name: parsed.data.name.trim(),
      email: parsed.data.email || "",
      paymentTermsDays: parsed.data.payment_terms_days ?? 30,
      notes: parsed.data.notes || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "vendor_created",
      actor: req.currentUser.email,
      details: { name: vendor.name },
    });
    res.status(201).json(serializeVendor(vendor));
  } catch (err) {
    next(err);
  }
});

const vendorPatchSchema = vendorSchema.partial().extend({ active: z.boolean().optional() });

router.patch("/api/vendors/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = vendorPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const vendor = await Vendor.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!vendor) return res.status(404).json({ detail: "Vendor not found" });

    if (parsed.data.name !== undefined) vendor.name = parsed.data.name.trim();
    if (parsed.data.email !== undefined) vendor.email = parsed.data.email;
    if (parsed.data.payment_terms_days !== undefined) vendor.paymentTermsDays = parsed.data.payment_terms_days;
    if (parsed.data.notes !== undefined) vendor.notes = parsed.data.notes;
    if (parsed.data.active !== undefined) vendor.active = parsed.data.active;
    // A vendor a human has edited is no longer just whatever OCR produced.
    if (parsed.data.name !== undefined) vendor.autoCreated = false;
    await vendor.save();

    res.json(serializeVendor(vendor));
  } catch (err) {
    next(err);
  }
});

const mergeSchema = z.object({ into_vendor_id: z.string().min(1) });

// The whole point of the vendor table. Normalization can tell that "Acme
// Inc." and "  ACME Inc. " are one vendor; nothing can tell that "Acme
// Inc" and "Acme Incorporated" are, so a human says so once and every
// report -- past and future -- reflects it.
router.post("/api/vendors/:id/merge", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const { winner, invoicesMoved } = await mergeVendors(req.currentUser.orgId, {
      loserId: req.params.id,
      winnerId: parsed.data.into_vendor_id,
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "vendors_merged",
      actor: req.currentUser.email,
      details: { into: winner.name, bills_moved: invoicesMoved },
    });

    res.json({ vendor: serializeVendor(winner), bills_moved: invoicesMoved });
  } catch (err) {
    if (err instanceof VendorError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
