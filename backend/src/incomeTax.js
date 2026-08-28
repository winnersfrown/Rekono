// The income tax provision.
//
// The README has said for several releases that Rekono computes no tax,
// and that the defensible first step is booking a provision the user
// supplies rather than deriving one. This is that step, and the boundary
// is worth stating as plainly here as it is in the UI:
//
//   THIS IS NOT A TAX CALCULATION. It multiplies pre-tax book income by an
//   effective rate the user provides. It does not know about entity type,
//   multi-state apportionment, book-tax differences, deferred taxes,
//   valuation allowances, credits, or loss carryforwards. Every one of
//   those changes the real number. What this gives you is a provision
//   accrued on the books so the P&L isn't silently pre-tax and the balance
//   sheet isn't silently missing a liability -- not a return, and not
//   advice.
//
// Same stance stockCompensation.js takes with grant-date fair value: book
// the number the user brings, refuse to invent one.
//
// THE CIRCULARITY. A provision is a percentage of *pre-tax* income, so the
// base has to exclude income tax expense itself. Computing it against net
// income would feed the tax back into its own base -- post $10k of tax,
// income drops $10k, next run wants less tax, and it oscillates forever.
// preTaxIncomeCents below is the whole reason this module doesn't just
// call computeProfitAndLoss.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry } from "./ledger.js";
import { fiscalYearFor } from "./fiscalYear.js";
import { Account, JournalEntry, JournalLine, Organization } from "./models/index.js";

export const INCOME_TAX_EXPENSE_SUBTYPE = "income_tax_expense";
export const INCOME_TAXES_PAYABLE_SUBTYPE = "income_taxes_payable";

const ON_DEMAND = {
  [INCOME_TAX_EXPENSE_SUBTYPE]: { code: "6900", name: "Income Tax Expense", type: "expense" },
  [INCOME_TAXES_PAYABLE_SUBTYPE]: { code: "2400", name: "Income Taxes Payable", type: "liability" },
};

// Created on demand, not seeded: an org that never books a provision
// shouldn't carry two permanently-zero accounts in its chart.
export async function ensureTaxAccount(orgId, subtype) {
  const spec = ON_DEMAND[subtype];
  if (!spec) throw new LedgerError(`Unknown tax account subtype: ${subtype}`);
  const existing = await Account.findOne({ where: { orgId, type: spec.type, subtype } });
  if (existing) return existing;
  return Account.create({ orgId, ...spec, subtype, isSystemAccount: true });
}

export async function fiscalYearForOrg(orgId, date) {
  const org = await Organization.findOne({ where: { id: orgId } });
  return fiscalYearFor(date, org?.fiscalYearEndMonth ?? undefined);
}

// Revenue minus expenses over a period, with income tax expense left out
// of the expense side -- see the circularity note in this file's header.
//
// Year-end closing entries are excluded for the same reason the P&L
// excludes them: a closed year would otherwise report zero income and the
// provision would compute against nothing.
export async function preTaxIncomeCents(orgId, { from, to }) {
  const entryWhere = { orgId, entryDate: { [Op.gte]: from, [Op.lte]: to }, source: { [Op.ne]: "closing_entry" } };
  const entries = await JournalEntry.findAll({ where: entryWhere, attributes: ["id"], raw: true });
  if (!entries.length) return 0;

  const [accounts, lines] = await Promise.all([
    Account.findAll({ where: { orgId }, raw: true }),
    JournalLine.findAll({
      where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) } },
      attributes: ["accountId", "debitCents", "creditCents"],
      raw: true,
    }),
  ]);

  const byId = new Map(accounts.map((a) => [a.id, a]));
  let cents = 0;
  for (const line of lines) {
    const account = byId.get(line.accountId);
    if (!account) continue;
    if (account.subtype === INCOME_TAX_EXPENSE_SUBTYPE) continue;
    if (account.type === "revenue") cents += line.creditCents - line.debitCents;
    else if (account.type === "expense") cents -= line.debitCents - line.creditCents;
  }
  return cents;
}

// What has already been accrued inside a fiscal year, so a second run
// posts only the difference rather than the whole thing again.
async function postedProvisionCents(orgId, { from, to }) {
  const entries = await JournalEntry.findAll({
    where: { orgId, sourceType: "income_tax", entryDate: { [Op.gte]: from, [Op.lte]: to } },
    attributes: ["id"],
    raw: true,
  });
  if (!entries.length) return 0;

  const expense = await Account.findOne({ where: { orgId, type: "expense", subtype: INCOME_TAX_EXPENSE_SUBTYPE } });
  if (!expense) return 0;

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: expense.id },
    attributes: ["debitCents", "creditCents"],
    raw: true,
  });
  // Voided entries and their reversals both appear here and cancel, the
  // same way every other statement query in this app treats them.
  return lines.reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);
}

