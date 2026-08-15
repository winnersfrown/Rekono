import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const INVOICE_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence, cross-check passed - fast-track review
  "needs_review", // low confidence or failed cross-check - flagged
  "approved",
  "rejected",
  "failed",
];

export const Invoice = sequelize.define(
  "Invoice",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...INVOICE_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    vendorName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    invoiceNumber: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    invoiceDate: { type: DataTypes.DATEONLY, allowNull: true },
    dueDate: { type: DataTypes.DATEONLY, allowNull: true },
    currency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "USD" },
    poReference: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },

    subtotal: { type: DataTypes.FLOAT, allowNull: true },
    tax: { type: DataTypes.FLOAT, allowNull: true },
    total: { type: DataTypes.FLOAT, allowNull: true },

    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    crossCheckPassed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    crossCheckDetail: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    // Set when a same-org invoice with the same vendor + invoice number
    // already exists (see pipeline.js's findDuplicateInvoice) -- a likely
    // double-upload/double-payment risk, not an extraction quality issue,
    // so it forces review independent of confidence. Denormalized filename
    // (rather than a join at read time) since it's just a stable one-line
    // display hint, not data anything else derives from.
    duplicateOfInvoiceId: { type: DataTypes.STRING(32), allowNull: true },
    duplicateOfFilename: { type: DataTypes.STRING(512), allowNull: true },

    // Self-reported by extraction.js (LLM) or a distinct-invoice-number
    // heuristic (no API key) -- the document may contain more than one
    // invoice, which extraction only ever captures one of. Forces review
    // independent of confidence, same reasoning as duplicateOf* above.
    possibleMultiInvoice: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    possibleMultiInvoiceReason: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  },
  {
    tableName: "invoices",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }],
    // Soft delete (adds a nullable `deletedAt` column): a deleted invoice
    // disappears from every normal query (list, detail, matching, export,
    // the AI assistant's dataset, duplicate detection) without physically
    // removing the row -- its LineItems/MatchResults/AuditLog entries stay
    // intact in the database, since routes/invoices.js's DELETE handler
    // doesn't destroy them, only the parent. That preserves this app's
    // audit-trail guarantee even for a deleted document. The one place that
    // deliberately does NOT respect this default (documentUsage.js's
    // monthly count) opts back in to seeing soft-deleted rows on purpose --
    // see the comment there.
    paranoid: true,
  }
);
