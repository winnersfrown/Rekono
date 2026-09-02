// The three financial statements, computed from ledger.js's journal lines:
// profit & loss, balance sheet, and cash flow. Phase 2 of the accounting
// pivot -- v1.20 built the general ledger these are all views over, and
// nothing here adds a new table or a new write path. Every figure traces
// back to posted journal lines; there are no derived-and-stored balances
// to drift out of sync with the ledger.

import { Op } from "sequelize";
import { Account, JournalEntry, JournalLine, Organization } from "./models/index.js";
import { CLOSING_ENTRY_SOURCE } from "./yearEndClose.js";
import { COST_OF_REVENUE_SUBTYPE, centsToDollars } from "./ledger.js";
import { DEFAULT_FISCAL_YEAR_END_MONTH, dayBefore, fiscalYearFor } from "./fiscalYear.js";
import { INCOME_TAX_EXPENSE_SUBTYPE } from "./incomeTax.js";

// Which side of an account increases it. Assets and expenses are
// debit-normal (a debit makes them bigger); liabilities, equity, and
// revenue are credit-normal. Getting this wrong is the classic way a
// statement comes out sign-flipped, so it lives in one place rather than
// being re-derived per report.
const DEBIT_NORMAL_TYPES = new Set(["asset", "expense"]);

export function normalBalanceCents(type, debitCents, creditCents) {
  return DEBIT_NORMAL_TYPES.has(type) ? debitCents - creditCents : creditCents - debitCents;
}