// The provision for the fiscal year containing `asOf`, at `ratePercent`.
//
// Cumulative-to-date rather than per-period, because that is how a real
// provision behaves: each quarter you recompute the full-year expectation
// and true up the difference. A quarter where income fell posts a negative
// increment, and that is correct, not an error to suppress.
export async function computeProvision(orgId, { asOf, ratePercent }) {
  if (!(ratePercent >= 0 && ratePercent <= 100)) {
    throw new LedgerError("The effective tax rate has to be between 0 and 100 percent.");
  }

  const year = await fiscalYearForOrg(orgId, asOf);
  // Never past the fiscal year end: a provision "as of" a date after the
  // year closed still only covers that year.
  const to = asOf < year.end ? asOf : year.end;

  const preTax = await preTaxIncomeCents(orgId, { from: year.start, to });
  const alreadyPosted = await postedProvisionCents(orgId, { from: year.start, to: year.end });

  // A loss produces no benefit. Booking one asserts the loss will shelter
  // future income -- a deferred tax asset, which is only recognizable if
  // you believe you'll be profitable enough to use it, and which most
  // companies at this stage offset with a full valuation allowance. That
  // judgment is not one this app can make on the user's behalf, so the
  // conservative floor is zero: accrue tax on profit, never a receivable
  // on a loss.
  const target = Math.max(Math.round((preTax * ratePercent) / 100), 0);

  return {
    fiscal_year: year.label,
    period_start: year.start,
    period_end: to,
    rate_percent: ratePercent,
    pre_tax_income: centsToDollars(preTax),
    provision: centsToDollars(target),
    already_posted: centsToDollars(alreadyPosted),
    // What a run would post right now. Negative means a true-up down.
    to_post: centsToDollars(target - alreadyPosted),
  };
}

// Accrues the provision: Debit Income Tax Expense / Credit Income Taxes
// Payable. No cash moves -- paying it is a separate event, below.
export async function recordProvision(orgId, { asOf, ratePercent, memo = "" }, { postedByUserId = null } = {}) {
  const preview = await computeProvision(orgId, { asOf, ratePercent });
  const deltaCents = Math.round(preview.to_post * 100);
  if (deltaCents === 0) return { entry: null, ...preview };

  const [expense, payable] = await Promise.all([
    ensureTaxAccount(orgId, INCOME_TAX_EXPENSE_SUBTYPE),
    ensureTaxAccount(orgId, INCOME_TAXES_PAYABLE_SUBTYPE),
  ]);

  // A true-up downwards flips the lines rather than posting a negative
  // amount -- the ledger requires every line to be a debit or a credit.
  const lines =
    deltaCents > 0
      ? [
          { accountId: expense.id, debitCents: deltaCents },
          { accountId: payable.id, creditCents: deltaCents },
        ]
      : [
          { accountId: payable.id, debitCents: -deltaCents },
          { accountId: expense.id, creditCents: -deltaCents },
        ];

  const entry = await postJournalEntry(orgId, {
    entryDate: preview.period_end,
    memo: memo || `Income tax provision -- ${preview.fiscal_year}`,
    source: "income_tax",
    sourceType: "income_tax",
    sourceId: preview.fiscal_year,
    postedByUserId,
    lines,
  });

  return { entry, ...preview };
}

// Paying the accrued tax: Debit Income Taxes Payable / Credit cash. The
// expense was already recognized when the provision was accrued, so this
// touches neither the P&L nor equity -- it settles a liability.
export async function recordTaxPayment(orgId, { amountCents, paymentDate, cashAccountId, memo = "" }, { postedByUserId = null } = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new LedgerError("Enter an amount greater than zero.");

  const cash = await Account.findOne({ where: { id: cashAccountId, orgId } });
  if (!cash || !["asset", "liability"].includes(cash.type)) {
    throw new LedgerError("The account the money left from must be an asset or liability account you own.");
  }
  if (cash.subtype === INCOME_TAXES_PAYABLE_SUBTYPE) {
    throw new LedgerError("Income Taxes Payable can't pay itself.");
  }

  const payable = await ensureTaxAccount(orgId, INCOME_TAXES_PAYABLE_SUBTYPE);
  const owed = await taxPayableCents(orgId, { asOf: paymentDate });
  if (amountCents > owed) {
    throw new LedgerError(
      `Only ${centsToDollars(owed).toLocaleString("en-US", { style: "currency", currency: "USD" })} of income tax is accrued as of ${paymentDate}.`
    );
  }

  return postJournalEntry(orgId, {
    entryDate: paymentDate,
    memo: memo || "Income tax paid",
    source: "income_tax",
    sourceType: "income_tax_payment",
    sourceId: paymentDate,
    postedByUserId,
    lines: [
      { accountId: payable.id, debitCents: amountCents },
      { accountId: cash.id, creditCents: amountCents },
    ],
  });
}

// The outstanding balance in Income Taxes Payable -- accrued minus paid.
export async function taxPayableCents(orgId, { asOf = null } = {}) {
  const payable = await Account.findOne({ where: { orgId, type: "liability", subtype: INCOME_TAXES_PAYABLE_SUBTYPE } });
  if (!payable) return 0;

  const entryWhere = { orgId };
  if (asOf) entryWhere.entryDate = { [Op.lte]: asOf };
  const entries = await JournalEntry.findAll({ where: entryWhere, attributes: ["id"], raw: true });
  if (!entries.length) return 0;

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: payable.id },
    attributes: ["debitCents", "creditCents"],
    raw: true,
  });
  return lines.reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);
}
