import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A single bank/card line from an uploaded statement, with the expense
// category it was assigned to. Separate from MatchEntry (which also holds
// bank rows) on purpose: a MatchEntry exists to be reconciled against an
// invoice and is owned by the MatchSource it was uploaded in, whereas a
// Transaction is a standing record that gets categorized, corrected, and
// reported on. Conflating them would mean deleting a matching source also
// destroys categorization work that has nothing to do with matching.
export const Transaction = sequelize.define(
  "Transaction",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    postedDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The raw statement descriptor, kept verbatim ("SQ *BLUE BOTTLE 1234
    // SAN FRANCISCOCA") so the UI can show exactly what the bank sent.
    description: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // The normalized form the learned-category lookup keys on -- see
    // transactionCategorization.js's normalizeMerchant. Stored rather than
    // recomputed per query so a lookup stays a plain equality match.
    merchantKey: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    amount: { type: DataTypes.FLOAT, allowNull: true },

    // "" until categorized. One of ExpenseReceipt's EXPENSE_CATEGORIES, so
    // a transaction and a receipt for the same spend land in the same
    // bucket rather than two parallel taxonomies.
    category: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    categoryConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    // How the category was arrived at: "learned" (a human already decided
    // this merchant), "ai", "heuristic", or "manual". Worth recording
    // separately from confidence because it changes what a reviewer should
    // do -- a "learned" category was already someone's decision, an "ai"
    // one is still a guess no matter how confident the model claimed to be.
    categorySource: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "" },
    // Set once a human has explicitly accepted or corrected the category.
    reviewedAt: { type: DataTypes.DATE, allowNull: true },

    rawRow: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  },
  {
    tableName: "transactions",
    updatedAt: false,
    createdAt: "createdAt",
    indexes: [{ fields: ["orgId"] }, { fields: ["orgId", "merchantKey"] }, { fields: ["category"] }],
    // Soft delete, same reasoning as the document models: a deleted
    // transaction disappears from every normal query without erasing the
    // categorization history behind it.
    paranoid: true,
  }
);
