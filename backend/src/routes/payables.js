// Bill payments and the AP aging report. accountsPayable.js owns the
// accounting; this is the HTTP surface, same division of labor as
// ledger.js/routes/journalEntries.js and accountsReceivable.js/
// routes/receivables.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  PAYABLE_INVOICE_STATUS,
  amountPaidCents,
  computeApAging,
  invoiceTotalCents,
  isValidPaymentAccount,
  recordBillPayment,
  voidBillPaymentEntry,
} from "../accountsPayable.js";
import { Account, AuditLog, BillPayment, Invoice } from "../models/index.js";

const router = Router();

function serializePayment(payment, account) {
  return {
    id: payment.id,
    invoice_id: payment.invoiceId,
    payment_account_id: payment.paymentAccountId,
    payment_account_name: account?.name,
    payment_date: payment.paymentDate,
    amount: centsToDollars(payment.amountCents),
    discount: centsToDollars(payment.discountCents || 0),
    memo: payment.memo,
  };
}

// `withSamples` rather than the default scope, for the same reason
// computeApAging uses it: the Review Queue lets a seeded sample invoice be
// approved like any other, and approving it posts to Accounts Payable for
// real. If aging shows it as owed, it has to be payable too -- otherwise
// there's a line on the report with no way to clear it.
async function getOwnedInvoice(id, orgId) {
  return Invoice.scope("withSamples").findOne({ where: { id, orgId } });
}

async function paymentsPayload(invoice) {
  const payments = await BillPayment.findAll({
    where: { invoiceId: invoice.id },
    order: [["paymentDate", "ASC"]],
  });
  const accounts = await Account.findAll({ where: { orgId: invoice.orgId } });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const totalCents = invoiceTotalCents(invoice);
  // Amount+discount both relieve the payable -- see amountPaidCents.
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents + (p.discountCents || 0), 0);
  return {
    invoice_id: invoice.id,
    total: centsToDollars(totalCents),
    amount_paid: centsToDollars(paidCents),
    amount_outstanding: centsToDollars(totalCents - paidCents),
    items: payments.map((p) => serializePayment(p, byId.get(p.paymentAccountId))),
  };
}

// Approved bills with what's still owed on each -- everything the Bill
// Payments tab needs in one response. Deliberately its own endpoint rather
// than the invoice list plus a payments call per row: that shape is an N+1
// on a list that grows with the org, and the invoice list serializer
// doesn't carry a due date or any payment state anyway.
router.get("/api/bills", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const invoices = await Invoice.scope("withSamples").findAll({
      where: { orgId, status: PAYABLE_INVOICE_STATUS },
      order: [["dueDate", "ASC"]],
    });

    // One query for every payment in the org rather than one per bill.
    // Amount+discount both relieve the payable -- see amountPaidCents --
    // so a bill paid with a discount has to sum both here too, or it never
    // drops off this list's outstanding balance.
    const payments = await BillPayment.findAll({
      where: { orgId },
      attributes: ["invoiceId", "amountCents", "discountCents"],
      raw: true,
    });
    const paidByInvoice = new Map();
    for (const p of payments) {
      paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) || 0) + p.amountCents + (p.discountCents || 0));
    }

    const outstandingOnly = req.query.outstanding !== "false";
    const items = [];
    for (const invoice of invoices) {
      const totalCents = invoiceTotalCents(invoice);
      const paidCents = paidByInvoice.get(invoice.id) || 0;
      const outstandingCents = totalCents - paidCents;
      if (outstandingOnly && outstandingCents <= 0) continue;
      items.push({
        invoice_id: invoice.id,
        vendor_name: invoice.vendorName,
        invoice_number: invoice.invoiceNumber,
        due_date: invoice.dueDate,
        total: centsToDollars(totalCents),
        amount_paid: centsToDollars(paidCents),
        amount_outstanding: centsToDollars(outstandingCents),
      });
    }

    res.json({ items, total_outstanding: centsToDollars(items.reduce((s, i) => s + dollarsToCents(i.amount_outstanding), 0)) });
  } catch (err) {
    next(err);
  }
});

router.get("/api/invoices/:id/payments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    res.json(await paymentsPayload(invoice));
  } catch (err) {
    next(err);
  }
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  payment_date: z.string().min(1),
  payment_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
  // An early-payment discount taken against this bill, if any -- see
  // accountsPayable.js's earlyPayDiscount. Zero (the default) for the
  // ordinary case of paying the full outstanding balance.
  discount: z.number().min(0).optional(),
});

router.post("/api/invoices/:id/payments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const invoice = await getOwnedInvoice(req.params.id, orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

    // Only an approved bill is a payable: that's the status whose approval
    // posted to Accounts Payable, so it's the only one a payment can
    // relieve.
    if (invoice.status !== PAYABLE_INVOICE_STATUS) {
      return res.status(409).json({ detail: `Can't pay a ${invoice.status} invoice -- approve it first.` });
    }

    const totalCents = invoiceTotalCents(invoice);
    if (totalCents <= 0) {
      return res.status(409).json({ detail: "This invoice has no amount to pay." });
    }

    const paymentAccount = await Account.findOne({ where: { id: parsed.data.payment_account_id, orgId } });
    if (!isValidPaymentAccount(paymentAccount)) {
      return res.status(422).json({
        detail: "Payment account must be an asset or liability account you own, and not Accounts Payable itself.",
      });
    }

    const amountCents = dollarsToCents(parsed.data.amount);
    const discountCents = dollarsToCents(parsed.data.discount || 0);
    const alreadyPaid = await amountPaidCents(invoice.id);
    if (alreadyPaid + amountCents + discountCents > totalCents) {
      return res.status(422).json({
        detail: `That would overpay this bill. Outstanding balance is ${centsToDollars(totalCents - alreadyPaid)}.`,
      });
    }

    await recordBillPayment(invoice, {
      amountCents,
      discountCents,
      paymentDate: parsed.data.payment_date,
      paymentAccountId: paymentAccount.id,
      memo: parsed.data.memo || "",
      postedByUserId: req.currentUser.id,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "bill_payment_recorded",
      actor: req.currentUser.email,
      details: { amount: parsed.data.amount, discount: parsed.data.discount || 0, payment_account: paymentAccount.name },
    });

    res.status(201).json(await paymentsPayload(invoice));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// Unapplying a payment reverses its journal entry rather than deleting it,
// same as every other correction in this ledger -- the payment row goes,
// but the entry and its reversal both stay on the books. Needed as an
// escape hatch: a payment recorded against the wrong bill has no other way
// back out, and the AR side already refuses to void an invoice that has
// payments against it for exactly this reason.
router.delete("/api/invoices/:id/payments/:paymentId", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const invoice = await getOwnedInvoice(req.params.id, orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

    const payment = await BillPayment.findOne({ where: { id: req.params.paymentId, invoiceId: invoice.id, orgId } });
    if (!payment) return res.status(404).json({ detail: "Payment not found" });

    await voidBillPaymentEntry(orgId, payment.id, { postedByUserId: req.currentUser.id });
    await payment.destroy();

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "bill_payment_removed",
      actor: req.currentUser.email,
      details: { amount: centsToDollars(payment.amountCents) },
    });

    res.json(await paymentsPayload(invoice));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/reports/ap-aging", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || "") ? req.query.as_of : null;
    res.json(await computeApAging(req.currentUser.orgId, { asOf }));
  } catch (err) {
    next(err);
  }
});

export default router;
