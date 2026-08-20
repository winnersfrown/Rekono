// The end-to-end extraction pipeline run for each queued invoice:
// OCR -> LLM/heuristic structured extraction -> confidence scoring -> persist.

import { Op } from "sequelize";
import * as confidenceModule from "./confidence.js";
import * as extractionModule from "./extraction.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { PLANS } from "./plans.js";
import { AuditLog, Invoice, LineItem, Organization } from "./models/index.js";
import { lookupVendorAlias } from "./vendorAlias.js";

// If this exact raw vendor text has been corrected before for this org
// (see vendorAlias.js / routes/invoices.js), use the known-good name and
// treat it as high-confidence -- a human already verified this exact
// mapping once, so this isn't a fresh guess. Runs on the raw extraction
// result before confidence scoring, so the boosted confidence feeds into
// the same needs_review decision as everything else, instead of being a
// separate override layered on top. The boolean return value doubles as
// processInvoice's "is this a known vendor" signal for shouldAutoApprove,
// below -- a brand-new vendor never auto-approves regardless of confidence.
export async function applyVendorAlias(orgId, result) {
  const alias = await lookupVendorAlias(orgId, result.fields.vendor_name);
  if (!alias) return false;
  result.fields.vendor_name = alias.canonicalVendorName;
  result.fieldConfidence.vendor_name = Math.max(result.fieldConfidence.vendor_name ?? 0, 0.95);
  return true;
}

// An org's own confidenceThreshold only applies while its plan actually
// carries the customConfidenceThreshold feature (see plans.js) -- so a
// value set while on Business/Scale doesn't silently keep applying after a
// downgrade, without needing to clear it out on every plan change.
export async function effectiveConfidenceThreshold(orgId) {
  const org = await Organization.findByPk(orgId);
  const plan = org && PLANS[org.plan];
  if (plan?.customConfidenceThreshold && org.confidenceThreshold !== null && org.confidenceThreshold !== undefined) {
    return org.confidenceThreshold;
  }
  return settings.reviewConfidenceThreshold;
}

// Skips the manual "click Approve" step for an invoice that would already
// have been fast-tracked as `extracted` -- this NEVER overrides a
// needs_review flag (see processInvoice, below, which only calls this once
// `flagged` is already false), it only removes a redundant human click for
// spend that's already both confidently extracted AND low business risk.
// "Low risk" requires every one of: the org has explicitly opted in (never
// on by default, even on a qualifying plan -- see Organization.js's comment
// on autoApprovalEnabled), its plan includes riskBasedAutoApproval
// (Business/Scale, see plans.js -- this is exactly the kind of thing that
// only matters at real volume), the total is at or under org's own
// configured ceiling, and the vendor has a known alias (a human has
// corrected/confirmed this exact vendor before -- a brand-new vendor always
// gets a human's eyes on its first invoice, regardless of confidence or
// amount).
export async function shouldAutoApprove(invoice, knownVendor) {
  if (!knownVendor || invoice.total == null) return false;

  const org = await Organization.findByPk(invoice.orgId);
  if (!org?.autoApprovalEnabled || org.autoApprovalMaxAmount == null) return false;

  const plan = PLANS[org.plan];
  if (!plan?.riskBasedAutoApproval) return false;

  return invoice.total <= org.autoApprovalMaxAmount;
}

// Whether an already-auto-approved invoice gets flagged for a retrospective
// QA spot-check (see processInvoice, below, and routes/invoices.js's
// qa-sample-queue/qa-review routes). `random` is injectable (defaults to
// the real Math.random) the same way every network-touching function in
// this codebase takes an injectable fetchImpl -- so this stays a pure,
// deterministically testable decision rather than something tests have to
// reason about statistically.
export function shouldSampleForQa(org, { random = Math.random } = {}) {
  return Boolean(org?.sampleReviewEnabled && org.sampleReviewRate && random() < org.sampleReviewRate);
}

