import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Learned from human corrections to a transaction's category (see
// routes/transactions.js), the same shape and reasoning as VendorAlias and
// VendorExpenseAccount: once someone decides that "BLUE BOTTLE COFFEE"
// is Meals & Entertainment, every future transaction from that merchant
// takes the category directly instead of asking the model again.
//
// This is what makes categorization get cheaper and more accurate the
// longer an org uses it: the LLM is only ever consulted for merchants
// nobody has ruled on yet, so a mature account resolves most of a
// statement with zero API calls.
export const MerchantCategory = sequelize.define(
  "MerchantCategory",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Already normalized by transactionCategorization.js's
    // normalizeMerchant at write time, so lookups are a plain equality
    // match with no per-query normalization -- same approach as
    // VendorAlias.rawVendorName.
    merchantKey: { type: DataTypes.STRING(512), allowNull: false },
    category: { type: DataTypes.STRING(64), allowNull: false },
  },
  {
    tableName: "merchant_categories",
    updatedAt: true,
    indexes: [{ fields: ["orgId", "merchantKey"], unique: true }],
  }
);
