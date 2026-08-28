// The general ledger: chart of accounts + double-entry journal entries.
// Phase 1 of turning Rekono from an AP-automation tool into real
// accounting software -- see CHANGELOG.md's v1.20 entry for the fuller
// context. Financial statements, revenue recognition, AR/customer
// invoicing, and AI-driven close automation are the roadmap after this;
// this file is deliberately just the foundation everything else is a view
// over or a process built on.
//
// Every write to journal_lines goes through postJournalEntry -- it's the
// one place that enforces the core double-entry invariant (a balanced
// entry, at least 2 lines), so no caller (the manual-entry route, invoice
// approval's auto-posting) can produce an unbalanced one.

import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import { Account, AuditLog, JournalEntry, JournalLine } from "./models/index.js";
import { EXPENSE_CATEGORIES } from "./models/ExpenseReceipt.js";
import { isPeriodClosed, periodMonthFor } from "./fiscalYear.js";
import { attachVendorToInvoice } from "./vendors.js";

export class LedgerError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// Amounts are stored as integer cents (see JournalLine.js's own comment on
// why) but every other money field in this app (Invoice.total, etc.) is a
// whole-dollar float -- these two converters are the one place that
// boundary is crossed, so it's never done ad hoc at a call site.
export function dollarsToCents(amount) {
  return Math.round(Number(amount) * 100);
}

export function centsToDollars(cents) {
  return Math.round(cents) / 100;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// The starter chart of accounts every org gets at onboarding (see
// seedDefaultChartOfAccounts below) -- codes follow traditional
// bookkeeping numbering (1000s asset, 2000s liability, 3000s equity, 4000s
// revenue, 5000s expense) mostly for the "this looks like real accounting
// software" familiarity a bookkeeper would expect, not because anything
// in this app currently enforces or relies on the numbering itself.
// Expense accounts mirror ExpenseReceipt.EXPENSE_CATEGORIES exactly, so
// the chart of accounts lines up with the category taxonomy already used
// everywhere else (ExpenseReceipt.category, Transaction.category).
function defaultAccountsFor() {
  const expenseAccounts = EXPENSE_CATEGORIES.map((name, i) => ({
    code: String(5000 + (i + 1) * 10),
    name,
    type: "expense",
  }));
  return [
    { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
    { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "accounts_receivable" },
    { code: "1900", name: "Uncategorized Asset", type: "asset" },
    { code: "2000", name: "Accounts Payable", type: "liability", subtype: "accounts_payable" },
    { code: "2100", name: "Credit Card", type: "liability", subtype: "credit_card" },
    // Billed-but-not-yet-earned revenue. See revenueRecognition.js --
    // a service you have invoiced for but not yet delivered is money
    // you owe as service, which is a liability, not income.
    { code: "2200", name: "Deferred Revenue", type: "liability", subtype: "deferred_revenue" },
    { code: "2900", name: "Uncategorized Liability", type: "liability" },
    { code: "3000", name: "Owner's Equity", type: "equity" },
    // The rest of the equity set (common stock, APIC, retained earnings,
    // treasury, distributions) and dividends payable are created on
    // demand by equity.js and yearEndClose.js -- a sole proprietor never
    // needs them, and an empty Treasury Stock line on every new org's
    // chart is clutter.
    { code: "4900", name: "Uncategorized Revenue", type: "revenue" },
    ...expenseAccounts,
    { code: "5900", name: "Uncategorized Expense", type: "expense" },
  ];
}

// Called at the same points sampleSeed.js's seedSampleInvoiceForNewOrg is
// (onboarding.js's free-plan path, billing.js's checkout-confirm and
// subscription-created paths), so every org has a working ledger from day
// one instead of an empty setup screen. Idempotent: never re-seeds an org
// that already has any accounts, so calling this more than once (e.g. a
// retried webhook) can't duplicate the chart of accounts.
export async function seedDefaultChartOfAccounts(org) {
  const existing = await Account.count({ where: { orgId: org.id } });
  if (existing > 0) return;
  await Account.bulkCreate(defaultAccountsFor().map((a) => ({ ...a, orgId: org.id, isSystemAccount: true })));
}

// The one place journal_lines ever gets written to. `lines` is
// [{ accountId, debitCents, creditCents, memo }, ...] -- each line must be
// a debit OR a credit, never both or neither, and the whole entry must
// balance. Throws LedgerError (a clean 422) for any violation rather than
// a raw DB error, since these are business-rule checks, not schema ones.
export async function postJournalEntry(
  orgId,
  { entryDate = todayIso(), memo = "", source = "manual", sourceType = null, sourceId = null, postedByUserId = null, lines }
) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new LedgerError("A journal entry needs at least two lines.");
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const accountIds = new Set();
  for (const line of lines) {
    const debit = Math.round(Number(line.debitCents) || 0);
    const credit = Math.round(Number(line.creditCents) || 0);
    if (debit < 0 || credit < 0) throw new LedgerError("Amounts can't be negative.");
    if ((debit > 0) === (credit > 0)) {
      throw new LedgerError("Each line must be either a debit or a credit, not both or neither.");
    }
    if (!line.accountId) throw new LedgerError("Every line needs an account.");
    totalDebit += debit;
    totalCredit += credit;
    accountIds.add(line.accountId);
  }
  if (totalDebit !== totalCredit) {
    throw new LedgerError(
      `This entry doesn't balance: debits total ${centsToDollars(totalDebit)}, credits total ${centsToDollars(totalCredit)}.`
    );
  }

  const accounts = await Account.findAll({ where: { id: [...accountIds], orgId } });
  if (accounts.length !== accountIds.size) {
    throw new LedgerError("One or more accounts weren't found.", 404);
  }

  // Nothing may be posted into a month that's already been closed --
  // otherwise a backdated entry could silently rewrite financials that
  // were already reported. Checked here rather than in the routes so it
  // covers every posting path (manual entries, invoice approval, voids)
  // from one place. Reopening the period in the Month-End Close tab
  // unlocks it again.
  if (await isPeriodClosed(orgId, entryDate)) {
    throw new LedgerError(
      `${periodMonthFor(entryDate)} has been closed. Reopen that period in Month-End Close before posting to it.`,
      409
    );
  }

  const entry = await JournalEntry.create({
    orgId,
    entryDate,
    memo,
    source,
    sourceType,
    sourceId,
    postedByUserId,
    status: "posted",
  });
  await JournalLine.bulkCreate(
    lines.map((line, i) => ({
      journalEntryId: entry.id,
      accountId: line.accountId,
      debitCents: Math.round(Number(line.debitCents) || 0),
      creditCents: Math.round(Number(line.creditCents) || 0),
      memo: line.memo || "",
      position: i,
    }))
  );
  return entry;
}

// Corrects a posted entry by posting its exact mirror image (debits and
// credits flipped) rather than editing or deleting it -- preserves the
// audit trail, same reasoning invoices are soft-deleted rather than
// destroyed. Idempotent: voiding an already-voided entry is a no-op that
// returns the original reversal rather than posting a second one.
export async function voidJournalEntry(orgId, journalEntryId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { id: journalEntryId, orgId },
    include: [{ model: JournalLine, as: "lines" }],
  });
  if (!entry) throw new LedgerError("Journal entry not found.", 404);
  if (entry.status === "voided") {
    return entry.voidedByEntryId ? JournalEntry.findOne({ where: { id: entry.voidedByEntryId, orgId } }) : null;
  }

  const reversal = await postJournalEntry(orgId, {
    entryDate: todayIso(),
    memo: entry.memo ? `Void of: ${entry.memo}` : "Void",
    source: "void",
    sourceType: "journal_entry",
    sourceId: entry.id,
    postedByUserId,
    lines: entry.lines.map((line) => ({
      accountId: line.accountId,
      debitCents: line.creditCents,
      creditCents: line.debitCents,
      memo: line.memo,
    })),
  });

  entry.status = "voided";
  entry.voidedByEntryId = reversal.id;
  await entry.save();
  return reversal;
}

