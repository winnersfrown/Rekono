import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Same status shape as Invoice (models/Invoice.js) -- the pipeline this
// runs through (queue -> OCR -> extract -> confidence-gate -> review) is
// the same shape, just a different document type and schema.
export const EXPENSE_RECEIPT_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence - fast-track review
  "needs_review", // low confidence - flagged
  "approved",
  "rejected",
  "failed",
];

// A fixed set rather than free text: lets the review UI offer a dropdown
// instead of a text field, and keeps reporting/export meaningful across an
// org's receipts instead of accumulating a long tail of one-off spellings.
// The extraction prompt (extractionReceipts.js) is given this exact list so
// the LLM classifies into it directly rather than inventing its own labels.
export const EXPENSE_CATEGORIES = [
  "Travel",
  "Meals & Entertainment",
  "Office Supplies",
  "Software & Subscriptions",
  "Utilities",
  "Professional Services",
  "Other",
];

export const ExpenseReceipt = sequelize.define(
  "ExpenseReceipt",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...EXPENSE_RECEIPT_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    merchantName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    receiptDate: { type: DataTypes.DATEONLY, allowNull: true },
    category: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    currency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "USD" },
    tax: { type: DataTypes.FLOAT, allowNull: true },
    amount: { type: DataTypes.FLOAT, allowNull: true },

    // Free-text note a submitter can attach (e.g. what the expense was for,
    // which client/project it bills to) -- nothing extraction fills in, a
    // human-entered field from the start, same as Invoice fields a human
    // corrects in review.
    note: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "expense_receipts",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }],
    // Soft delete, same reasoning as Invoice's own paranoid: true (see that
    // model's comment) -- a deleted receipt disappears from every normal
    // query without erasing its audit trail, and documentUsage.js's cap
    // count deliberately opts back in to seeing it (still consumed OCR/LLM
    // budget at upload time).
    paranoid: true,
  }
);
