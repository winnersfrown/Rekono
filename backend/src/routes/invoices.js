import fs from "node:fs/promises";
import { Router } from "express";
import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { AuditLog, BillPayment, Invoice as InvoiceModel, LineItem, MatchResult } from "../models/index.js";
import { serializeAuditLog, serializeInvoiceDetail, serializeInvoiceListItem } from "../serializers.js";
import { rememberVendorCorrection } from "../vendorAlias.js";
import { enqueue } from "../jobs.js";
import { effectiveConfidenceThreshold } from "../pipeline.js";
import { score as scoreConfidence } from "../confidence.js";
import { postInvoiceApproval, voidInvoiceJournalEntry } from "../ledger.js";

const router = Router();

// This whole module is the Review Queue -- unlike every other consumer of
// Invoice (dashboard KPIs, exports, matching, QuickBooks sync, ...), a
// seeded sample invoice belongs here just like a real one: it needs to
// show up in the list, open in the detail pane, and be approvable/
// deletable, so a new user can actually interact with it. See
// models/Invoice.js's defaultScope for why every other file gets samples
// filtered out automatically instead.
const Invoice = InvoiceModel.scope("withSamples");

async function getOwnedInvoice(invoiceId, orgId, options = {}) {
  // billPayments comes along so the detail view can say whether the bill is
  // paid. It is loaded here rather than fetched per serializer call because
  // every route that returns a detail wants the same answer.
  const invoice = await Invoice.findOne({
    where: { id: invoiceId, orgId },
    include: [
      { model: LineItem, as: "lineItems" },
      { model: MatchResult, as: "matchResults" },
      { model: BillPayment, as: "billPayments" },
    ],
    order: [[{ model: LineItem, as: "lineItems" }, "position", "ASC"]],
    ...options,
  });
  return invoice;
}

// A generous ceiling, not the everyday page size -- most callers (the
// sidebar's recent-uploads list, the matching view's invoice lookup) still
// just want "everything" and shouldn't have to think about pagination, but
// an org with years of history shouldn't be able to force one query to
// pull its entire table either.
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Maps the API's snake_case sort names to the model attribute they sort by
// -- deliberately a fixed allowlist rather than passing req.query.sort
// straight through to Sequelize's `order`, which would let a caller sort
// (or error the query) by any column on the table, including ones that
// were never meant to be sortable from outside.
const SORTABLE_FIELDS = {
  created_at: "createdAt",
  total: "total",
  vendor_name: "vendorName",
  overall_confidence: "overallConfidence",
};

// Shared by the correction route (PATCH /api/invoices/:id) and the
// quick-review routes below -- one place both agree on which API field
// names map to which model attributes.
const FIELD_TO_ATTR = {
  vendor_name: "vendorName",
  invoice_number: "invoiceNumber",
  invoice_date: "invoiceDate",
  due_date: "dueDate",
  currency: "currency",
  po_reference: "poReference",
  subtotal: "subtotal",
  shipping: "shipping",
  discount: "discount",
  other_charges: "otherCharges",
  tax: "tax",
  payment_terms: "paymentTerms",
  total: "total",
};

router.get("/api/invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    // Case-insensitive substring match against vendor name or invoice
    // number -- the two fields someone would actually recognize an invoice
    // by at a glance. LOWER(...) on both sides (rather than Op.iLike, which
    // Postgres supports but SQLite doesn't) is what keeps this working the
    // same way in dev/CI (SQLite) and production (Postgres).
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const needle = `%${q.toLowerCase()}%`;
      where[Op.or] = [
        sequelizeWhere(fn("LOWER", col("vendorName")), { [Op.like]: needle }),
        sequelizeWhere(fn("LOWER", col("invoiceNumber")), { [Op.like]: needle }),
      ];
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await Invoice.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      items: rows.map(serializeInvoiceListItem),
      total: count,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

const bulkActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(["approve", "reject"]),
});

