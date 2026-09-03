import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A vendor bill that has to be booked every period rather than once -- the
// AP mirror of RecurringInvoice.js. Rent, a SaaS subscription, a retainer
// paid to a contractor: all recur on a fixed schedule and all had to be
// keyed into the Review Queue by hand every period before this, with every
// chance that implies to forget a month or bill the wrong amount.
//
// Unlike RecurringInvoice, there's no line-item sub-table: postInvoiceApproval
// (ledger.js) posts an approved bill's *total* to a single resolved expense
// account -- it has never split one bill across several accounts -- so a
// template mirrors that shape with one flat amount and one expense account
// rather than modeling a line breakdown the ledger would ignore anyway.
export const RECURRING_BILL_FREQUENCIES = ["monthly", "quarterly", "annually"];

export const RecurringBill = sequelize.define(
  "RecurringBill",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // Free text, same as Invoice.vendorName -- resolved to a real Vendor
    // identity at read time (AP aging) and at approval time
    // (attachVendorToInvoice), not stored as a foreign key here. A template
    // created before a Vendor record exists for this name still works.
    vendorName: { type: DataTypes.STRING(512), allowNull: false },
    expenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    frequency: { type: DataTypes.ENUM(...RECURRING_BILL_FREQUENCIES), allowNull: false, defaultValue: "monthly" },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The last period actually issued, as a date. Null until the first run.
    lastIssuedDate: { type: DataTypes.DATEONLY, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // If true, each occurrence is approved (and posted to the ledger)
    // immediately instead of landing in the Review Queue as a draft. Left
    // false by default: approving a bill puts a real payable on the books
    // unattended, so the safer default is a human reviewing it first --
    // same reasoning as RecurringInvoice.autoSend, one notch down in
    // consequence since approving doesn't notify anyone outside the org the
    // way sending a customer invoice does.
    autoApprove: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "recurring_bills",
    indexes: [{ fields: ["orgId"] }],
  }
);
