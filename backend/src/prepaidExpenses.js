// Prepaid expense amortization -- the AP mirror of revenueRecognition.js.
//
// Money paid for something consumed over time (a year of insurance, a
// prepaid lease, an annual license) is real cash out on day one, but the
// expense hasn't happened yet -- what's true then is that the org now
// *holds a right to future service*, an asset (Prepaid Expenses), not a
// cost. An amortization run moves each month's consumed share across as
// it's used:
//
//   Prepayment made   Debit Prepaid Expenses / Credit [payment account]
//   Each month         Debit [expense account] / Credit Prepaid Expenses
//
// See PrepaidExpense.js for why this is its own record rather than
// something layered onto postInvoiceApproval.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { buildSchedule, periodEndDate } from "./revenueRecognition.js";
import { Account, JournalEntry, PrepaidExpense, PrepaidExpenseScheduleEntry } from "./models/index.js";

export const PREPAID_EXPENSE_SUBTYPE = "prepaid_expenses";

// The Prepaid Expenses account, created on demand -- same pattern as
// ensureDeferredRevenueAccount, for an org that predates this release.
export async function ensurePrepaidExpenseAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "asset", subtype: PREPAID_EXPENSE_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "1400",
    name: "Prepaid Expenses",
    type: "asset",
    subtype: PREPAID_EXPENSE_SUBTYPE,
    isSystemAccount: true,
  });
}

// Posts Debit Prepaid Expenses / Credit the payment account -- the cash
// left, but nothing has been consumed yet.
export async function postPrepaidExpense(prepaid, { postedByUserId = null } = {}) {
  const prepaidAccount = await ensurePrepaidExpenseAccount(prepaid.orgId);
  return postJournalEntry(prepaid.orgId, {
    entryDate: prepaid.paymentDate,
    memo: `${prepaid.vendorName || "Prepaid expense"} (${prepaid.serviceStartDate} to ${prepaid.serviceEndDate})`,
    source: "prepaid_expense",
    sourceType: "prepaid_expense",
    sourceId: prepaid.id,
    postedByUserId,
    lines: [
      { accountId: prepaidAccount.id, debitCents: prepaid.totalCents },
      { accountId: prepaid.paymentAccountId, creditCents: prepaid.totalCents },
    ],
  });
}

// Reverses whatever a prepaid expense posted, if anything. Same
// (sourceType, sourceId) lookup the rest of the ledger uses.
export async function voidPrepaidExpenseEntry(orgId, prepaidExpenseId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "prepaid_expense", sourceId: prepaidExpenseId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

// Writes the schedule rows for a prepaid expense. Called right after it
// posts -- a void prepaid expense carries no schedule, consistent with a
// void posting nothing.
export async function createScheduleForPrepaidExpense(prepaid) {
  const slices = buildSchedule(prepaid.totalCents, prepaid.serviceStartDate, prepaid.serviceEndDate);
  return PrepaidExpenseScheduleEntry.bulkCreate(
    slices.map((slice) => ({
      orgId: prepaid.orgId,
      prepaidExpenseId: prepaid.id,
      expenseAccountId: prepaid.expenseAccountId,
      periodMonth: slice.periodMonth,
      amountCents: slice.amountCents,
    }))
  );
}

// Drops the not-yet-amortized part of a prepaid expense's schedule. Used
// when one is voided.
export async function dropUnrecognizedSchedule(orgId, prepaidExpenseId) {
  return PrepaidExpenseScheduleEntry.destroy({ where: { orgId, prepaidExpenseId, recognizedAt: null } });
}

// How much of a prepaid expense has already been amortized -- used to
// decide whether voiding it is still simple (see the route: a partially
// amortized prepaid expense is a judgment call about correcting history,
// same reasoning voiding a credit memo already applied is refused rather
// than guessed at).
export async function amountRecognizedCents(prepaidExpenseId) {
  const rows = await PrepaidExpenseScheduleEntry.findAll({
    where: { prepaidExpenseId, recognizedAt: { [Op.ne]: null } },
    attributes: ["amountCents"],
    raw: true,
  });
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}

// Everything scheduled for a month and not yet amortized, oldest first --
// including months before the requested one, so a period missed because
// nobody ran amortization in March doesn't stay stranded in Prepaid
// Expenses forever.
export async function pendingThrough(orgId, periodMonth) {
  return PrepaidExpenseScheduleEntry.findAll({
    where: { orgId, recognizedAt: null, periodMonth: { [Op.lte]: periodMonth } },
    order: [
      ["periodMonth", "ASC"],
      ["id", "ASC"],
    ],
  });
}

// Posts Debit [expense account] / Credit Prepaid Expenses for everything
// due through `periodMonth`, one journal entry per month (debits collapsed
// per expense account, since two different prepaid items landing in the
// same account in the same month is one line an accountant would write by
// hand, not two).
export async function amortizeThrough(orgId, periodMonth, { postedByUserId = null } = {}) {
  const prepaidAccount = await ensurePrepaidExpenseAccount(orgId);
  const pending = await pendingThrough(orgId, periodMonth);
  if (!pending.length) return { periods: [], totalCents: 0, entries: [] };

  const byMonth = new Map();
  for (const row of pending) {
    if (!byMonth.has(row.periodMonth)) byMonth.set(row.periodMonth, []);
    byMonth.get(row.periodMonth).push(row);
  }

  const entries = [];
  let totalCents = 0;

  for (const [month, rows] of [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))) {
    const monthTotal = rows.reduce((sum, r) => sum + r.amountCents, 0);
    if (monthTotal <= 0) continue;

    const debitsByAccount = new Map();
    for (const r of rows) {
      debitsByAccount.set(r.expenseAccountId, (debitsByAccount.get(r.expenseAccountId) || 0) + r.amountCents);
    }

    const entry = await postJournalEntry(orgId, {
      entryDate: periodEndDate(month),
      memo: `Prepaid expense amortization -- ${month}`,
      source: "prepaid_expense_amortization",
      sourceType: "prepaid_expense_amortization",
      sourceId: month,
      postedByUserId,
      lines: [
        ...[...debitsByAccount].map(([accountId, debitCents]) => ({ accountId, debitCents })),
        { accountId: prepaidAccount.id, creditCents: monthTotal },
      ],
    });

    const now = new Date();
    await PrepaidExpenseScheduleEntry.update(
      { recognizedAt: now, journalEntryId: entry.id },
      { where: { id: { [Op.in]: rows.map((r) => r.id) } } }
    );

    entries.push({ period_month: month, amount: centsToDollars(monthTotal), journal_entry_id: entry.id });
    totalCents += monthTotal;
  }

  return { periods: entries.map((e) => e.period_month), totalCents, entries };
}

