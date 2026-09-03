import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One fiscal year's spending/revenue plan for an org, set against the
// same revenue and expense accounts the P&L reports on -- "budget vs
// actual" is a straight comparison against real accounts, never a
// parallel category system that has to be kept in sync with the chart of
// accounts by hand.
//
// Keyed by the fiscal year's *end* year (the "2026" in "FY2026", same
// naming fiscalYear.js's fiscalYearFor uses) rather than a raw calendar
// year, so a budget for an org with a non-December year-end still means
// one thing.
export const Budget = sequelize.define(
  "Budget",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    fiscalYearEndYear: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    createdByUserId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "budgets",
    indexes: [{ fields: ["orgId"] }, { fields: ["orgId", "fiscalYearEndYear"], unique: true }],
  }
);

// One account's target for one calendar month within its budget's fiscal
// year. Monthly rather than one annual figure per account so a seasonal
// business can shape its plan -- budget.js's quick-entry endpoint splits
// an annual figure evenly across the months as a starting point, but the
// stored shape is always monthly.
export const BudgetLine = sequelize.define(
  "BudgetLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    budgetId: { type: DataTypes.STRING(32), allowNull: false },
    accountId: { type: DataTypes.STRING(32), allowNull: false },
    periodMonth: { type: DataTypes.STRING(7), allowNull: false }, // "YYYY-MM"
    amountCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "budget_lines",
    indexes: [{ fields: ["budgetId"] }, { fields: ["budgetId", "accountId", "periodMonth"], unique: true }],
  }
);
