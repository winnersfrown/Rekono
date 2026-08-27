// Accounts payable: paying the vendor bills the AP pipeline approves, and
// the AP aging report. The mirror of accountsReceivable.js.
//
// Approving a vendor bill has posted Debit expense / Credit Accounts
// Payable since v1.20 (ledger.js's postInvoiceApproval), but nothing ever
// relieved that payable -- Accounts Payable only ever grew. This is the
// other half: paying a bill posts Debit Accounts Payable / Credit whatever
// account the money left from.
//
// Everything that touches the ledger goes through ledger.js's
// postJournalEntry, so AP payments inherit the same guarantees as
// everything else: balanced entries only, closed periods refused, voids as
// reversals.

import { LedgerError, centsToDollars, dollarsToCents, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { Account, BillPayment, Invoice, JournalEntry } from "./models/index.js";

// Only an approved bill is a payable -- that's the status whose approval
// posted to Accounts Payable in the first place.
export const PAYABLE_INVOICE_STATUS = "approved";

// Accounts money can be paid *from*: an asset or liability account, minus
// the two control accounts that make no sense as a source.
//
// Accounts Payable itself, because paying from AP posts Debit AP / Credit
// AP -- balanced, passes every check the ledger makes, and moves nothing.
// Accounts Receivable, because crediting AR to pay a vendor reads as a
// customer having settled their invoice; the money owed *to* the org is
// not a place money can leave *from*.
//
// A credit card is deliberately allowed: paying a bill with a card swaps
// one liability for another rather than spending cash, and the ledger
// models that correctly.
const NON_SOURCE_SUBTYPES = new Set(["accounts_payable", "accounts_receivable"]);

export function isValidPaymentAccount(account) {
  if (!account) return false;
  if (NON_SOURCE_SUBTYPES.has(account.subtype)) return false;
  return account.type === "asset" || account.type === "liability";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// What the bill is worth in cents. Invoice.total is a FLOAT in dollars
// (the AP pipeline predates the ledger's integer-cents convention), so
// every comparison against a payment has to convert at this one boundary
// rather than mixing the two representations.
export function invoiceTotalCents(invoice) {
  return dollarsToCents(invoice.total || 0);
}

export async function amountPaidCents(invoiceId) {
  const payments = await BillPayment.findAll({ where: { invoiceId }, attributes: ["amountCents"], raw: true });
  return payments.reduce((sum, p) => sum + p.amountCents, 0);
}

// Posts Debit Accounts Payable / Credit [payment account] -- the payable
// cleared, the money gone. Dated to the payment date rather than today, so
// the cash flow statement attributes it to the period the money actually
// left in.
export async function postBillPayment(payment, invoice, { postedByUserId = null } = {}) {
  const apAccount = await Account.findOne({
    where: { orgId: invoice.orgId, type: "liability", subtype: "accounts_payable" },
  });
  if (!apAccount) throw new LedgerError("No Accounts Payable account found in the chart of accounts.", 409);

  return postJournalEntry(invoice.orgId, {
    entryDate: payment.paymentDate,
    memo: `Payment on ${invoice.invoiceNumber || invoice.id.slice(0, 8)} -- ${invoice.vendorName || "Unknown vendor"}`,
    source: "bill_payment",
    sourceType: "bill_payment",
    sourceId: payment.id,
    postedByUserId,
    lines: [
      { accountId: apAccount.id, debitCents: payment.amountCents },
      { accountId: payment.paymentAccountId, creditCents: payment.amountCents },
    ],
  });
}

// Reverses whatever a bill payment posted, if anything. Looked up by
// (sourceType, sourceId), same approach the rest of the ledger uses.
export async function voidBillPaymentEntry(orgId, billPaymentId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "bill_payment", sourceId: billPaymentId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

// Records a payment and posts it, unwinding the row if the ledger refuses.
// Shared by the payments route and the QuickBooks bank-match confirmation,
// so both produce exactly the same ledger effect rather than one of them
// quietly doing less.
//
// The payment row has to exist before the entry can name it as its source,
// so a refused posting (a closed period, most likely) has to delete it --
// otherwise the bill reads as paid against cash that never posted.
export async function recordBillPayment(
  invoice,
  { amountCents, paymentDate, paymentAccountId, memo = "", postedByUserId = null }
) {
  // You can only relieve a payable that exists. Approving a bill is what
  // credits Accounts Payable, and that posting can be skipped (a bill
  // approved into a closed period -- see postInvoiceApproval), so an
  // "approved" status alone isn't proof it landed. Debiting AP for a bill
  // that never credited it drives the balance negative against nothing,
  // which reconciles with no report and no bank statement.
  //
  // Recoverable rather than permanent: re-approving the invoice re-runs
  // postInvoiceApproval, which is idempotent, so the fix is to reopen the
  // period and approve again.
  const approvalEntry = await JournalEntry.findOne({
    where: { orgId: invoice.orgId, sourceType: "invoice", sourceId: invoice.id, status: "posted" },
  });
  if (!approvalEntry) {
    throw new LedgerError(
      "This bill never posted to Accounts Payable, so there's nothing to pay down. Re-approve it to post it first.",
      409
    );
  }

  const payment = await BillPayment.create({
    orgId: invoice.orgId,
    invoiceId: invoice.id,
    paymentAccountId,
    paymentDate,
    amountCents,
    memo,
  });

  try {
    await postBillPayment(payment, invoice, { postedByUserId });
  } catch (err) {
    await payment.destroy();
    throw err;
  }

  return payment;
}

// Standard AP aging buckets, same shape as the AR side's. "Current" means
// not yet due; everything else is counted from the due date.
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

// What the org owes, bucketed by how far past due, grouped by vendor.
// Only approved bills count -- anything still in review isn't a payable
// yet, and nothing else has posted to Accounts Payable.
//
// Grouped by vendor *name* rather than a vendor table, because the AP side
// has no Vendor model (unlike AR's Customer). Names are normalized for
// grouping only -- trimmed and case-folded, so "Acme Inc." and "ACME
// Inc." land in one row -- with the first spelling seen kept for display.
// It's a weaker key than a real foreign key, which is exactly the argument
// Customer.js makes for AR having one; noted here as the known limitation
// rather than papered over.
export async function computeApAging(orgId, { asOf = null } = {}) {
  const asOfDate = asOf || todayIso();

  // `withSamples` rather than the default scope, which excludes seeded
  // sample invoices. That exclusion is right for usage metrics, but wrong
  // here: the Review Queue deliberately shows the sample and lets it be
  // approved like any other invoice (see Invoice.js), and approving it
  // posts to Accounts Payable for real. Excluding it from aging alone
  // would leave this report disagreeing with the balance sheet by exactly
  // the sample's amount -- and an aging report that doesn't tie to the
  // ledger is worse than no aging report.
  const invoices = await Invoice.scope("withSamples").findAll({
    where: { orgId, status: PAYABLE_INVOICE_STATUS },
  });

  const byVendor = new Map();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
  let grandTotalCents = 0;

  for (const invoice of invoices) {
    const totalCents = invoiceTotalCents(invoice);
    if (totalCents <= 0) continue;

    const outstandingCents = totalCents - (await amountPaidCents(invoice.id));
    if (outstandingCents <= 0) continue; // fully paid

    // A bill with no due date can't be aged, so it counts as current
    // rather than being dropped -- it's still money owed, and silently
    // omitting it would make the report disagree with the AP balance.
    const daysPastDue = invoice.dueDate ? daysBetween(invoice.dueDate, asOfDate) : 0;
    const bucket = AGING_BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);

    const displayName = (invoice.vendorName || "").trim() || "(unknown vendor)";
    const key = displayName.toLowerCase();
    if (!byVendor.has(key)) {
      byVendor.set(key, {
        vendor_name: displayName,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])),
        total: 0,
      });
    }
    const row = byVendor.get(key);
    row[bucket.key] += outstandingCents;
    row.total += outstandingCents;
    totals[bucket.key] += outstandingCents;
    grandTotalCents += outstandingCents;
  }

  return {
    as_of: asOfDate,
    buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    vendors: [...byVendor.values()]
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
