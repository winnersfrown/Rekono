// Accounts receivable: customer invoices, payments against them, and the
// aging report. The mirror image of the AP side this app started as --
// where an approved vendor invoice posts Debit expense / Credit Accounts
// Payable (ledger.js's postInvoiceApproval), issuing a customer invoice
// posts Debit Accounts Payable's opposite number, Accounts Receivable,
// against revenue.
//
// Everything that touches the ledger goes through ledger.js's
// postJournalEntry, so AR inherits the same guarantees as everything else:
// balanced entries only, closed periods refused, voids as reversals.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { createSchedulesForInvoice, ensureDeferredRevenueAccount, lineIsDeferred } from "./revenueRecognition.js";
import { ensureSalesTaxPayableAccount } from "./salesTax.js";
import {
  Account,
  BadDebtWriteOff,
  Customer,
  CustomerCreditMemo,
  CustomerCreditMemoApplication,
  CustomerInvoice,
  CustomerInvoiceLine,
  CustomerPayment,
  JournalEntry,
} from "./models/index.js";

// Sequential per org: INV-0001, INV-0002, ... Padded so they sort
// lexicographically for as long as it matters, and prefixed so an invoice
// number is recognizable on its own in an email or a bank memo.
//
// Derived from the highest existing number rather than a stored counter,
// which is a deliberate simplicity/robustness trade: a counter column
// would be exactly correct under concurrency but is one more thing to
// keep in sync, and two people creating an invoice in the same
// millisecond -- the only way this collides -- is not a realistic load
// for a single org's billing.
export async function nextInvoiceNumber(orgId) {
  const invoices = await CustomerInvoice.findAll({ where: { orgId }, attributes: ["invoiceNumber"], raw: true });
  let highest = 0;
  for (const { invoiceNumber } of invoices) {
    const match = /^INV-(\d+)$/.exec(invoiceNumber || "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `INV-${String(highest + 1).padStart(4, "0")}`;
}

// Sequential per org: CM-0001, CM-0002, ... Same derivation-from-history
// approach as nextInvoiceNumber, and for the same reason: a credit memo
// is cut rarely enough that a stored counter buys correctness no one
// needs at the cost of one more thing to keep in sync.
export async function nextCreditMemoNumber(orgId) {
  const memos = await CustomerCreditMemo.findAll({ where: { orgId }, attributes: ["creditNumber"], raw: true });
  let highest = 0;
  for (const { creditNumber } of memos) {
    const match = /^CM-(\d+)$/.exec(creditNumber || "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `CM-${String(highest + 1).padStart(4, "0")}`;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function findSystemAccount(orgId, type, subtype) {
  return Account.findOne({ where: { orgId, type, subtype } });
}

// Posts Debit Accounts Receivable / Credit each line's revenue account.
// One credit line per revenue account keeps the P&L's revenue section
// broken out the way the invoice itself was, rather than collapsing
// everything into a single lump.
//
// Called when a draft is sent, not when it's created -- a draft isn't a
// receivable yet, and shouldn't touch revenue.
export async function postCustomerInvoice(invoice, lines, { postedByUserId = null } = {}) {
  const arAccount = await findSystemAccount(invoice.orgId, "asset", "accounts_receivable");
  if (!arAccount) throw new LedgerError("No Accounts Receivable account found in the chart of accounts.", 409);

  const lineTotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const taxCents = invoice.taxCents || 0;
  if (lineTotalCents + taxCents !== invoice.totalCents) {
    // Should be impossible (routes recompute the total from the lines and
    // the tax on every write) -- caught here anyway because posting a
    // journal entry whose debit doesn't match what the invoice claims is
    // exactly the kind of drift that only shows up as an unexplained AR
    // variance months later.
    throw new LedgerError("This invoice's total doesn't match the sum of its lines and tax.");
  }

  // Credits collapsed per account: two lines billing the same account
  // produce one credit line, not two, which is how the entry would be
  // written by hand.
  //
  // A line with a service period credits Deferred Revenue rather than its
  // revenue account -- it's been billed but not yet earned, so on the day
  // the invoice goes out it's a liability (service owed), not income.
  // revenueRecognition.js releases it month by month from there. A line
  // with no service period is unchanged: point-in-time delivery is earned
  // when billed.
  const deferredLines = lines.filter(lineIsDeferred);
  const deferredAccount = deferredLines.length ? await ensureDeferredRevenueAccount(invoice.orgId) : null;

  const creditsByAccount = new Map();
  for (const line of lines) {
    const accountId = lineIsDeferred(line) ? deferredAccount.id : line.revenueAccountId;
    creditsByAccount.set(accountId, (creditsByAccount.get(accountId) || 0) + line.amountCents);
  }

  // Tax collected is never this org's revenue -- it's a liability from the
  // moment it's billed, same reasoning a billed-but-unearned line credits
  // Deferred Revenue above rather than revenue.
  if (taxCents > 0) {
    const taxAccount = await ensureSalesTaxPayableAccount(invoice.orgId);
    creditsByAccount.set(taxAccount.id, (creditsByAccount.get(taxAccount.id) || 0) + taxCents);
  }

  return postJournalEntry(invoice.orgId, {
    entryDate: invoice.issueDate,
    memo: `${invoice.invoiceNumber} -- ${invoice.customerName || "Customer"}`,
    docNumber: invoice.invoiceNumber || "",
    source: "customer_invoice",
    sourceType: "customer_invoice",
    sourceId: invoice.id,
    postedByUserId,
    lines: [
      { accountId: arAccount.id, debitCents: invoice.totalCents },
      ...[...creditsByAccount].map(([accountId, creditCents]) => ({ accountId, creditCents })),
    ],
  });
}

// Posts Debit [deposit account] / Credit Accounts Receivable -- cash in,
// receivable cleared. Dated to the payment date rather than today, so the
// cash flow statement attributes it to the period the money actually
// arrived in.
export async function postCustomerPayment(payment, invoice, { postedByUserId = null } = {}) {
  const arAccount = await findSystemAccount(invoice.orgId, "asset", "accounts_receivable");
  if (!arAccount) throw new LedgerError("No Accounts Receivable account found in the chart of accounts.", 409);

  return postJournalEntry(invoice.orgId, {
    entryDate: payment.paymentDate,
    memo: `Payment on ${invoice.invoiceNumber}`,
    source: "customer_payment",
    sourceType: "customer_payment",
    sourceId: payment.id,
    postedByUserId,
    lines: [
      { accountId: payment.depositAccountId, debitCents: payment.amountCents },
      { accountId: arAccount.id, creditCents: payment.amountCents },
    ],
  });
}

// Posts Debit each line's revenue account (+ Debit Sales Tax Payable, for
// the tax portion) / Credit Accounts Receivable -- the mirror image of
// postCustomerInvoice. A credit memo reduces revenue and what the
// customer owes; it never touches Deferred Revenue, even when it's
// crediting back something originally billed on a service period (see
// CustomerCreditMemo.js) -- by the time someone cuts a credit, working
// out how much of the original line was already recognized versus still
// deferred is a judgment call this app isn't in a position to make
// silently, so it books the credit against revenue directly and leaves
// any deferred-revenue correction to a manual journal entry.
export async function postCustomerCreditMemo(creditMemo, lines, { postedByUserId = null } = {}) {
  const arAccount = await findSystemAccount(creditMemo.orgId, "asset", "accounts_receivable");
  if (!arAccount) throw new LedgerError("No Accounts Receivable account found in the chart of accounts.", 409);

  const lineTotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const taxCents = creditMemo.taxCents || 0;
  if (lineTotalCents + taxCents !== creditMemo.totalCents) {
    throw new LedgerError("This credit memo's total doesn't match the sum of its lines and tax.");
  }

  const debitsByAccount = new Map();
  for (const line of lines) {
    debitsByAccount.set(line.revenueAccountId, (debitsByAccount.get(line.revenueAccountId) || 0) + line.amountCents);
  }
  if (taxCents > 0) {
    const taxAccount = await ensureSalesTaxPayableAccount(creditMemo.orgId);
    debitsByAccount.set(taxAccount.id, (debitsByAccount.get(taxAccount.id) || 0) + taxCents);
  }

  return postJournalEntry(creditMemo.orgId, {
    entryDate: creditMemo.issueDate,
    memo: `${creditMemo.creditNumber} -- ${creditMemo.customerName || "Customer"}`,
    docNumber: creditMemo.creditNumber || "",
    source: "customer_credit_memo",
    sourceType: "customer_credit_memo",
    sourceId: creditMemo.id,
    postedByUserId,
    lines: [
      ...[...debitsByAccount].map(([accountId, debitCents]) => ({ accountId, debitCents })),
      { accountId: arAccount.id, creditCents: creditMemo.totalCents },
    ],
  });
}

// Reverses whatever a credit memo posted, if anything. Same
// (sourceType, sourceId) lookup as voidCustomerInvoiceEntry.
export async function voidCustomerCreditMemoEntry(orgId, customerCreditMemoId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "customer_credit_memo", sourceId: customerCreditMemoId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

// How much of a credit memo has already been used against invoices.
export async function amountAppliedFromCreditMemoCents(customerCreditMemoId) {
  const applications = await CustomerCreditMemoApplication.findAll({
    where: { customerCreditMemoId },
    attributes: ["amountCents"],
    raw: true,
  });
  return applications.reduce((sum, a) => sum + a.amountCents, 0);
}

// What's left of a credit memo to apply to some invoice -- 0 once fully
// used, and always 0 for a void memo (nothing left to give: the credit
// itself was reversed).
export async function unappliedCreditMemoCents(creditMemo) {
  if (creditMemo.status === "void") return 0;
  return creditMemo.totalCents - (await amountAppliedFromCreditMemoCents(creditMemo.id));
}

// How much of an invoice's balance has been offset by credit memos --
// the credit-memo equivalent of amountPaidCents, and added to it
// everywhere an invoice's outstanding balance is computed, so a customer
// who was credited instead of refunded doesn't sit on the aging report
// forever.
export async function amountCreditedCents(customerInvoiceId) {
  const applications = await CustomerCreditMemoApplication.findAll({
    where: { customerInvoiceId },
    attributes: ["amountCents"],
    raw: true,
  });
  return applications.reduce((sum, a) => sum + a.amountCents, 0);
}

// Applies (part of) a credit memo against a specific invoice. Posts no
// journal entry of its own -- see CustomerCreditMemoApplication.js for
// why the money already moved when the memo was issued -- so this is
// pure validation plus a row, the same shape a payment would be if
// payments needed no ledger entry.
export async function applyCreditMemoToInvoice(creditMemo, invoice, amountCents, appliedDate) {
  if (creditMemo.status === "void") throw new LedgerError("This credit memo has been voided.");
  if (creditMemo.customerId !== invoice.customerId) {
    throw new LedgerError("A credit memo can only be applied to an invoice for the same customer.");
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new LedgerError("Enter an amount greater than zero.");

  const available = await unappliedCreditMemoCents(creditMemo);
  if (amountCents > available) {
    throw new LedgerError(`This credit memo only has ${centsToDollars(available)} left unapplied.`);
  }

  const alreadyOwed =
    invoice.totalCents -
    (await amountPaidCents(invoice.id)) -
    (await amountCreditedCents(invoice.id)) -
    (await amountWrittenOffCents(invoice.id));
  if (amountCents > alreadyOwed) {
    throw new LedgerError(`That would over-apply the credit. This invoice only has ${centsToDollars(alreadyOwed)} outstanding.`);
  }

  const application = await CustomerCreditMemoApplication.create({
    orgId: creditMemo.orgId,
    customerCreditMemoId: creditMemo.id,
    customerInvoiceId: invoice.id,
    amountCents,
    appliedDate,
  });
  await refreshInvoiceStatus(invoice);
  return application;
}

// Draft -> sent, the moment an invoice becomes a real receivable. Posts
// the ledger entry, creates any deferred-revenue schedule its lines need,
// and marks the invoice sent -- the exact three steps the manual "Send"
// route performs, factored out so a recurring invoice's auto-send does the
// identical thing rather than a second, drift-prone copy of it. Mutates
// and saves `invoice`; the caller is responsible for the "already sent"
// guard, since that check differs slightly between a fresh draft and a
// just-created recurring occurrence.
export async function sendCustomerInvoice(invoice, lines, { postedByUserId = null } = {}) {
  await postCustomerInvoice({ ...invoice.get(), customerName: invoice.customer?.name }, lines, { postedByUserId });

  // Only after the posting succeeded -- a schedule for an invoice whose
  // journal entry was refused would plan revenue against a receivable
  // that never landed.
  await createSchedulesForInvoice(invoice, lines);

  invoice.status = "sent";
  invoice.sentAt = new Date();
  await invoice.save();
  return invoice;
}

// Reverses whatever a customer invoice posted, if anything. Looked up by
// (sourceType, sourceId) rather than a column on the invoice, same
// approach ledger.js's voidInvoiceJournalEntry uses for the AP side.
export async function voidCustomerInvoiceEntry(orgId, customerInvoiceId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "customer_invoice", sourceId: customerInvoiceId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

export async function amountPaidCents(customerInvoiceId) {
  const payments = await CustomerPayment.findAll({
    where: { customerInvoiceId },
    attributes: ["amountCents"],
    raw: true,
  });
  return payments.reduce((sum, p) => sum + p.amountCents, 0);
}

export const BAD_DEBT_EXPENSE_SUBTYPE = "bad_debt_expense";

// The Bad Debt Expense account, created on demand -- same pattern as
// ensureDeferredRevenueAccount, for an org that predates this release.
export async function ensureBadDebtExpenseAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "expense", subtype: BAD_DEBT_EXPENSE_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "5900",
    name: "Bad Debt Expense",
    type: "expense",
    subtype: BAD_DEBT_EXPENSE_SUBTYPE,
    isSystemAccount: true,
  });
}

// How much of an invoice's balance has been recognized as uncollectible --
// the write-off equivalent of amountPaidCents, added alongside it and
// amountCreditedCents everywhere an invoice's outstanding balance is
// computed, so a written-off invoice drops off AR aging the same way a
// paid one does.
export async function amountWrittenOffCents(customerInvoiceId) {
  const writeOffs = await BadDebtWriteOff.findAll({
    where: { customerInvoiceId },
    attributes: ["amountCents"],
    raw: true,
  });
  return writeOffs.reduce((sum, w) => sum + w.amountCents, 0);
}

// Posts Debit Bad Debt Expense / Credit Accounts Receivable -- the
// balance is gone from AR, but revenue stays exactly as billed. See
// BadDebtWriteOff.js for why this is not modeled as a void.
export async function postBadDebtWriteOff(writeOff, invoice, { postedByUserId = null } = {}) {
  const arAccount = await findSystemAccount(invoice.orgId, "asset", "accounts_receivable");
  if (!arAccount) throw new LedgerError("No Accounts Receivable account found in the chart of accounts.", 409);
  const badDebtAccount = await ensureBadDebtExpenseAccount(invoice.orgId);

  return postJournalEntry(invoice.orgId, {
    entryDate: writeOff.writeOffDate,
    memo: `Write-off -- ${invoice.invoiceNumber}`,
    source: "bad_debt_write_off",
    sourceType: "bad_debt_write_off",
    sourceId: writeOff.id,
    postedByUserId,
    lines: [
      { accountId: badDebtAccount.id, debitCents: writeOff.amountCents },
      { accountId: arAccount.id, creditCents: writeOff.amountCents },
    ],
  });
}

// Records and posts a write-off in one step, unwinding the row if the
// ledger refuses -- same recoverable-on-refusal shape recordBillPayment
// uses on the AP side. Only a sent (or already-partly-settled) invoice has
// a receivable balance worth writing off; a draft never posted one and a
// void already reversed it.
export async function writeOffInvoice(invoice, { amountCents, writeOffDate, memo = "", postedByUserId = null } = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new LedgerError("Enter an amount greater than zero.");

  const alreadySettled =
    (await amountPaidCents(invoice.id)) + (await amountCreditedCents(invoice.id)) + (await amountWrittenOffCents(invoice.id));
  const outstandingCents = invoice.totalCents - alreadySettled;
  if (amountCents > outstandingCents) {
    throw new LedgerError(`That would over-write-off this invoice. It only has ${centsToDollars(outstandingCents)} outstanding.`);
  }

  const writeOff = await BadDebtWriteOff.create({
    orgId: invoice.orgId,
    customerInvoiceId: invoice.id,
    amountCents,
    writeOffDate,
    memo,
  });

  try {
    await postBadDebtWriteOff(writeOff, invoice, { postedByUserId });
  } catch (err) {
    await writeOff.destroy();
    throw err;
  }

  await refreshInvoiceStatus(invoice);
  return writeOff;
}

// A sent invoice becomes "paid" once payments, applied credits, and
// write-offs together cover it, and drops back to "sent" if any is later
// removed. Derived rather than set by hand, so the two can't disagree.
export async function refreshInvoiceStatus(invoice) {
  if (!["sent", "paid"].includes(invoice.status)) return invoice;
  const settled =
    (await amountPaidCents(invoice.id)) + (await amountCreditedCents(invoice.id)) + (await amountWrittenOffCents(invoice.id));
  const nextStatus = settled >= invoice.totalCents ? "paid" : "sent";
  if (invoice.status !== nextStatus) {
    invoice.status = nextStatus;
    await invoice.save();
  }
  return invoice;
}

// Standard AR aging buckets. "Current" means not yet due -- everything
// else is counted from the due date, not the issue date, which is what
// makes this a collections tool rather than just a list sorted by age.
const AGING_BUCKETS = [
  { key: "current", label: "Current", min: -Infinity, max: 0 },
  { key: "d1_30", label: "1-30 days", min: 1, max: 30 },
  { key: "d31_60", label: "31-60 days", min: 31, max: 60 },
  { key: "d61_90", label: "61-90 days", min: 61, max: 90 },
  { key: "d90_plus", label: "90+ days", min: 91, max: Infinity },
];

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

// Who owes what, bucketed by how far past due. Only `sent` invoices count
// -- a draft isn't a receivable, a paid one is settled, and a void one
// never happened.
export async function computeArAging(orgId, { asOf = null } = {}) {
  const asOfDate = asOf || todayIso();

  const invoices = await CustomerInvoice.findAll({
    where: { orgId, status: "sent", issueDate: { [Op.lte]: asOfDate } },
    include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
  });

  const byCustomer = new Map();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
  let grandTotalCents = 0;

  for (const invoice of invoices) {
    const outstandingCents =
      invoice.totalCents -
      (await amountPaidCents(invoice.id)) -
      (await amountCreditedCents(invoice.id)) -
      (await amountWrittenOffCents(invoice.id));
    if (outstandingCents <= 0) continue; // fully settled but not yet re-statused

    const daysPastDue = daysBetween(invoice.dueDate, asOfDate);
    const bucket = AGING_BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);

    const customerId = invoice.customerId;
    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, {
        customer_id: customerId,
        customer_name: invoice.customer?.name || "(unknown customer)",
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])),
        total: 0,
      });
    }
    const row = byCustomer.get(customerId);
    row[bucket.key] += outstandingCents;
    row.total += outstandingCents;
    totals[bucket.key] += outstandingCents;
    grandTotalCents += outstandingCents;
  }

  return {
    as_of: asOfDate,
    buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    customers: [...byCustomer.values()]
      .map((row) => ({
        ...row,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, centsToDollars(row[b.key])])),
        total: centsToDollars(row.total),
      }))
      .sort((a, b) => b.total - a.total),
    totals: {
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, centsToDollars(totals[b.key])])),
      total: centsToDollars(grandTotalCents),
    },
  };
}

