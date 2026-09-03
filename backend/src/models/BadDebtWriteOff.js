import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Recognizes that a customer invoice's remaining balance will never be
// collected. Deliberately not a void: voiding reverses the original sale
// (Debit revenue / Credit AR) as though it never happened, but a bad debt
// write-off is the opposite claim -- the sale was real and already earned,
// only the collection failed. So it posts Debit Bad Debt Expense / Credit
// Accounts Receivable instead, leaving revenue exactly as billed.
//
// No status column and no void route: same reasoning CustomerPayment has
// neither on the AR side (unlike its AP counterpart, BillPayment) --
// correcting a mistaken write-off is rare enough that a manual journal
// entry is the right tool, not a dedicated undo UI.
export const BadDebtWriteOff = sequelize.define(
  "BadDebtWriteOff",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    writeOffDate: { type: DataTypes.DATEONLY, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "bad_debt_write_offs",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerInvoiceId"] }],
  }
);
