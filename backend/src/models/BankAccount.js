// One real bank/credit account underneath a BankConnection (Plaid Item) --
// a single login can expose several of these (checking + savings at the
// same bank). This is the entity a bank statement's transactions get
// synced into (see plaid.js's syncTransactions) for the Matching /
// Reconciliation engine to match against, distinct from Account.js's
// chart-of-accounts ledger entries: this table is "what Plaid told us
// about a real external account," not a posting target.

import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const BankAccount = sequelize.define(
  "BankAccount",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    connectionId: { type: DataTypes.STRING(32), allowNull: false },

    plaidAccountId: { type: DataTypes.STRING(128), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    officialName: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    // Last 4 digits -- the only part of the real account number Plaid
    // exposes and the only part worth showing in the UI, same reasoning as
    // TaxDocument.js truncating TINs to last-4: there's no legitimate need
    // for more, and showing more would just be a bigger liability if this
    // database were ever compromised.
    mask: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "" },
    // Plaid's own type/subtype ("depository"/"checking", "credit"/"credit
    // card", ...) -- kept as Plaid reports it rather than mapped onto
    // Account.js's asset/liability enum, since this table describes a real
    // external account, not a ledger posting target.
    accountType: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    accountSubtype: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },

    currentBalance: { type: DataTypes.FLOAT, allowNull: true },
    availableBalance: { type: DataTypes.FLOAT, allowNull: true },
    currency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "USD" },

    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },

    // The MatchSource (sourceType "bank") this account's synced
    // transactions land in as MatchEntry rows -- created once on first
    // sync, reused on every later one, so a Plaid-connected account
    // behaves exactly like an uploaded bank-statement CSV to the existing
    // matching engine instead of needing a second reconciliation path.
    matchSourceId: { type: DataTypes.STRING(32), allowNull: true },
  },
  { tableName: "bank_accounts", indexes: [{ fields: ["orgId"] }, { fields: ["connectionId"] }] }
);