// One shared read: every posted journal line in a date window, joined to
// the account it hits. `from` is optional -- the balance sheet is a
// point-in-time snapshot of everything up to `to`, while the P&L and cash
// flow cover a bounded period.
async function loadLines(orgId, { from = null, to = null, excludeSources = null } = {}) {
  // Deliberately NOT filtered to status: "posted". A voided entry keeps
  // its lines on the books and is always accompanied by a reversing entry
  // that cancels it (ledger.js's voidJournalEntry posts the reversal
  // first, then marks the original voided, so a voided entry without its
  // reversal can't exist) -- counting both is what nets them to zero.
  // Filtering to "posted" would drop the original while keeping the
  // reversal, leaving every statement showing the *negative* of the
  // voided amount.
  //
  // This also gets the period attribution right: the reversal carries its
  // own (later) date, so an entry voided in a subsequent period shows up
  // as activity in the period it was actually corrected, which is how a
  // reversal is supposed to read.
  const entryWhere = { orgId };
  if (from && to) entryWhere.entryDate = { [Op.between]: [from, to] };
  else if (from) entryWhere.entryDate = { [Op.gte]: from };
  else if (to) entryWhere.entryDate = { [Op.lte]: to };
  // The income statement excludes year-end closing entries; the balance
  // sheet includes them. A closing entry debits every revenue account to
  // zero, so a P&L that counted it would report no revenue for any year
  // that had been formally closed -- the report would go blank precisely
  // because the books were done properly. The balance sheet must count it,
  // because that entry is what moved the earnings into the Retained
  // Earnings account.
  if (excludeSources?.length) entryWhere.source = { [Op.notIn]: excludeSources };

  const [accounts, entries] = await Promise.all([
    Account.findAll({ where: { orgId }, order: [["code", "ASC"], ["name", "ASC"]], raw: true }),
    JournalEntry.findAll({ where: entryWhere, attributes: ["id"], raw: true }),
  ]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  let lines = [];
  if (entries.length) {
    lines = await JournalLine.findAll({
      where: { journalEntryId: entries.map((e) => e.id) },
      attributes: ["journalEntryId", "accountId", "debitCents", "creditCents"],
      raw: true,
    });
  }
  return { accounts, accountsById, lines };
}

// Per-account debit/credit totals from a flat line list.
function totalsByAccount(lines) {
  const totals = new Map();
  for (const line of lines) {
    const t = totals.get(line.accountId) || { debit: 0, credit: 0 };
    t.debit += line.debitCents;
    t.credit += line.creditCents;
    totals.set(line.accountId, t);
  }
  return totals;
}

// Accounts of one type, with their normal-balance amount, dropping the
// ones with no activity -- a statement listing every zero-balance account
// in the chart is noise, not information.
function sectionFor(accounts, totals, type) {
  const rows = [];
  let totalCents = 0;
  for (const account of accounts) {
    if (account.type !== type) continue;
    const t = totals.get(account.id);
    if (!t) continue;
    const amountCents = normalBalanceCents(type, t.debit, t.credit);
    if (amountCents === 0) continue;
    rows.push({ account_id: account.id, code: account.code, name: account.name, amount: centsToDollars(amountCents) });
    totalCents += amountCents;
  }
  return { rows, totalCents };
}

// The income statement (profit & loss) for a period: revenue earned minus
// expenses incurred. A period report, not a snapshot -- `from`/`to` bound
// it, and unlike the balance sheet nothing carries in from before `from`.
//
// Multi-step, in the order a reader works down it:
//
//   Revenue
//   less  Cost of revenue          <- subtype cost_of_revenue
//   =     Gross profit
//   less  Operating expenses
//   =     Operating income
//   less  Income tax expense       <- subtype income_tax_expense
//   =     Net income
//
// Each subtotal answers a different question, which is the whole reason to
// separate them: gross profit says whether the thing being sold makes money
// at all, and operating income says whether the company around it does. A
// single-step statement (revenue minus one lump of expenses) can't tell
// those two failures apart.
export async function computeProfitAndLoss(orgId, { from = null, to = null } = {}) {
  const { accounts, lines } = await loadLines(orgId, { from, to, excludeSources: [CLOSING_ENTRY_SOURCE] });
  const totals = totalsByAccount(lines);

  const revenue = sectionFor(accounts, totals, "revenue");
  const allExpenses = sectionFor(accounts, totals, "expense");

  // Both splits are found by account *subtype*, never by name, since an org
  // can rename its accounts and the arithmetic must not depend on the label.
  //
  // Income tax is separated for a reason beyond presentation: a provision is
  // a percentage of *pre-tax* income (see incomeTax.js), so a statement that
  // buried tax inside the expense total would give the reader no way to
  // check the number against the rate.
  const subtypeIds = (subtype) => new Set(accounts.filter((a) => a.subtype === subtype).map((a) => a.id));
  const taxAccountIds = subtypeIds(INCOME_TAX_EXPENSE_SUBTYPE);
  const cogsAccountIds = subtypeIds(COST_OF_REVENUE_SUBTYPE);

  const centsOf = (rows) => Math.round(rows.reduce((sum, r) => sum + r.amount * 100, 0));

  const taxRows = allExpenses.rows.filter((r) => taxAccountIds.has(r.account_id));
  const cogsRows = allExpenses.rows.filter((r) => cogsAccountIds.has(r.account_id));
  const operatingRows = allExpenses.rows.filter((r) => !taxAccountIds.has(r.account_id) && !cogsAccountIds.has(r.account_id));

  const taxCents = centsOf(taxRows);
  const cogsCents = centsOf(cogsRows);
  // Derived by subtraction rather than by summing operatingRows so that the
  // three parts always add back to the total the ledger reported, with no
  // room for a rounding drift between them.
  const operatingCents = allExpenses.totalCents - taxCents - cogsCents;

  const grossProfitCents = revenue.totalCents - cogsCents;
  const preTaxCents = grossProfitCents - operatingCents;

  return {
    from,
    to,
    revenue: { accounts: revenue.rows, total: centsToDollars(revenue.totalCents) },
    cost_of_revenue: { accounts: cogsRows, total: centsToDollars(cogsCents) },
    gross_profit: centsToDollars(grossProfitCents),
    // Still named `expenses`, and still the same number for every org that
    // has posted nothing to a cost_of_revenue account -- which is every org
    // that existed before this subtype did. Same compatibility argument the
    // tax split made: a new classification nobody has used yet cannot move
    // an existing org's reported figures.
    expenses: { accounts: operatingRows, total: centsToDollars(operatingCents) },
    // Equal to income_before_taxes today, and kept as its own key anyway:
    // the moment a non-operating classification exists (interest, FX, a
    // one-off gain) they diverge, and the tax provision is defined against
    // pre-tax income specifically, not against operating income.
    operating_income: centsToDollars(preTaxCents),
    income_before_taxes: centsToDollars(preTaxCents),
    income_tax_expense: centsToDollars(taxCents),
    // Unchanged in meaning: revenue minus every expense including tax and
    // cost of revenue.
    net_income: centsToDollars(preTaxCents - taxCents),
  };
}

// Balance sheet as of a date: assets = liabilities + equity.
//
// The subtlety worth understanding: this app never posts period-closing
// entries (the traditional year-end move that sweeps revenue and expense
// balances into retained earnings and resets them to zero). Without that,
// revenue and expense accounts accumulate forever and are *not* part of
// any equity account -- so a naive assets-vs-liabilities+equity comparison
// would be off by exactly the cumulative net income, every time.
//
// Both earnings figures below are therefore derived rather than posted.
// That's not a shortcut: QuickBooks and Xero both compute current-year
// earnings the same way, because the year isn't over yet and there's
// nothing to close. Deriving the prior years too (instead of posting real
// closing entries) additionally means there's nothing to un-post if the
// fiscal year end is reconfigured later -- the split just moves.
//
// What the two lines mean, matching how every other GL presents them:
//   - retained_earnings: everything earned in FISCAL YEARS BEFORE the one
//     containing `asOf`. Settled history.
//   - current_year_earnings: the fiscal year in progress. This is the
//     figure that reconciles to a P&L run over the same fiscal year.
export async function computeBalanceSheet(orgId, { asOf = null } = {}) {
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);
  const org = await Organization.findByPk(orgId, { attributes: ["fiscalYearEndMonth"], raw: true });
  const fiscalYearEndMonth = org?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH;
  const fiscalYear = fiscalYearFor(asOfDate, fiscalYearEndMonth);

  const [allTime, currentYear] = await Promise.all([
    loadLines(orgId, { to: asOfDate }),
    loadLines(orgId, { from: fiscalYear.start, to: asOfDate }),
  ]);

  const totals = totalsByAccount(allTime.lines);
  const { accounts } = allTime;

  const assets = sectionFor(accounts, totals, "asset");
  const liabilities = sectionFor(accounts, totals, "liability");
  const equity = sectionFor(accounts, totals, "equity");

  // Cumulative earnings through asOf, then the slice of it belonging to
  // the fiscal year still in progress. Prior years are the remainder --
  // computed by subtraction rather than by a third query, so the two can
  // never disagree about where the year boundary falls.
  //
  // A formally closed year (yearEndClose.js) drops out of this on its own
  // and does not double-count, which is worth spelling out because it
  // looks like it should: the closing entry debits every revenue account
  // and credits every expense account by its balance, so that year's
  // contribution to `cumulativeEarningsCents` becomes exactly zero at the
  // same instant its net income lands in the Retained Earnings *account*
  // and starts being counted by `equity.totalCents` instead. The earnings
  // move from the derived half of this sum to the posted half; the total
  // never changes. So `retained_earnings` below covers prior years that
  // were never formally closed, and closed ones show as the account.
  const cumulativeEarningsCents =
    sectionFor(accounts, totals, "revenue").totalCents - sectionFor(accounts, totals, "expense").totalCents;

  const currentTotals = totalsByAccount(currentYear.lines);
  const currentYearEarningsCents =
    sectionFor(accounts, currentTotals, "revenue").totalCents - sectionFor(accounts, currentTotals, "expense").totalCents;

  const retainedEarningsCents = cumulativeEarningsCents - currentYearEarningsCents;
  const totalEquityCents = equity.totalCents + cumulativeEarningsCents;

  return {
    as_of: asOfDate,
    fiscal_year: {
      label: fiscalYear.label,
      start: fiscalYear.start,
      end: fiscalYear.end,
      // The cutoff retained earnings covers through, spelled out so the
      // UI can say "as of <date>" rather than making the user infer it.
      prior_years_through: dayBefore(fiscalYear.start),
    },
    assets: { accounts: assets.rows, total: centsToDollars(assets.totalCents) },
    liabilities: { accounts: liabilities.rows, total: centsToDollars(liabilities.totalCents) },
    equity: {
      accounts: equity.rows,
      // Both surfaced as their own labeled lines rather than folded
      // silently into the equity total -- an accountant reading this needs
      // to see where each came from, and current_year_earnings reconciles
      // directly to a P&L run over `fiscal_year`.
      retained_earnings: centsToDollars(retainedEarningsCents),
      current_year_earnings: centsToDollars(currentYearEarningsCents),
      total: centsToDollars(totalEquityCents),
    },
    total_liabilities_and_equity: centsToDollars(liabilities.totalCents + totalEquityCents),
    balanced: assets.totalCents === liabilities.totalCents + totalEquityCents,
  };
}

