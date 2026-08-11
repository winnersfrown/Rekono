// The end-to-end extraction pipeline run for each queued invoice:
// OCR -> LLM/heuristic structured extraction -> confidence scoring -> persist.

import * as confidenceModule from "./confidence.js";
import * as extractionModule from "./extraction.js";
import * as ocrModule from "./ocr.js";
import { settings } from "./config.js";
import { AuditLog, Invoice, LineItem } from "./models/index.js";

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
      await fail(invoice, `OCR failed: ${exc.message}`);
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

    const flagged = report.overallConfidence < settings.reviewConfidenceThreshold || !report.crossCheckPassed;
    invoice.status = flagged ? "needs_review" : "extracted";
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
      },
    });
  } catch (exc) {
    console.error(`process_invoice failed for ${invoiceId}`, exc);
    await fail(invoice, `Unexpected error: ${exc.message}`);
  }
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
