import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One billable line on a customer invoice. Each line names its own
// revenue account, which is how real AR works -- a single invoice can
// bill consulting and software against different income accounts, and
// that split is what makes the P&L's revenue section meaningful rather
// than one undifferentiated lump.
export const CustomerInvoiceLine = sequelize.define(
  "CustomerInvoiceLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    customerInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    revenueAccountId: { type: DataTypes.STRING(32), allowNull: false },
    description: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    quantity: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 1 },
    unitPriceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Stored rather than computed from quantity * unitPrice: rounding a
    // fractional quantity (1.5 hours at $99.99) has to land on exactly one
    // integer-cent answer, and recomputing it at read time risks a
    // different rounding than the one the journal entry was posted with.
    amountCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // When this line is delivered over time rather than at a point in
    // time. Both set -> the line is billed up front but earned across the
    // period, so it credits Deferred Revenue and releases monthly (see
    // revenueRecognition.js). Both null -> earned when billed, credits
    // revenue directly, which is what every line did before v1.26.
    serviceStartDate: { type: DataTypes.DATEONLY, allowNull: true },
    serviceEndDate: { type: DataTypes.DATEONLY, allowNull: true },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "customer_invoice_lines",
    indexes: [{ fields: ["customerInvoiceId"] }],
    timestamps: false,
  }
);
