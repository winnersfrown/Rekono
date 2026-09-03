// Bill payments and the AP aging report. accountsPayable.js owns the
// accounting; this is the HTTP surface, same division of labor as
// ledger.js/routes/journalEntries.js and accountsReceivable.js/
// routes/receivables.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import { rateLimitMiddleware } from "../rateLimit.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  PAYABLE_INVOICE_STATUS,
  amountCreditedCents,
  amountAppliedFromVendorCreditMemoCents,
  amountPaidCents,
  applyVendorCreditMemoToBill,
  computeApAging,
  invoiceTotalCents,
  isValidPaymentAccount,
  nextVendorCreditMemoNumber,
  postVendorCreditMemo,
  recordBillPayment,
  unappliedVendorCreditMemoCents,
  voidBillPaymentEntry,
  voidVendorCreditMemoEntry,
} from "../accountsPayable.js";
import { buildVendorResolver } from "../vendors.js";
import { dueDates, previewRecurringBills, runRecurringBills } from "../recurringBills.js";
import { RECURRING_BILL_FREQUENCIES } from "../models/RecurringBill.js";
import { Account, AuditLog, BillPayment, Invoice, RecurringBill, VendorCreditMemo, VendorCreditMemoApplication } from "../models/index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const creditedCents = await amountCreditedCents(invoice.id);
  return {
    invoice_id: invoice.id,
    total: centsToDollars(totalCents),
    amount_paid: centsToDollars(paidCents),
    amount_credited: centsToDollars(creditedCents),
    amount_outstanding: centsToDollars(totalCents - paidCents - creditedCents),
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

    // Same one-query-for-the-org shape as payments above, so a bill settled
    // partly by vendor credit doesn't sit on this list as still fully owed.
    const creditApplications = await VendorCreditMemoApplication.findAll({
      where: { orgId },
      attributes: ["invoiceId", "amountCents"],
      raw: true,
    });
    const creditedByInvoice = new Map();
    for (const a of creditApplications) {
      creditedByInvoice.set(a.invoiceId, (creditedByInvoice.get(a.invoiceId) || 0) + a.amountCents);
    }

    const outstandingOnly = req.query.outstanding !== "false";
    const items = [];
    for (const invoice of invoices) {
      const totalCents = invoiceTotalCents(invoice);
      const paidCents = paidByInvoice.get(invoice.id) || 0;
      const creditedCents = creditedByInvoice.get(invoice.id) || 0;
      const outstandingCents = totalCents - paidCents - creditedCents;
      if (outstandingOnly && outstandingCents <= 0) continue;
      items.push({
        invoice_id: invoice.id,
        vendor_name: invoice.vendorName,
        invoice_number: invoice.invoiceNumber,
        due_date: invoice.dueDate,
        total: centsToDollars(totalCents),
        amount_paid: centsToDollars(paidCents),
        amount_credited: centsToDollars(creditedCents),
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

// ---- Vendor credit memos ----

function serializeVendorCreditMemo(memo, { unappliedCents } = {}) {
  return {
    id: memo.id,
    vendor_name: memo.vendorName,
    expense_account_id: memo.expenseAccountId,
    expense_account_name: memo.expenseAccount?.name,
    credit_number: memo.creditNumber,
    issue_date: memo.issueDate,
    status: memo.status,
    amount: centsToDollars(memo.amountCents),
    memo: memo.memo,
    ...(unappliedCents !== undefined ? { unapplied: centsToDollars(unappliedCents) } : {}),
  };
}

async function getOwnedVendorCreditMemo(id, orgId) {
  return VendorCreditMemo.findOne({
    where: { id, orgId },
    include: [{ model: Account, as: "expenseAccount", attributes: ["id", "name"] }],
  });
}

router.get("/api/vendor-credit-memos", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    const memos = await VendorCreditMemo.findAll({
      where,
      include: [{ model: Account, as: "expenseAccount", attributes: ["id", "name"] }],
      order: [["issueDate", "DESC"], ["createdAt", "DESC"]],
    });

    const items = await Promise.all(
      memos.map(async (m) => serializeVendorCreditMemo(m, { unappliedCents: await unappliedVendorCreditMemoCents(m) }))
    );
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const vendorCreditMemoSchema = z.object({
  vendor_name: z.string().min(1).max(512),
  expense_account_id: z.string().min(1),
  issue_date: z.string().min(1),
  amount: z.number().positive(),
  memo: z.string().max(512).optional(),
});

// Posted immediately -- see VendorCreditMemo.js for why this skips the
// Review Queue every other bill-related write path here goes through.
router.post("/api/vendor-credit-memos", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = vendorCreditMemoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const expenseAccount = await Account.findOne({ where: { id: parsed.data.expense_account_id, orgId, type: "expense" } });
    if (!expenseAccount) {
      return res.status(422).json({ detail: "This credit must reverse an expense account in your chart of accounts." });
    }

    const creditMemo = await VendorCreditMemo.create({
      orgId,
      vendorName: parsed.data.vendor_name,
      expenseAccountId: expenseAccount.id,
      creditNumber: await nextVendorCreditMemoNumber(orgId),
      issueDate: parsed.data.issue_date,
      memo: parsed.data.memo || "",
      amountCents: dollarsToCents(parsed.data.amount),
    });

    try {
      await postVendorCreditMemo(creditMemo, { postedByUserId: req.currentUser.id });
    } catch (err) {
      await creditMemo.destroy();
      throw err;
    }

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "vendor_credit_memo_issued",
      actor: req.currentUser.email,
      details: { credit_number: creditMemo.creditNumber, vendor: creditMemo.vendorName, amount: parsed.data.amount },
    });

    creditMemo.expenseAccount = expenseAccount;
    res.status(201).json(serializeVendorCreditMemo(creditMemo, { unappliedCents: creditMemo.amountCents }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/vendor-credit-memos/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const creditMemo = await getOwnedVendorCreditMemo(req.params.id, req.currentUser.orgId);
    if (!creditMemo) return res.status(404).json({ detail: "Credit memo not found" });
    res.json(serializeVendorCreditMemo(creditMemo, { unappliedCents: await unappliedVendorCreditMemoCents(creditMemo) }));
  } catch (err) {
    next(err);
  }
});

router.post("/api/vendor-credit-memos/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const creditMemo = await getOwnedVendorCreditMemo(req.params.id, req.currentUser.orgId);
    if (!creditMemo) return res.status(404).json({ detail: "Credit memo not found" });
    if (creditMemo.status === "void") return res.status(409).json({ detail: "This credit memo is already void." });

    // Mirrors the AR side's guard: unwinding a credit that's already been
    // used to settle a bill is a conversation with that bill, not something
    // to silently reverse out from under it.
    if ((await amountAppliedFromVendorCreditMemoCents(creditMemo.id)) > 0) {
      return res.status(409).json({
        detail: "This credit memo has been applied to a bill. That application can't be undone from here.",
      });
    }

    await voidVendorCreditMemoEntry(req.currentUser.orgId, creditMemo.id, { postedByUserId: req.currentUser.id });
    creditMemo.status = "void";
    await creditMemo.save();

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "vendor_credit_memo_voided",
      actor: req.currentUser.email,
      details: { credit_number: creditMemo.creditNumber },
    });

    res.json(serializeVendorCreditMemo(creditMemo, { unappliedCents: 0 }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

const applyVendorCreditSchema = z.object({
  invoice_id: z.string().min(1),
  amount: z.number().positive(),
  applied_date: z.string().min(1).optional(),
});

router.post("/api/vendor-credit-memos/:id/apply", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = applyVendorCreditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const creditMemo = await getOwnedVendorCreditMemo(req.params.id, orgId);
    if (!creditMemo) return res.status(404).json({ detail: "Credit memo not found" });

    const invoice = await getOwnedInvoice(parsed.data.invoice_id, orgId);
    if (!invoice) return res.status(404).json({ detail: "Bill not found" });
    if (invoice.status !== PAYABLE_INVOICE_STATUS) {
      return res.status(409).json({ detail: `Can't apply a credit to a ${invoice.status} bill.` });
    }

    const resolveVendor = await buildVendorResolver(orgId);
    await applyVendorCreditMemoToBill(
      creditMemo,
      invoice,
      dollarsToCents(parsed.data.amount),
      parsed.data.applied_date || todayIso(),
      resolveVendor
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "vendor_credit_memo_applied",
      actor: req.currentUser.email,
      details: { credit_number: creditMemo.creditNumber, invoice_number: invoice.invoiceNumber, amount: parsed.data.amount },
    });

    res.json({
      credit_memo: serializeVendorCreditMemo(creditMemo, { unappliedCents: await unappliedVendorCreditMemoCents(creditMemo) }),
      bill: await paymentsPayload(invoice),
    });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// ---- Recurring bills ----

// .../run mutates real billing state on every call -- it can create a real
// Invoice and, if the template is flagged autoApprove, post it to the
// ledger, all in a single request -- so this group gets the same tighter
// rate limit routes/receivables.js applies to .../recurring-invoices/run,
// on top of the blanket one every route already has.
const recurringBillRateLimit = rateLimitMiddleware({
  windowMs: 15 * 60 * 1000,
  max: settings.rateLimitExpensiveMax,
  message: "Too many requests. Please slow down and try again shortly.",
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function serializeRecurringBill(t) {
  return {
    id: t.id,
    vendor_name: t.vendorName,
    expense_account_id: t.expenseAccountId,
    expense_account_name: t.expenseAccount?.name,
    name: t.name,
    memo: t.memo,
    amount: centsToDollars(t.amountCents),
    frequency: t.frequency,
    start_date: t.startDate,
    end_date: t.endDate,
    last_issued_date: t.lastIssuedDate,
    active: t.active,
    auto_approve: t.autoApprove,
    next_due: dueDates({ frequency: t.frequency, startDate: t.startDate, endDate: t.endDate, lastPostedDate: t.lastIssuedDate }, todayIso())[0] || null,
  };
}

router.get("/api/recurring-bills", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const templates = await RecurringBill.findAll({
      where: { orgId: req.currentUser.orgId },
      include: [{ model: Account, as: "expenseAccount", attributes: ["id", "name"] }],
      order: [["name", "ASC"]],
    });
    res.json({ items: templates.map(serializeRecurringBill) });
  } catch (err) {
    next(err);
  }
});

const recurringBillSchema = z.object({
  vendor_name: z.string().min(1).max(512),
  expense_account_id: z.string().min(1),
  name: z.string().min(1).max(256),
  memo: z.string().max(512).optional(),
  amount: z.number().positive(),
  frequency: z.enum(RECURRING_BILL_FREQUENCIES),
  start_date: z.string().regex(ISO_DATE),
  end_date: z.string().regex(ISO_DATE).optional(),
  auto_approve: z.boolean().optional(),
});

router.post("/api/recurring-bills", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const parsed = recurringBillSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const data = parsed.data;

    if (data.end_date && data.end_date < data.start_date) {
      return res.status(422).json({ detail: "A recurring bill can't end before it starts." });
    }
    const expenseAccount = await Account.findOne({ where: { id: data.expense_account_id, orgId, type: "expense" } });
    if (!expenseAccount) {
      return res.status(422).json({ detail: "This bill must post to an expense account in your chart of accounts." });
    }

    const template = await RecurringBill.create({
      orgId,
      vendorName: data.vendor_name,
      expenseAccountId: expenseAccount.id,
      name: data.name,
      memo: data.memo || "",
      amountCents: dollarsToCents(data.amount),
      frequency: data.frequency,
      startDate: data.start_date,
      endDate: data.end_date || null,
      autoApprove: data.auto_approve || false,
    });
    template.expenseAccount = expenseAccount;

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "recurring_bill_created",
      actor: req.currentUser.email,
      details: { name: template.name, vendor: template.vendorName, frequency: template.frequency },
    });

    res.status(201).json(serializeRecurringBill(template));
  } catch (err) {
    next(err);
  }
});