// What's still sitting in Prepaid Expenses, and which months it will
// release in -- the AP mirror of computeDeferredRevenueWaterfall.
export async function computePrepaidExpenseWaterfall(orgId, { months = 12 } = {}) {
  const pending = await PrepaidExpenseScheduleEntry.findAll({
    where: { orgId, recognizedAt: null },
    order: [["periodMonth", "ASC"]],
  });

  const byMonth = new Map();
  for (const row of pending) {
    byMonth.set(row.periodMonth, (byMonth.get(row.periodMonth) || 0) + row.amountCents);
  }

  const all = [...byMonth].sort((a, b) => a[0].localeCompare(b[0]));
  const shown = all.slice(0, months);
  const remainderCents = all.slice(months).reduce((sum, [, cents]) => sum + cents, 0);
  const totalCents = all.reduce((sum, [, cents]) => sum + cents, 0);

  return {
    total_prepaid: centsToDollars(totalCents),
    periods: shown.map(([periodMonth, cents]) => ({ period_month: periodMonth, amount: centsToDollars(cents) })),
    beyond: { periods: Math.max(all.length - months, 0), amount: centsToDollars(remainderCents) },
  };
}

// The schedule for one prepaid expense, amortized and pending alike.
export async function scheduleForPrepaidExpense(orgId, prepaidExpenseId) {
  const [prepaid, rows] = await Promise.all([
    PrepaidExpense.findOne({ where: { id: prepaidExpenseId, orgId } }),
    PrepaidExpenseScheduleEntry.findAll({
      where: { orgId, prepaidExpenseId },
      order: [
        ["periodMonth", "ASC"],
        ["id", "ASC"],
      ],
    }),
  ]);
  if (!prepaid) return null;

  const recognizedCents = rows.filter((r) => r.recognizedAt).reduce((s, r) => s + r.amountCents, 0);
  const pendingCents = rows.filter((r) => !r.recognizedAt).reduce((s, r) => s + r.amountCents, 0);

  return {
    prepaid_expense_id: prepaid.id,
    total_scheduled: centsToDollars(recognizedCents + pendingCents),
    recognized: centsToDollars(recognizedCents),
    remaining: centsToDollars(pendingCents),
    entries: rows.map((r) => ({
      id: r.id,
      period_month: r.periodMonth,
      amount: centsToDollars(r.amountCents),
      recognized: Boolean(r.recognizedAt),
      recognized_at: r.recognizedAt,
      journal_entry_id: r.journalEntryId,
    })),
  };
}
