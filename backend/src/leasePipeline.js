// The end-to-end extraction pipeline for each queued lease: OCR ->
// LLM/heuristic structured extraction -> confidence scoring -> persist.
// Mirrors vendorDocPipeline.js's shape, same v1 scope (no auto-approval,
// QA sampling, vendor-alias learning, duplicate detection) -- the core
// loop only, proven out three times already by the invoice, expense-
// receipt, and vendor-document pipelines.

import * as confidenceModule from "./confidenceLeases.js";
import * as extractionModule from "./extractionLeases.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, Lease } from "./models/index.js";

export async function effectiveConfidenceThreshold() {
  // Reuses the same org-wide default as invoices/receipts/vendor
  // documents rather than its own separate setting -- one "how confident
  // is confident enough" knob for the whole app.
  return settings.reviewConfidenceThreshold;
}

export async function processLease(leaseId) {
  const lease = await Lease.findByPk(leaseId);
  if (!lease) {
    console.warn(`processLease: lease ${leaseId} not found`);
    return;
  }

  lease.status = "processing";
  await lease.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(lease.storagePath, lease.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      console.error(`OCR failed for lease ${leaseId}:`, exc.message);
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(lease, message);
      return;
    }
    throw exc;
  }

  lease.rawOcrText = ocrText;
  if (!ocrText.trim()) {
    await fail(lease, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const report = confidenceModule.score(result);

    lease.landlordName = result.fields.landlord_name || "";
    lease.propertyAddress = result.fields.property_address || "";
    lease.commencementDate = result.fields.commencement_date || null;
    lease.expirationDate = result.fields.expiration_date || null;
    lease.renewalNoticeDeadline = result.fields.renewal_notice_deadline || null;
    lease.monthlyRent = result.fields.monthly_rent;
    lease.annualEscalationPct = result.fields.annual_escalation_pct;

    lease.extractionMethod = result.method;
    lease.fieldConfidence = result.fieldConfidence;
    lease.overallConfidence = report.overallConfidence;

    const threshold = await effectiveConfidenceThreshold();
    const flagged = report.overallConfidence < threshold;
    lease.status = flagged ? "needs_review" : "extracted";
    await lease.save();

    await AuditLog.create({
      orgId: lease.orgId,
      leaseId: lease.id,
      action: "extraction_completed",
      actor: "system",
      details: { method: result.method, overall_confidence: report.overallConfidence },
    });
  } catch (exc) {
    console.error(`processLease failed for ${leaseId}`, exc);
    await fail(lease, `Unexpected error: ${exc.message}`);
  }
}

async function fail(lease, message) {
  lease.status = "failed";
  lease.errorMessage = message;
  await lease.save();
  await AuditLog.create({
    orgId: lease.orgId,
    leaseId: lease.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (jobs.js's drain loop), same reasoning as
// pipeline.js's markFailedIfStuck.
export async function markFailedIfStuck(leaseId, exc) {
  const lease = await Lease.findByPk(leaseId);
  if (!lease || ["failed", "extracted", "needs_review", "approved"].includes(lease.status)) {
    return;
  }
  await fail(lease, `Unexpected error while processing this document: ${exc.message}`);
}