router.patch("/api/recurring-bills/:id", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        name: z.string().min(1).max(256).optional(),
        active: z.boolean().optional(),
        end_date: z.string().regex(ISO_DATE).nullable().optional(),
        auto_approve: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const template = await RecurringBill.findOne({
      where: { id: req.params.id, orgId: req.currentUser.orgId },
      include: [{ model: Account, as: "expenseAccount", attributes: ["id", "name"] }],
    });
    if (!template) return res.status(404).json({ detail: "Recurring bill not found" });

    if (parsed.data.name !== undefined) template.name = parsed.data.name;
    if (parsed.data.active !== undefined) template.active = parsed.data.active;
    if (parsed.data.end_date !== undefined) template.endDate = parsed.data.end_date;
    if (parsed.data.auto_approve !== undefined) template.autoApprove = parsed.data.auto_approve;
    await template.save();

    res.json(serializeRecurringBill(template));
  } catch (err) {
    next(err);
  }
});

// Deleting stops future issuance. Bills already created are real Invoice
// rows and stay -- this only stops the next one.
router.delete("/api/recurring-bills/:id", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const template = await RecurringBill.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!template) return res.status(404).json({ detail: "Recurring bill not found" });
    await template.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/api/recurring-bills/pending", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const asOf = ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : todayIso();
    res.json(await previewRecurringBills(req.currentUser.orgId, asOf));
  } catch (err) {
    next(err);
  }
});

router.post("/api/recurring-bills/run", requireAuth, requireActivePlan, recurringBillRateLimit, async (req, res, next) => {
  try {
    const parsed = z
      .object({ as_of: z.string().regex(ISO_DATE).optional(), template_id: z.string().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const asOf = parsed.data.as_of || todayIso();

    const result = await runRecurringBills(req.currentUser.orgId, asOf, {
      postedByUserId: req.currentUser.id,
      templateId: parsed.data.template_id || null,
    });

    if (result.issued.length) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "recurring_bills_run",
        actor: req.currentUser.email,
        details: { as_of: asOf, issued: result.issued.length, amount: result.total },
      });
    }
    res.json({ as_of: asOf, ...result });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
