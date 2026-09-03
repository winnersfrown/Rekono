import { sequelize } from "../db.js";
import { applyRlsPolicies, installCls, verifyRlsEffective } from "../rls.js";
import { Organization } from "./Organization.js";
import { User } from "./User.js";
import { Invoice } from "./Invoice.js";
import { LineItem } from "./LineItem.js";
import { AuditLog } from "./AuditLog.js";
import { MatchSource } from "./MatchSource.js";
import { MatchEntry } from "./MatchEntry.js";
import { MatchResult } from "./MatchResult.js";
import { VendorAlias } from "./VendorAlias.js";
import { VendorExpenseAccount } from "./VendorExpenseAccount.js";
import { DismissedBankTransaction } from "./DismissedBankTransaction.js";
import { Invite } from "./Invite.js";
import { ExpenseReceipt } from "./ExpenseReceipt.js";
import { VendorDocument } from "./VendorDocument.js";
import { Lease } from "./Lease.js";
import { TaxDocument } from "./TaxDocument.js";
import { Check } from "./Check.js";
import { ClosePeriod } from "./ClosePeriod.js";
import { CloseTask } from "./CloseTask.js";
import { Transaction } from "./Transaction.js";
import { MerchantCategory } from "./MerchantCategory.js";
import { NetWorthAccount } from "./NetWorthAccount.js";
import { NetWorthEntry } from "./NetWorthEntry.js";
import { Account } from "./Account.js";
import { JournalEntry } from "./JournalEntry.js";
import { JournalLine } from "./JournalLine.js";
import { Customer } from "./Customer.js";
import { CustomerInvoice } from "./CustomerInvoice.js";
import { CustomerInvoiceLine } from "./CustomerInvoiceLine.js";
import { CustomerPayment } from "./CustomerPayment.js";
import { BillPayment } from "./BillPayment.js";
import { Vendor } from "./Vendor.js";
import { RevenueScheduleEntry } from "./RevenueScheduleEntry.js";
import { RecurringEntry, RecurringEntryLine } from "./RecurringEntry.js";
import { RecurringInvoice, RecurringInvoiceLine } from "./RecurringInvoice.js";
import { RecurringBill } from "./RecurringBill.js";
import { FixedAsset } from "./FixedAsset.js";
import { WrittenCheck } from "./WrittenCheck.js";
import { EquityTransaction } from "./EquityTransaction.js";
import { ShareClass, ShareTransaction, Shareholder } from "./ShareRegister.js";
import { AwardEvent, EquityAward, EquityPlan } from "./EquityAward.js";
import { BankConnection } from "./BankConnection.js";
import { BankAccount } from "./BankAccount.js";
import { Employee } from "./Employee.js";
import { PayrollRun } from "./PayrollRun.js";
import { BankReconciliation, ReconciledJournalLine } from "./BankReconciliation.js";
import { Budget, BudgetLine } from "./Budget.js";
import { CustomerCreditMemo } from "./CustomerCreditMemo.js";
import { CustomerCreditMemoLine } from "./CustomerCreditMemoLine.js";
import { CustomerCreditMemoApplication } from "./CustomerCreditMemoApplication.js";
import { VendorCreditMemo } from "./VendorCreditMemo.js";
import { VendorCreditMemoApplication } from "./VendorCreditMemoApplication.js";
import { PrepaidExpense } from "./PrepaidExpense.js";
import { PrepaidExpenseScheduleEntry } from "./PrepaidExpenseScheduleEntry.js";

Organization.hasMany(User, { foreignKey: "orgId", as: "users" });
User.belongsTo(Organization, { foreignKey: "orgId", as: "organization" });

Organization.hasMany(Invite, { foreignKey: "orgId", as: "invites" });
Invite.belongsTo(Organization, { foreignKey: "orgId" });

Invoice.hasMany(LineItem, {
  foreignKey: "invoiceId",
  as: "lineItems",
  onDelete: "CASCADE",
  hooks: true,
});
LineItem.belongsTo(Invoice, { foreignKey: "invoiceId" });

