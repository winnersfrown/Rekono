// Revenue recognition (ASC 606) for anything billed up front and
// delivered over time -- the subscription/SaaS case.
//
// Without this, sending a customer an annual invoice in January credits
// twelve months of revenue into January. The P&L then shows a spike that
// didn't happen and eleven months that look dead, and neither figure is
// something you could hand an investor. What's true on day one is that
// cash (or a receivable) came in and the org now *owes twelve months of
// service* -- a liability, not income.
//
// So a line with a service period credits **Deferred Revenue** instead of
// revenue, and a monthly recognition run moves each month's earned share
// across as it's delivered:
//
//   Invoice sent   Debit Accounts Receivable / Credit Deferred Revenue
//   Each month     Debit Deferred Revenue     / Credit Revenue
//
// A line with no service period is unchanged: it credits revenue directly,
// because point-in-time delivery is earned when billed.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry } from "./ledger.js";
import { Account, CustomerInvoice, CustomerInvoiceLine, RevenueScheduleEntry } from "./models/index.js";

export const DEFERRED_REVENUE_SUBTYPE = "deferred_revenue";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseIso(date) {
  return new Date(`${date}T00:00:00Z`);
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function daysInclusive(fromIso, toIso) {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / 86400000) + 1;
}

// The Deferred Revenue account, created on demand. Seeded into every new
// org's chart (ledger.js), but an org onboarded before this release won't
// have one -- and the first invoice with a service period shouldn't fail
// because of when the org signed up.
export async function ensureDeferredRevenueAccount(orgId) {
  const existing = await Account.findOne({
    where: { orgId, type: "liability", subtype: DEFERRED_REVENUE_SUBTYPE },
  });
  if (existing) return existing;

  return Account.create({
    orgId,
    code: "2200",
    name: "Deferred Revenue",
    type: "liability",
    subtype: DEFERRED_REVENUE_SUBTYPE,
    isSystemAccount: true,
  });
}

// Splits an amount across the calendar months a service period touches,
// proportional to how many days of the period fall in each.
//
// Daily proportion rather than equal monthly twelfths, because a term
// almost never starts on the 1st: Jan 15 - Jan 14 is 17 days of January
// and 14 of the following January, and calling both "one month" overstates
// the first period and understates the last. Straight-line over days is
// what a subscription's performance obligation actually looks like.
//
// The remainder lands on the final month so the schedule sums to the line
// *exactly*. Rounding each month independently would leave a cent or two
// stranded in deferred revenue forever -- a balance that never clears and
// that nobody can explain a year later.
export function buildSchedule(amountCents, serviceStartDate, serviceEndDate) {
  if (parseIso(serviceEndDate) < parseIso(serviceStartDate)) {
    throw new LedgerError("A service period can't end before it starts.");
  }

  const totalDays = daysInclusive(serviceStartDate, serviceEndDate);
  const start = parseIso(serviceStartDate);
  const end = parseIso(serviceEndDate);

  // Days of the period falling in each calendar month, in order.
  const months = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const monthStart = cursor;
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const from = monthStart > start ? monthStart : start;
    const to = monthEnd < end ? monthEnd : end;
    const days = Math.round((to - from) / 86400000) + 1;
    if (days > 0) months.push({ periodMonth: monthKey(cursor), days });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  let allocated = 0;
  return months.map((m, i) => {
    const isLast = i === months.length - 1;
    const cents = isLast ? amountCents - allocated : Math.round((amountCents * m.days) / totalDays);
    allocated += cents;
    return { periodMonth: m.periodMonth, amountCents: cents, days: m.days };
  });
}

export function lineIsDeferred(line) {
  return Boolean(line.serviceStartDate && line.serviceEndDate);
}

// Writes the schedule rows for every deferred line on an invoice. Called
// when the invoice is sent -- the same moment it hits the books -- so a
// draft carries no schedule, consistent with a draft posting nothing.
export async function createSchedulesForInvoice(invoice, lines) {
  const deferred = lines.filter(lineIsDeferred);
  if (!deferred.length) return [];

  const rows = [];
  for (const line of deferred) {
    for (const slice of buildSchedule(line.amountCents, line.serviceStartDate, line.serviceEndDate)) {
      rows.push({
        orgId: invoice.orgId,
        customerInvoiceId: invoice.id,
        customerInvoiceLineId: line.id,
        revenueAccountId: line.revenueAccountId,
        periodMonth: slice.periodMonth,
        amountCents: slice.amountCents,
      });
    }
  }
  return RevenueScheduleEntry.bulkCreate(rows);
}

// Drops the not-yet-recognized part of an invoice's schedule. Used when an
// invoice is voided: months already recognized are history and stay (their
// journal entries are reversed by the void like any other posting), but
// months that were never earned should simply stop being planned.
export async function dropUnrecognizedSchedule(orgId, customerInvoiceId) {
  return RevenueScheduleEntry.destroy({
    where: { orgId, customerInvoiceId, recognizedAt: null },
  });
}

