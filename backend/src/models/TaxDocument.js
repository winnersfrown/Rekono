import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Same status shape as Invoice/ExpenseReceipt/VendorDocument/Lease -- the
// pipeline this runs through (queue -> OCR -> extract -> confidence-gate ->
// review) is the same shape, just a fifth document type and schema.
export const TAX_DOCUMENT_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence - fast-track review
  "needs_review", // low confidence - flagged
  "approved",
  "rejected",
  "failed",
];

// A fixed set rather than free text, same reasoning as
// VENDOR_DOCUMENT_TYPES -- lets the review UI offer a dropdown, keeps the
// per-year totals meaningful, and gives the extraction prompt
// (extractionTaxDocs.js) a fixed list to classify into directly. Scoped to
// what actually lands in a small business's January/February mail rather
// than the full IRS form catalogue; anything else is "Other".
export const TAX_DOCUMENT_TYPES = [
  "1099-NEC",
  "1099-MISC",
  "1099-K",
  "1099-INT",
  "1099-DIV",
  "W-2",
  "1098",
  "K-1",
  "Other",
];

export const TaxDocument = sequelize.define(
  "TaxDocument",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...TAX_DOCUMENT_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    documentType: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
    // The field the whole module exists for: every one of these documents
    // belongs to exactly one tax year, and "show me everything for 2025"
    // is the only question anyone ever asks of a pile of them. This is
    // what routes/taxDocuments.js's tax_year filter and its per-year
    // totals key off of. An integer rather than a date -- a tax year is a
    // label on the form, not a point in time.
    taxYear: { type: DataTypes.INTEGER, allowNull: true },
    payerName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    recipientName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // ONLY the last four digits, never the whole number -- see
    // extractionTaxDocs.js's tinLast4/redactTins. These forms carry SSNs,
    // and a full SSN sitting in a database column (and flowing out through
    // every CSV export) is a liability with no matching upside: last-four
    // is the standard reconciliation key, and the full number is still
    // right there in the stored source document if anyone genuinely needs
    // it. An empty string means no TIN was found at all, which is itself
    // the compliance problem the missing_tin filter surfaces -- a 1099
    // without a payee TIN is what triggers an IRS B-notice and backup
    // withholding.
    recipientTinLast4: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "" },
    // The headline dollar figure for the form's own type: box 1
    // nonemployee compensation on a 1099-NEC, box 1 wages on a W-2, gross
    // payments on a 1099-K, and so on. One field rather than a column per
    // box -- the boxes differ per form and are blank on all the others.
    amount: { type: DataTypes.FLOAT, allowNull: true },
    federalTaxWithheld: { type: DataTypes.FLOAT, allowNull: true },

    // Free-text note a submitter can attach -- nothing extraction fills
    // in, a human-entered field from the start, same as the other four
    // pipelines' note field.
    note: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    // Redacted before it's stored (see taxDocPipeline.js) -- the raw OCR
    // of a W-2 contains the same full SSN the recipientTinLast4 comment
    // above explains we deliberately don't keep.
    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "tax_documents",
    indexes: [
      { fields: ["orgId"] },
      { fields: ["status"] },
      { fields: ["taxYear"] },
      { fields: ["documentType"] },
    ],
    // Soft delete, same reasoning as the other four pipelines' paranoid:
    // true -- a deleted document disappears from every normal query
    // without erasing its audit trail, and documentUsage.js's cap count
    // deliberately opts back in to seeing it (still consumed OCR/LLM
    // budget at upload time).
    paranoid: true,
  }
);
