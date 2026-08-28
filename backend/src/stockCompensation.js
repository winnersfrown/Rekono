// Stock compensation expense (ASC 718).
//
// v1.31 tracks what an option grant does to *ownership*. This is what it
// does to the *income statement*, and they are not the same thing at all:
// a grant is compensation the company pays in equity instead of cash, and
// it is an expense in the period the employee earns it even though no cash
// ever moves.
//
// Rekono does not compute the fair value of an option. That needs
// Black-Scholes inputs -- volatility, risk-free rate, expected term -- and
// a 409A valuation of the underlying stock, and a wrong number here flows
// straight into reported net income. So the grant-date fair value per share
// is supplied, exactly the way the README says an income tax provision
// would be: booking a number the user brings is defensible, deriving one is
// not.
//
// THE ONE THING WORTH READING TWICE. Expense recognition is not the vesting
// curve. Under a 12-month cliff nothing *vests* for a year -- but the
// employee is rendering service the whole time, so a year of expense is
// recognized. equityAwards.js's `vestedShares` answers "how many shares
// could they exercise", and the answer during a cliff is zero; this module
// answers "how much of the service has been rendered", and the answer is
// twelve months' worth. Reusing the vesting curve here would defer a year
// of real compensation cost and then dump it in one month.
//
// The attribution method is straight-line over the requisite service
// period, which is the policy election most companies make and ASC
// 718-10-35-8 permits for an award with a service condition only.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry } from "./ledger.js";
import { EQUITY_SUBTYPES, ensureAccount } from "./equity.js";
import { monthsElapsed, vestedShares } from "./equityAwards.js";
import { periodEndDate } from "./revenueRecognition.js";
import { Account, AwardEvent, EquityAward, JournalEntry } from "./models/index.js";

export const STOCK_COMP_EXPENSE_SUBTYPE = "stock_compensation_expense";

// Created on demand rather than seeded, same as every other account this
// app adds late: an org that never grants equity should not carry an
// always-zero expense line on its P&L.
export async function ensureStockCompensationAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "expense", subtype: STOCK_COMP_EXPENSE_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "6200",
    name: "Stock Compensation Expense",
    type: "expense",
    subtype: STOCK_COMP_EXPENSE_SUBTYPE,
    isSystemAccount: true,
  });
}

// The total cost of an award at grant: fair value per share times shares.
// Fixed at grant and never remeasured -- an equity-classified award is
// measured once, and later moves in the stock price change nothing about
// the expense. (Liability-classified awards do remeasure; Rekono has no
// such awards, which is why there is no remeasurement path here.)
export function grantCostCents(award) {
  if (!award.grantDateFairValueMicros) return 0;
  return Math.round((award.shares * award.grantDateFairValueMicros) / 10000);
}

// The fraction of an award's service period rendered by `asOf`.
//
// Deliberately NOT gated on the cliff -- see this file's header. Service
// accrues from the vesting start date whether or not anything has vested.
export function servedFraction(award, asOf) {
  if (award.vestingMonths <= 0) return 1;
  const months = Math.min(monthsElapsed(award.vestingStartDate, asOf), award.vestingMonths);
  return months / award.vestingMonths;
}

// Cumulative expense that should have been recognized on one award by the
// end of `asOf`, net of forfeiture.
//
// Forfeiture is the second place this diverges from intuition. When an
// award is cancelled before it vests, ASC 718-10-35-3 requires the expense
// already recognized against those shares to be *reversed* -- the company
// never received the service it was paying for. Expense on shares that had
// already vested is not reversed: that service was rendered and the cost
// was real, whatever happened afterwards.
export function cumulativeExpenseCents(award, events, asOf) {
  const cost = grantCostCents(award);
  if (!cost) return 0;

  // Only the unvested portion of a cancellation drops out of the cost
  // base. Shares that had already vested -- and anything exercised, which
  // is vested by definition -- keep their expense.
  const forfeited = unvestedAtCancellation(award, events, asOf);
  const liveShares = Math.max(award.shares - forfeited, 0);
  const liveCost = Math.round((liveShares * (award.grantDateFairValueMicros || 0)) / 10000);

  return Math.round(liveCost * servedFraction(award, asOf));
}

// How much of what was cancelled was still unvested at the moment it was
// cancelled. Cancelling vested shares is unusual (an expired unexercised
// option, say) but it happens, and those carry no expense reversal.
//
// Whether a share had vested is asked of `vestedShares`, the same function
// the register uses, rather than recomputed straight-line here. Those two
// answers differ precisely where it matters most: with a 12-month cliff an
// employee who leaves at five months has vested *nothing*, so the whole
// grant forfeits and every cent of its expense reverses. A straight-line
// approximation would say a tenth of it had vested and would strand that
// expense on the P&L forever.
function unvestedAtCancellation(award, events, asOf) {
  let unvested = 0;
  for (const e of events) {
    if (e.type !== "cancel" || e.eventDate > asOf) continue;
    const unvestedThen = Math.max(award.shares - vestedShares(award, e.eventDate), 0);
    unvested += Math.min(e.shares, unvestedThen);
  }
  return unvested;
}

