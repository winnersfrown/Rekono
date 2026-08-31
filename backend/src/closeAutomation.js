// Close automation: noticing what a close is missing.
//
// The close checklist Rekono already had (routes/close.js's
// readinessChecks) asks document-workflow questions -- are the invoices
// reviewed, is anything still extracting, is approved spend matched. Every
// one of those looks at the queue. None of them looks at the *ledger*, so
// the failure that actually matters at month-end goes unnoticed: the month
// where rent simply never got posted.
//
// That is the gap this closes. Two suggestions, both derived from what the
// books already say rather than from anything the user had to configure:
//
//   1. An expense that has posted every month and didn't this month.
//   2. A fixed asset sitting on the balance sheet with nothing depreciating
//      it.
//
// Both are *suggestions*. Neither posts anything, and neither blocks a
// close -- routes/close.js's own comment is right that a close is a human
// attestation and there are legitimate reasons to sign off with a known
// exception. The job here is to make sure the exception is one somebody
// actually saw.

import { Op } from "sequelize";
import { centsToDollars } from "./ledger.js";
import { straightLineDepreciationCents } from "./recurringEntries.js";
import { previewRecurringEntries } from "./recurringEntries.js";
import { Account, FixedAsset, JournalEntry, JournalLine, RecurringEntry, RecurringEntryLine } from "./models/index.js";

// How far back to look for a pattern, and how much of that window an
// expense has to fill before its absence counts as a suggestion.
//
// Three of four, not four of four: an expense that skipped one month
// earlier in the window is still plainly a monthly expense, and demanding
// a perfect run would silence exactly the accounts most worth watching.
// Two of four is not a pattern, it's a coincidence.
const PATTERN_WINDOW_MONTHS = 4;
const PATTERN_MIN_MONTHS = 3;

// A default only for the suggested figure, never for a posting. Five years
// is the common convention for equipment; the user picks the real life.
const DEFAULT_USEFUL_LIFE_MONTHS = 60;

// Assets that are not "fixed assets" in the sense that gets depreciated.
// Cash and receivables are the obvious ones; anything an org adds itself
// with no subtype is left in, since a bare `asset` account with a large
// balance is exactly the case worth asking about.
const NON_DEPRECIABLE_ASSET_SUBTYPES = new Set(["bank", "cash", "accounts_receivable"]);

function previousMonth(month, back = 1) {
  let [y, m] = month.split("-").map(Number);
  m -= back;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

// The median, not the mean. One anomalous month -- a double payment, a
// catch-up -- shouldn't drag the "what you'd expect" figure with it, and
// the median is the whole reason to bother collecting the amounts rather
// than just counting the months.
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Per-account, per-month debit-minus-credit totals across a date range.
async function monthlyActivity(orgId, { from, to }) {
  const entries = await JournalEntry.findAll({
    where: {
      orgId,
      entryDate: { [Op.gte]: from, [Op.lte]: to },
      // A closing entry zeroes every expense account, which would read as
      // a month of enormous activity followed by silence. Excluded for the
      // same reason the P&L excludes it.
      source: { [Op.ne]: "closing_entry" },
    },
    attributes: ["id", "entryDate"],
    raw: true,
  });
  if (!entries.length) return new Map();

  const monthByEntry = new Map(entries.map((e) => [e.id, e.entryDate.slice(0, 7)]));
  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) } },
    attributes: ["journalEntryId", "accountId", "debitCents", "creditCents"],
    raw: true,
  });

  // accountId -> month -> net cents
  const byAccount = new Map();
  for (const line of lines) {
    const month = monthByEntry.get(line.journalEntryId);
    if (!month) continue;
    if (!byAccount.has(line.accountId)) byAccount.set(line.accountId, new Map());
    const months = byAccount.get(line.accountId);
    months.set(month, (months.get(month) ?? 0) + line.debitCents - line.creditCents);
  }
  return byAccount;
}

// An expense that posted in most of the preceding months and not in this
// one.
//
// Expenses only, deliberately. A revenue account with nothing in it is a
// slow month, which is a business fact and not a bookkeeping omission;
// assets and liabilities move irregularly by their nature. Rent, payroll,
// software, insurance -- the things that recur and get forgotten -- are
// all expenses.
export async function suggestMissingExpenses(orgId, periodMonth) {
  const windowStart = monthBounds(previousMonth(periodMonth, PATTERN_WINDOW_MONTHS)).start;
  const { end } = monthBounds(periodMonth);

  const [accounts, activity, duePreview] = await Promise.all([
    Account.findAll({ where: { orgId, type: "expense" }, raw: true }),
    monthlyActivity(orgId, { from: windowStart, to: end }),
    // A template that is already due and unposted is reported by the
    // recurring-entries preview, which can also *post* it. Reporting the
    // same rent through two mechanisms would have the user chasing one
    // problem twice.
    previewRecurringEntries(orgId, end),
  ]);

  // The preview reports templates, not accounts, so the account ids come
  // from a second read against the due template ids.
  const dueAccountIds = new Set();
  const dueTemplateIds = (duePreview?.items ?? []).map((i) => i.id);
  if (dueTemplateIds.length) {
    const dueLines = await RecurringEntryLine.findAll({
      where: { recurringEntryId: { [Op.in]: dueTemplateIds } },
      attributes: ["accountId"],
      raw: true,
    });
    for (const line of dueLines) dueAccountIds.add(line.accountId);
  }

  const priorMonths = [];
  for (let i = PATTERN_WINDOW_MONTHS; i >= 1; i -= 1) priorMonths.push(previousMonth(periodMonth, i));

  const suggestions = [];
  for (const account of accounts) {
    if (dueAccountIds.has(account.id)) continue;

    const months = activity.get(account.id) ?? new Map();
    const present = priorMonths.filter((m) => (months.get(m) ?? 0) !== 0);
    if (present.length < PATTERN_MIN_MONTHS) continue;
    if ((months.get(periodMonth) ?? 0) !== 0) continue;

    const amounts = present.map((m) => months.get(m));
    suggestions.push({
      type: "missing_expense",
      account_id: account.id,
      account_code: account.code,
      account_name: account.name,
      months_seen: present.length,
      window_months: PATTERN_WINDOW_MONTHS,
      last_seen: present[present.length - 1],
      typical_amount: centsToDollars(median(amounts)),
      detail:
        `${account.name} posted in ${present.length} of the last ${PATTERN_WINDOW_MONTHS} months ` +
        `(typically ${centsToDollars(median(amounts)).toLocaleString("en-US", { style: "currency", currency: "USD" })}) ` +
        `and has nothing in ${periodMonth}.`,
    });
  }

  return suggestions.sort((a, b) => b.typical_amount - a.typical_amount);
}