// Everything scheduled for a month and not yet recognized, oldest first.
// Includes months *before* the requested one: a period missed because
// nobody ran recognition in March shouldn't stay stranded in deferred
// revenue forever, so running April picks it up too. Catching up is the
// behavior that keeps the balance sheet honest.
export async function pendingThrough(orgId, periodMonth) {
  return RevenueScheduleEntry.findAll({
    where: { orgId, recognizedAt: null, periodMonth: { [Op.lte]: periodMonth } },
    order: [
      ["periodMonth", "ASC"],
      ["id", "ASC"],
    ],
  });
}

// The last day of a period month -- the date recognition posts on, so the
// entry lands inside the month it recognizes rather than on whatever day
// someone happened to run it.
export function periodEndDate(periodMonth) {
  const [y, m] = periodMonth.split("-").map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

// Posts Debit Deferred Revenue / Credit revenue for everything due through
// `periodMonth`, one journal entry per month so each period's recognition
// is a single reviewable document rather than a scattering of tiny entries.
//
// Credits are collapsed per revenue account for the same reason invoice
// posting collapses them: that's how the entry would be written by hand,
// and it keeps the P&L's revenue section broken out by account rather than
// by invoice line.
export async function recognizeThrough(orgId, periodMonth, { postedByUserId = null } = {}) {
  const deferredAccount = await ensureDeferredRevenueAccount(orgId);
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

    const creditsByAccount = new Map();
    for (const r of rows) {
      creditsByAccount.set(r.revenueAccountId, (creditsByAccount.get(r.revenueAccountId) || 0) + r.amountCents);
    }

    const entry = await postJournalEntry(orgId, {
      entryDate: periodEndDate(month),
      memo: `Revenue recognition -- ${month}`,
      source: "revenue_recognition",
      sourceType: "revenue_recognition",
      sourceId: month,
      postedByUserId,
      lines: [
        { accountId: deferredAccount.id, debitCents: monthTotal },
        ...[...creditsByAccount].map(([accountId, creditCents]) => ({ accountId, creditCents })),
      ],
    });

    // Marked only after the posting succeeds, so a refused period (a
    // closed month, most likely) leaves its rows pending rather than
    // flagged as recognized against an entry that never posted.
    const now = new Date();
    await RevenueScheduleEntry.update(
      { recognizedAt: now, journalEntryId: entry.id },
      { where: { id: { [Op.in]: rows.map((r) => r.id) } } }
    );

    entries.push({ period_month: month, amount: centsToDollars(monthTotal), journal_entry_id: entry.id });
    totalCents += monthTotal;
  }

  return { periods: entries.map((e) => e.period_month), totalCents, entries };
}

// What's still sitting in deferred revenue, and which months it will
// release in -- the "waterfall" every subscription business is asked for.
// Derived from the schedule rather than the ledger so it can look forward;
// the ledger only knows what has already happened.
export async function computeDeferredRevenueWaterfall(orgId, { months = 12 } = {}) {
  const pending = await RevenueScheduleEntry.findAll({
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
    total_deferred: centsToDollars(totalCents),
    periods: shown.map(([periodMonth, cents]) => ({
      period_month: periodMonth,
      amount: centsToDollars(cents),
    })),
    beyond: { periods: Math.max(all.length - months, 0), amount: centsToDollars(remainderCents) },
  };
}

// The schedule for one invoice, recognized and pending alike -- what
// someone opens when they want to see why an invoice's revenue is landing
// where it is.
export async function scheduleForInvoice(orgId, customerInvoiceId) {
  const [invoice, rows] = await Promise.all([
    CustomerInvoice.findOne({ where: { id: customerInvoiceId, orgId } }),
    RevenueScheduleEntry.findAll({
      where: { orgId, customerInvoiceId },
      order: [
        ["periodMonth", "ASC"],
        ["id", "ASC"],
      ],
    }),
  ]);
  if (!invoice) return null;

  const lines = await CustomerInvoiceLine.findAll({ where: { customerInvoiceId } });
  const linesById = new Map(lines.map((l) => [l.id, l]));

  const recognizedCents = rows.filter((r) => r.recognizedAt).reduce((s, r) => s + r.amountCents, 0);
  const pendingCents = rows.filter((r) => !r.recognizedAt).reduce((s, r) => s + r.amountCents, 0);

  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoiceNumber,
    total_scheduled: centsToDollars(recognizedCents + pendingCents),
    recognized: centsToDollars(recognizedCents),
    deferred: centsToDollars(pendingCents),
    entries: rows.map((r) => ({
      id: r.id,
      period_month: r.periodMonth,
      description: linesById.get(r.customerInvoiceLineId)?.description || "",
      amount: centsToDollars(r.amountCents),
      recognized: Boolean(r.recognizedAt),
      recognized_at: r.recognizedAt,
      journal_entry_id: r.journalEntryId,
    })),
  };
}
