// The end-to-end extraction pipeline for each queued expense receipt:
// OCR -> LLM/heuristic structured extraction -> confidence scoring ->
// persist. Mirrors pipeline.js's processInvoice, deliberately without the
// invoice pipeline's more advanced features (auto-approval, QA sampling,
// vendor-alias learning, duplicate detection) -- v1 for a second document
// type is the same core loop only; those can follow once this one's proven
// out, the same way the invoice pipeline grew them one at a time.

import * as confidenceModule from "./confidenceReceipts.js";
import * as extractionModule from "./extractionReceipts.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, ExpenseReceipt } from "./models/index.js";

export async function effectiveConfidenceThreshold() {
  // Reuses the same org-wide default as invoices (settings.js) rather than
  // its own separate setting -- one "how confident is confident enough"
  // knob for the whole app, not a second one to keep in sync. The
  // Business/Scale custom-threshold override (pipeline.js's invoice-specific
  // version) is invoice-only for now; revisit if receipts need their own.
  return settings.reviewConfidenceThreshold;
}

export async function processExpense(receiptId) {
  const receipt = await ExpenseReceipt.findByPk(receiptId);
  if (!receipt) {
    console.warn(`processExpense: receipt ${receiptId} not found`);
    return;
  }

  receipt.status = "processing";
  await receipt.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(receipt.storagePath, receipt.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      console.error(`OCR failed for receipt ${receiptId}:`, exc.message);
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(receipt, message);
      return;
    }
    throw exc;
  }

  receipt.rawOcrText = ocrText;
  if (!ocrText.trim()) {
    await fail(receipt, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const report = confidenceModule.score(result);

    receipt.merchantName = result.fields.merchant_name || "";
    receipt.receiptDate = result.fields.receipt_date || null;
    receipt.category = result.fields.category || "";
    receipt.currency = result.fields.currency || "USD";
    receipt.tax = result.fields.tax;
    receipt.amount = result.fields.amount;

    receipt.extractionMethod = result.method;
    receipt.fieldConfidence = result.fieldConfidence;
    receipt.overallConfidence = report.overallConfidence;

    const threshold = await effectiveConfidenceThreshold();
    const flagged = report.overallConfidence < threshold;
    receipt.status = flagged ? "needs_review" : "extracted";
    await receipt.save();

    await AuditLog.create({
      orgId: receipt.orgId,
      receiptId: receipt.id,
      action: "extraction_completed",
      actor: "system",
      details: { method: result.method, overall_confidence: report.overallConfidence },
    });
  } catch (exc) {
    console.error(`process_expense failed for ${receiptId}`, exc);
    await fail(receipt, `Unexpected error: ${exc.message}`);
  }
}

async function fail(receipt, message) {
  receipt.status = "failed";
  receipt.errorMessage = message;
  await receipt.save();
  await AuditLog.create({
    orgId: receipt.orgId,
    receiptId: receipt.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (jobs.js's drain loop), same reasoning as
// pipeline.js's markFailedIfStuck.
export async function markFailedIfStuck(receiptId, exc) {
  const receipt = await ExpenseReceipt.findByPk(receiptId);
  if (!receipt || ["failed", "extracted", "needs_review", "approved"].includes(receipt.status)) {
    return;
  }
  await fail(receipt, `Unexpected error while processing this document: ${exc.message}`);
}
