import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One month's worth of a prepaid expense waiting to be consumed -- the AP
// mirror of RevenueScheduleEntry.js. A row per (prepaid expense, month)
// rather than a formula recomputed on read, for the same reason: the
// schedule is a plan someone can reconcile against, and once a month is
// amortized it carries the journal entry that did it.
export const PrepaidExpenseScheduleEntry = sequelize.define(
  "PrepaidExpenseScheduleEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    prepaidExpenseId: { type: DataTypes.STRING(32), allowNull: false },
    // Copied from the parent at creation, same reasoning
    // RevenueScheduleEntry.revenueAccountId is copied from its line: a
    // later edit can't silently redirect an already-scheduled month.
    expenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    // "YYYY-MM", matching ClosePeriod.periodMonth.
    periodMonth: { type: DataTypes.STRING(7), allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    // Null until the month is amortized. Set together with the journal
    // entry that moved it out of Prepaid Expenses.
    recognizedAt: { type: DataTypes.DATE, allowNull: true },
    journalEntryId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "prepaid_expense_schedule_entries",
    indexes: [
      { fields: ["orgId"] },
      { fields: ["prepaidExpenseId"] },
      { fields: ["orgId", "periodMonth"] },
    ],
  }
);
