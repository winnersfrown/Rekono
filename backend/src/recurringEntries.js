// Recurring (adjusting) journal entries: depreciation, prepaid
// amortization, accrued interest, accrued wages, monthly rent.
//
// These are the entries that make a close a close. Before this, closing a
// month in Rekono locked the period and ticked a checklist -- but nothing
// posted the depreciation or the accruals that are the actual work of
// closing, so the "closed" books were missing exactly the entries a close
// exists to record.
//
// A template plus a schedule, not a queue of future-dated entries: an
// entry that exists before its period has been posted would show up in a
// trial balance run today, and books that already contain next quarter's
// depreciation are wrong in a way nobody notices until an audit.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry } from "./ledger.js";
import { Account, RecurringEntry, RecurringEntryLine } from "./models/index.js";

const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, annually: 12 };

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseIso(d) {
  return new Date(`${d}T00:00:00Z`);
}

function toIso(d) {
  return d.toISOString().slice(0, 10);
}

// Advances a date by n months, clamping to the last day of the target
// month. A template that starts on the 31st has to post on the 30th in
// April and the 28th in February rather than silently rolling into the
// next month -- an adjusting entry landing in the wrong period is the
// whole failure mode this is guarding against.
export function addMonthsClamped(isoDate, months) {
  const d = parseIso(isoDate);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(Math.min(day, lastDay))}`;
}

// Every date this template is due to post for, up to and including `asOf`
// and not yet posted.
//
// Derived from startDate + frequency rather than from "the last one plus
// one interval", so a run that was skipped stays due instead of being
// lost. Missing a month's depreciation and then never being told is worse
// than posting it late.
export function dueDates(template, asOf) {
  const step = MONTHS_PER_PERIOD[template.frequency] ?? 1;
  const limit = template.endDate && template.endDate < asOf ? template.endDate : asOf;

  const dates = [];
  let cursor = template.startDate;
  // A generous ceiling rather than an unbounded loop: 40 years of monthly
  // periods is far past any real template, and a runaway loop here would
  // hang a request.
  for (let i = 0; i < 480 && cursor <= limit; i++) {
    if (!template.lastPostedDate || cursor > template.lastPostedDate) dates.push(cursor);
    cursor = addMonthsClamped(template.startDate, step * (i + 1));
  }
  return dates;
}

export async function loadTemplateLines(recurringEntryId) {
  return RecurringEntryLine.findAll({
    where: { recurringEntryId },
    order: [
      ["position", "ASC"],
      ["id", "ASC"],
    ],
  });
}

// A reversing entry always lands on the first of the *following* month,
// never the same day-of-month as the accrual it undoes. The date is
// deliberate, not incidental: it has to be in place before the real bill
// or payroll run posts sometime in that month, and "sometime in that
// month" is the only guarantee -- day 1 is the one date guaranteed to be
// early enough regardless of frequency.
function firstOfNextMonth(isoDate) {
  const d = parseIso(isoDate);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-01`;
}

// Posts one occurrence, plus its auto-reversal if the template calls for
// one. Returns { entry, reversal, reversalError }. Throws LedgerError only
// for the occurrence itself (a closed period being the expected case) --
// the occurrence is a correct, complete entry on its own, so a problem
// posting its reversal doesn't undo it. That failure comes back as
// `reversalError` instead, the same "named rather than swallowed" contract
// runRecurringEntries already uses for a refused period.
export async function postOccurrence(template, lines, entryDate, { postedByUserId = null } = {}) {
  const entry = await postJournalEntry(template.orgId, {
    entryDate,
    memo: template.memo || template.name,
    source: "recurring_entry",
    sourceType: "recurring_entry",
    sourceId: template.id,
    postedByUserId,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      memo: l.memo,
    })),
  });

  if (!template.autoReverse) return { entry, reversal: null, reversalError: null };

  try {
    const reversal = await postJournalEntry(template.orgId, {
      entryDate: firstOfNextMonth(entryDate),
      memo: `Reversal of: ${template.memo || template.name}`,
      source: "reversing_entry",
      sourceType: "recurring_entry",
      sourceId: template.id,
      postedByUserId,
      // Debits and credits flipped -- the exact mirror image, same shape
      // voidJournalEntry uses for a correction.
      lines: lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.creditCents,
        creditCents: l.debitCents,
        memo: l.memo,
      })),
    });
    return { entry, reversal, reversalError: null };
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    return { entry, reversal: null, reversalError: err.message };
  }
}

