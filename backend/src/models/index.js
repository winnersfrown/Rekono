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
};