// Which accounts count as cash for the cash-flow statement. Matches the
// seeded "Cash" account's subtype (ledger.js's defaultAccountsFor) and the
// obvious manual equivalents, so an org that adds a second bank account
// with the same subtype is picked up without configuration.
const CASH_SUBTYPES = new Set(["bank", "cash"]);

function isCashAccount(account) {
  return account.type === "asset" && CASH_SUBTYPES.has(account.subtype);
}

// Cash flow for a period, direct method: every entry that moved cash,
// classified by what the cash moved against.
//
// Classification is per *line*, not per entry: an entry that touches cash
// once and three different counter-accounts gets each counter-account's
// amount attributed to its own category. Because the entry balances by
// construction, those attributed amounts always sum back to the cash
// movement exactly -- which is why net_change_in_cash below is guaranteed
// to reconcile against the cash accounts' own net movement, and the
// response says so explicitly rather than leaving it to be trusted.
//
// The indirect method (net income plus non-cash adjustments) is the one
// most SaaS finance teams actually present. It needs a working-capital
// story -- AR/AP period-over-period deltas -- and Rekono has no AR side
// yet, so the direct method is the honest version to ship first.
const CATEGORY_BY_COUNTER_TYPE = {
  revenue: "operating",
  expense: "operating",
  liability: "financing",
  equity: "financing",
  asset: "investing",
};

