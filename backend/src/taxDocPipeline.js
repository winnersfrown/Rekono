// The end-to-end extraction pipeline for each queued tax document: OCR ->
// LLM/heuristic structured extraction -> confidence scoring -> persist.
// Mirrors leasePipeline.js's shape, same v1 scope (no auto-approval, QA
// sampling, duplicate detection) -- the core loop only, proven out four
// times already by the invoice, expense-receipt, vendor-document, and
// lease pipelines.

import * as confidenceModule from "./confidenceTaxDocs.js";
import * as extractionModule from "./extractionTaxDocs.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, TaxDocument } from "./models/index.js";

export async function effectiveConfidenceThreshold() {
  // Reuses the same org-wide default as the other four pipelines rather
  // than its own separate setting -- one "how confident is confident
  // enough" knob for the whole app.
  return settings.reviewConfidenceThreshold;
}

export async function processTaxDocument(taxDocumentId) {
  const doc = await TaxDocument.findByPk(taxDocumentId);
  if (!doc) {
    console.warn(`processTaxDocument: tax document ${taxDocumentId} not found`);
    return;
  }

  doc.status = "processing";
  await doc.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(doc.storagePath, doc.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      console.error(`OCR failed for tax document ${taxDocumentId}:`, exc.message);
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(doc, message);
      return;
    }
    throw exc;
  }

  // Extraction reads the unredacted text (it needs the full number to know
  // which four digits are the last four), but only the redacted copy is
  // ever written to the database -- see TaxDocument.js's rawOcrText and
  // recipientTinLast4 comments.
  doc.rawOcrText = extractionModule.redactTins(ocrText);
  if (!ocrText.trim()) {
    await fail(doc, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const report = confidenceModule.score(result);

    doc.documentType = result.fields.document_type || "";
    doc.taxYear = result.fields.tax_year ?? null;
    doc.payerName = result.fields.payer_name || "";
    doc.recipientName = result.fields.recipient_name || "";
    doc.recipientTinLast4 = result.fields.recipient_tin_last4 || "";
    doc.amount = result.fields.amount;
    doc.federalTaxWithheld = result.fields.federal_tax_withheld;

    doc.extractionMethod = result.method;
    doc.fieldConfidence = result.fieldConfidence;
    doc.overallConfidence = report.overallConfidence;

    const threshold = await effectiveConfidenceThreshold();
    const flagged = report.overallConfidence < threshold;
    doc.status = flagged ? "needs_review" : "extracted";
    await doc.save();

    await AuditLog.create({
      orgId: doc.orgId,
      taxDocumentId: doc.id,
      action: "extraction_completed",
      actor: "system",
      details: { method: result.method, overall_confidence: report.overallConfidence },
    });
  } catch (exc) {
    console.error(`processTaxDocument failed for ${taxDocumentId}`, exc);
    await fail(doc, `Unexpected error: ${exc.message}`);
  }
}

async function fail(doc, message) {
  doc.status = "failed";
  doc.errorMessage = message;
  await doc.save();
  await AuditLog.create({
    orgId: doc.orgId,
    taxDocumentId: doc.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (jobs.js's drain loop), same reasoning as
// pipeline.js's markFailedIfStuck.
export async function markFailedIfStuck(taxDocumentId, exc) {
  const doc = await TaxDocument.findByPk(taxDocumentId);
  if (!doc || ["failed", "extracted", "needs_review", "approved"].includes(doc.status)) {
    return;
  }
  await fail(doc, `Unexpected error while processing this document: ${exc.message}`);
}
