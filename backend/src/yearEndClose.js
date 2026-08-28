// Year-end closing entries: zeroing revenue and expense into Retained
// Earnings so a fiscal year's books are formally shut.
//
// Rekono has always *derived* retained earnings (v1.21/v1.22) rather than
// posting closing entries, and that stays the default -- it's what
// QuickBooks and Xero do for the open year, and it means changing the
// fiscal year end re-slices the split instantly with nothing to un-post.
// But an org that wants a formal close (and an auditor who asks for one)
// needs the entries to actually exist, with revenue and expense accounts
// standing at zero on the first day of the new year.
//
// The two approaches coexist without double-counting, and the reason is
// worth stating because it looks like a bug otherwise: a closing entry
// debits every revenue account and credits every expense account by its
// balance, so after it posts, the cumulative revenue-minus-expense that
// computeBalanceSheet derives from is exactly zero for that year. The
// earnings move out of the derivation and into the Retained Earnings
// account balance in the same instant. Total equity never changes.
//
// The one thing that does need handling: a P&L run over a closed year
// would otherwise include the closing entry and report zero revenue --
// the report going blank precisely because the books were closed
// properly. So the income statement excludes this source while the
// balance sheet includes it. See financialStatements.js.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { fiscalYearFor } from "./fiscalYear.js";
import { Account, JournalEntry, JournalLine, Organization } from "./models/index.js";

export const CLOSING_ENTRY_SOURCE = "closing_entry";
export const RETAINED_EARNINGS_SUBTYPE = "retained_earnings";

// The Retained Earnings equity account, created on demand -- an org that
// onboarded before this release has no such account, and its first
// year-end shouldn't fail because of when it signed up.
export async function ensureRetainedEarningsAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "equity", subtype: RETAINED_EARNINGS_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "3200",
    name: "Retained Earnings",
    type: "equity",
    subtype: RETAINED_EARNINGS_SUBTYPE,
    isSystemAccount: true,
  });
}

export async function fiscalYearBounds(orgId, anyDateInYear) {
  const org = await Organization.findByPk(orgId);
  return fiscalYearFor(anyDateInYear, org?.fiscalYearEndMonth ?? undefined);
}

// What each revenue and expense account currently stands at over a date
// range, in the direction that closes it: revenue is credit-normal so
// closing debits it, expense is debit-normal so closing credits it.
//
// Deliberately counts *everything*, closing entries included. Filtering
// them out by source looks right -- "don't re-close what's closed" -- but
// gets three of the four cases wrong. Current balances get all four:
//
//   Open year        full balances, all of it to close
//   Just closed      zero, because the closing entry cancelled it
//   Closed, then a   only the part that landed afterwards, which is
//   late entry       exactly what's left unclosed
//   Reopened         full balances again, because the closing entry and
//                    the reversal that reopened it cancel
//
// The reopen case is the one that makes source-filtering actively unsafe:
// voidJournalEntry posts its reversal with source "void", not
// "closing_entry", so excluding only closing entries would leave the
// reversal counted on its own and double the balances.
async function balancesToClose(orgId, from, to) {
  const [accounts, entries] = await Promise.all([
    Account.findAll({ where: { orgId, type: { [Op.in]: ["revenue", "expense"] } }, raw: true }),
    JournalEntry.findAll({
      where: { orgId, entryDate: { [Op.between]: [from, to] } },
      attributes: ["id"],
      raw: true,
    }),
  ]);
  if (!accounts.length || !entries.length) return [];

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) } },
    attributes: ["accountId", "debitCents", "creditCents"],
    raw: true,
  });

  const byAccount = new Map();
  for (const l of lines) byAccount.set(l.accountId, (byAccount.get(l.accountId) || 0) + l.creditCents - l.debitCents);

  // Net credit for revenue (positive = earned), net debit for expense
  // (negative here = incurred). Zero-balance accounts are skipped: a
  // closing line for an account with nothing in it is noise.
  return accounts
    .map((a) => ({ account: a, netCreditCents: byAccount.get(a.id) || 0 }))
    .filter((r) => r.netCreditCents !== 0);
}

