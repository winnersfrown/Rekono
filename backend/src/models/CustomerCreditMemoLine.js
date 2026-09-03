import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One line of a credit memo -- which revenue account is being credited
// back and how much. Same shape as CustomerInvoiceLine, minus the
// service-period fields: a credit memo doesn't create or adjust a
// deferred-revenue schedule (see CustomerCreditMemo.js's comment), so
// there's nothing here for revenueRecognition.js to read.
export const CustomerCreditMemoLine = sequelize.define(
  "CustomerCreditMemoLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    customerCreditMemoId: { type: DataTypes.STRING(32), allowNull: false },
    revenueAccountId: { type: DataTypes.STRING(32), allowNull: false },
    description: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    amountCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Whether this line's amount counts toward the memo's sales tax
    // credit -- same meaning and default as CustomerInvoiceLine.taxable.
    taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "customer_credit_memo_lines",
    indexes: [{ fields: ["customerCreditMemoId"] }],
    timestamps: false,
  }
);
