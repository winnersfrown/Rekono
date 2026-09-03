// Bank reconciliation: tying a cash account's book balance to what the
// bank actually reports on a statement, the same exercise a bookkeeper
// does with a paper statement and a highlighter.
//
// The one number a bank statement can be trusted for is what it says
// cleared. Everything the ledger has posted to the account but the bank
// hasn't processed yet -- a check written but not cashed, a deposit made
// after the cutoff -- is an "outstanding item," and the reconciliation's
// whole job is accounting for the gap between "what we've recorded" and
// "what the bank has seen" instead of treating a mismatch as a mystery.
//
// A JournalLine never changes once posted (ledger.js), so "cleared" can't
// be a column on it -- it lives in ReconciledJournalLine instead, a
// separate ledger of reconciliation bookkeeping that never touches the
// financial record it's checking. Completing a reconciliation is an
// attestation, not an enforced gate, same posture as ClosePeriod: it
// doesn't stop a later entry from landing on the account, it just records
// that a human ties out to this statement.

import { Op } from "sequelize";
import { LedgerError } from "./ledger.js";
import { Account, BankReconciliation, JournalEntry, JournalLine, ReconciledJournalLine } from "./models/index.js";

// Only accounts set up as "Cash & bank" (accountTaxonomy.js's "bank"
// subtype) are reconcilable -- reconciling an AP or expense account
// against a bank statement isn't a coherent operation.
async function requireCashAccount(orgId, cashAccountId) {
  const account = await Account.findOne({ where: { id: cashAccountId, orgId } });
  if (!account || account.type !== "asset" || account.subtype !== "bank") {
    throw new LedgerError("Choose a cash or bank account to reconcile.");
  }
  return account;
}

export async function eligibleCashAccounts(orgId) {
  return Account.findAll({ where: { orgId, type: "asset", subtype: "bank" }, order: [["code", "ASC"]] });
}

export async function startReconciliation(orgId, { cashAccountId, statementDate, statementEndingBalanceCents }, { postedByUserId = null } = {}) {
  const account = await requireCashAccount(orgId, cashAccountId);
  if (!statementDate) throw new LedgerError("Enter the statement date.");
  if (!Number.isInteger(statementEndingBalanceCents)) {
    throw new LedgerError("Enter the statement's ending balance.");
  }

  const open = await BankReconciliation.findOne({ where: { orgId, cashAccountId: account.id, status: "open" } });
  if (open) {
    throw new LedgerError(`${account.name} already has a reconciliation in progress (statement date ${open.statementDate}). Finish or reopen it before starting another.`);
  }

  return BankReconciliation.create({
    orgId,
    cashAccountId: account.id,
    statementDate,
    statementEndingBalanceCents,
    createdByUserId: postedByUserId,
  });
}

async function ownedReconciliation(orgId, reconciliationId) {
  const reconciliation = await BankReconciliation.findOne({ where: { id: reconciliationId, orgId } });
  if (!reconciliation) throw new LedgerError("Reconciliation not found.", 404);
  return reconciliation;
}

// All of an account's activity through the statement date, so the caller
// can split it into what's already cleared (tied to any reconciliation,
// not just this one -- a line another completed reconciliation already
// claimed can't reappear here) and what's still outstanding.
async function accountLinesThroughDate(orgId, cashAccountId, asOf) {
  const entries = await JournalEntry.findAll({
    where: { orgId, entryDate: { [Op.lte]: asOf } },
    attributes: ["id", "entryDate", "memo", "docNumber", "source"],
    raw: true,
  });
  if (!entries.length) return [];
  const entryById = new Map(entries.map((e) => [e.id, e]));

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: cashAccountId },
    attributes: ["id", "journalEntryId", "debitCents", "creditCents", "memo"],
    raw: true,
  });

  return lines.map((line) => {
    const entry = entryById.get(line.journalEntryId);
    return {
      journal_line_id: line.id,
      journal_entry_id: line.journalEntryId,
      entry_date: entry.entryDate,
      memo: line.memo || entry.memo,
      doc_number: entry.docNumber,
      source: entry.source,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
    };
  });
}

