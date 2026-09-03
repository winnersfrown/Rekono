import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One statement period's worth of tying a cash account's book balance to
// what the bank actually reports. "open" while a human is still ticking
// off cleared lines; "completed" once they attest it's done -- same
// posture as ClosePeriod, an attestation rather than an enforced gate, so
// completing one doesn't stop later entries from landing on the account.
export const BANK_RECONCILIATION_STATUSES = ["open", "completed"];

export const BankReconciliation = sequelize.define(
  "BankReconciliation",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    cashAccountId: { type: DataTypes.STRING(32), allowNull: false },
    statementDate: { type: DataTypes.DATEONLY, allowNull: false },
    // What the bank says the account held on statementDate -- entered by a
    // human off the paper or PDF statement, never derived: the whole point
    // of a reconciliation is comparing an outside source to the ledger.
    statementEndingBalanceCents: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM(...BANK_RECONCILIATION_STATUSES),
      allowNull: false,
      defaultValue: "open",
    },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "bank_reconciliations",
    indexes: [{ fields: ["orgId"] }, { fields: ["cashAccountId"] }],
  }
);

// Which journal lines a human has ticked off as appearing on this
// statement. A separate join table rather than a column on JournalLine --
// ledger.js's lines are immutable once posted, and "cleared" is
// reconciliation bookkeeping, not a fact about the entry itself. The
// unique index on journalLineId means a line can only ever belong to one
// reconciliation, ever: once a completed reconciliation has claimed it,
// it can't be pulled into a different one later.
export const ReconciledJournalLine = sequelize.define(
  "ReconciledJournalLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    reconciliationId: { type: DataTypes.STRING(32), allowNull: false },
    journalLineId: { type: DataTypes.STRING(32), allowNull: false },
    clearedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "reconciled_journal_lines",
    updatedAt: false,
    indexes: [
      { fields: ["orgId"] },
      { fields: ["reconciliationId"] },
      { fields: ["journalLineId"], unique: true },
    ],
  }
);