// What closing this fiscal year would post.
export async function previewYearEndClose(orgId, anyDateInYear) {
  const fy = await fiscalYearBounds(orgId, anyDateInYear);
  const rows = await balancesToClose(orgId, fy.start, fy.end);

  const revenue = rows.filter((r) => r.account.type === "revenue");
  const expense = rows.filter((r) => r.account.type === "expense");
  const revenueCents = revenue.reduce((s, r) => s + r.netCreditCents, 0);
  const expenseCents = expense.reduce((s, r) => s - r.netCreditCents, 0);

  const existing = await JournalEntry.findOne({
    where: { orgId, source: CLOSING_ENTRY_SOURCE, sourceId: fy.label, status: "posted" },
  });

  // A closed year can pick up activity afterwards -- a late adjusting
  // entry, a recurring template catching up, an invoice backdated into it.
  // Nothing about that is *wrong*: the totals stay right, because the
  // balance sheet derives whatever the closing entry didn't capture (see
  // computeBalanceSheet). But "closed" then no longer means the revenue
  // and expense accounts stand at zero, and reporting the leftover as if
  // it were the year's income would be actively misleading. So a
  // closed-but-stale year is called out for what it is, with the fix
  // (reopen, re-close -- ideally after locking the months) left to a human
  // rather than silently re-posted. Because balances are counted live,
  // `rows` is empty for a cleanly-closed year, so anything left here is by
  // definition activity that arrived after the close.
  const closed = Boolean(existing);
  const remainderCents = revenueCents - expenseCents;
  const needsReclose = closed && rows.length > 0;

  return {
    fiscal_year: fy,
    already_closed: closed,
    // Activity not covered by a closing entry. For an open year that's the
    // whole year; for a closed one it's only what landed afterwards.
    revenue: centsToDollars(revenueCents),
    expenses: centsToDollars(expenseCents),
    net_income: centsToDollars(remainderCents),
    accounts: rows.length,
    needs_reclose: needsReclose,
    unclosed_since_close: needsReclose ? centsToDollars(remainderCents) : 0,
  };
}

// Posts the closing entry for a fiscal year: every revenue account debited
// to zero, every expense account credited to zero, the difference to
// Retained Earnings.
//
// One entry rather than the textbook three-step Income Summary dance. The
// intermediate account exists in teaching material to make the arithmetic
// visible by hand; in a system that posts atomically it adds an account
// that is always zero and a second entry that can only ever be a
// transcription of the first.
export async function postYearEndClose(orgId, anyDateInYear, { postedByUserId = null } = {}) {
  const fy = await fiscalYearBounds(orgId, anyDateInYear);

  const existing = await JournalEntry.findOne({
    where: { orgId, source: CLOSING_ENTRY_SOURCE, sourceId: fy.label, status: "posted" },
  });
  if (existing) {
    throw new LedgerError(`${fy.label} has already been closed. Reopen it first if you need to redo it.`, 409);
  }

  const rows = await balancesToClose(orgId, fy.start, fy.end);
  if (!rows.length) {
    throw new LedgerError(`${fy.label} has no revenue or expense activity to close.`, 409);
  }

  const retained = await ensureRetainedEarningsAccount(orgId);

  const lines = [];
  let netCreditCents = 0;
  for (const { account, netCreditCents: bal } of rows) {
    // Close each account against its own balance, whichever way it runs --
    // a contra or negative-balance account closes in the opposite
    // direction and has to be handled by sign, not by account type.
    if (bal > 0) lines.push({ accountId: account.id, debitCents: bal });
    else lines.push({ accountId: account.id, creditCents: -bal });
    netCreditCents += bal;
  }

  // The balancing line to Retained Earnings. A profitable year credits it;
  // a loss debits it.
  if (netCreditCents > 0) lines.push({ accountId: retained.id, creditCents: netCreditCents });
  else if (netCreditCents < 0) lines.push({ accountId: retained.id, debitCents: -netCreditCents });
  else {
    // Revenue exactly equalled expenses. The P&L accounts still need
    // zeroing, and the entry balances without a retained-earnings line.
  }

  return postJournalEntry(orgId, {
    entryDate: fy.end,
    memo: `Closing entries -- ${fy.label}`,
    source: CLOSING_ENTRY_SOURCE,
    sourceType: CLOSING_ENTRY_SOURCE,
    sourceId: fy.label,
    postedByUserId,
    lines,
  });
}

// Reverses a year's closing entry, putting the revenue and expense
// balances back. Needed because closing is the one posting most likely to
// be done too early -- a late adjusting entry arrives, and the year has to
// be reopened to take it.
export async function reopenYearEndClose(orgId, anyDateInYear, { postedByUserId = null } = {}) {
  const fy = await fiscalYearBounds(orgId, anyDateInYear);
  const entry = await JournalEntry.findOne({
    where: { orgId, source: CLOSING_ENTRY_SOURCE, sourceId: fy.label, status: "posted" },
  });
  if (!entry) throw new LedgerError(`${fy.label} has not been closed.`, 409);
  await voidJournalEntry(orgId, entry.id, { postedByUserId });
  return fy;
}

export async function closedFiscalYears(orgId) {
  const entries = await JournalEntry.findAll({
    where: { orgId, source: CLOSING_ENTRY_SOURCE, status: "posted" },
    order: [["entryDate", "DESC"]],
  });
  return entries.map((e) => ({ fiscal_year: e.sourceId, entry_date: e.entryDate, journal_entry_id: e.id }));
}
