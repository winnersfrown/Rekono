import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One month's worth of revenue waiting to be earned, for one invoice line.
//
// When a customer is billed up front for something delivered over time (an
// annual subscription, a support retainer, a 6-month engagement), the cash
// and the receivable are real on day one but the revenue is not -- it's
// owed as service, which makes it a liability (deferred revenue) until
// each month is actually delivered. ASC 606 in the shape that matters for
// a subscription business: recognize over the period you perform, not the
// period you bill.
//
// A row per (line, month) rather than a formula recomputed on read, for
// the same reason financial statements are derived but journal entries are
// stored: the schedule is a *plan* someone can look at and reconcile
// against, and once a month is recognized it carries the journal entry
// that did it. Recomputing would silently rewrite history the first time a
// rounding rule changed.
export const RevenueScheduleEntry = sequelize.define(
  "RevenueScheduleEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    customerInvoiceLineId: { type: DataTypes.STRING(32), allowNull: false },
    // The revenue account this month's share lands in when recognized --
    // copied from the line so a later edit to the line can't silently
    // redirect revenue that was already scheduled.
    revenueAccountId: { type: DataTypes.STRING(32), allowNull: false },
    // "YYYY-MM", matching ClosePeriod.periodMonth so the two line up.
    periodMonth: { type: DataTypes.STRING(7), allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    // Null until the month is recognized. Set together with the journal
    // entry that moved it out of deferred revenue, so "has this been
    // recognized" and "what posted it" can never disagree.
    recognizedAt: { type: DataTypes.DATE, allowNull: true },
    journalEntryId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "revenue_schedule_entries",
    indexes: [
      { fields: ["orgId"] },
      { fields: ["customerInvoiceId"] },
      { fields: ["customerInvoiceLineId"] },
      { fields: ["orgId", "periodMonth"] },
    ],
  }
);
