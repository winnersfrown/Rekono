// The three financial statements, computed from ledger.js's journal lines:
// profit & loss, balance sheet, and cash flow. Phase 2 of the accounting
// pivot -- v1.20 built the general ledger these are all views over, and
// nothing here adds a new table or a new write path. Every figure traces
// back to posted journal lines; there are no derived-and-stored balances
// to drift out of sync with the ledger.

import { Op } from "sequelize";
import { Account, JournalEntry, JournalLine } from "./models/index.js";
import { centsToDollars } from "./ledger.js";

// Which side of an account increases it. Assets and expenses are
// debit-normal (a debit makes them bigger); liabilities, equity, and
// revenue are credit-normal. Getting this wrong is the classic way a
// statement comes out sign-flipped, so it lives in one place rather than
// being re-derived per report.
const DEBIT_NORMAL_TYPES = new Set(["asset", "expense"]);

function normalBalanceCents(type, debitCents, creditCents) {
  return DEBIT_NORMAL_TYPES.has(type) ? debitCents - creditCents : creditCents - debitCents;
}

// One shared read: every posted journal line in a date window, joined to
// the account it hits. `from` is optional -- the balance sheet is a
// point-in-time snapshot of everything up to `to`, while the P&L and cash
// flow cover a bounded period.
async function loadLines(orgId, { from = null, to = null } = {}) {
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

// Profit & loss for a period: revenue earned minus expenses incurred.
// A period report, not a snapshot -- `from`/`to` bound it, and unlike the
// balance sheet nothing carries in from before `from`.
export async function computeProfitAndLoss(orgId, { from = null, to = null } = {}) {
  const { accounts, lines } = await loadLines(orgId, { from, to });
  const totals = totalsByAccount(lines);

  const revenue = sectionFor(accounts, totals, "revenue");
  const expenses = sectionFor(accounts, totals, "expense");
  const netIncomeCents = revenue.totalCents - expenses.totalCents;

  return {
    from,
    to,
    revenue: { accounts: revenue.rows, total: centsToDollars(revenue.totalCents) },
    expenses: { accounts: expenses.rows, total: centsToDollars(expenses.totalCents) },
    net_income: centsToDollars(netIncomeCents),
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
// Rather than posting closing entries (which would mean picking a fiscal
// year end, and making entries the user never asked for), retained
// earnings is computed here: cumulative revenue minus cumulative expenses
// through `as_of`, presented as its own equity line. That's the same
// number a closing entry would have moved, arrived at by derivation
// instead of by mutation -- so the statement balances, the ledger stays
// untouched, and there's nothing to un-post if the fiscal year is later
// configured differently.
export async function computeBalanceSheet(orgId, { asOf = null } = {}) {
  const { accounts, lines } = await loadLines(orgId, { to: asOf });
  const totals = totalsByAccount(lines);

  const assets = sectionFor(accounts, totals, "asset");
  const liabilities = sectionFor(accounts, totals, "liability");
  const equity = sectionFor(accounts, totals, "equity");
  const revenue = sectionFor(accounts, totals, "revenue");
  const expenses = sectionFor(accounts, totals, "expense");

  const retainedEarningsCents = revenue.totalCents - expenses.totalCents;
  const totalEquityCents = equity.totalCents + retainedEarningsCents;

  return {
    as_of: asOf,
    assets: { accounts: assets.rows, total: centsToDollars(assets.totalCents) },
    liabilities: { accounts: liabilities.rows, total: centsToDollars(liabilities.totalCents) },
    equity: {
      accounts: equity.rows,
      // Surfaced as its own labeled line rather than folded silently into
      // the equity total -- an accountant looking at this needs to see
      // where it came from, and it reconciles directly to the P&L's
      // net income for the same window.
      retained_earnings: centsToDollars(retainedEarningsCents),
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
      const category = CATEGORY_BY_COUNTER_TYPE[account.type] || "operating";
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
