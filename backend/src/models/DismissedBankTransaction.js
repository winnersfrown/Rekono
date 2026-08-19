import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A user's explicit "not a match" on a QuickBooks bank/card transaction
// surfaced for reconciliation (see routes/integrations.js's dismiss route).
// Without this, a transaction that doesn't match any pushed bill would keep
// resurfacing on every reload -- Rekono has no other way to tell "already
// reviewed, not relevant" apart from "not reviewed yet", since the
// transaction itself lives in QuickBooks, not this database.
export const DismissedBankTransaction = sequelize.define(
  "DismissedBankTransaction",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    quickbooksTransactionId: { type: DataTypes.STRING(64), allowNull: false },
  },
  {
    tableName: "dismissed_bank_transactions",
    indexes: [{ fields: ["orgId", "quickbooksTransactionId"], unique: true }],
  }
);
