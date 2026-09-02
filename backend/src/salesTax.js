// Sales tax collected on customer invoices, and its remittance.
//
// Not a tax calculation any more than incomeTax.js's provision is one: this
// multiplies each invoice's taxable lines by a flat rate the org supplies
// (Settings > Accounting), with no notion of jurisdiction, nexus, or
// product-specific exemptions. What it guarantees is that tax collected
// from a customer is never recognized as this org's own revenue -- it's a
// liability (money held on behalf of a state) from the moment the invoice
// is sent until it's remitted, which is the one thing a real accounting
// system cannot get wrong here even in a deliberately simple first pass.
//
// Unlike income tax, there's no separate "accrue a provision" step: the
// liability is already exactly right the instant an invoice posts, one
// invoice at a time, so remittance is the only action this file adds on
// top of what postCustomerInvoice (accountsReceivable.js) already does.

import { Op } from "sequelize";
import { LedgerError, postJournalEntry } from "./ledger.js";
import { Account, JournalEntry, JournalLine } from "./models/index.js";

export const SALES_TAX_PAYABLE_SUBTYPE = "sales_tax_payable";

// Created on demand, not seeded: an org that never charges sales tax
// shouldn't carry a permanently-zero liability account in its chart.
export async function ensureSalesTaxPayableAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "liability", subtype: SALES_TAX_PAYABLE_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "2300",
    name: "Sales Tax Payable",
    type: "liability",
    subtype: SALES_TAX_PAYABLE_SUBTYPE,
    isSystemAccount: true,
  });
}

// The tax on one invoice: the flat rate applied to whichever lines are
// marked taxable, rounded once against their summed total rather than
// line by line -- the same "round the whole, not the parts" rule
// receivables.js's own line-amount rounding follows, so a rounding
// difference can never make the invoice fail postCustomerInvoice's
// debit/credit check.
export function computeInvoiceTaxCents(ratePercent, lines) {
  if (!ratePercent) return 0;
  const taxableCents = lines.filter((l) => l.taxable !== false).reduce((sum, l) => sum + l.amountCents, 0);
  return Math.round((taxableCents * ratePercent) / 100);
}

// Sales Tax Payable's running balance: everything credited by invoices
// (see accountsReceivable.js's postCustomerInvoice) minus everything
// remitted below. Same shape as incomeTax.js's taxPayableCents.
export async function salesTaxPayableCents(orgId, { asOf = null } = {}) {
  const payable = await Account.findOne({ where: { orgId, type: "liability", subtype: SALES_TAX_PAYABLE_SUBTYPE } });
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

// Debit Sales Tax Payable / Credit [cash account]: money this org was
// always just holding, now handed to the state. Doesn't touch the P&L --
// the tax was never this org's revenue to begin with, so there's no
// expense to recognize here the way there is for an income tax payment.
export async function recordSalesTaxRemittance(orgId, { amountCents, paymentDate, cashAccountId, memo = "" }, { postedByUserId = null } = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new LedgerError("Enter an amount greater than zero.");

  const cash = await Account.findOne({ where: { id: cashAccountId, orgId } });
  if (!cash || cash.type !== "asset") {
    throw new LedgerError("The account the money left from must be an asset account you own.");
  }

  const payable = await ensureSalesTaxPayableAccount(orgId);
  const owed = await salesTaxPayableCents(orgId, { asOf: paymentDate });
  if (amountCents > owed) {
    throw new LedgerError(`Only ${(owed / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} of sales tax is accrued as of ${paymentDate}.`);
  }

  return postJournalEntry(orgId, {
    entryDate: paymentDate,
    memo: memo || "Sales tax remittance",
    source: "sales_tax_remittance",
    sourceType: "sales_tax_remittance",
    postedByUserId,
    lines: [
      { accountId: payable.id, debitCents: amountCents },
      { accountId: cash.id, creditCents: amountCents },
    ],
  });
}