// Working-capital accounts, which the type-based rule above gets wrong.
// Accounts Receivable is an asset and Accounts Payable is a liability, so
// by type alone collecting from a customer would read as *investing* and
// paying a vendor as *financing*. Both are plainly operating activities --
// investing means buying and selling long-term assets, financing means
// raising and returning capital, and neither describes collecting what
// you're owed or settling what you owe. Matched on subtype, which
// ledger.js's seeded chart of accounts already sets on both.
const OPERATING_SUBTYPES = new Set(["accounts_receivable", "accounts_payable"]);

function cashFlowCategoryFor(account) {
  if (OPERATING_SUBTYPES.has(account.subtype)) return "operating";
  return CATEGORY_BY_COUNTER_TYPE[account.type] || "operating";
}

export async function computeCashFlow(orgId, { from = null, to = null } = {}) {
  const { accountsById, lines } = await loadLines(orgId, { from, to });

  // Group by entry so each cash line can see its counter-lines.
  const byEntry = new Map();
  for (const line of lines) {
    if (!byEntry.has(line.journalEntryId)) byEntry.set(line.journalEntryId, []);
    byEntry.get(line.journalEntryId).push(line);
  }

  const categories = { operating: 0, investing: 0, financing: 0 };
  let netCashCents = 0;

  for (const entryLines of byEntry.values()) {
    const cashLines = entryLines.filter((l) => isCashAccount(accountsById.get(l.accountId) || {}));
    if (!cashLines.length) continue; // this entry never touched cash

    netCashCents += cashLines.reduce((sum, l) => sum + (l.debitCents - l.creditCents), 0);

    for (const line of entryLines) {
      const account = accountsById.get(line.accountId);
      if (!account || isCashAccount(account)) continue;
      // A counter-line's effect on cash is the opposite of its own
      // debit/credit: cash going out (credit cash) pairs with a debit
      // somewhere else, and that debit is what the cash was spent on.
      const cashEffectCents = line.creditCents - line.debitCents;
      const category = cashFlowCategoryFor(account);
      categories[category] += cashEffectCents;
    }
  }

  const attributedCents = categories.operating + categories.investing + categories.financing;

  return {
    from,
    to,
    operating: centsToDollars(categories.operating),
    investing: centsToDollars(categories.investing),
    financing: centsToDollars(categories.financing),
    net_change_in_cash: centsToDollars(netCashCents),
    // Should always be true by construction (see the per-line note above)
    // -- surfaced anyway, on the same reasoning as the trial balance's own
    // `balanced` flag: a report that silently stops reconciling is worse
    // than one that says it stopped.
    reconciled: attributedCents === netCashCents,
  };
}
