import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Same status shape as Invoice/ExpenseReceipt -- the pipeline this runs
// through (queue -> OCR -> extract -> confidence-gate -> review) is the
// same shape, just a third document type and schema. "approved" here means
// "verified and filed"; "rejected" means "not a valid/usable document" --
// same review vocabulary reused rather than inventing a compliance-specific
// one, so the frontend queue/detail patterns carry over unchanged.
export const VENDOR_DOCUMENT_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence - fast-track review
  "needs_review", // low confidence - flagged
  "approved",
  "rejected",
  "failed",
];

// A fixed set rather than free text, same reasoning as ExpenseReceipt's
// EXPENSE_CATEGORIES -- lets the review UI offer a dropdown, keeps
// reporting/export meaningful, and gives the extraction prompt
// (extractionVendorDocs.js) a fixed list to classify into directly.
export const VENDOR_DOCUMENT_TYPES = ["W-9", "Certificate of Insurance", "Contract", "Other"];

export const VendorDocument = sequelize.define(
  "VendorDocument",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...VENDOR_DOCUMENT_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    vendorName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    documentType: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    effectiveDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The field the whole module exists for: a W-9 rarely has one, a
    // certificate of insurance or contract usually does -- this is what
    // routes/vendorDocuments.js's expiring-soon filter and the frontend's
    // status badge key off of.
    expirationDate: { type: DataTypes.DATEONLY, allowNull: true },
    // TIN/EIN on a W-9, policy number on a COI, contract number on a
    // contract -- one generic field rather than three type-specific
    // columns that are each blank two-thirds of the time.
    referenceNumber: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    // Coverage amount (COI) or contract value -- null for a W-9, where it
    // doesn't apply.
    amount: { type: DataTypes.FLOAT, allowNull: true },

    // Free-text note a submitter can attach -- nothing extraction fills
    // in, a human-entered field from the start, same as the other two
    // pipelines' note field.
    note: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "vendor_documents",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }, { fields: ["expirationDate"] }],
    // Soft delete, same reasoning as Invoice/ExpenseReceipt's paranoid:
    // true -- a deleted document disappears from every normal query
    // without erasing its audit trail, and documentUsage.js's cap count
    // deliberately opts back in to seeing it (still consumed OCR/LLM
    // budget at upload time).
    paranoid: true,
  }
);
