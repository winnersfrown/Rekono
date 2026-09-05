// Fiscal-year boundaries and closed-period lookups -- the two things the
// ledger needs to know about *time* that aren't just a date on an entry.
//
// Split out from ledger.js/financialStatements.js because both need it and
// neither owns it: the balance sheet uses fiscal-year boundaries to
// separate prior-year retained earnings from current-year earnings, and
// postJournalEntry uses the closed-period lookup to refuse writes into a
// month that's already been closed.

import { ClosePeriod, Organization } from "./models/index.js";

// Calendar year, the default for most SMBs -- an org that never touches
// the setting behaves exactly as it did before fiscal years existed.
export const DEFAULT_FISCAL_YEAR_END_MONTH = 12;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// The fiscal year containing `date`, as { start, end } ISO date strings.
//
// A fiscal year is named by the calendar year it *ends* in, which is the
// near-universal convention: with a June year-end, "FY2026" runs
// 2025-07-01 through 2026-06-30. The calendar-year case (endMonth 12)
// collapses to exactly what you'd expect, Jan 1 - Dec 31.
export function fiscalYearFor(date, endMonth = DEFAULT_FISCAL_YEAR_END_MONTH) {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;

  // The year the fiscal year ends in: on or before the end month, it's
  // this calendar year; after it, we're already into the next one.
  const endYear = month <= endMonth ? year : year + 1;

  // Start is the day after the previous year-end. For a December year-end
  // that's January 1 of the same year; for any other month it's the
  // following month, in the previous calendar year.
  const startMonth = (endMonth % 12) + 1;
  const startYear = startMonth === 1 ? endYear : endYear - 1;

  // Day 0 of the following month is the last day of this one -- avoids
  // hardcoding month lengths or a leap-year special case for February.
  const endDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();

  return {
    start: `${startYear}-${pad2(startMonth)}-01`,
    end: `${endYear}-${pad2(endMonth)}-${pad2(endDay)}`,
    label: `FY${endYear}`,
  };
}

// The day before a fiscal year starts -- the cutoff for "everything that
// happened in a prior fiscal year", which is exactly what retained
// earnings means on a balance sheet.
export function dayBefore(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// "YYYY-MM" for a date, matching ClosePeriod.periodMonth's own format.
export function periodMonthFor(isoDate) {
  return String(isoDate).slice(0, 7);
}

// The fiscal year end year containing today, for the org -- what "the
// current budget" or "the current board report" means with nothing more
// specific requested. Was previously a route-local copy inside
// routes/budget.js; pulled here once a second caller (boardReport.js)
// needed the identical five lines, since a fiscal-year-end lookup is
// exactly the kind of thing this module exists to own.
export async function currentFiscalYearEndYear(orgId) {
  const org = await Organization.findByPk(orgId, { attributes: ["fiscalYearEndMonth"], raw: true });
  const endMonth = org?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH;
  const today = new Date().toISOString().slice(0, 10);
  return Number(fiscalYearFor(today, endMonth).end.slice(0, 4));
}

// Whether the month containing `entryDate` has been closed. Closing a
// period (routes/close.js) used to be a pure checklist that touched
// nothing in the ledger -- this is what gives it teeth: once a month is
// closed, nothing new can be posted into it, so already-reported
// financials can't be silently rewritten by a backdated entry.
//
// Reopening a period (which close.js already supports) unlocks it again,
// so this is a control rather than a one-way door.
export async function isPeriodClosed(orgId, entryDate) {
  const period = await ClosePeriod.findOne({
    where: { orgId, periodMonth: periodMonthFor(entryDate), status: "closed" },
    attributes: ["id"],
  });
  return Boolean(period);
}