// Runs every active template up to `asOf`, posting each occurrence it owes.
//
// A template that fails (a closed period, a deleted account) doesn't stop
// the others: one broken depreciation schedule shouldn't block the rest of
// the close. Failures come back named so they're visible rather than
// silently skipped, which is the same trade postInvoiceApproval makes.
export async function runRecurringEntries(orgId, asOf, { postedByUserId = null, templateId = null } = {}) {
  const where = { orgId, active: true };
  if (templateId) where.id = templateId;
  const templates = await RecurringEntry.findAll({ where, order: [["name", "ASC"]] });

  const posted = [];
  const skipped = [];
  let totalCents = 0;

  for (const template of templates) {
    const dates = dueDates(template, asOf);
    if (!dates.length) continue;

    const lines = await loadTemplateLines(template.id);
    if (lines.length < 2) {
      skipped.push({ name: template.name, reason: "This template needs at least two lines to post." });
      continue;
    }

    for (const date of dates) {
      try {
        const { entry, reversal, reversalError } = await postOccurrence(template, lines, date, { postedByUserId });
        const amountCents = lines.reduce((s, l) => s + l.debitCents, 0);
        totalCents += amountCents;
        posted.push({
          template: template.name,
          entry_date: date,
          journal_entry_id: entry.id,
          amount: centsToDollars(amountCents),
          ...(reversal ? { reversal_entry_id: reversal.id, reversal_date: reversal.entryDate } : {}),
          ...(reversalError ? { reversal_error: reversalError } : {}),
        });
        // Advanced only after the posting succeeded, so a refused period
        // leaves the template still due for it rather than skipping past.
        template.lastPostedDate = date;
        await template.save();
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        skipped.push({ name: template.name, entry_date: date, reason: err.message });
        // Stop this template at its first failure: posting later periods
        // over a gap would leave the books with April and June but not
        // May, which is harder to spot than a template that just stopped.
        break;
      }
    }
  }

  return { posted, skipped, total: centsToDollars(totalCents) };
}

// What a run would post, without posting it. Same argument as revenue
// recognition's preview: these are real journal entries against periods
// someone may have already reported on.
export async function previewRecurringEntries(orgId, asOf) {
  const templates = await RecurringEntry.findAll({ where: { orgId, active: true }, order: [["name", "ASC"]] });
  const items = [];

  for (const template of templates) {
    const dates = dueDates(template, asOf);
    if (!dates.length) continue;
    const lines = await loadTemplateLines(template.id);
    const amountCents = lines.reduce((s, l) => s + l.debitCents, 0);
    items.push({
      id: template.id,
      name: template.name,
      frequency: template.frequency,
      periods: dates,
      amount_each: centsToDollars(amountCents),
      amount_total: centsToDollars(amountCents * dates.length),
      auto_reverse: template.autoReverse,
    });
  }

  return { as_of: asOf, items, occurrences: items.reduce((s, i) => s + i.periods.length, 0) };
}

// Convenience for the commonest adjusting entry there is. Straight-line
// only: declining-balance and MACRS are real methods but they're a tax
// concept more than a bookkeeping one, and guessing at which a user wants
// would be worse than making them say so with an explicit template.
export function straightLineDepreciationCents(costCents, salvageCents, usefulLifeMonths) {
  if (usefulLifeMonths <= 0) throw new LedgerError("Useful life must be at least one month.");
  if (salvageCents > costCents) throw new LedgerError("Salvage value can't exceed cost.");
  return Math.round((costCents - salvageCents) / usefulLifeMonths);
}

export async function accountsExist(orgId, accountIds) {
  const found = await Account.findAll({ where: { orgId, id: { [Op.in]: accountIds } }, attributes: ["id"], raw: true });
  return found.length === new Set(accountIds).size;
}
