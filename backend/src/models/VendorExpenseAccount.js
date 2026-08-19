import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Learned from human corrections to a pushed invoice's suggested QuickBooks
// expense account (see routes/integrations.js), same shape and reasoning as
// VendorAlias: once someone corrects (or confirms) which account a vendor's
// invoices belong under, that choice is remembered per org+vendor so future
// invoices from the same vendor suggest it directly instead of asking the
// LLM (or the user) again every time.
export const VendorExpenseAccount = sequelize.define(
  "VendorExpenseAccount",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Trimmed + lowercased at write time, same as VendorAlias.rawVendorName
    // -- lookups are a plain equality match, no per-query normalization.
    vendorName: { type: DataTypes.STRING(512), allowNull: false },
    expenseAccountId: { type: DataTypes.STRING(64), allowNull: false },
    expenseAccountName: { type: DataTypes.STRING(256), allowNull: false },
  },
  {
    tableName: "vendor_expense_accounts",
    updatedAt: true,
    indexes: [{ fields: ["orgId", "vendorName"], unique: true }],
  }
);
