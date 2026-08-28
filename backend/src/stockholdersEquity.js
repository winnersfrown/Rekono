// The statement of stockholders' equity: how the owners' stake got from
// what it was at the start of a period to what it is at the end.
//
// The fourth statement, and the one Rekono was missing. The balance sheet
// says equity is $X; this says why -- capital came in, the business earned
// or lost money, owners took distributions, the company bought back
// shares.
//
// It is built as a **roll-forward that ties by construction**. Beginning
// and ending totals are read straight from computeBalanceSheet at the two
// dates, so the statement can never disagree with the balance sheet it
// sits next to. The movements in between are attributed from the typed
// equity transactions plus net income, and whatever those don't account
// for lands on an explicit `other` line rather than being quietly
// absorbed.
//
// That last part matters. Equity accounts are reachable by a plain manual
// journal entry, so a hand-posted credit to Owner's Equity is always
// possible. A statement that silently swallowed it would be wrong; one
// that refused to balance would be useless. Naming it keeps the report
// honest and points at the thing to go look at.

import { Op } from "sequelize";
import { centsToDollars, dollarsToCents } from "./ledger.js";
import { computeBalanceSheet, computeProfitAndLoss } from "./financialStatements.js";
import { dayBefore } from "./fiscalYear.js";
import { EquityTransaction } from "./models/index.js";

// How each transaction type moves total equity. Contributions and
// reissues raise it; distributions, declared dividends and buybacks lower
// it. Paying a previously declared dividend moves no equity at all -- it
// settles a liability that was already recognized when the dividend was
// declared, so counting it here would double-count the reduction.
const EQUITY_EFFECT = {
  contribution: 1,
  treasury_reissue: 1,
  distribution: -1,
  dividend_declared: -1,
  treasury_purchase: -1,
  dividend_paid: 0,
};

const LINE_FOR_TYPE = {
  contribution: "contributions",
  treasury_reissue: "treasury_stock",
  treasury_purchase: "treasury_stock",
  distribution: "distributions",
  dividend_declared: "distributions",
};

export async function computeStockholdersEquity(orgId, { from = null, to = null } = {}) {
  const asOf = to || new Date().toISOString().slice(0, 10);
  // With no `from`, the statement covers everything up to `to`, so the
  // opening position is zero rather than some arbitrary recent date.
  const openingAsOf = from ? dayBefore(from) : null;

  const [opening, closing, periodPnl] = await Promise.all([
    openingAsOf ? computeBalanceSheet(orgId, { asOf: openingAsOf }) : null,
    computeBalanceSheet(orgId, { asOf }),
    computeProfitAndLoss(orgId, { from, to: asOf }),
  ]);

  const beginningCents = opening ? dollarsToCents(opening.equity.total) : 0;
  const endingCents = dollarsToCents(closing.equity.total);
  const netIncomeCents = dollarsToCents(periodPnl.net_income);

  // Typed equity events inside the period.
  const where = { orgId };
  if (from && to) where.transactionDate = { [Op.between]: [from, asOf] };
  else if (from) where.transactionDate = { [Op.gte]: from };
  else where.transactionDate = { [Op.lte]: asOf };

  const transactions = await EquityTransaction.findAll({ where, order: [["transactionDate", "ASC"]] });

  const movements = { contributions: 0, distributions: 0, treasury_stock: 0 };
  for (const t of transactions) {
    const effect = EQUITY_EFFECT[t.type] ?? 0;
    if (effect === 0) continue;
    // A voided transaction's entry was reversed in the ledger, so the
    // balance sheet totals already exclude it. Counting it here would
    // make the attributed movements overshoot and push the difference
    // onto `other`, which would then be wrong in both directions.
    if (!t.journalEntryId) continue;
    movements[LINE_FOR_TYPE[t.type]] += effect * t.amountCents;
  }

  const attributedCents =
    netIncomeCents + movements.contributions + movements.distributions + movements.treasury_stock;
  const otherCents = endingCents - beginningCents - attributedCents;

  return {
    from,
    to: asOf,
    beginning_balance: centsToDollars(beginningCents),
    net_income: centsToDollars(netIncomeCents),
    contributions: centsToDollars(movements.contributions),
    distributions: centsToDollars(movements.distributions),
    treasury_stock: centsToDollars(movements.treasury_stock),
    // Equity movement no typed transaction explains -- almost always a
    // manual journal entry posted straight to an equity account. Zero on
    // healthy books; when it isn't, it's naming something real.
    other: centsToDollars(otherCents),
    ending_balance: centsToDollars(endingCents),
    // The equity section of the balance sheet at `to`, so the components
    // (common stock, APIC, retained earnings, treasury) can be shown
    // beside the roll-forward without a second request.
    components: closing.equity.accounts,
    retained_earnings: closing.equity.retained_earnings,
    current_year_earnings: closing.equity.current_year_earnings,
    // True by construction -- both ends come from the balance sheet and
    // `other` is the remainder. Surfaced anyway so a future change that
    // breaks the identity fails loudly instead of silently.
    reconciles:
      beginningCents + netIncomeCents + movements.contributions + movements.distributions + movements.treasury_stock + otherCents ===
      endingCents,
  };
}