// The reconciliation's full working detail: book balance as of the
// statement date, which lines are cleared vs. still outstanding, and
// whether what's cleared actually adds up to what the bank reported.
export async function getReconciliationDetail(orgId, reconciliationId) {
  const reconciliation = await ownedReconciliation(orgId, reconciliationId);
  const account = await Account.findOne({ where: { id: reconciliation.cashAccountId, orgId } });

  const [lines, clearedRows] = await Promise.all([
    accountLinesThroughDate(orgId, reconciliation.cashAccountId, reconciliation.statementDate),
    ReconciledJournalLine.findAll({ where: { orgId }, attributes: ["journalLineId", "reconciliationId"], raw: true }),
  ]);
  const clearedByLineId = new Map(clearedRows.map((c) => [c.journalLineId, c.reconciliationId]));

  let bookBalanceCents = 0;
  let clearedBalanceCents = 0;
  const outstandingChecks = [];
  const depositsInTransit = [];
  const clearedLines = [];

  for (const line of lines) {
    const net = line.debit_cents - line.credit_cents;
    bookBalanceCents += net;
    const clearedBy = clearedByLineId.get(line.journal_line_id);
    if (clearedBy) {
      clearedBalanceCents += net;
      if (clearedBy === reconciliation.id) clearedLines.push(line);
    } else if (line.credit_cents > 0) {
      outstandingChecks.push(line);
    } else if (line.debit_cents > 0) {
      depositsInTransit.push(line);
    }
  }

  const outstandingChecksCents = outstandingChecks.reduce((sum, l) => sum + l.credit_cents, 0);
  const depositsInTransitCents = depositsInTransit.reduce((sum, l) => sum + l.debit_cents, 0);

  return {
    id: reconciliation.id,
    cash_account_id: reconciliation.cashAccountId,
    cash_account_name: account?.name || "",
    statement_date: reconciliation.statementDate,
    statement_ending_balance_cents: reconciliation.statementEndingBalanceCents,
    status: reconciliation.status,
    completed_at: reconciliation.completedAt,
    book_balance_cents: bookBalanceCents,
    cleared_balance_cents: clearedBalanceCents,
    difference_cents: reconciliation.statementEndingBalanceCents - clearedBalanceCents,
    outstanding_checks_cents: outstandingChecksCents,
    deposits_in_transit_cents: depositsInTransitCents,
    outstanding_checks: outstandingChecks,
    deposits_in_transit: depositsInTransit,
    cleared_lines: clearedLines,
  };
}

export async function listReconciliations(orgId, { cashAccountId = null } = {}) {
  const where = { orgId };
  if (cashAccountId) where.cashAccountId = cashAccountId;
  return BankReconciliation.findAll({ where, order: [["statementDate", "DESC"], ["createdAt", "DESC"]] });
}

export async function setLineCleared(orgId, reconciliationId, journalLineId, cleared, { postedByUserId = null } = {}) {
  const reconciliation = await ownedReconciliation(orgId, reconciliationId);
  if (reconciliation.status !== "open") {
    throw new LedgerError("This reconciliation is already completed and can't be changed.");
  }

  const line = await JournalLine.findOne({ where: { id: journalLineId, accountId: reconciliation.cashAccountId } });
  if (!line) throw new LedgerError("That transaction doesn't belong to this account.", 404);
  const entry = await JournalEntry.findOne({ where: { id: line.journalEntryId, orgId } });
  if (!entry || entry.entryDate > reconciliation.statementDate) {
    throw new LedgerError("That transaction is dated after the statement.");
  }

  const existing = await ReconciledJournalLine.findOne({ where: { journalLineId } });

  if (cleared) {
    if (existing) throw new LedgerError("That transaction has already been reconciled.");
    await ReconciledJournalLine.create({ orgId, reconciliationId, journalLineId, clearedAt: new Date() });
  } else {
    if (!existing || existing.reconciliationId !== reconciliation.id) {
      throw new LedgerError("That transaction isn't cleared on this reconciliation.");
    }
    await existing.destroy();
  }

  return getReconciliationDetail(orgId, reconciliationId);
}

export async function completeReconciliation(orgId, reconciliationId) {
  const reconciliation = await ownedReconciliation(orgId, reconciliationId);
  if (reconciliation.status !== "open") throw new LedgerError("This reconciliation is already completed.");

  reconciliation.status = "completed";
  reconciliation.completedAt = new Date();
  await reconciliation.save();
  return getReconciliationDetail(orgId, reconciliationId);
}

export async function reopenReconciliation(orgId, reconciliationId) {
  const reconciliation = await ownedReconciliation(orgId, reconciliationId);
  if (reconciliation.status !== "completed") throw new LedgerError("This reconciliation isn't completed.");

  reconciliation.status = "open";
  reconciliation.completedAt = null;
  await reconciliation.save();
  return getReconciliationDetail(orgId, reconciliationId);
}
