import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// An invoice the org ISSUES to a customer -- money coming in. Named
// CustomerInvoice rather than Invoice because this codebase's existing
// `Invoice` model is the opposite thing: a bill *received* from a vendor
// (money going out). Two models with the same noun on opposite sides of
// the ledger would be a permanent source of confusion, so the AR one
// carries the qualifier.
//
// Lifecycle: draft -> sent -> paid, with void reachable from sent/paid.
//   - draft: editable, NOT on the books yet (nothing posted). Real AR
//     software works this way -- you build an invoice before you commit to
//     it, and an unsent draft shouldn't affect revenue or receivables.
//   - sent: posted (Debit Accounts Receivable / Credit revenue). Now
//     immutable, same reasoning as a posted journal entry.
//   - paid: fully settled. Derived from payments, not set by hand.
//   - void: reversed on the books, kept for the audit trail.
export const CUSTOMER_INVOICE_STATUSES = ["draft", "sent", "paid", "void"];

export const CustomerInvoice = sequelize.define(
  "CustomerInvoice",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    customerId: { type: DataTypes.STRING(32), allowNull: false },
    // Sequential per org (INV-0001, ...), assigned at creation. See
    // accountsReceivable.js's nextInvoiceNumber for the numbering.
    invoiceNumber: { type: DataTypes.STRING(64), allowNull: false },
    issueDate: { type: DataTypes.DATEONLY, allowNull: false },
    dueDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM(...CUSTOMER_INVOICE_STATUSES), allowNull: false, defaultValue: "draft" },
    // Integer cents, matching JournalLine rather than the FLOAT the AP
    // Invoice uses -- this figure has to tie out to a journal entry
    // exactly, and that's the whole argument for cents (see
    // JournalLine.js). Kept denormalized off the lines so a list view
    // doesn't have to sum them, and revalidated against the lines
    // whenever the invoice is edited.
    totalCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // The sales tax portion of totalCents, denormalized alongside it for
    // the same reason totalCents itself is: postCustomerInvoice needs an
    // exact figure to validate its posting against without re-deriving it
    // from the lines and the org's rate (which could have changed since
    // this invoice was created) every time. Zero for a tax-exempt customer
    // or an org that's never set a rate -- never null, so every reader can
    // just add it without a null check.
    taxCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    sentAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "customer_invoices",
    indexes: [{ fields: ["orgId"] }, { fields: ["customerId"] }, { fields: ["status"] }, { fields: ["dueDate"] }],
  }
);