// A customer's own AR activity over a period, with a running balance --
// what a collections call or a "here's what you owe" email needs, as
// opposed to computeArAging's org-wide, point-in-time view.
//
// Built from the three sources that actually move a customer's AR
// balance, each dated to when it did: an invoice at its issueDate (Debit
// AR), a payment at its paymentDate (Credit AR), and a credit memo at its
// own issueDate -- not whichever invoice it was later applied to, since
// postCustomerCreditMemo credits AR the moment the memo posts, same as
// the ledger itself would show. Draft and void invoices, and void credit
// memos, never touched AR and are excluded, same as computeArAging.
export async function computeCustomerStatement(orgId, customerId, { from, to } = {}) {
  const customer = await Customer.findOne({ where: { id: customerId, orgId } });
  if (!customer) return null;

  const toDate = to || todayIso();
  const fromDate = from || "0000-01-01";

  const invoices = await CustomerInvoice.findAll({
    where: { orgId, customerId, status: { [Op.in]: ["sent", "paid"] } },
  });
  const invoiceIds = invoices.map((i) => i.id);

  const [payments, credits, writeOffs] = await Promise.all([
    invoiceIds.length
      ? CustomerPayment.findAll({ where: { orgId, customerInvoiceId: { [Op.in]: invoiceIds } } })
      : [],
    CustomerCreditMemo.findAll({ where: { orgId, customerId, status: "issued" } }),
    invoiceIds.length
      ? BadDebtWriteOff.findAll({ where: { orgId, customerInvoiceId: { [Op.in]: invoiceIds } } })
      : [],
  ]);

  const events = [
    ...invoices.map((i) => ({
      date: i.issueDate,
      type: "invoice",
      description: `Invoice ${i.invoiceNumber}`,
      amountCents: i.totalCents,
    })),
    ...payments.map((p) => ({
      date: p.paymentDate,
      type: "payment",
      description: "Payment received",
      amountCents: -p.amountCents,
    })),
    ...credits.map((c) => ({
      date: c.issueDate,
      type: "credit_memo",
      description: `Credit memo ${c.creditNumber}`,
      amountCents: -c.totalCents,
    })),
    ...writeOffs.map((w) => ({
      date: w.writeOffDate,
      type: "write_off",
      description: "Written off",
      amountCents: -w.amountCents,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const openingCents = events
    .filter((e) => e.date < fromDate)
    .reduce((sum, e) => sum + e.amountCents, 0);

  let runningCents = openingCents;
  const activity = events
    .filter((e) => e.date >= fromDate && e.date <= toDate)
    .map((e) => {
      runningCents += e.amountCents;
      return {
        date: e.date,
        type: e.type,
        description: e.description,
        amount: centsToDollars(e.amountCents),
        balance: centsToDollars(runningCents),
      };
    });

  return {
    customer_id: customer.id,
    customer_name: customer.name,
    from: fromDate === "0000-01-01" ? null : fromDate,
    to: toDate,
    opening_balance: centsToDollars(openingCents),
    closing_balance: centsToDollars(runningCents),
    activity,
  };
}
