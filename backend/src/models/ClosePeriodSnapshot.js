import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A frozen trial balance, taken at the moment a period is closed (and again
// at every re-close). Closing itself has always been a human attestation
// with nothing behind it but that attestation -- close automation
// (closeAutomation.js) can say what a month is *missing*, but not what the
// books actually said the moment someone signed off on them. Without this,
// reopening a period and closing it again leaves no record of what changed:
// the new close just overwrites the only frozen picture that ever existed,
// which was none.
//
// One row per close, not one row per period -- a period can be reopened and
// re-closed any number of times (a late adjusting entry is the routine
// reason), and each of those is its own attestation worth keeping. History
// is what makes the after-the-fact question ("what did we restate, and by
// how much") answerable at all.
export const ClosePeriodSnapshot = sequelize.define(
  "ClosePeriodSnapshot",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    closePeriodId: { type: DataTypes.STRING(32), allowNull: false },
    // Denormalized from the parent period, same reasoning as CloseTask.orgId.
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // The trial balance's as-of date: the last calendar day of the period
    // month, independent of which day the close button was actually clicked.
    asOfDate: { type: DataTypes.DATEONLY, allowNull: false },
    // Mirrors ClosePeriod.closedAt/closedBy at the moment this snapshot was
    // taken -- kept alongside the period's own fields (rather than only
    // joined through it) because the period's fields move to the *latest*
    // close on every re-close, while a snapshot's own closedAt/closedBy must
    // stay pinned to the close that produced it.
    closedAt: { type: DataTypes.DATE, allowNull: false },
    closedBy: { type: DataTypes.STRING(256), allowNull: true },
    // Array of { account_id, code, name, type, debit_cents, credit_cents },
    // one row per account with any activity as of asOfDate. Integer cents,
    // per this repo's ledger convention -- computeTrialBalance's own return
    // shape is dollars for direct API display, so the close route converts
    // before storing here.
    accounts: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    totalDebitCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    totalCreditCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    balanced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "close_period_snapshots",
    updatedAt: false,
    createdAt: "createdAt",
    indexes: [{ fields: ["orgId"] }, { fields: ["closePeriodId"] }],
  }
);