// Applies the same status transition + audit-log write as the single-invoice
// approve/reject routes below, across many invoices in one call -- clearing
// a batch of high-confidence extractions (or a bad upload run) one click at
// a time doesn't scale once there's real volume. Never fails the whole
// batch for one bad id: anything that doesn't belong to the caller's org,
// or that approve's status restriction rejects, is reported back in
// `skipped` (with why) instead, so the frontend can show exactly what
// happened rather than an all-or-nothing error.
router.post("/api/invoices/bulk-action", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = bulkActionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { ids, action } = parsed.data;

    const invoices = await Invoice.findAll({ where: { id: ids, orgId: req.currentUser.orgId } });
    const succeeded = [];
    const skipped = [];

    for (const invoice of invoices) {
      if (action === "approve" && !["extracted", "needs_review"].includes(invoice.status)) {
        skipped.push({ id: invoice.id, reason: `Cannot approve invoice in status ${invoice.status}` });
        continue;
      }
      invoice.status = action === "approve" ? "approved" : "rejected";
      await invoice.save();
      if (action === "approve") await postInvoiceApproval(invoice);
      else await voidInvoiceJournalEntry(req.currentUser.orgId, invoice.id);
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: action === "approve" ? "approved" : "rejected",
        actor: req.currentUser.email,
        details: { bulk: true },
      });
      succeeded.push(invoice.id);
    }

    const foundIds = new Set(invoices.map((inv) => inv.id));
    for (const id of ids) {
      if (!foundIds.has(id)) skipped.push({ id, reason: "Invoice not found" });
    }

    res.json({ succeeded, skipped });
  } catch (err) {
    next(err);
  }
});

// Fields eligible for quick, one-at-a-time review -- reuses FIELD_TO_ATTR's
// exact key set (the correction route's own field list below) so both stay
// in sync automatically.
// other_charges is excluded: quick review is one scalar field at a time,
// and a labelled list has no sensible single-value prompt. It is corrected
// in the full detail view or not at all.
const QUICK_REVIEW_FIELDS = Object.keys(FIELD_TO_ATTR).filter((f) => f !== "other_charges");
const NUMERIC_QUICK_REVIEW_FIELDS = new Set(["subtotal", "shipping", "discount", "tax", "total"]);

// Flat, one-row-per-low-confidence-field queue across every eligible
// needs_review invoice in the org -- the point is letting a reviewer
// confirm/correct one field at a time (see the quick-review-field route
// below) instead of opening a full invoice detail view per invoice.
// Deliberately excludes invoices flagged for a *structural* reason
// (duplicate, possible multi-invoice) rather than a low-confidence field --
// those need real judgment on the whole document, not a quick per-field
// confirm, and always route through the normal Review Queue instead. An
// invoice flagged purely by a failed cross-check with no individually
// low-confidence field (rare, but possible) also won't appear here, for the
// same reason -- nothing to "confirm" fixes an arithmetic mismatch by
// itself. Registered above GET /api/invoices/:id -- Express matches routes
// in registration order, and ":id" would otherwise swallow this literal
// path first (same reason bulk-action, below, is registered before it too).
router.get("/api/invoices/quick-review-queue", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const threshold = await effectiveConfidenceThreshold(req.currentUser.orgId);
    const invoices = await Invoice.findAll({
      where: {
        orgId: req.currentUser.orgId,
        status: "needs_review",
        duplicateOfInvoiceId: null,
        possibleMultiInvoice: false,
      },
      order: [["createdAt", "ASC"]],
      limit: 200,
    });

    const items = [];
    outer: for (const inv of invoices) {
      for (const field of QUICK_REVIEW_FIELDS) {
        const confidence = inv.fieldConfidence?.[field] ?? 0;
        if (confidence >= threshold) continue;
        items.push({
          invoice_id: inv.id,
          field,
          value: inv[FIELD_TO_ATTR[field]],
          confidence,
          vendor_name: inv.vendorName,
          original_filename: inv.originalFilename,
        });
        if (items.length >= 500) break outer;
      }
    }

    res.json(items);
  } catch (err) {
    next(err);
  }
});

