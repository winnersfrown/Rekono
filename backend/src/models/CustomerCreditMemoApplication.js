import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Records that (part of) a credit memo has been used to offset a specific
// invoice's outstanding balance. This is bookkeeping for the AR sub-ledger
// only -- it posts no journal entry of its own, because issuing the credit
// memo already moved the general-ledger money (Debit revenue / Credit
// Accounts Receivable, see postCustomerCreditMemo). AR is one control
// account; which invoice a credit is "applied to" is purely a question of
// which specific receivable an aging report and a customer statement
// should show as reduced, the same way a payment says which invoice cash
// arrived against.
export const CustomerCreditMemoApplication = sequelize.define(
  "CustomerCreditMemoApplication",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerCreditMemoId: { type: DataTypes.STRING(32), allowNull: false },
    customerInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    appliedDate: { type: DataTypes.DATEONLY, allowNull: false },
  },
  {
    tableName: "customer_credit_memo_applications",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerCreditMemoId"] }, { fields: ["customerInvoiceId"] }],
  }
);
