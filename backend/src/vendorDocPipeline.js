// The end-to-end extraction pipeline for each queued vendor document:
// OCR -> LLM/heuristic structured extraction -> confidence scoring ->
// persist. Mirrors expensePipeline.js's processExpense, same v1 scope
// (no auto-approval, QA sampling, vendor-alias learning, duplicate
// detection) -- the core loop only, proven out twice already by the
// invoice and expense-receipt pipelines.

import * as confidenceModule from "./confidenceVendorDocs.js";
import * as extractionModule from "./extractionVendorDocs.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, VendorDocument } from "./models/index.js";

export async function effectiveConfidenceThreshold() {
  // Reuses the same org-wide default as invoices/receipts rather than its
  // own separate setting -- one "how confident is confident enough" knob
  // for the whole app.
  return settings.reviewConfidenceThreshold;
}

export async function processVendorDocument(documentId) {
  const doc = await VendorDocument.findByPk(documentId);
  if (!doc) {
    console.warn(`processVendorDocument: document ${documentId} not found`);
    return;
  }

  doc.status = "processing";
  await doc.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(doc.storagePath, doc.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      console.error(`OCR failed for vendor document ${documentId}:`, exc.message);
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(doc, message);
      return;
    }
    throw exc;
  }

  doc.rawOcrText = ocrText;
  if (!ocrText.trim()) {
    await fail(doc, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const report = confidenceModule.score(result);

    doc.vendorName = result.fields.vendor_name || "";
    doc.documentType = result.fields.document_type || "";
    doc.effectiveDate = result.fields.effective_date || null;
    doc.expirationDate = result.fields.expiration_date || null;
    doc.referenceNumber = result.fields.reference_number || "";
    doc.amount = result.fields.amount;

    doc.extractionMethod = result.method;
    doc.fieldConfidence = result.fieldConfidence;
    doc.overallConfidence = report.overallConfidence;

    const threshold = await effectiveConfidenceThreshold();
    const flagged = report.overallConfidence < threshold;
    doc.status = flagged ? "needs_review" : "extracted";
    await doc.save();

    await AuditLog.create({
      orgId: doc.orgId,
      vendorDocumentId: doc.id,
      action: "extraction_completed",
      actor: "system",
      details: { method: result.method, overall_confidence: report.overallConfidence },
    });
  } catch (exc) {
    console.error(`processVendorDocument failed for ${documentId}`, exc);
    await fail(doc, `Unexpected error: ${exc.message}`);
  }
}

async function fail(doc, message) {
  doc.status = "failed";
  doc.errorMessage = message;
  await doc.save();
  await AuditLog.create({
    orgId: doc.orgId,
    vendorDocumentId: doc.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (jobs.js's drain loop), same reasoning as
// pipeline.js's markFailedIfStuck.
export async function markFailedIfStuck(documentId, exc) {
  const doc = await VendorDocument.findByPk(documentId);
  if (!doc || ["failed", "extracted", "needs_review", "approved"].includes(doc.status)) {
    return;
  }
  await fail(doc, `Unexpected error while processing this document: ${exc.message}`);
}