// Invoices auto-approved and randomly selected for a retrospective spot
// check (see pipeline.js's processInvoice), still awaiting one -- a
// lightweight companion queue to quick-review-queue above, but for a
// different job: this isn't blocking anything (the invoice is already
// approved, possibly already pushed to QuickBooks), it's just catching
// drift in auto-approval decisions nobody looked at, on a sample rather
// than every one of them. Same registration-order reasoning as above.
router.get("/api/invoices/qa-sample-queue", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoices = await Invoice.findAll({
      where: { orgId: req.currentUser.orgId, sampledForQa: true, qaReviewedAt: null },
      order: [["createdAt", "ASC"]],
      limit: 200,
    });
    res.json(
      invoices.map((inv) => ({
        invoice_id: inv.id,
        vendor_name: inv.vendorName,
        original_filename: inv.originalFilename,
        total: inv.total,
        invoice_date: inv.invoiceDate,
        overall_confidence: inv.overallConfidence,
      }))
    );
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
  shipping: z.number().nullable().optional(),
  // Accepted either way round and stored as a magnitude, matching how the
  // extractor normalises it -- a human correcting "-45" and a human
  // correcting "45" on a discount line mean the same thing.
  discount: z.number().nullable().optional(),
  other_charges: z
    .array(z.object({ label: z.string().max(128), amount: z.number() }))
    .max(20)
    .nullable()
    .optional(),
  tax: z.number().nullable().optional(),
  payment_terms: z.string().max(64).nullable().optional(),
  total: z.number().nullable().optional(),
  line_items: z.array(lineItemSchema).nullable().optional(),
});

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
      // Same normalisation the extractor applies: a discount is stored as
      // the magnitude to subtract, however it was typed. Doing it here
      // rather than trusting the client means the arithmetic below and the
      // cross-check see one representation, not two.
      const newValue = field === "discount" && payload[field] !== null ? Math.abs(payload[field]) : payload[field];
      const oldValue = invoice[attr];
      if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) {
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

    // Re-score after a correction. The whole point of letting somebody fix
    // a field is that the verdict on the document changes; leaving the old
    // cross-check result on screen after they supplied the missing shipping
    // amount is the same "it says error on a correct invoice" complaint in
    // a different place. Status is deliberately untouched -- approving is a
    // separate, explicit act.
    const fresh = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (Object.keys(changed).length) {
      const report = scoreConfidence({
        fields: scoringFieldsFor(fresh),
        fieldConfidence: fresh.fieldConfidence,
        lineItems: (fresh.lineItems || []).map((li) => ({ amount: li.amount, confidence: li.confidence })),
      });
      fresh.overallConfidence = report.overallConfidence;
      fresh.crossCheckPassed = report.crossCheckPassed;
      fresh.crossCheckDetail = report.crossCheckDetail;
      await fresh.save();
    }
    res.json(serializeInvoiceDetail(fresh));
  } catch (err) {
    next(err);
  }
});

// The extraction-shaped view of a stored invoice, for re-scoring after a
// human edits it. Kept in one place because it is easy to add a field to
// the model and forget it here, and the symptom -- a cross-check that
// silently ignores an amount -- looks like a bug in the arithmetic rather
// than an omission in a mapping.
function scoringFieldsFor(invoice) {
  return {
    vendor_name: invoice.vendorName,
    invoice_number: invoice.invoiceNumber,
    invoice_date: invoice.invoiceDate,
    due_date: invoice.dueDate,
    po_reference: invoice.poReference,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    shipping: invoice.shipping,
    discount: invoice.discount,
    other_charges: invoice.otherCharges ?? [],
    tax: invoice.tax,
    payment_terms: invoice.paymentTerms,
    total: invoice.total,
  };
}

const quickReviewFieldSchema = z.object({
  field: z.enum(QUICK_REVIEW_FIELDS),
  value: z.union([z.string(), z.number()]).nullable(),
});