export async function processInvoice(invoiceId) {
  const invoice = await Invoice.findByPk(invoiceId);
  if (!invoice) {
    console.warn(`processInvoice: invoice ${invoiceId} not found`);
    return;
  }

  invoice.status = "processing";
  await invoice.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(invoice.storagePath, invoice.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      // exc.message from a failed pdftoppm/tesseract call includes the full
      // shelled-out command plus its raw stdout/stderr (Node's child_process
      // default) -- useful in server logs, not as the user-facing message
      // the review UI now shows verbatim, so log the detail here and surface
      // a plain-language reason instead.
      console.error(`OCR failed for invoice ${invoiceId}:`, exc.message);
      // A missing source file (as opposed to one OCR couldn't read) usually
      // means the upload was lost to an ephemeral filesystem restart/redeploy
      // before processing got to it -- tell the user something they can
      // actually act on (re-upload) instead of implying their file is bad.
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(invoice, message);
      return;
    }
    throw exc;
  }

  invoice.rawOcrText = ocrText;
  if (!ocrText.trim()) {
    await fail(invoice, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const knownVendor = await applyVendorAlias(invoice.orgId, result);
    const report = confidenceModule.score(result);

    invoice.vendorName = result.fields.vendor_name || "";
    invoice.invoiceNumber = result.fields.invoice_number || "";
    invoice.invoiceDate = result.fields.invoice_date || null;
    invoice.dueDate = result.fields.due_date || null;
    invoice.currency = result.fields.currency || "USD";
    invoice.poReference = result.fields.po_reference || "";
    invoice.subtotal = result.fields.subtotal;
    invoice.tax = result.fields.tax;
    invoice.total = result.fields.total;

    invoice.extractionMethod = result.method;
    invoice.fieldConfidence = result.fieldConfidence;
    invoice.overallConfidence = report.overallConfidence;
    invoice.crossCheckPassed = report.crossCheckPassed;
    invoice.crossCheckDetail = report.crossCheckDetail;

    const duplicateOf = await findDuplicateInvoice(invoice);
    if (duplicateOf) {
      invoice.duplicateOfInvoiceId = duplicateOf.id;
      invoice.duplicateOfFilename = duplicateOf.originalFilename;
    }

    invoice.possibleMultiInvoice = Boolean(result.possibleMultiInvoice);
    invoice.possibleMultiInvoiceReason = result.possibleMultiInvoiceReason || "";

    const threshold = await effectiveConfidenceThreshold(invoice.orgId);
    const flagged =
      Boolean(duplicateOf) || invoice.possibleMultiInvoice || report.overallConfidence < threshold || !report.crossCheckPassed;
    const autoApproved = !flagged && (await shouldAutoApprove(invoice, knownVendor));
    invoice.status = flagged ? "needs_review" : autoApproved ? "approved" : "extracted";
    await invoice.save();

    await LineItem.destroy({ where: { invoiceId: invoice.id } });
    await LineItem.bulkCreate(
      result.lineItems.map((li, i) => ({
        invoiceId: invoice.id,
        position: i,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        amount: li.amount,
        confidence: li.confidence,
      }))
    );

    await AuditLog.create({
      orgId: invoice.orgId,
      invoiceId: invoice.id,
      action: "extraction_completed",
      actor: "system",
      details: {
        method: result.method,
        overall_confidence: report.overallConfidence,
        cross_check_passed: report.crossCheckPassed,
        cross_check_detail: report.crossCheckDetail,
        duplicate_of_invoice_id: duplicateOf?.id ?? null,
        possible_multi_invoice: invoice.possibleMultiInvoice,
      },
    });

    // Kept as its own audit entry (rather than folded into
    // extraction_completed's details above) so it reads clearly in the
    // audit trail as a real approval decision, same "system" actor
    // treatment auto-populated fields already get -- this is real money
    // that a human never looked at, and that needs to be legible on its own
    // line for the finance/compliance conversations this trail exists for.
    if (autoApproved) {
      await AuditLog.create({
        orgId: invoice.orgId,
        invoiceId: invoice.id,
        action: "auto_approved",
        actor: "system",
        details: {
          reason: "known vendor, within the org's configured amount ceiling, high-confidence extraction",
          total: invoice.total,
          overall_confidence: report.overallConfidence,
        },
      });

      // Statistical spot-checking: an auto-approved invoice never gets a
      // human's eyes otherwise, so a random slice of them get flagged for a
      // retrospective quality check (see routes/invoices.js's
      // qa-sample-queue/qa-review routes) -- catches drift in the
      // auto-approval logic itself without reviewing every invoice it
      // clears. Only rolled here, not on every invoice, since a manually
      // reviewed or `extracted`-but-pending invoice already gets a human's
      // attention on its own.
      const org = await Organization.findByPk(invoice.orgId);
      if (shouldSampleForQa(org)) {
        invoice.sampledForQa = true;
        await invoice.save();
        await AuditLog.create({
          orgId: invoice.orgId,
          invoiceId: invoice.id,
          action: "qa_sampled",
          actor: "system",
          details: { sample_rate: org.sampleReviewRate },
        });
      }
    }
  } catch (exc) {
    console.error(`process_invoice failed for ${invoiceId}`, exc);
    await fail(invoice, `Unexpected error: ${exc.message}`);
  }
}

// Same org, same vendor + invoice number (trimmed, case-insensitive) on a
// different, non-rejected invoice -- the classic double-upload/double-pay
// signal. Deliberately narrow: only runs once both fields are non-empty, so
// two blank/low-confidence extractions never "match" each other. A rejected
// invoice is excluded because a human already decided that record doesn't
// count, so it shouldn't block a genuine resubmission.
export async function findDuplicateInvoice(invoice) {
  const vendorName = invoice.vendorName.trim().toLowerCase();
  const invoiceNumber = invoice.invoiceNumber.trim().toLowerCase();
  if (!vendorName || !invoiceNumber) return null;

  const candidates = await Invoice.findAll({
    where: {
      orgId: invoice.orgId,
      id: { [Op.ne]: invoice.id },
      status: { [Op.ne]: "rejected" },
      vendorName: { [Op.ne]: "" },
      invoiceNumber: { [Op.ne]: "" },
    },
    attributes: ["id", "vendorName", "invoiceNumber", "originalFilename"],
  });

  return (
    candidates.find(
      (c) => c.vendorName.trim().toLowerCase() === vendorName && c.invoiceNumber.trim().toLowerCase() === invoiceNumber
    ) || null
  );
}

async function fail(invoice, message) {
  invoice.status = "failed";
  invoice.errorMessage = message;
  await invoice.save();
  await AuditLog.create({
    orgId: invoice.orgId,
    invoiceId: invoice.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (see jobs.js's drain loop): if processInvoice
// throws in a way it didn't already handle -- a bug, an OCR failure that
// somehow escapes the OcrError wrapping above -- the invoice would otherwise
// stay stuck on "processing" forever, since nothing else ever calls fail()
// for it. Only acts if the invoice is still mid-pipeline, so it can't
// clobber a result that actually completed before the error was thrown.
export async function markFailedIfStuck(invoiceId, exc) {
  const invoice = await Invoice.findByPk(invoiceId);
  if (
    !invoice ||
    ["failed", "extracted", "needs_review", "approved"].includes(invoice.status)
  ) {
    return;
  }
  await fail(invoice, `Unexpected error while processing this document: ${exc.message}`);
}
