import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// The 5 fundamental account types -- every other classification (subtype)
// is just detail layered on top of one of these, and which side of a
// journal entry is "normal" for an account is derived from this rather
// than stored separately: asset/expense increase on the debit side,
// liability/equity/revenue increase on the credit side.
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"];

export const Account = sequelize.define(
  "Account",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Traditional bookkeeping numbering (1000s=asset, 2000s=liability, ...)
    // -- optional on a manually-created account, auto-assigned on the
    // seeded defaults (ledger.js's seedDefaultChartOfAccounts).
    code: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "" },
    name: { type: DataTypes.STRING(256), allowNull: false },
    type: { type: DataTypes.ENUM(...ACCOUNT_TYPES), allowNull: false },
    // Free string rather than an enum -- statement classification (which
    // subtypes roll up into "current assets" vs "fixed assets" on a real
    // balance sheet) is a later phase's concern, not enforced yet.
    subtype: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    // Protects the seeded defaults (Cash, Accounts Payable, ...) other code
    // posts to automatically -- deleting "Accounts Payable" out from under
    // the invoice-approval auto-posting logic would silently break it.
    isSystemAccount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Accounts are deactivated, never deleted -- a posted JournalLine's
    // accountId always has to resolve, even years later.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "accounts",
    indexes: [{ fields: ["orgId"] }, { fields: ["type"] }],
  }
);
