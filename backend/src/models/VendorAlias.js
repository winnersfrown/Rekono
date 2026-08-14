import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Learned from human corrections (see routes/invoices.js's PATCH handler):
// whenever someone corrects a vendor name, the originally-extracted text is
// remembered as an alias for the corrected canonical name, scoped to the
// org. pipeline.js applies known aliases to future extractions so the same
// OCR misread/inconsistent vendor name doesn't need re-correcting every
// time the same vendor's invoices come in.
export const VendorAlias = sequelize.define(
  "VendorAlias",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Trimmed + lowercased at write time so lookups are a plain equality
    // match -- no per-query normalization, no dialect-specific case-folding.
    rawVendorName: { type: DataTypes.STRING(512), allowNull: false },
    canonicalVendorName: { type: DataTypes.STRING(512), allowNull: false },
  },
  {
    tableName: "vendor_aliases",
    updatedAt: true,
    indexes: [{ fields: ["orgId", "rawVendorName"], unique: true }],
  }
);
