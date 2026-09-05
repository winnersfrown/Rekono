// A single assembled view of the numbers a board update actually needs,
// built entirely from statements this app already computes and tests
// independently -- financialStatements.js, budget.js, equityAwards.js.
// This module adds exactly one piece of arithmetic none of those already
// had: burn rate and runway, because no existing report needed them
// before a board wanted to know how many months are left.

import { computeBalanceSheet, computeCashFlow, computeCashPosition, computeProfitAndLoss } from "./financialStatements.js";
import { computeFullyDiluted } from "./equityAwards.js";
import { computeBudgetVsActual } from "./budget.js";
import { currentFiscalYearEndYear, periodMonthFor } from "./fiscalYear.js";
import { computeMrr } from "./saasMetrics.js";
import { centsToDollars, dollarsToCents } from "./ledger.js";

// Trailing months averaged into the burn figure. A single month swings on
// timing alone (an annual insurance bill, a big invoice landing a day
// late), so runway is only honest read off a few months, not the latest
// one.
const BURN_WINDOW_MONTHS = 3;

function monthsBefore(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export async function computeBoardReport(orgId, { asOf = null } = {}) {
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);
  const burnFrom = monthsBefore(asOfDate, BURN_WINDOW_MONTHS);

  const [cash, cashFlowWindow, profitAndLoss, balanceSheet, capTable, fiscalYearEndYear, saas] = await Promise.all([
    computeCashPosition(orgId, { asOf: asOfDate }),
    computeCashFlow(orgId, { from: burnFrom, to: asOfDate }),
    computeProfitAndLoss(orgId, { from: burnFrom, to: asOfDate }),
    computeBalanceSheet(orgId, { asOf: asOfDate }),
    computeFullyDiluted(orgId, { asOf: asOfDate }),
    currentFiscalYearEndYear(orgId),
    computeMrr(orgId, { asOf: asOfDate }),
  ]);

  const budgetVsActual = await computeBudgetVsActual(orgId, fiscalYearEndYear, {
    throughMonth: periodMonthFor(asOfDate),
  });

  // net_change_in_cash > 0 means cash grew over the window; burn is only
  // the outflow case, averaged to a monthly figure.
  const netChangeCents = dollarsToCents(cashFlowWindow.net_change_in_cash);
  const monthlyBurnCents = netChangeCents < 0 ? Math.round(-netChangeCents / BURN_WINDOW_MONTHS) : 0;
  const cashOnHandCents = dollarsToCents(cash.total);
  // null rather than Infinity -- JSON can't carry Infinity, and "not
  // burning" is a real state the UI should render as its own thing, not a
  // number to be misread as literally zero months left.
  const runwayMonths = monthlyBurnCents > 0 ? Math.round((cashOnHandCents / monthlyBurnCents) * 10) / 10 : null;

  return {
    as_of: asOfDate,
    burn_window: { from: burnFrom, to: asOfDate, months: BURN_WINDOW_MONTHS },
    cash: {
      on_hand: cash.total,
      monthly_burn: centsToDollars(monthlyBurnCents),
      runway_months: runwayMonths,
    },
    profit_and_loss: profitAndLoss,
    balance_sheet: balanceSheet,
    budget_vs_actual: budgetVsActual,
    cap_table: capTable,
    saas,
  };
}
