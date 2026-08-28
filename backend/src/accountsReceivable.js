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
import { ensureDeferredRevenueAccount, lineIsDeferred } from "./revenueRecognition.js";
import {
  Account,
  Customer,
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
  if (lineTotalCents !== invoice.totalCents) {
    // Should be impossible (routes recompute the total from the lines on
    // every write) -- caught here anyway because posting a journal entry
    // whose debit doesn't match what the invoice claims is exactly the
    // kind of drift that only shows up as an unexplained AR variance
    // months later.
    throw new LedgerError("This invoice's total doesn't match the sum of its lines.");
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

  return postJournalEntry(invoice.orgId, {
    entryDate: invoice.issueDate,
    memo: `${invoice.invoiceNumber} -- ${invoice.customerName || "Customer"}`,
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

// A sent invoice becomes "paid" once payments cover it, and drops back to
// "sent" if a payment is later removed. Derived from the payments rather
// than set by hand, so the two can't disagree.
export async function refreshInvoiceStatus(invoice) {
  if (!["sent", "paid"].includes(invoice.status)) return invoice;
  const paid = await amountPaidCents(invoice.id);
  const nextStatus = paid >= invoice.totalCents ? "paid" : "sent";
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
    const outstandingCents = invoice.totalCents - (await amountPaidCents(invoice.id));
    if (outstandingCents <= 0) continue; // fully paid but not yet re-statused

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
