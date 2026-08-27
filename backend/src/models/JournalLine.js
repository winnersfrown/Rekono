import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Amounts are stored as integer cents, not FLOAT (the rest of this app's
// money fields, e.g. Invoice.total) and not DECIMAL either. FLOAT's
// rounding error is a real problem specifically here, where debits have to
// sum to *exactly* credits, not just "close enough to display". DECIMAL
// would fix that on Postgres but Sequelize's SQLite dialect (this app's
// test/local default) can hand DECIMAL columns back as strings depending
// on the value, which would silently break the sum(debit) === sum(credit)
// arithmetic ledger.js relies on -- integer cents behaves identically on
// both dialects with no parsing required. ledger.js's
// dollarsToCents/centsToDollars convert at the boundary with the rest of
// the app's dollar-float fields.
export const JournalLine = sequelize.define(
  "JournalLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    journalEntryId: { type: DataTypes.STRING(32), allowNull: false },
    accountId: { type: DataTypes.STRING(32), allowNull: false },
    debitCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    creditCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "journal_lines",
    indexes: [{ fields: ["journalEntryId"] }, { fields: ["accountId"] }],
    // A line never changes after its entry posts -- see JournalEntry's own
    // comment on why corrections are reversing entries, not edits.
    timestamps: false,
  }
);