// A fixed asset with nothing depreciating it.
//
// Deliberately a question rather than an assertion. Land is never
// depreciated, an asset bought this month may not be in service yet, and a
// deposit sitting in an asset account isn't a fixed asset at all. What the
// suggestion carries is the arithmetic already done, so saying "yes, 60
// months" is one step rather than a spreadsheet.
export async function suggestDepreciation(orgId, periodMonth) {
  const { end } = monthBounds(periodMonth);

  const accounts = await Account.findAll({ where: { orgId, type: "asset" }, raw: true });
  const candidates = accounts.filter((a) => !NON_DEPRECIABLE_ASSET_SUBTYPES.has(a.subtype));
  if (!candidates.length) return [];

  const entries = await JournalEntry.findAll({
    where: { orgId, entryDate: { [Op.lte]: end } },
    attributes: ["id"],
    raw: true,
  });
  if (!entries.length) return [];

  const [lines, templates] = await Promise.all([
    JournalLine.findAll({
      where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: { [Op.in]: candidates.map((a) => a.id) } },
      attributes: ["accountId", "debitCents", "creditCents"],
      raw: true,
    }),
    RecurringEntry.findAll({ where: { orgId }, attributes: ["id"], raw: true }),
  ]);

  // Any recurring template touching the account counts as "already
  // handled" -- that is what a depreciation schedule looks like in this
  // app, and a template posting against the asset is evidence somebody
  // already thought about it.
  //
  // Read as two id-scoped queries rather than one join, matching how
  // routes/close.js and routes/dashboard.js already do this: the join
  // shape differs enough between SQLite and Postgres to be worth avoiding.
  const scheduled = new Set();
  if (templates.length) {
    const templateLines = await RecurringEntryLine.findAll({
      where: { recurringEntryId: { [Op.in]: templates.map((t) => t.id) } },
      attributes: ["accountId"],
      raw: true,
    });
    for (const line of templateLines) scheduled.add(line.accountId);
  }
  // A FixedAsset's own depreciation entry never touches the asset account
  // itself (a real entry only moves Depreciation Expense and Accumulated
  // Depreciation), so the template-lines check above can never see it --
  // this asset needs its own lookup, checked directly against
  // assetAccountId rather than through the template's lines.
  const fixedAssets = await FixedAsset.findAll({
    where: { orgId, assetAccountId: { [Op.in]: candidates.map((a) => a.id) } },
    attributes: ["assetAccountId"],
    raw: true,
  });
  for (const fa of fixedAssets) scheduled.add(fa.assetAccountId);

  const balances = new Map();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.debitCents - line.creditCents);
  }

  const suggestions = [];
  for (const account of candidates) {
    if (scheduled.has(account.id)) continue;
    const balanceCents = balances.get(account.id) ?? 0;
    if (balanceCents <= 0) continue;

    const monthlyCents = straightLineDepreciationCents(balanceCents, 0, DEFAULT_USEFUL_LIFE_MONTHS);
    suggestions.push({
      type: "undepreciated_asset",
      account_id: account.id,
      account_code: account.code,
      account_name: account.name,
      balance: centsToDollars(balanceCents),
      suggested_useful_life_months: DEFAULT_USEFUL_LIFE_MONTHS,
      suggested_monthly_amount: centsToDollars(monthlyCents),
      detail:
        `${account.name} holds ${centsToDollars(balanceCents).toLocaleString("en-US", { style: "currency", currency: "USD" })} ` +
        `and no recurring entry posts against it. At ${DEFAULT_USEFUL_LIFE_MONTHS} months straight-line that would be ` +
        `${centsToDollars(monthlyCents).toLocaleString("en-US", { style: "currency", currency: "USD" })} a month.`,
    });
  }

  return suggestions.sort((a, b) => b.balance - a.balance);
}

export async function suggestionsFor(orgId, periodMonth) {
  const [missing, depreciation] = await Promise.all([
    suggestMissingExpenses(orgId, periodMonth),
    suggestDepreciation(orgId, periodMonth),
  ]);
  return [...missing, ...depreciation];
}
