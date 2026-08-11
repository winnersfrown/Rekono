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
  },
  {
    tableName: "invoices",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }],
  }
);
