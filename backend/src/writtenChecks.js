// Writing a check: the same bill payment "Record payment" already posts
// (accountsPayable.js's recordBillPayment), wrapped with the paper-trail
// fields a real check carries -- check number, payee, memo -- and a row
// that outlives the payment so it can still be shown (and reprinted) after
// the fact. See models/WrittenCheck.js for why this isn't just Check with
// an extra flag.

import { LedgerError, centsToDollars } from "./ledger.js";
import { PAYABLE_INVOICE_STATUS, amountPaidCents, invoiceTotalCents, isValidPaymentAccount, recordBillPayment, voidBillPaymentEntry } from "./accountsPayable.js";
import { Account, BillPayment, Invoice, WrittenCheck } from "./models/index.js";

// Same validation payables.js's POST /api/invoices/:id/payments already
// does -- duplicated rather than imported as shared middleware, matching
// how routes/checks.js's own /link route (a different way of recording the
// same kind of payment) already duplicates this same set of checks.
export async function writeCheck(orgId, { invoiceId, checkNumber, payeeName, checkDate, amountCents, memo, paymentAccountId, postedByUserId = null }) {
  const invoice = await Invoice.scope("withSamples").findOne({ where: { id: invoiceId, orgId } });
  if (!invoice) throw new LedgerError("Bill not found.", 404);
  if (invoice.status !== PAYABLE_INVOICE_STATUS) {
    throw new LedgerError(`Can't pay a ${invoice.status} invoice -- approve it first.`, 409);
  }

  const totalCents = invoiceTotalCents(invoice);
  if (totalCents <= 0) throw new LedgerError("This bill has no amount to pay.", 409);

  const paymentAccount = await Account.findOne({ where: { id: paymentAccountId, orgId } });
  if (!isValidPaymentAccount(paymentAccount)) {
    throw new LedgerError("Payment account must be an asset or liability account you own, and not Accounts Payable itself.");
  }

  const alreadyPaid = await amountPaidCents(invoice.id);
  if (alreadyPaid + amountCents > totalCents) {
    throw new LedgerError(`That would overpay this bill. Outstanding balance is ${centsToDollars(totalCents - alreadyPaid)}.`);
  }

  const payment = await recordBillPayment(invoice, {
    amountCents,
    paymentDate: checkDate,
    paymentAccountId: paymentAccount.id,
    memo: memo || `Check #${checkNumber}`,
    docNumber: checkNumber,
    postedByUserId,
  });

  return WrittenCheck.create({
    orgId,
    checkNumber,
    payeeName,
    checkDate,
    amountCents,
    memo: memo || "",
    paymentAccountId: paymentAccount.id,
    invoiceId: invoice.id,
    billPaymentId: payment.id,
  });
}

// Voids the underlying bill payment and removes both the payment row and
// the check record -- same two-step teardown routes/payables.js's own
// payment-removal route does (void the entry, then destroy the row), so an
// outstanding-balance query doesn't keep counting a payment whose journal
// entry has been reversed. The payment's own void logic
// (voidBillPaymentEntry) already handles a period that's since closed by
// refusing the reversal -- this just doesn't catch that error, so it
// surfaces the same way it would from the Bill Payments tab.
export async function voidWrittenCheck(orgId, writtenCheckId, { postedByUserId = null } = {}) {
  const check = await WrittenCheck.findOne({ where: { id: writtenCheckId, orgId } });
  if (!check) return null;
  await voidBillPaymentEntry(orgId, check.billPaymentId, { postedByUserId });
  // The check has to go first: it holds the foreign key onto the payment,
  // so destroying the payment first would fail the constraint.
  const billPaymentId = check.billPaymentId;
  await check.destroy();
  const payment = await BillPayment.findOne({ where: { id: billPaymentId, orgId } });
  if (payment) await payment.destroy();
  return check;
}

export function serializeWrittenCheck(check, invoice = null, paymentAccount = null) {
  return {
    id: check.id,
    check_number: check.checkNumber,
    payee_name: check.payeeName,
    check_date: check.checkDate,
    amount: centsToDollars(check.amountCents),
    memo: check.memo,
    payment_account_id: check.paymentAccountId,
    payment_account_name: paymentAccount?.name,
    invoice_id: check.invoiceId,
    invoice_number: invoice?.invoiceNumber,
    vendor_name: invoice?.vendorName,
    bill_payment_id: check.billPaymentId,
  };
}
