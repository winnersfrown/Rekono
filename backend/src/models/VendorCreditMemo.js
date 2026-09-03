import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A credit a vendor issues against what we owe them -- a return, a billing
// error, or a goodwill adjustment. The AP mirror of CustomerCreditMemo.js.
// Posted immediately on creation, same reasoning as the AR side: something
// already billed needs correcting, so there's no "not on the books yet"
// draft stage worth modeling.
//
// Unlike CustomerCreditMemo, there's no line-item sub-table: postInvoiceApproval
// (ledger.js) has never split an approved bill's total across more than one
// expense account, so a credit against that bill mirrors the same shape --
// one flat amount and one expense account -- rather than modeling a line
// breakdown the ledger would ignore anyway (see RecurringBill.js, which made
// the identical call for the same reason).
export const VENDOR_CREDIT_MEMO_STATUSES = ["issued", "void"];

export const VendorCreditMemo = sequelize.define(
  "VendorCreditMemo",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Free text, same as Invoice.vendorName and RecurringBill.vendorName --
    // resolved to a real Vendor identity at read time, not stored as a
    // foreign key here.
    vendorName: { type: DataTypes.STRING(512), allowNull: false },
    expenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    // Sequential per org (VCM-0001, ...), same derivation-from-history
    // approach as nextCreditMemoNumber on the AR side.
    creditNumber: { type: DataTypes.STRING(64), allowNull: false },
    issueDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM(...VENDOR_CREDIT_MEMO_STATUSES), allowNull: false, defaultValue: "issued" },
    amountCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "vendor_credit_memos",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }],
  }
);