// Every account's debit/credit totals as of a date -- the simplest report
// that proves the ledger is internally consistent (a real GL always
// balances to zero; if this doesn't, something upstream posted an
// unbalanced entry some way other than postJournalEntry).
//
// Voided entries are deliberately INCLUDED here, alongside the reversing
// entries that cancel them. Filtering to status: "posted" instead looks
// right but isn't: it drops the original while keeping its reversal,
// leaving the account showing the exact negative of the voided amount.
// That bug is invisible in this report specifically -- a reversal is
// itself balanced, so `balanced` below stays true while the per-account
// numbers are wrong -- which is how it survived until the financial
// statements (financialStatements.js) surfaced it. voidJournalEntry posts
// the reversal before marking the original voided, so a voided entry
// without its cancelling reversal can't exist.
export async function computeTrialBalance(orgId, asOfDate = null) {
  const entryWhere = { orgId };
  if (asOfDate) entryWhere.entryDate = { [Op.lte]: asOfDate };

  const [accounts, entries] = await Promise.all([
    Account.findAll({ where: { orgId }, order: [["code", "ASC"], ["name", "ASC"]], raw: true }),
    JournalEntry.findAll({ where: entryWhere, attributes: ["id"], raw: true }),
  ]);

  const totals = new Map();
  if (entries.length) {
    const lines = await JournalLine.findAll({
      where: { journalEntryId: entries.map((e) => e.id) },
      attributes: ["accountId", "debitCents", "creditCents"],
      raw: true,
    });
    for (const line of lines) {
      const t = totals.get(line.accountId) || { debit: 0, credit: 0 };
      t.debit += line.debitCents;
      t.credit += line.creditCents;
      totals.set(line.accountId, t);
    }
  }

  const rows = accounts.map((a) => {
    const t = totals.get(a.id) || { debit: 0, credit: 0 };
    return {
      account_id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debit: centsToDollars(t.debit),
      credit: centsToDollars(t.credit),
    };
  });
  const totalDebitCents = [...totals.values()].reduce((sum, t) => sum + t.debit, 0);
  const totalCreditCents = [...totals.values()].reduce((sum, t) => sum + t.credit, 0);

  return {
    as_of: asOfDate,
    accounts: rows,
    total_debit: centsToDollars(totalDebitCents),
    total_credit: centsToDollars(totalCreditCents),
    balanced: totalDebitCents === totalCreditCents,
  };
}

