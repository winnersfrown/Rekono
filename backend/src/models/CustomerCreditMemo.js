import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A credit issued to a customer -- a return, a billing error, or a
// goodwill adjustment -- that reduces what they owe. Posted immediately
// on creation rather than going through a draft stage the way
// CustomerInvoice does: unlike an invoice, which commits future revenue a
// business plans before sending, a credit memo exists because something
// already billed needs correcting, so there's no "not on the books yet"
// state worth modeling.
//
// It is its own document with its own line items and revenue accounts,
// not a reversal of specific invoice lines -- the same simplification
// real AR software makes, since by the time a credit is cut the original
// invoice may be long since partially paid or its lines partly earned.
// One consequence: crediting a line that was originally deferred revenue
// still credits the revenue account directly rather than unwinding the
// deferred-revenue schedule -- see accountsReceivable.js's
// postCustomerCreditMemo for why that's the right call rather than a gap.
export const CUSTOMER_CREDIT_MEMO_STATUSES = ["issued", "void"];

export const CustomerCreditMemo = sequelize.define(
  "CustomerCreditMemo",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerId: { type: DataTypes.STRING(32), allowNull: false },
    // Sequential per org (CM-0001, ...), same numbering scheme as
    // invoices -- see accountsReceivable.js's nextCreditMemoNumber.
    creditNumber: { type: DataTypes.STRING(64), allowNull: false },
    issueDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM(...CUSTOMER_CREDIT_MEMO_STATUSES), allowNull: false, defaultValue: "issued" },
    totalCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    taxCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "customer_credit_memos",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerId"] }, { fields: ["status"] }],
  }
);
