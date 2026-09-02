import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A customer invoice that has to go out every period rather than once --
// the subscription/retainer billing case recurringEntries.js never covered,
// since that file only posts adjusting journal entries, not real AR
// invoices with an external effect (a customer actually gets billed).
//
// Modeled the same way as RecurringEntry: a template plus a schedule, not
// N future-dated invoices, so a pre-created invoice for next quarter can't
// show up in this month's aging report.
export const RECURRING_INVOICE_FREQUENCIES = ["monthly", "quarterly", "annually"];

export const RecurringInvoice = sequelize.define(
  "RecurringInvoice",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    frequency: { type: DataTypes.ENUM(...RECURRING_INVOICE_FREQUENCIES), allowNull: false, defaultValue: "monthly" },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The last period actually issued, as a date. Null until the first run.
    lastIssuedDate: { type: DataTypes.DATEONLY, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // If true, each occurrence is posted and sent immediately -- a real
    // receivable hits the books unattended. Left false by default: an AR
    // invoice bills an actual customer, which is a bigger consequence than
    // an internal adjusting entry, so the safer default is a draft a human
    // reviews before it goes out.
    autoSend: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "recurring_invoices",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerId"] }],
  }
);

// The template's lines. Same shape as CustomerInvoiceLine minus the
// service-period fields -- a recurring template bills the same flat
// amount each period, so deferred-revenue scheduling (which needs a
// concrete date range per occurrence) isn't offered here; add it as a
// real invoice line after the occurrence is created if a given period
// needs it.
export const RecurringInvoiceLine = sequelize.define(
  "RecurringInvoiceLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    recurringInvoiceId: { type: DataTypes.STRING(32), allowNull: false },
    revenueAccountId: { type: DataTypes.STRING(32), allowNull: false },
    description: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    quantity: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 1 },
    unitPriceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "recurring_invoice_lines",
    indexes: [{ fields: ["recurringInvoiceId"] }],
    timestamps: false,
  }
);