async function findAccountByName(orgId, type, name) {
  return Account.findOne({
    where: { orgId, type, [Op.and]: [sequelizeWhere(fn("LOWER", col("name")), name.toLowerCase())] },
  });
}

// Which expense account an approved invoice posts to: reuses
// invoice.quickbooksExpenseAccountName -- the *existing* AI-suggested-or-
// vendor-learned field from the QuickBooks integration
// (quickbooks.js's suggestExpenseAccount, VendorExpenseAccount.js) --
// matched case-insensitively against this org's chart of accounts, falling
// back to "Uncategorized Expense" when unset or unmatched. Deliberately
// reuses inference the app already computes rather than adding new
// categorization logic: the AI already knew this.
async function resolveExpenseAccount(invoice) {
  if (invoice.quickbooksExpenseAccountName) {
    const match = await findAccountByName(invoice.orgId, "expense", invoice.quickbooksExpenseAccountName);
    if (match) return match;
  }
  return findAccountByName(invoice.orgId, "expense", "Uncategorized Expense");
}

// Auto-posts Debit [expense account] / Credit Accounts Payable for an
// approved invoice. Several different code paths can transition an
// invoice to "approved" (the single approve route, bulk-action, the
// quick-review flow auto-approving once every flag clears, and
// pipeline.js's own auto-approval) -- rather than trust every one of them
// to call this exactly once, the function checks for an existing posted
// entry for this invoice first and no-ops if it finds one, so it's safe
// to call from all of them unconditionally. Also degrades silently
// (returns null, doesn't throw) when the org has no chart of accounts yet
// or the invoice has no usable total -- approving an invoice must never
// fail because of the ledger.
export async function postInvoiceApproval(invoice) {
  // Resolve the bill's vendor identity here rather than at each of the
  // four call sites that can approve one (the detail route, the bulk
  // action, the quick-review flow, and pipeline.js's auto-approve) --
  // same argument period locking makes for living in the ledger: one
  // place, so no approval path can quietly skip it. Runs before the
  // already-posted check because identity isn't accounting: a bill
  // approved before vendors existed should still get one if it's
  // re-approved.
  await attachVendorToInvoice(invoice.orgId, invoice);

  const alreadyPosted = await JournalEntry.findOne({
    where: { orgId: invoice.orgId, sourceType: "invoice", sourceId: invoice.id, status: "posted" },
  });
  if (alreadyPosted) return alreadyPosted;

  const amountCents = dollarsToCents(invoice.total);
  if (!amountCents || amountCents <= 0) return null;

  const [expenseAccount, apAccount] = await Promise.all([
    resolveExpenseAccount(invoice),
    findAccountByName(invoice.orgId, "liability", "Accounts Payable"),
  ]);
  if (!expenseAccount || !apAccount) return null;

  try {
    return await postJournalEntry(invoice.orgId, {
      memo: `Invoice ${invoice.invoiceNumber || invoice.id.slice(0, 8)} -- ${invoice.vendorName || "Unknown vendor"}`,
      source: "invoice_approval",
      sourceType: "invoice",
      sourceId: invoice.id,
      lines: [
        { accountId: expenseAccount.id, debitCents: amountCents },
        { accountId: apAccount.id, creditCents: amountCents },
      ],
    });
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    // The only LedgerError reachable here is a closed period (the amount
    // and accounts were both validated above), and it should be rare:
    // auto-posting always carries today's date, and a period is normally
    // closed only after it has ended. Approving must not fail because of
    // it -- but the invoice would then be approved with nothing on the
    // books, so this records *why* rather than swallowing it. The audit
    // entry is what makes the gap findable at close time instead of
    // showing up as an unexplained variance months later.
    console.error(`Invoice ${invoice.id} approved but not posted to the ledger: ${err.message}`);
    await AuditLog.create({
      orgId: invoice.orgId,
      invoiceId: invoice.id,
      action: "journal_posting_skipped",
      actor: "system",
      details: { reason: err.message, amount: invoice.total },
    });
    return null;
  }
}

// Reverses whatever postInvoiceApproval posted for this invoice, if
// anything -- called when a previously-approved invoice is rejected or
// deleted. Looked up by (sourceType, sourceId) rather than a dedicated FK
// column on Invoice, so posting stays a pure side effect with nothing new
// for Invoice itself to track. A no-op if the invoice was never posted
// (e.g. it was approved before this feature existed, or postInvoiceApproval
// degraded silently for it) or its entry is already voided.
export async function voidInvoiceJournalEntry(orgId, invoiceId) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "invoice", sourceId: invoiceId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id);
}
