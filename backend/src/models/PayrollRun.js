import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One employee's pay for one pay period -- deliberately a manual-entry
// record, not a tax-withholding calculator. Rekono records the numbers a
// real payroll provider (or a spreadsheet) already computed and posts the
// correct journal entry from them; it never derives federal/state/FICA
// withholding itself. That calculation is a large, ever-changing
// compliance surface (federal tables change yearly, 50 states differ) that
// dedicated payroll providers charge specifically to maintain -- same
// reasoning this app records a QuickBooks bank match instead of trying to
// reimplement bank-feed categorization.
//
// The entry this posts:
//   Debit  Wages Expense              = grossWages
//   Debit  Payroll Tax Expense        = employer's own share (match + SUTA/FUTA)
//   Credit Cash/bank (paymentAccount) = net pay actually disbursed
//   Credit Payroll Liabilities        = everything withheld/owed but not yet
//                                        remitted (employee withholding +
//                                        deductions + the employer's own share)
// which balances by construction: net pay + liabilities == gross wages +
// employer taxes, since net pay is gross wages minus everything withheld.
export const PayrollRun = sequelize.define(
  "PayrollRun",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    employeeId: { type: DataTypes.STRING(32), allowNull: false },
    payDate: { type: DataTypes.DATEONLY, allowNull: false },

    grossWagesCents: { type: DataTypes.INTEGER, allowNull: false },

    // Employee-side withholding -- reduces net pay, owed to someone else
    // (the IRS, the state, the benefits provider) until remitted.
    federalTaxWithheldCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    stateTaxWithheldCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ficaEmployeeWithheldCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Benefits/retirement/garnishments -- anything else withheld from the
    // employee's pay that isn't a tax.
    otherDeductionsCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Employer-side cost -- never touches the employee's pay, but is a
    // real expense of running payroll (the employer's own FICA match, plus
    // unemployment tax).
    employerFicaMatchCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    employerUnemploymentTaxCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Accounts this run posts against -- picked per run rather than
    // assumed, same reasoning BillPayment.paymentAccountId is picked per
    // payment: nothing in the default chart of accounts is seeded
    // specifically for payroll, so there's nothing safe to assume.
    paymentAccountId: { type: DataTypes.STRING(32), allowNull: false },
    wagesExpenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    payrollTaxExpenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    liabilityAccountId: { type: DataTypes.STRING(32), allowNull: false },

    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "payroll_runs",
    indexes: [{ fields: ["orgId"] }, { fields: ["employeeId"] }],
  }
);
