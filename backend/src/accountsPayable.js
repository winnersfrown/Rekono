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
import { Account, BillPayment, Invoice, JournalEntry, VendorCreditMemo, VendorCreditMemoApplication } from "./models/index.js";
import { buildVendorResolver } from "./vendors.js";

// Only an approved bill is a payable -- that's the status whose approval
// posted to Accounts Payable in the first place.
export const PAYABLE_INVOICE_STATUS = "approved";

// An early-payment discount taken (see earlyPayDiscount below, and the
// vendor terms it reads) reduces what the purchase actually cost -- it
// isn't income, it's less expense. Booked as a contra-expense account
// rather than folded into the original expense/COGS line, so a company can
// see how much of what it paid was true cost versus discounts captured
// (the same reasoning Distributions is a separate contra-equity account
// instead of a debit straight to Retained Earnings). Credit-normal in
// effect: crediting an expense-type account reduces the expense total on
// the P&L, which is exactly what taking a discount should do.
export const PURCHASES_DISCOUNT_SUBTYPE = "purchases_discount";

// Created on demand, not seeded: an org that never takes an early-payment
// discount shouldn't carry a permanently-zero account in its chart. Same
// pattern as incomeTax.js's ensureTaxAccount and equity.js's ensureAccount.
export async function ensurePurchasesDiscountAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "expense", subtype: PURCHASES_DISCOUNT_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "5080",
    name: "Purchases Discounts Taken",
    type: "expense",
    subtype: PURCHASES_DISCOUNT_SUBTYPE,
    isSystemAccount: true,
  });
}

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

// Includes any discount taken -- a discounted payment relieves AP for the
// full amount+discount, not just the cash that moved, so a bill paid $980
// cash plus a $20 discount is fully settled, not sitting $20 "outstanding"
// forever.
export async function amountPaidCents(invoiceId) {
  const payments = await BillPayment.findAll({
    where: { invoiceId },
    attributes: ["amountCents", "discountCents"],
    raw: true,
  });
  return payments.reduce((sum, p) => sum + p.amountCents + (p.discountCents || 0), 0);
}