Invoice.hasMany(AuditLog, { foreignKey: "invoiceId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(Invoice, { foreignKey: "invoiceId" });

ExpenseReceipt.hasMany(AuditLog, { foreignKey: "receiptId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(ExpenseReceipt, { foreignKey: "receiptId" });

VendorDocument.hasMany(AuditLog, { foreignKey: "vendorDocumentId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(VendorDocument, { foreignKey: "vendorDocumentId" });

Lease.hasMany(AuditLog, { foreignKey: "leaseId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(Lease, { foreignKey: "leaseId" });

TaxDocument.hasMany(AuditLog, { foreignKey: "taxDocumentId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(TaxDocument, { foreignKey: "taxDocumentId" });

Check.hasMany(AuditLog, { foreignKey: "checkId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(Check, { foreignKey: "checkId" });

// A check points at the bill it pays. Deliberately without a constraint:
// the bill long outlives the check image, and unlinking a check is a
// reversal (see routes/checks.js), never a deletion of either side.
Check.belongsTo(Invoice, { foreignKey: "invoiceId", constraints: false });

// Deleting a close period takes its checklist with it -- a task has no
// meaning outside the month it belongs to.
ClosePeriod.hasMany(CloseTask, { foreignKey: "closePeriodId", as: "tasks", onDelete: "CASCADE", hooks: true });
CloseTask.belongsTo(ClosePeriod, { foreignKey: "closePeriodId" });

Invoice.hasMany(MatchResult, {
  foreignKey: "invoiceId",
  as: "matchResults",
  onDelete: "CASCADE",
  hooks: true,
});
MatchResult.belongsTo(Invoice, { foreignKey: "invoiceId" });

MatchSource.hasMany(MatchEntry, {
  foreignKey: "sourceId",
  as: "entries",
  onDelete: "CASCADE",
  hooks: true,
});
MatchEntry.belongsTo(MatchSource, { foreignKey: "sourceId", as: "source" });

MatchResult.belongsTo(MatchEntry, { foreignKey: "matchEntryId", as: "matchEntry" });

// Deleting an account takes its balance history with it -- a snapshot has
// no meaning without the account it was a snapshot of.
NetWorthAccount.hasMany(NetWorthEntry, {
  foreignKey: "accountId",
  as: "entries",
  onDelete: "CASCADE",
  hooks: true,
});
NetWorthEntry.belongsTo(NetWorthAccount, { foreignKey: "accountId" });

// A journal entry's lines have no meaning detached from it -- there's no
// destroy route for a posted entry (see JournalEntry.js's own comment on
// why), but the association still declares the correct cascade behavior
// for consistency with every other parent/child pair here.
JournalEntry.hasMany(JournalLine, { foreignKey: "journalEntryId", as: "lines", onDelete: "CASCADE", hooks: true });
JournalLine.belongsTo(JournalEntry, { foreignKey: "journalEntryId" });
JournalLine.belongsTo(Account, { foreignKey: "accountId" });

// A customer's invoices outlive any edit to the customer, but deleting a
// customer outright isn't offered (they're deactivated instead, see
// Customer.js) -- the cascade here is for completeness/consistency with
// every other parent/child pair, not a path the app actually exercises.
Customer.hasMany(CustomerInvoice, { foreignKey: "customerId", as: "invoices", onDelete: "CASCADE", hooks: true });
CustomerInvoice.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });

CustomerInvoice.hasMany(CustomerInvoiceLine, { foreignKey: "customerInvoiceId", as: "lines", onDelete: "CASCADE", hooks: true });
CustomerInvoiceLine.belongsTo(CustomerInvoice, { foreignKey: "customerInvoiceId" });
CustomerInvoiceLine.belongsTo(Account, { foreignKey: "revenueAccountId", as: "revenueAccount" });

CustomerInvoice.hasMany(CustomerPayment, { foreignKey: "customerInvoiceId", as: "payments", onDelete: "CASCADE", hooks: true });
CustomerPayment.belongsTo(CustomerInvoice, { foreignKey: "customerInvoiceId" });
CustomerPayment.belongsTo(Account, { foreignKey: "depositAccountId", as: "depositAccount" });

// A recurring invoice template's lines die with it. Invoices it already
// issued are real CustomerInvoice rows and are untouched -- deleting the
// template stops future issuance, it does not un-issue history.
RecurringInvoice.hasMany(RecurringInvoiceLine, { foreignKey: "recurringInvoiceId", as: "lines", onDelete: "CASCADE", hooks: true });
RecurringInvoiceLine.belongsTo(RecurringInvoice, { foreignKey: "recurringInvoiceId" });
RecurringInvoiceLine.belongsTo(Account, { foreignKey: "revenueAccountId", as: "revenueAccount" });
RecurringInvoice.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });

// The AP mirror of CustomerPayment. Invoice is the vendor bill being paid.
Invoice.hasMany(BillPayment, { foreignKey: "invoiceId", as: "billPayments", onDelete: "CASCADE", hooks: true });
BillPayment.belongsTo(Invoice, { foreignKey: "invoiceId" });
BillPayment.belongsTo(Account, { foreignKey: "paymentAccountId", as: "paymentAccount" });

// The AP mirror of RecurringInvoice -- no line sub-table (see RecurringBill.js's
// own comment on why), just a direct link to the one expense account it bills.
RecurringBill.belongsTo(Account, { foreignKey: "expenseAccountId", as: "expenseAccount" });

// A written check is the paper trail around one BillPayment (see
// writtenChecks.js) -- no cascade from BillPayment, since voidWrittenCheck
// always removes the check first and the payment it made second, the same
// single path that ever removes both.
WrittenCheck.belongsTo(Invoice, { foreignKey: "invoiceId" });
WrittenCheck.belongsTo(Account, { foreignKey: "paymentAccountId", as: "paymentAccount" });
WrittenCheck.belongsTo(BillPayment, { foreignKey: "billPaymentId" });

// A vendor's bills outlive any edit to the vendor. No cascade delete:
// merging repoints the bills first and only then removes the losing
// vendor, and a vendor nobody merged away is deactivated, not deleted.
Vendor.hasMany(Invoice, { foreignKey: "vendorId", as: "bills" });
Invoice.belongsTo(Vendor, { foreignKey: "vendorId", as: "vendor" });

// Schedule rows die with the invoice line they plan out -- an invoice
// deleted outright should not leave revenue planned for a line that no
// longer exists. Voiding is different and handled in the routes:
// recognized months stay, only unrecognized ones are dropped.
CustomerInvoiceLine.hasMany(RevenueScheduleEntry, { foreignKey: "customerInvoiceLineId", as: "revenueSchedule", onDelete: "CASCADE", hooks: true });
RevenueScheduleEntry.belongsTo(CustomerInvoiceLine, { foreignKey: "customerInvoiceLineId" });
RevenueScheduleEntry.belongsTo(Account, { foreignKey: "revenueAccountId", as: "revenueAccount" });

// A template's lines die with it. Entries it already posted are real
// journal entries and are untouched -- deleting the template stops
// future postings, it does not un-post history.
RecurringEntry.hasMany(RecurringEntryLine, { foreignKey: "recurringEntryId", as: "lines", onDelete: "CASCADE", hooks: true });
RecurringEntryLine.belongsTo(RecurringEntry, { foreignKey: "recurringEntryId" });
RecurringEntryLine.belongsTo(Account, { foreignKey: "accountId" });

// A fixed asset owns the one RecurringEntry that posts its depreciation --
// see models/FixedAsset.js. No cascade from RecurringEntry to FixedAsset:
// the route deletes the FixedAsset first and its own template second, so
// there's exactly one path that ever removes both.
FixedAsset.belongsTo(RecurringEntry, { foreignKey: "recurringEntryId" });
FixedAsset.belongsTo(Account, { foreignKey: "assetAccountId", as: "assetAccount" });
FixedAsset.belongsTo(Account, { foreignKey: "expenseAccountId", as: "expenseAccount" });
FixedAsset.belongsTo(Account, { foreignKey: "accumulatedDepreciationAccountId", as: "accumulatedDepreciationAccount" });

// The cash account an equity event moved through. No cascade: deleting
// an account is not offered, and an equity transaction outlives any
// edit to one.
EquityTransaction.belongsTo(Account, { foreignKey: "cashAccountId", as: "cashAccount" });

// The share register. No cascade deletes anywhere in it: a class or a
// holder with transactions against it is deactivated, never removed, for
// the same reason Customer and Vendor are -- a position has to stay
// attributable to somebody forever.
ShareTransaction.belongsTo(ShareClass, { foreignKey: "shareClassId", as: "shareClass" });
ShareClass.hasMany(ShareTransaction, { foreignKey: "shareClassId", as: "transactions" });
ShareTransaction.belongsTo(Shareholder, { foreignKey: "fromShareholderId", as: "fromShareholder" });
ShareTransaction.belongsTo(Shareholder, { foreignKey: "toShareholderId", as: "toShareholder" });
// The one link between shares and dollars. Nullable, because a transfer
// between two shareholders moves no company money at all.
ShareTransaction.belongsTo(EquityTransaction, { foreignKey: "equityTransactionId", as: "equityTransaction" });

// The option pool. A plan reserves shares of a class; an award promises
// some of them to a person; an event is what later happened to the award.
// Only an exercise reaches the register, which is why AwardEvent is the
// only one of the three with a link to a ShareTransaction.
EquityPlan.belongsTo(ShareClass, { foreignKey: "shareClassId", as: "shareClass" });
EquityPlan.hasMany(EquityAward, { foreignKey: "equityPlanId", as: "awards" });
EquityAward.belongsTo(EquityPlan, { foreignKey: "equityPlanId", as: "plan" });
EquityAward.belongsTo(Shareholder, { foreignKey: "shareholderId", as: "shareholder" });
// An award's events die with it. Unlike a share movement, an award that
// was entered by mistake and never exercised has left no trace on the
// register, so there is nothing for its events to outlive.
EquityAward.hasMany(AwardEvent, { foreignKey: "equityAwardId", as: "events", onDelete: "CASCADE", hooks: true });
AwardEvent.belongsTo(EquityAward, { foreignKey: "equityAwardId" });
AwardEvent.belongsTo(ShareTransaction, { foreignKey: "shareTransactionId", as: "shareTransaction" });

// A connection (one Plaid Item/login) owns the real accounts underneath
// it. Removing a connection also removes the accounts Plaid told us about
// through it -- the accounts have no independent existence once the
// credential that reads them is gone.
BankConnection.hasMany(BankAccount, { foreignKey: "connectionId", as: "accounts", onDelete: "CASCADE", hooks: true });
BankAccount.belongsTo(BankConnection, { foreignKey: "connectionId", as: "connection" });
BankAccount.belongsTo(MatchSource, { foreignKey: "matchSourceId", as: "matchSource" });

// A pay run outlives any edit to the employee it paid. No cascade: an
// employee with payroll history is deactivated, never deleted, same
// reasoning Vendor and Customer aren't either.
Employee.hasMany(PayrollRun, { foreignKey: "employeeId", as: "payrollRuns" });
PayrollRun.belongsTo(Employee, { foreignKey: "employeeId", as: "employee" });
PayrollRun.belongsTo(Account, { foreignKey: "paymentAccountId", as: "paymentAccount" });
PayrollRun.belongsTo(Account, { foreignKey: "wagesExpenseAccountId", as: "wagesExpenseAccount" });
PayrollRun.belongsTo(Account, { foreignKey: "payrollTaxExpenseAccountId", as: "payrollTaxExpenseAccount" });
PayrollRun.belongsTo(Account, { foreignKey: "liabilityAccountId", as: "liabilityAccount" });

// No cascade on the reconciliation -> cleared-line relationship: a
// completed reconciliation is a historical attestation, and the lines it
// swept up should stay attributed to it even if something upstream
// changes, same reasoning JournalEntry rows are never deleted.
BankReconciliation.hasMany(ReconciledJournalLine, { foreignKey: "reconciliationId", as: "clearedLines" });
ReconciledJournalLine.belongsTo(BankReconciliation, { foreignKey: "reconciliationId" });
BankReconciliation.belongsTo(Account, { foreignKey: "cashAccountId", as: "cashAccount" });

// A budget owns its lines the same way a RecurringEntry owns its lines --
// deleting the plan deletes what it was made of.
Budget.hasMany(BudgetLine, { foreignKey: "budgetId", as: "lines", onDelete: "CASCADE", hooks: true });
BudgetLine.belongsTo(Budget, { foreignKey: "budgetId" });
BudgetLine.belongsTo(Account, { foreignKey: "accountId" });

Customer.hasMany(CustomerCreditMemo, { foreignKey: "customerId", as: "creditMemos", onDelete: "CASCADE", hooks: true });
CustomerCreditMemo.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });

CustomerCreditMemo.hasMany(CustomerCreditMemoLine, { foreignKey: "customerCreditMemoId", as: "lines", onDelete: "CASCADE", hooks: true });
CustomerCreditMemoLine.belongsTo(CustomerCreditMemo, { foreignKey: "customerCreditMemoId" });
CustomerCreditMemoLine.belongsTo(Account, { foreignKey: "revenueAccountId", as: "revenueAccount" });

CustomerCreditMemo.hasMany(CustomerCreditMemoApplication, { foreignKey: "customerCreditMemoId", as: "applications", onDelete: "CASCADE", hooks: true });
CustomerCreditMemoApplication.belongsTo(CustomerCreditMemo, { foreignKey: "customerCreditMemoId" });
CustomerInvoice.hasMany(CustomerCreditMemoApplication, { foreignKey: "customerInvoiceId", as: "creditApplications", onDelete: "CASCADE", hooks: true });
CustomerCreditMemoApplication.belongsTo(CustomerInvoice, { foreignKey: "customerInvoiceId" });

// The AP mirror -- no line sub-table, same reasoning as RecurringBill (see
// VendorCreditMemo.js).
VendorCreditMemo.belongsTo(Account, { foreignKey: "expenseAccountId", as: "expenseAccount" });

VendorCreditMemo.hasMany(VendorCreditMemoApplication, { foreignKey: "vendorCreditMemoId", as: "applications", onDelete: "CASCADE", hooks: true });
VendorCreditMemoApplication.belongsTo(VendorCreditMemo, { foreignKey: "vendorCreditMemoId" });
Invoice.hasMany(VendorCreditMemoApplication, { foreignKey: "invoiceId", as: "creditApplications", onDelete: "CASCADE", hooks: true });
VendorCreditMemoApplication.belongsTo(Invoice, { foreignKey: "invoiceId" });

// The AP mirror of the CustomerInvoice/RevenueScheduleEntry relationship.
PrepaidExpense.belongsTo(Account, { foreignKey: "expenseAccountId", as: "expenseAccount" });
PrepaidExpense.belongsTo(Account, { foreignKey: "paymentAccountId", as: "paymentAccount" });
PrepaidExpense.hasMany(PrepaidExpenseScheduleEntry, { foreignKey: "prepaidExpenseId", as: "scheduleEntries", onDelete: "CASCADE", hooks: true });
PrepaidExpenseScheduleEntry.belongsTo(PrepaidExpense, { foreignKey: "prepaidExpenseId" });
PrepaidExpenseScheduleEntry.belongsTo(Account, { foreignKey: "expenseAccountId", as: "expenseAccount" });

// Postgres codes that mean "another process already created this" rather
// than a real schema problem: 42P07 duplicate_table (a table or index by
// that name already exists), 42710 duplicate_object, 23505 unique_violation
// (concurrent `CREATE TABLE IF NOT EXISTS` racing on Postgres's own internal
// pg_type catalog -- reproduced locally by running sync() from two processes
// against the same fresh database at once). Render's rolling deploys start
// the new container and run its own sequelize.sync() while the previous
// container is still up, so two instances legitimately race to sync the
// same persistent database on every deploy -- this isn't a hypothetical.
const BENIGN_SYNC_RACE_CODES = new Set(["42P07", "42710", "23505"]);

export async function initDb() {
  // Must be in place before anything opens a transaction, so that the
  // per-request transaction rls.js starts is picked up automatically by
  // every query inside that request.
  installCls();

  // Operator-triggered escape hatch for schema drift that additive-only
  // sync can't fix by itself -- e.g. a required column that can't be added
  // because legacy rows predate it (see the 23502 branch below), which is
  // exactly what happened to this app's own live database once. There's no
  // way to safely guess the right values for those legacy rows from inside
  // the app, so instead of trying, this drops and recreates the schema from
  // scratch, then falls through to the normal sync below to rebuild every
  // table from the current models with a guaranteed-correct shape.
  //
  // Deliberately gated behind an explicitly-named env var rather than any
  // kind of admin API route: setting DANGEROUSLY_RESET_DB=true on the
  // deployed service and redeploying is something an operator does through
  // Render's own dashboard (which already requires their login), with
  // nothing new to install or authenticate against. ALL DATA IS LOST.
  // Remove the env var again right after confirming it worked -- it stays
  // set across restarts otherwise, and every future boot would wipe the
  // database again.
  if (process.env.DANGEROUSLY_RESET_DB === "true" && sequelize.getDialect() === "postgres") {
    console.warn("DANGEROUSLY_RESET_DB is set -- dropping and recreating the public schema now. ALL DATA WILL BE LOST.");
    await sequelize.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  }

  const synced = await syncSchema();
  if (synced) {
    await enableRowLevelSecurity();
  }
}

// Returns false when sync bailed out in a way that leaves the schema in an
// unknown shape -- applying policies on top of that would fail confusingly
// on the very tables that didn't get built.
async function syncSchema() {
  try {
    // { drop: false } is the safe half of Sequelize's "alter" mode: it adds
    // any column a model declares that an existing table is missing (e.g.
    // this database predates a column that got added to a model later --
    // plain sync() never backfills that, and any query touching it then
    // fails with Postgres 42703 "column does not exist" forever). It never
    // removes a column absent from the model or changes an existing one, so
    // it can't destroy real data the way full `alter: true` could.
    await sequelize.sync({ alter: { drop: false } });
    return true;
  } catch (err) {
    const code = err?.parent?.code || err?.original?.code;
    if (BENIGN_SYNC_RACE_CODES.has(code)) {
      console.warn(`sequelize.sync(): schema already present (racing another instance?), continuing (${err.parent?.message || err.message})`);
      // The other instance built the same schema from the same models, so
      // the tables policies attach to are there either way.
      return true;
    }
    // 23502 = the column we just tried to add is NOT NULL and this table
    // already has rows predating it (e.g. Invoice.orgId, added after this
    // table's very first deploy). We can't safely invent a value for
    // legacy rows -- assigning the wrong org would leak that row across
    // tenants -- so this needs a human decision, not a guess. Log loudly
    // and keep booting: the rest of the app (auth, other tables) still
    // works, and this is strictly better than crash-looping the whole
    // process over one table's backfill.
    if (code === "23502") {
      console.error(
        `sequelize.sync(): could not add a NOT NULL column -- some existing rows predate it and need manual cleanup or a backfill. ` +
          `The app will keep booting, but queries touching that column/table will keep failing until this is resolved. (${err.parent?.message || err.message})`
      );
      return false;
    }
    throw err;
  }
}

async function enableRowLevelSecurity() {
  const { applied } = await applyRlsPolicies();
  if (!applied) return;

  const { effective } = await verifyRlsEffective();
  if (effective) {
    console.log(`Row-level security active on ${applied} tables.`);
  }
}

export {
  Organization,
  User,
  Invoice,
  LineItem,
  AuditLog,
  MatchSource,
  MatchEntry,
  MatchResult,
  VendorAlias,
  VendorExpenseAccount,
  DismissedBankTransaction,
  Invite,
  ExpenseReceipt,
  VendorDocument,
  Lease,
  TaxDocument,
  Check,
  ClosePeriod,
  CloseTask,
  Transaction,
  MerchantCategory,
  NetWorthAccount,
  NetWorthEntry,
  Account,
  JournalEntry,
  JournalLine,
  Customer,
  CustomerInvoice,
  CustomerInvoiceLine,
  CustomerPayment,
  BillPayment,
  Vendor,
  RevenueScheduleEntry,
  RecurringEntry,
  RecurringEntryLine,
  RecurringInvoice,
  RecurringInvoiceLine,
  RecurringBill,
  FixedAsset,
  WrittenCheck,
  EquityTransaction,
  ShareClass,
  Shareholder,
  ShareTransaction,
  EquityPlan,
  EquityAward,
  AwardEvent,
  BankConnection,
  BankAccount,
  Employee,
  PayrollRun,
  BankReconciliation,
  ReconciledJournalLine,
  Budget,
  BudgetLine,
  CustomerCreditMemo,
  CustomerCreditMemoLine,
  CustomerCreditMemoApplication,
  VendorCreditMemo,
  VendorCreditMemoApplication,
  PrepaidExpense,
  PrepaidExpenseScheduleEntry,
};
