import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Records that (part of) a vendor credit memo has been used to offset a
// specific bill's outstanding balance. The AP mirror of
// CustomerCreditMemoApplication.js, and for the same reason posts no
// journal entry of its own: issuing the credit memo already moved the
// general-ledger money (Debit Accounts Payable / Credit the expense
// account, see postVendorCreditMemo). Accounts Payable is one control
// account; which bill a credit is "applied to" is purely bookkeeping for
// the AP sub-ledger and the aging report, the same relationship a bill
// payment has to the bill it's recorded against.
export const VendorCreditMemoApplication = sequelize.define(
  "VendorCreditMemoApplication",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    vendorCreditMemoId: { type: DataTypes.STRING(32), allowNull: false },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    appliedDate: { type: DataTypes.DATEONLY, allowNull: false },
  },
  {
    tableName: "vendor_credit_memo_applications",
    indexes: [{ fields: ["orgId"] }, { fields: ["vendorCreditMemoId"] }, { fields: ["invoiceId"] }],
  }
);
