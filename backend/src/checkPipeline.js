// The end-to-end extraction pipeline for each queued check: OCR ->
// LLM/heuristic structured extraction -> confidence scoring -> persist.
// Mirrors taxDocPipeline.js's shape, same v1 scope (no auto-approval, QA
// sampling, duplicate detection) -- the core loop only, proven out five
// times already.
//
// One thing this pipeline deliberately does NOT do: link the check to a
// bill. Extraction can suggest a match (see routes/checks.js's
// match-suggestions), but applying one posts a journal entry and moves
// money, and nothing in this app lets an OCR guess do that unaided. The
// pipeline's job ends at "here is what the check says".

import * as confidenceModule from "./confidenceChecks.js";
import * as extractionModule from "./extractionChecks.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, Check } from "./models/index.js";

export async function effectiveConfidenceThreshold() {
  // Reuses the same org-wide default as the other five pipelines rather
  // than its own separate setting -- one "how confident is confident
  // enough" knob for the whole app.
  return settings.reviewConfidenceThreshold;
}

export async function processCheck(checkId) {
  const check = await Check.findByPk(checkId);
  if (!check) {
    console.warn(`processCheck: check ${checkId} not found`);
    return;
  }

  check.status = "processing";
  await check.save();

  let ocrText;
  try {
    ocrText = await ocrModule.extractText(check.storagePath, check.contentType);
  } catch (exc) {
    if (exc instanceof ocrModule.OcrError) {
      console.error(`OCR failed for check ${checkId}:`, exc.message);
      const message = exc.message.startsWith("File not found:")
        ? "The uploaded file is no longer available on the server (this can happen after a restart or redeploy on ephemeral hosting). Please re-upload this document."
        : "OCR failed: the document couldn't be processed. It may be corrupted, password-protected, or not a valid file of its type.";
      await fail(check, message);
      return;
    }
    throw exc;
  }

  // Extraction reads the unredacted text (it needs the full run to know
  // which four digits are the last four), but only the redacted copy is
  // ever written to the database -- see Check.js's accountLast4 comment.
  check.rawOcrText = extractionModule.redactMicr(ocrText);
  if (!ocrText.trim()) {
    await fail(check, "OCR produced no text (image may be blank, unreadable, or unsupported).");
    return;
  }

  try {
    const result = await extractionModule.extract(ocrText);
    const report = confidenceModule.score(result);

    check.checkNumber = result.fields.check_number || "";
    check.checkDate = result.fields.check_date || null;
    check.payeeName = result.fields.payee_name || "";
    check.amount = result.fields.amount;
    check.memo = result.fields.memo || "";
    check.bankName = result.fields.bank_name || "";
    check.accountLast4 = result.fields.account_last4 || "";

    check.extractionMethod = result.method;
    check.fieldConfidence = result.fieldConfidence;
    check.overallConfidence = report.overallConfidence;

    const threshold = await effectiveConfidenceThreshold();
    // A check with no readable amount or payee can't be applied to
    // anything regardless of what the weighted score came out at, so it's
    // flagged on those two directly rather than relying on the average to
    // drag it under the threshold -- the same "a missing field is not a
    // low-confidence field" distinction the invoice cross-check makes.
    const unusable = check.amount == null || !check.payeeName;
    check.status = unusable || report.overallConfidence < threshold ? "needs_review" : "extracted";
    await check.save();

    await AuditLog.create({
      orgId: check.orgId,
      checkId: check.id,
      action: "extraction_completed",
      actor: "system",
      details: { method: result.method, overall_confidence: report.overallConfidence },
    });
  } catch (exc) {
    console.error(`processCheck failed for ${checkId}`, exc);
    await fail(check, `Unexpected error: ${exc.message}`);
  }
}

async function fail(check, message) {
  check.status = "failed";
  check.errorMessage = message;
  await check.save();
  await AuditLog.create({
    orgId: check.orgId,
    checkId: check.id,
    action: "extraction_failed",
    actor: "system",
    details: { error: message },
  });
}

// Safety net for the job queue (jobs.js's drain loop), same reasoning as
// pipeline.js's markFailedIfStuck.
export async function markFailedIfStuck(checkId, exc) {
  const check = await Check.findByPk(checkId);
  if (!check || ["failed", "extracted", "needs_review", "approved"].includes(check.status)) {
    return;
  }
  await fail(check, `Unexpected error while processing this document: ${exc.message}`);
}
