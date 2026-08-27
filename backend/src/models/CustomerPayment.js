import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Cash received against a customer invoice. Its own table rather than an
// amountPaid column on the invoice, because partial payments are normal
// in AR and each one is a separate dated event that posts its own journal
// entry (Debit the deposit account / Credit Accounts Receivable). A
// running total on the invoice couldn't say *when* cash arrived, which is
// exactly what the cash flow statement needs.
export const CustomerPayment = sequelize.define(
  "CustomerPayment",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    // Which cash/bank account the money landed in -- an org with more than
    // one bank account needs to say, and the cash flow statement keys off
    // the account's own subtype to recognize it as cash.
    depositAccountId: { type: DataTypes.STRING(32), allowNull: false },
    paymentDate: { type: DataTypes.DATEONLY, allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "customer_payments",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerInvoiceId"] }],
  }
);
