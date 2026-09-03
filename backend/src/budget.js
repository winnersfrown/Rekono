// Budget vs actual: a revenue/expense plan for a fiscal year, compared
// against what the ledger actually shows.
//
// Set against the same accounts the P&L reports on, never a parallel
// category system -- a budget line for an account that gets renamed or
// merged doesn't need separate upkeep, because there was never a second
// name for it to begin with. "Actual" is computed the exact way
// financialStatements.js's computeProfitAndLoss computes revenue and
// expense (same normal-balance convention, same closing-entry exclusion),
// so budget vs actual always agrees with what the P&L itself would report
// for the same accounts and period.
//
// Budgets are keyed by fiscal year, using the org's own configured
// year-end (fiscalYear.js) rather than assuming a calendar year -- an org
// with a June year-end gets FY2026 running July 2025 through June 2026,
// same as every other fiscal-year-aware report in this app.

import { Op } from "sequelize";
import { LedgerError, centsToDollars } from "./ledger.js";
import { normalBalanceCents } from "./financialStatements.js";
import { CLOSING_ENTRY_SOURCE } from "./yearEndClose.js";
import { DEFAULT_FISCAL_YEAR_END_MONTH, fiscalYearFor } from "./fiscalYear.js";
import { Account, Budget, BudgetLine, JournalEntry, JournalLine, Organization } from "./models/index.js";

const BUDGETABLE_TYPES = new Set(["revenue", "expense"]);

async function fiscalYearRange(orgId, fiscalYearEndYear) {
  const org = await Organization.findByPk(orgId, { attributes: ["fiscalYearEndMonth"], raw: true });
  const endMonth = org?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH;
  // Any date inside the target fiscal year works as the probe -- the last
  // day of the end month always lands in the year it names.
  const probe = `${fiscalYearEndYear}-${String(endMonth).padStart(2, "0")}-01`;
  return fiscalYearFor(probe, endMonth);
}

function monthsInRange(startIso, endIso) {
  const months = [];
  let cursor = new Date(`${startIso}T00:00:00Z`);
  const last = new Date(`${endIso}T00:00:00Z`);
  while (cursor <= last) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

export async function ensureBudget(orgId, fiscalYearEndYear, { name = "", postedByUserId = null } = {}) {
  const existing = await Budget.findOne({ where: { orgId, fiscalYearEndYear } });
  if (existing) return existing;
  return Budget.create({ orgId, fiscalYearEndYear, name, createdByUserId: postedByUserId });
}

// Splits an annual figure evenly across the fiscal year's months, the
// remainder landing on the last one -- same reasoning
// revenueRecognition.js's buildSchedule puts its own remainder on the
// final period: rounding each month independently would leave a cent or
// two nowhere, and a plan that doesn't sum to the number someone typed in
// is worse than not having one.
export async function splitAnnualBudgetCents(orgId, fiscalYearEndYear, annualCents) {
  const { start, end } = await fiscalYearRange(orgId, fiscalYearEndYear);
  const months = monthsInRange(start, end);
  const perMonth = Math.trunc(annualCents / months.length);
  const remainder = annualCents - perMonth * months.length;
  return months.map((periodMonth, i) => ({
    period_month: periodMonth,
    amount_cents: perMonth + (i === months.length - 1 ? remainder : 0),
  }));
}

async function requireBudgetableAccount(orgId, accountId) {
  const account = await Account.findOne({ where: { id: accountId, orgId } });
  if (!account || !BUDGETABLE_TYPES.has(account.type)) {
    throw new LedgerError("Choose a revenue or expense account to budget.");
  }
  return account;
}

// Replaces this account's entire set of lines within the budget -- a
// budget line is a plan, not a history, so there's nothing to preserve
// about the amounts it's replacing the way there would be for a posted
// journal line.
export async function setAccountBudget(orgId, budgetId, accountId, lines) {
  const budget = await Budget.findOne({ where: { id: budgetId, orgId } });
  if (!budget) throw new LedgerError("Budget not found.", 404);
  await requireBudgetableAccount(orgId, accountId);

  const { start, end } = await fiscalYearRange(orgId, budget.fiscalYearEndYear);
  const validMonths = new Set(monthsInRange(start, end));
  for (const line of lines) {
    if (!validMonths.has(line.period_month)) {
      throw new LedgerError(`${line.period_month} isn't a month in this budget's fiscal year.`);
    }
  }

  await BudgetLine.destroy({ where: { budgetId, accountId } });
  if (lines.length) {
    await BudgetLine.bulkCreate(lines.map((l) => ({ budgetId, accountId, periodMonth: l.period_month, amountCents: Math.round(l.amount_cents) })));
  }
}

export async function removeAccountBudget(orgId, budgetId, accountId) {
  const budget = await Budget.findOne({ where: { id: budgetId, orgId } });
  if (!budget) throw new LedgerError("Budget not found.", 404);
  await BudgetLine.destroy({ where: { budgetId, accountId } });
}

// Actual posted amounts by account, bucketed by month, for whatever
// window is asked for. Same normal-balance convention and closing-entry
// exclusion computeProfitAndLoss uses, so this always agrees with the P&L
// for the same accounts and period -- there's exactly one definition of
// "actual" in this app, not a second one that happens to live here.
async function actualsByAccountMonth(orgId, fromDate, toDate) {
  const entries = await JournalEntry.findAll({
    where: { orgId, entryDate: { [Op.between]: [fromDate, toDate] }, source: { [Op.ne]: CLOSING_ENTRY_SOURCE } },
    attributes: ["id", "entryDate"],
    raw: true,
  });
  const totals = new Map(); // accountId -> Map(periodMonth -> cents)
  if (!entries.length) return totals;
  const monthByEntry = new Map(entries.map((e) => [e.id, e.entryDate.slice(0, 7)]));

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) } },
    attributes: ["journalEntryId", "accountId", "debitCents", "creditCents"],
    raw: true,
  });

  const accounts = await Account.findAll({ where: { orgId, type: { [Op.in]: [...BUDGETABLE_TYPES] } }, attributes: ["id", "type"], raw: true });
  const typeByAccount = new Map(accounts.map((a) => [a.id, a.type]));

  for (const line of lines) {
    const type = typeByAccount.get(line.accountId);
    if (!type) continue; // not a revenue/expense account -- not part of this report
    const month = monthByEntry.get(line.journalEntryId);
    const net = normalBalanceCents(type, line.debitCents, line.creditCents);
    if (!totals.has(line.accountId)) totals.set(line.accountId, new Map());
    const byMonth = totals.get(line.accountId);
    byMonth.set(month, (byMonth.get(month) || 0) + net);
  }
  return totals;
}