// Posts Debit Accounts Payable / Credit [payment account] (+ Credit
// Purchases Discounts Taken, if a discount was taken) -- the payable
// cleared, the money gone. Dated to the payment date rather than today, so
// the cash flow statement attributes it to the period the money actually
// left in. AP is debited for amount+discount, since that's the full amount
// relieved; the cash side only ever moves the actual cash paid.
export async function postBillPayment(payment, invoice, { postedByUserId = null, docNumber = "" } = {}) {
  const apAccount = await Account.findOne({
    where: { orgId: invoice.orgId, type: "liability", subtype: "accounts_payable" },
  });
  if (!apAccount) throw new LedgerError("No Accounts Payable account found in the chart of accounts.", 409);

  const discountCents = payment.discountCents || 0;
  const lines = [
    { accountId: apAccount.id, debitCents: payment.amountCents + discountCents },
    { accountId: payment.paymentAccountId, creditCents: payment.amountCents },
  ];
  if (discountCents > 0) {
    const discountAccount = await ensurePurchasesDiscountAccount(invoice.orgId);
    lines.push({ accountId: discountAccount.id, creditCents: discountCents });
  }

  return postJournalEntry(invoice.orgId, {
    entryDate: payment.paymentDate,
    memo: `Payment on ${invoice.invoiceNumber || invoice.id.slice(0, 8)} -- ${invoice.vendorName || "Unknown vendor"}`,
    docNumber,
    source: "bill_payment",
    sourceType: "bill_payment",
    sourceId: payment.id,
    postedByUserId,
    lines,
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

// Sequential per org: VCM-0001, VCM-0002, ... Same derivation-from-history
// approach as the AR side's nextCreditMemoNumber, for the same reason: a
// vendor credit is cut rarely enough that a stored counter buys correctness
// no one needs at the cost of one more thing to keep in sync.
export async function nextVendorCreditMemoNumber(orgId) {
  const memos = await VendorCreditMemo.findAll({ where: { orgId }, attributes: ["creditNumber"], raw: true });
  let highest = 0;
  for (const { creditNumber } of memos) {
    const match = /^VCM-(\d+)$/.exec(creditNumber || "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `VCM-${String(highest + 1).padStart(4, "0")}`;
}

// Posts Debit Accounts Payable / Credit the credit memo's expense account --
// the mirror image of postInvoiceApproval. A vendor credit reduces what we
// owe them and reverses the expense we'd already booked. Like
// postCustomerCreditMemo it doesn't try to unwind anything more specific
// than that (there's no deferred-revenue equivalent to worry about on the
// expense side, and no line breakdown to preserve -- see VendorCreditMemo.js).
export async function postVendorCreditMemo(creditMemo, { postedByUserId = null } = {}) {
  const apAccount = await Account.findOne({ where: { orgId: creditMemo.orgId, type: "liability", subtype: "accounts_payable" } });
  if (!apAccount) throw new LedgerError("No Accounts Payable account found in the chart of accounts.", 409);

  return postJournalEntry(creditMemo.orgId, {
    entryDate: creditMemo.issueDate,
    memo: `${creditMemo.creditNumber} -- ${creditMemo.vendorName || "Vendor"}`,
    docNumber: creditMemo.creditNumber || "",
    source: "vendor_credit_memo",
    sourceType: "vendor_credit_memo",
    sourceId: creditMemo.id,
    postedByUserId,
    lines: [
      { accountId: apAccount.id, debitCents: creditMemo.amountCents },
      { accountId: creditMemo.expenseAccountId, creditCents: creditMemo.amountCents },
    ],
  });
}

// Reverses whatever a vendor credit memo posted, if anything. Same
// (sourceType, sourceId) lookup as voidBillPaymentEntry.
export async function voidVendorCreditMemoEntry(orgId, vendorCreditMemoId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "vendor_credit_memo", sourceId: vendorCreditMemoId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

// How much of a vendor credit memo has already been used against bills.
export async function amountAppliedFromVendorCreditMemoCents(vendorCreditMemoId) {
  const applications = await VendorCreditMemoApplication.findAll({
    where: { vendorCreditMemoId },
    attributes: ["amountCents"],
    raw: true,
  });
  return applications.reduce((sum, a) => sum + a.amountCents, 0);
}

// What's left of a vendor credit memo to apply to some bill -- 0 once fully
// used, and always 0 for a void memo.
export async function unappliedVendorCreditMemoCents(creditMemo) {
  if (creditMemo.status === "void") return 0;
  return creditMemo.amountCents - (await amountAppliedFromVendorCreditMemoCents(creditMemo.id));
}

// How much of a bill's balance has been offset by vendor credit memos --
// the credit-memo equivalent of amountPaidCents, and added to it everywhere
// a bill's outstanding balance is computed, so a bill settled partly by
// credit doesn't sit on the aging report forever.
export async function amountCreditedCents(invoiceId) {
  const applications = await VendorCreditMemoApplication.findAll({
    where: { invoiceId },
    attributes: ["amountCents"],
    raw: true,
  });
  return applications.reduce((sum, a) => sum + a.amountCents, 0);
}

// Applies (part of) a vendor credit memo against a specific bill. Posts no
// journal entry of its own -- see VendorCreditMemoApplication.js for why
// the money already moved when the memo was issued -- so this is pure
// validation plus a row, the same shape a bill payment would be if
// payments needed no ledger entry.
export async function applyVendorCreditMemoToBill(creditMemo, invoice, amountCents, appliedDate, resolveVendor) {
  if (creditMemo.status === "void") throw new LedgerError("This credit memo has been voided.");
  if (resolveVendor({ vendorName: creditMemo.vendorName, vendorId: null }).key !== resolveVendor(invoice).key) {
    throw new LedgerError("A credit memo can only be applied to a bill from the same vendor.");
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new LedgerError("Enter an amount greater than zero.");

  const available = await unappliedVendorCreditMemoCents(creditMemo);
  if (amountCents > available) {
    throw new LedgerError(`This credit memo only has ${centsToDollars(available)} left unapplied.`);
  }

  const totalCents = invoiceTotalCents(invoice);
  const alreadyOwed = totalCents - (await amountPaidCents(invoice.id)) - (await amountCreditedCents(invoice.id));
  if (amountCents > alreadyOwed) {
    throw new LedgerError(`That would over-apply the credit. This bill only has ${centsToDollars(alreadyOwed)} outstanding.`);
  }

  return VendorCreditMemoApplication.create({
    orgId: creditMemo.orgId,
    vendorCreditMemoId: creditMemo.id,
    invoiceId: invoice.id,
    amountCents,
    appliedDate,
  });
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
  { amountCents, paymentDate, paymentAccountId, memo = "", postedByUserId = null, docNumber = "", discountCents = 0 }
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
    discountCents,
    memo,
  });

  try {
    await postBillPayment(payment, invoice, { postedByUserId, docNumber });
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

function addDaysIso(fromIso, days) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// What's still available to save by paying this one bill early, as of
// asOfDate -- 0/null once the window's closed. Terms run from the invoice
// date (what "10 days" in "2/10 net 30" actually counts from), which is
// independent of the due date the aging bucket above is anchored to: a
// vendor can offer 30-day terms with a 10-day discount window, so a bill
// can be squarely "current" in the aging sense while its discount has
// already lapsed.
function earlyPayDiscount(vendor, invoice, outstandingCents, asOfDate) {
  if (!vendor.earlyPayDiscountPct || !vendor.earlyPayDiscountDays || !invoice.invoiceDate) {
    return { cents: 0, deadline: null };
  }
  const deadline = addDaysIso(invoice.invoiceDate, vendor.earlyPayDiscountDays);
  if (asOfDate > deadline) return { cents: 0, deadline: null };
  return { cents: Math.round(outstandingCents * (vendor.earlyPayDiscountPct / 100)), deadline };
}

// What the org owes, bucketed by how far past due, grouped by vendor.
// Only approved bills count -- anything still in review isn't a payable
// yet, and nothing else has posted to Accounts Payable.
//
// Grouped by resolved vendor identity (see vendors.js), not by normalizing
// the extracted name. Normalization handled "Acme Inc." vs "  ACME Inc. "
// and nothing else -- the moment the same vendor's name arrived genuinely
// differently ("Acme Inc" one month, "Acme Incorporated" the next), this
// report showed one vendor as two and every collections decision made off
// it was wrong.
//
// Resolution happens at read time through vendors and aliases, so merging
// two vendors regroups history immediately with no invoice rewritten, and
// bills approved before vendors existed still group by name.
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
  const [invoices, resolveVendor] = await Promise.all([
    Invoice.scope("withSamples").findAll({ where: { orgId, status: PAYABLE_INVOICE_STATUS } }),
    buildVendorResolver(orgId),
  ]);

  const byVendor = new Map();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
  let grandTotalCents = 0;
  let discountTotalCents = 0;

  for (const invoice of invoices) {
    const totalCents = invoiceTotalCents(invoice);
    if (totalCents <= 0) continue;

    const outstandingCents = totalCents - (await amountPaidCents(invoice.id)) - (await amountCreditedCents(invoice.id));
    if (outstandingCents <= 0) continue; // fully paid or fully credited

    // A bill with no due date can't be aged, so it counts as current
    // rather than being dropped -- it's still money owed, and silently
    // omitting it would make the report disagree with the AP balance.
    const daysPastDue = invoice.dueDate ? daysBetween(invoice.dueDate, asOfDate) : 0;
    const bucket = AGING_BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);

    const vendor = resolveVendor(invoice);
    const discount = earlyPayDiscount(vendor, invoice, outstandingCents, asOfDate);

    if (!byVendor.has(vendor.key)) {
      byVendor.set(vendor.key, {
        vendor_id: vendor.vendorId,
        vendor_name: vendor.name,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])),
        total: 0,
        discount_available: 0,
        discount_deadline: null,
      });
    }
    const row = byVendor.get(vendor.key);
    row[bucket.key] += outstandingCents;
    row.total += outstandingCents;
    totals[bucket.key] += outstandingCents;
    grandTotalCents += outstandingCents;

    if (discount.cents > 0) {
      row.discount_available += discount.cents;
      // The soonest of this vendor's still-open windows -- if two bills'
      // discounts expire on different days, that earlier date is the one
      // that actually forces a decision.
      if (!row.discount_deadline || discount.deadline < row.discount_deadline) {
        row.discount_deadline = discount.deadline;
      }
      discountTotalCents += discount.cents;
    }
  }

  return {
    as_of: asOfDate,
    buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    vendors: [...byVendor.values()]
      .map((row) => ({
        ...row,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, centsToDollars(row[b.key])])),
        total: centsToDollars(row.total),
        discount_available: centsToDollars(row.discount_available),
      }))
      .sort((a, b) => b.total - a.total),
    totals: {
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, centsToDollars(totals[b.key])])),
      total: centsToDollars(grandTotalCents),
      discount_available: centsToDollars(discountTotalCents),
    },
  };
}
