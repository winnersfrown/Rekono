import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Where a journal entry came from -- "manual" is a human using the Journal
// Entries tab directly, "invoice_approval" is ledger.js's auto-posting on
// invoice approval, "void" is the reversing entry a void creates. More
// values get added as later phases wire up more triggers (bank import,
// bill payment, ...); a fixed enum rather than free text so the source
// column stays meaningful for reporting/filtering as that list grows.
export const JOURNAL_ENTRY_SOURCES = [
  "manual",
  "invoice_approval", // AP: a vendor bill was approved
  "bill_payment", // AP: a vendor bill was paid
  "customer_invoice", // AR: an invoice was issued to a customer
  "customer_payment", // AR: a customer paid
  "customer_credit_memo", // AR: a credit was issued against a customer's balance
  "bad_debt_write_off", // AR: a customer invoice's balance was recognized as uncollectible
  "vendor_credit_memo", // AP: a vendor issued a credit against a bill
  "prepaid_expense", // AP: cash paid up front for something consumed over time
  "prepaid_expense_amortization", // AP: a month of a prepaid expense was consumed
  "revenue_recognition", // AR: a month of deferred revenue was earned
  "recurring_entry", // an adjusting entry posted from a recurring template
  "fixed_asset_depreciation", // a declining-balance asset's own posting action (no recurring template -- see fixedAssets.js)
  "reversing_entry", // the auto-reverse mirror image of an accrual, posted the first of the next month
  "closing_entry", // year-end: revenue and expense zeroed into retained earnings
  "equity_transaction", // a dividend *declared* -- no cash moves, so this one stays out of the cash journals
  "equity_contribution", // cash in: an owner or investor put money in
  "equity_distribution", // cash out: a non-dividend distribution to owners
  "equity_dividend_paid", // cash out: a previously declared dividend settled
  "equity_treasury_purchase", // cash out: the company bought back its own shares
  "equity_treasury_reissue", // cash in: previously repurchased shares sold back out
  "stock_compensation", // ASC 718: a month of an equity award's cost was earned
  "income_tax", // the tax provision accrued -- no cash moves, so this stays out of the cash journals
  "income_tax_payment", // cash out: the accrued tax was actually paid
  "sales_tax_remittance", // cash out: sales tax collected on invoices was paid to the state
  "payroll_run", // gross wages, withholding, and the employer's own payroll tax cost
  "void",
];

// Posted entries are immutable by design, same reasoning real bookkeeping
// uses: a mistake is corrected with a reversing entry (ledger.js's
// voidJournalEntry), never by editing or deleting history. There is
// deliberately no PATCH or DELETE route for a journal entry -- only
// POST .../void.
export const JOURNAL_ENTRY_STATUSES = ["posted", "voided"];

export const JournalEntry = sequelize.define(
  "JournalEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // The paper document this entry corresponds to -- an invoice number, a
    // check number, a receipt number, a memorandum reference. Optional and
    // free text: not every entry has one (a payroll run or an equity event
    // doesn't produce a numbered document the way a check or invoice does),
    // and the exact numbering scheme is the org's own, not something this
    // app can standardize.
    docNumber: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    source: { type: DataTypes.ENUM(...JOURNAL_ENTRY_SOURCES), allowNull: false, defaultValue: "manual" },
    // Generic (sourceType, sourceId) pair rather than one nullable FK column
    // per possible source (the shape AuditLog uses) -- deliberate departure,
    // since this list is expected to keep growing as later phases wire up
    // more auto-posting triggers, and a new fixed column per trigger doesn't
    // scale as well as it does for AuditLog's fairly stable set of doc types.
    sourceType: { type: DataTypes.STRING(32), allowNull: true },
    sourceId: { type: DataTypes.STRING(32), allowNull: true },
    status: { type: DataTypes.ENUM(...JOURNAL_ENTRY_STATUSES), allowNull: false, defaultValue: "posted" },
    postedByUserId: { type: DataTypes.STRING(32), allowNull: true },
    // Set on the original entry once it's voided, pointing at the reversing
    // entry that undid it -- lets the UI show "voided, see entry X" instead
    // of just a status flag with no way to find what actually happened.
    voidedByEntryId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "journal_entries",
    indexes: [{ fields: ["orgId"] }, { fields: ["entryDate"] }, { fields: ["sourceType", "sourceId"] }],
  }
);