// Every month from the earliest grant through `throughMonth`, inclusive.
function monthsUpTo(fromMonth, throughMonth) {
  const out = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = throughMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

async function loadAwardsWithEvents(orgId) {
  const awards = await EquityAward.findAll({
    where: { orgId, grantDateFairValueMicros: { [Op.ne]: null } },
  });
  if (!awards.length) return [];
  const events = await AwardEvent.findAll({ where: { orgId, equityAwardId: { [Op.in]: awards.map((a) => a.id) } } });
  const byAward = new Map(awards.map((a) => [a.id, []]));
  for (const e of events) byAward.get(e.equityAwardId)?.push(e);
  return awards.map((award) => ({ award, events: byAward.get(award.id) ?? [] }));
}

// Which months have already been posted, so a re-run doesn't double-book.
// Keyed on the period month in sourceId, the same way revenue recognition
// keys its own idempotency.
async function postedMonths(orgId) {
  const entries = await JournalEntry.findAll({
    where: { orgId, sourceType: "stock_compensation", status: "posted" },
    attributes: ["sourceId"],
    raw: true,
  });
  return new Set(entries.map((e) => e.sourceId));
}

// The month-by-month expense schedule.
//
// Each month's expense is the *change* in cumulative expense, not a
// recomputed slice. That is what makes forfeiture work without a special
// case: the month an award is cancelled, cumulative expense drops, the
// delta comes out negative, and the reversal falls out of the same
// subtraction that produces every other month's charge.
export async function computeSchedule(orgId, { throughMonth = null } = {}) {
  const rows = await loadAwardsWithEvents(orgId);
  if (!rows.length) return { months: [], total: 0 };

  const through = throughMonth || new Date().toISOString().slice(0, 7);
  const earliest = rows.map((r) => r.award.vestingStartDate.slice(0, 7)).sort()[0];
  if (earliest > through) return { months: [], total: 0 };

  const posted = await postedMonths(orgId);
  const months = [];
  let totalCents = 0;

  for (const month of monthsUpTo(earliest, through)) {
    const end = periodEndDate(month);
    const priorEnd = periodEndDate(previousMonth(month));

    let amountCents = 0;
    for (const { award, events } of rows) {
      amountCents += cumulativeExpenseCents(award, events, end) - cumulativeExpenseCents(award, events, priorEnd);
    }

    // A zero month is skipped rather than posted: the ledger refuses an
    // entry with no debit and no credit, and an empty document adds
    // nothing to the record anyway.
    if (amountCents === 0) continue;

    months.push({ period_month: month, amount: centsToDollars(amountCents), posted: posted.has(month) });
    if (!posted.has(month)) totalCents += amountCents;
  }

  return { months, total: centsToDollars(totalCents) };
}

function previousMonth(month) {
  let [y, m] = month.split("-").map(Number);
  m -= 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Posts Debit Stock Compensation Expense / Credit Additional Paid-In
// Capital for every unposted month through `throughMonth`.
//
// APIC is the credit side because the company is paying for services in
// equity: the cost lands on the P&L and the offsetting capital lands in
// the same account a cash purchase of stock would have credited. No cash
// moves, which is exactly why this shows up as an add-back in the indirect
// cash flow statement.
export async function recognizeThrough(orgId, throughMonth, { postedByUserId = null } = {}) {
  const { months } = await computeSchedule(orgId, { throughMonth });
  const pending = months.filter((m) => !m.posted);
  if (!pending.length) return { entries: [], total: 0 };

  const [expenseAccount, apic] = await Promise.all([
    ensureStockCompensationAccount(orgId),
    ensureAccount(orgId, EQUITY_SUBTYPES.APIC),
  ]);

  const entries = [];
  let totalCents = 0;

  for (const month of pending) {
    const amountCents = Math.round(month.amount * 100);
    // A forfeiture month is a genuine credit to expense, so the lines flip
    // rather than the amount going negative -- the ledger requires every
    // line to be a debit or a credit, never a signed value.
    const lines =
      amountCents > 0
        ? [
            { accountId: expenseAccount.id, debitCents: amountCents },
            { accountId: apic.id, creditCents: amountCents },
          ]
        : [
            { accountId: apic.id, debitCents: -amountCents },
            { accountId: expenseAccount.id, creditCents: -amountCents },
          ];

    const entry = await postJournalEntry(orgId, {
      entryDate: periodEndDate(month.period_month),
      memo: `Stock compensation -- ${month.period_month}`,
      source: "stock_compensation",
      sourceType: "stock_compensation",
      sourceId: month.period_month,
      postedByUserId,
      lines,
    });

    entries.push({ period_month: month.period_month, amount: month.amount, journal_entry_id: entry.id });
    totalCents += amountCents;
  }

  return { entries, total: centsToDollars(totalCents) };
}

// What each award has cost so far and what is still to come -- the
// "unrecognized compensation cost" disclosure every set of audited
// financials carries.
export async function computeAwardCosts(orgId, { asOf = null } = {}) {
  const on = asOf || new Date().toISOString().slice(0, 10);
  const rows = await loadAwardsWithEvents(orgId);

  return rows.map(({ award, events }) => {
    const total = grantCostCents(award);
    const recognized = cumulativeExpenseCents(award, events, on);
    return {
      id: award.id,
      grant_date: award.grantDate,
      shares: award.shares,
      grant_date_fair_value: award.grantDateFairValueMicros / 1000000,
      total_cost: centsToDollars(total),
      recognized_cost: centsToDollars(recognized),
      // Never negative: a fully forfeited award has recognized nothing and
      // has nothing left to recognize either.
      unrecognized_cost: centsToDollars(Math.max(total - recognized, 0)),
      served_percent: Math.round(servedFraction(award, on) * 10000) / 100,
    };
  });
}