function sumThroughMonth(byMonth, throughMonth) {
  let sum = 0;
  for (const [month, cents] of byMonth) {
    if (!throughMonth || month <= throughMonth) sum += cents;
  }
  return sum;
}

// The report: every account with a budget line, actual activity, or both
// -- an unbudgeted account that actually spent money still shows up
// rather than silently missing, same reasoning closeAutomation.js's
// suggestions surface a gap instead of hiding it. `throughMonth` (an
// inclusive "YYYY-MM") lets the report answer "on pace so far this year"
// instead of only ever comparing full-year figures against a
// partly-elapsed one; omit it for the whole fiscal year.
export async function computeBudgetVsActual(orgId, fiscalYearEndYear, { throughMonth = null } = {}) {
  const { start, end, label } = await fiscalYearRange(orgId, fiscalYearEndYear);
  const budget = await Budget.findOne({ where: { orgId, fiscalYearEndYear } });

  const [budgetLines, actuals] = await Promise.all([
    budget ? BudgetLine.findAll({ where: { budgetId: budget.id }, raw: true }) : [],
    actualsByAccountMonth(orgId, start, end),
  ]);

  const budgetByAccountMonth = new Map(); // accountId -> Map(periodMonth -> cents)
  for (const line of budgetLines) {
    if (!budgetByAccountMonth.has(line.accountId)) budgetByAccountMonth.set(line.accountId, new Map());
    budgetByAccountMonth.get(line.accountId).set(line.periodMonth, line.amountCents);
  }

  const accountIds = new Set([...budgetByAccountMonth.keys(), ...actuals.keys()]);
  const accounts = accountIds.size ? await Account.findAll({ where: { orgId, id: { [Op.in]: [...accountIds] } } }) : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const rows = [...accountIds]
    .map((accountId) => {
      const account = accountById.get(accountId);
      const budgetCents = sumThroughMonth(budgetByAccountMonth.get(accountId) || new Map(), throughMonth);
      const actualCents = sumThroughMonth(actuals.get(accountId) || new Map(), throughMonth);
      const varianceCents = actualCents - budgetCents;
      // Revenue coming in over plan is good news; expense running over
      // plan is bad news -- the same variance sign means opposite things
      // depending on which side of the P&L the account sits on, so this
      // is computed once here rather than re-derived (and possibly
      // gotten backwards) in the frontend.
      const favorable =
        budgetCents === 0 && actualCents === 0
          ? null
          : account?.type === "revenue"
          ? varianceCents >= 0
          : varianceCents <= 0;
      return {
        account_id: accountId,
        account_name: account?.name || "",
        account_type: account?.type || "",
        budget: centsToDollars(budgetCents),
        actual: centsToDollars(actualCents),
        variance: centsToDollars(varianceCents),
        variance_pct: budgetCents !== 0 ? Math.round((varianceCents / Math.abs(budgetCents)) * 1000) / 10 : null,
        favorable,
      };
    })
    .sort((a, b) => (a.account_type === b.account_type ? a.account_name.localeCompare(b.account_name) : a.account_type === "revenue" ? -1 : 1));

  const revenueRows = rows.filter((r) => r.account_type === "revenue");
  const expenseRows = rows.filter((r) => r.account_type === "expense");
  const sumField = (list, field) => Math.round(list.reduce((sum, r) => sum + r[field] * 100, 0));

  const budgetRevenueCents = sumField(revenueRows, "budget");
  const actualRevenueCents = sumField(revenueRows, "actual");
  const budgetExpenseCents = sumField(expenseRows, "budget");
  const actualExpenseCents = sumField(expenseRows, "actual");

  return {
    fiscal_year_label: label,
    fiscal_year_start: start,
    fiscal_year_end: end,
    through_month: throughMonth,
    has_budget: !!budget,
    budget_id: budget?.id || null,
    rows,
    totals: {
      budget_revenue: centsToDollars(budgetRevenueCents),
      actual_revenue: centsToDollars(actualRevenueCents),
      budget_expense: centsToDollars(budgetExpenseCents),
      actual_expense: centsToDollars(actualExpenseCents),
      budget_net_income: centsToDollars(budgetRevenueCents - budgetExpenseCents),
      actual_net_income: centsToDollars(actualRevenueCents - actualExpenseCents),
    },
  };
}
