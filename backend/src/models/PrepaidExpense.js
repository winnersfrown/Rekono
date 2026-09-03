import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Money paid up front for something consumed over time -- a year of
// insurance, a prepaid lease, an annual software license paid once. The AP
// mirror of revenueRecognition.js's deferred revenue: the cash left on day
// one, but the expense hasn't happened yet, which makes it an asset
// (Prepaid Expenses) until each month is actually consumed.
//
// Deliberately its own record rather than something layered onto the
// existing bill-approval pipeline (postInvoiceApproval, ledger.js) -- that
// function is called from four different approval paths with no per-bill
// input today, and threading a "is this prepaid, and over what period"
// question through all of them would touch the single most heavily-used
// routine in AP for a case that's the exception, not the rule. A prepaid
// expense is recorded directly, the same way recurringEntries.js's
// adjusting entries live outside the invoice pipeline rather than inside
// it.
export const PREPAID_EXPENSE_STATUSES = ["active", "void"];

export const PrepaidExpense = sequelize.define(
  "PrepaidExpense",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    vendorName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // Where the cost lands each month once amortized -- copied onto each
    // schedule row at creation, same reasoning RevenueScheduleEntry copies
    // revenueAccountId off its line.
    expenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    // Where the cash left from when the prepayment was made.
    paymentAccountId: { type: DataTypes.STRING(32), allowNull: false },
    paymentDate: { type: DataTypes.DATEONLY, allowNull: false },
    totalCents: { type: DataTypes.INTEGER, allowNull: false },
    serviceStartDate: { type: DataTypes.DATEONLY, allowNull: false },
    serviceEndDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM(...PREPAID_EXPENSE_STATUSES), allowNull: false, defaultValue: "active" },
  },
  {
    tableName: "prepaid_expenses",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }],
  }
);