// Confirms (value left unchanged) or corrects (value edited) exactly one
// field, treating either case identically -- a human just looked at this
// specific field and vouched for the value now on it, so it's marked fully
// confident (1.0) either way, same as a full correction via
// PATCH /api/invoices/:id. Recomputes overall confidence and the
// cross-check from the invoice's current state (confidence.js's score)
// rather than leaving the extraction-time snapshot stale, since the whole
// point of this route is moving an invoice toward "nothing left to flag."
// Once nothing does, auto-approves -- a human has now personally vouched
// for every field that was ever in question, so there's nothing left for a
// manual Approve click to add.
router.post("/api/invoices/:id/quick-review-field", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = quickReviewFieldSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.status !== "needs_review") {
      return res.status(409).json({ detail: `Cannot quick-review a field on an invoice in status ${invoice.status}` });
    }
    if (invoice.duplicateOfInvoiceId || invoice.possibleMultiInvoice) {
      return res.status(409).json({ detail: "This invoice needs a full review, not quick field review." });
    }

    const { field } = parsed.data;
    const attr = FIELD_TO_ATTR[field];
    let value = parsed.data.value;
    if (NUMERIC_QUICK_REVIEW_FIELDS.has(field)) {
      value = value === null || value === "" ? null : Number(value);
      if (value !== null && !Number.isFinite(value)) {
        return res.status(422).json({ detail: `${field} must be a number.` });
      }
    } else {
      value = value === null ? "" : String(value);
    }

    const oldValue = invoice[attr];
    invoice[attr] = value;
    invoice.fieldConfidence = { ...invoice.fieldConfidence, [field]: 1.0 };

    const report = scoreConfidence({
      fields: scoringFieldsFor(invoice),
      fieldConfidence: invoice.fieldConfidence,
      lineItems: (invoice.lineItems || []).map((li) => ({ amount: li.amount, confidence: li.confidence })),
    });
    invoice.overallConfidence = report.overallConfidence;
    invoice.crossCheckPassed = report.crossCheckPassed;
    invoice.crossCheckDetail = report.crossCheckDetail;

    const threshold = await effectiveConfidenceThreshold(req.currentUser.orgId);
    const stillFlagged = report.overallConfidence < threshold || !report.crossCheckPassed;
    if (!stillFlagged) invoice.status = "approved";
    await invoice.save();
    if (!stillFlagged) await postInvoiceApproval(invoice);

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "quick_review_field",
      actor: req.currentUser.email,
      details: { field, old: oldValue, new: value },
    });

    // Same "only a real change is worth remembering" rule as the full
    // PATCH route above -- confirming an already-correct vendor name as-is
    // teaches nothing new.
    if (field === "vendor_name" && oldValue && String(oldValue) !== String(value)) {
      await rememberVendorCorrection(req.currentUser.orgId, oldValue, value);
    }

    if (!stillFlagged) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: "approved",
        actor: req.currentUser.email,
        details: { via: "quick_review" },
      });
    }

    res.json({ invoice_status: invoice.status, still_flagged: stillFlagged });
  } catch (err) {
    next(err);
  }
});

const qaReviewSchema = z.object({
  outcome: z.enum(["confirmed", "issue_flagged"]),
  note: z.string().max(1000).optional(),
});

// Records a human's verdict on a sampled auto-approval -- purely a QA
// record, same reasoning as the bank-reconciliation confirm route's
// "Rekono never writes this back" stance: this never changes the invoice's
// own status or touches QuickBooks. If a real error turns up, that's a
// signal to revisit the org's auto-approval settings (or handle that one
// invoice by hand, e.g. a manual correction + a note to whoever pays
// vendors) -- not something this route tries to undo automatically.
router.post("/api/invoices/:id/qa-review", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = qaReviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId, sampledForQa: true } });
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.qaReviewedAt) return res.status(409).json({ detail: "This invoice has already been spot-checked." });

    invoice.qaReviewedAt = new Date();
    invoice.qaOutcome = parsed.data.outcome;
    await invoice.save();

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "qa_reviewed",
      actor: req.currentUser.email,
      details: { outcome: parsed.data.outcome, note: parsed.data.note || "" },
    });

    res.json({ ok: true, qa_outcome: invoice.qaOutcome, qa_reviewed_at: invoice.qaReviewedAt });
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
    await postInvoiceApproval(invoice);
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
    await voidInvoiceJournalEntry(req.currentUser.orgId, invoice.id);
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

// Re-runs the full OCR + extraction pipeline for a document that's already
// on disk, without needing to re-upload the same file -- the only recovery
// path before this for a genuinely failed extraction (a transient OCR
// error, an LLM timeout, an API key that got fixed after the fact) was
// deleting the invoice and uploading it again. Blocked once approved: that
// status means a human has already signed off on the current field values
// as correct, and a fresh extraction pass would silently overwrite them.
router.post("/api/invoices/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.status === "approved") {
      return res.status(409).json({ detail: "Cannot retry an already-approved invoice." });
    }
    invoice.status = "queued";
    invoice.errorMessage = "";
    await invoice.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    enqueue(invoice.id);
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

    await voidInvoiceJournalEntry(req.currentUser.orgId, invoice.id);

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
