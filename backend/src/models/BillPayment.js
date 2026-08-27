import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Cash paid out against an approved vendor bill -- the AP mirror of
// CustomerPayment. Its own table for the same reasons: partial payments
// are normal, and each one is a separate dated event that posts its own
// journal entry (Debit Accounts Payable / Credit the account the money
// left from). A paidAt timestamp on Invoice couldn't express a partial
// payment, and couldn't say which bank account the money came out of.
//
// Deliberately separate from Invoice.quickbooksPaidAt, which records that
// QuickBooks' own bank feed matched a transaction to this bill. That's a
// fact about the QuickBooks integration; this is a fact about Rekono's
// ledger. Confirming a QuickBooks bank match creates one of these too (see
// routes/integrations.js), so the two stay in step without one pretending
// to be the other.
export const BillPayment = sequelize.define(
  "BillPayment",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    // Which account the money left from -- a bank account normally, but a
    // credit card is just as valid (paying a bill with a card moves the
    // liability rather than the cash, and the ledger handles that fine).
    paymentAccountId: { type: DataTypes.STRING(32), allowNull: false },
    paymentDate: { type: DataTypes.DATEONLY, allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "bill_payments",
    indexes: [{ fields: ["orgId"] }, { fields: ["invoiceId"] }],
  }
);
