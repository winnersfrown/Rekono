import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Same status shape as Invoice/ExpenseReceipt/VendorDocument -- the
// pipeline this runs through (queue -> OCR -> extract -> confidence-gate
// -> review) is the same shape, just a fourth document type and schema.
export const LEASE_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence - fast-track review
  "needs_review", // low confidence - flagged
  "approved",
  "rejected",
  "failed",
];

export const Lease = sequelize.define(
  "Lease",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...LEASE_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    landlordName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    propertyAddress: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    commencementDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The field the whole module exists for, same reasoning as
    // VendorDocument's own expirationDate: this is what the
    // expiring-soon filter and the frontend's status badge key off of.
    expirationDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The single costliest date to miss in lease management: the deadline
    // to notify the landlord in order to exercise a renewal option. Miss
    // it and the option lapses even though the lease itself hasn't
    // expired yet -- tracked as its own field rather than folded into
    // expirationDate, since the two can be months or years apart.
    renewalNoticeDeadline: { type: DataTypes.DATEONLY, allowNull: true },
    monthlyRent: { type: DataTypes.FLOAT, allowNull: true },
    annualEscalationPct: { type: DataTypes.FLOAT, allowNull: true },

    // Free-text note a submitter can attach -- nothing extraction fills
    // in, a human-entered field from the start, same as the other three
    // pipelines' note field.
    note: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "leases",
    indexes: [
      { fields: ["orgId"] },
      { fields: ["status"] },
      { fields: ["expirationDate"] },
      { fields: ["renewalNoticeDeadline"] },
    ],
    // Soft delete, same reasoning as the other three pipelines' paranoid:
    // true -- a deleted lease disappears from every normal query without
    // erasing its audit trail, and documentUsage.js's cap count
    // deliberately opts back in to seeing it (still consumed OCR/LLM
    // budget at upload time).
    paranoid: true,
  }
);
