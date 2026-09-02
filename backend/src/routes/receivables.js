// Customers, customer invoices, payments, and the AR aging report.
// accountsReceivable.js owns the accounting; this is the HTTP surface,
// same division of labor as ledger.js/routes/journalEntries.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  addDays,
  amountPaidCents,
  computeArAging,
  nextInvoiceNumber,
  postCustomerPayment,
  refreshInvoiceStatus,
  sendCustomerInvoice,
  voidCustomerInvoiceEntry,
} from "../accountsReceivable.js";
import { dropUnrecognizedSchedule } from "../revenueRecognition.js";
import {
  accountsExist,
  dueDates,
  loadTemplateLines,
  previewRecurringInvoices,
  runRecurringInvoices,
} from "../recurringInvoices.js";
import { RECURRING_INVOICE_FREQUENCIES } from "../models/RecurringInvoice.js";
import {
  Account,
  AuditLog,
  Customer,
  CustomerInvoice,
  CustomerInvoiceLine,
  CustomerPayment,
  RecurringInvoice,
  RecurringInvoiceLine,
} from "../models/index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const router = Router();

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function serializeCustomer(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    payment_terms_days: c.paymentTermsDays,
    notes: c.notes,
    active: c.active,
  };
}

function serializeLine(line) {
  return {
    id: line.id,
    revenue_account_id: line.revenueAccountId,
    revenue_account_name: line.revenueAccount?.name,
    description: line.description,
    quantity: line.quantity,
    unit_price: centsToDollars(line.unitPriceCents),
    amount: centsToDollars(line.amountCents),
    service_start_date: line.serviceStartDate,
    service_end_date: line.serviceEndDate,
  };
}

function serializeInvoice(invoice, { lines, paidCents } = {}) {
  const paid = paidCents ?? 0;
  return {
    id: invoice.id,
    customer_id: invoice.customerId,
    customer_name: invoice.customer?.name,
    invoice_number: invoice.invoiceNumber,
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    status: invoice.status,
    memo: invoice.memo,
    total: centsToDollars(invoice.totalCents),
    amount_paid: centsToDollars(paid),
    amount_outstanding: centsToDollars(invoice.totalCents - paid),
    sent_at: invoice.sentAt,
    ...(lines ? { lines: lines.map(serializeLine) } : {}),
  };
}

// ---- Customers ----

router.get("/api/customers", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.active === "true") where.active = true;
    const customers = await Customer.findAll({ where, order: [["name", "ASC"]] });
    res.json({ items: customers.map(serializeCustomer) });
  } catch (err) {
    next(err);
  }
});

const customerSchema = z.object({
  name: z.string().min(1).max(256),
  email: z.string().email().or(z.literal("")).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(4096).optional(),
});

router.post("/api/customers", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const existing = await Customer.findOne({ where: { orgId: req.currentUser.orgId, name: parsed.data.name } });
    if (existing) return res.status(409).json({ detail: `A customer named "${parsed.data.name}" already exists.` });

    const customer = await Customer.create({
      orgId: req.currentUser.orgId,
      name: parsed.data.name,
      email: parsed.data.email || "",
      paymentTermsDays: parsed.data.payment_terms_days ?? 30,
      notes: parsed.data.notes || "",
    });
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "customer_created",
      actor: req.currentUser.email,
      details: { name: customer.name },
    });
    res.status(201).json(serializeCustomer(customer));
  } catch (err) {
    next(err);
  }
});

const customerUpdateSchema = customerSchema.partial().extend({ active: z.boolean().optional() });

router.patch("/api/customers/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = customerUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const customer = await Customer.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!customer) return res.status(404).json({ detail: "Customer not found" });

    const FIELD_MAP = { name: "name", email: "email", payment_terms_days: "paymentTermsDays", notes: "notes", active: "active" };
    for (const [field, attr] of Object.entries(FIELD_MAP)) {
      if (parsed.data[field] !== undefined) customer[attr] = parsed.data[field];
    }
    await customer.save();
    res.json(serializeCustomer(customer));
  } catch (err) {
    next(err);
  }
});

// ---- Recurring invoices ----

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function serializeRecurringInvoice(t, lines = null, accountsById = null) {
  return {
    id: t.id,
    customer_id: t.customerId,
    customer_name: t.customer?.name,
    name: t.name,
    memo: t.memo,
    frequency: t.frequency,
    start_date: t.startDate,
    end_date: t.endDate,
    last_issued_date: t.lastIssuedDate,
    active: t.active,
    auto_send: t.autoSend,
    next_due: dueDates({ frequency: t.frequency, startDate: t.startDate, endDate: t.endDate, lastPostedDate: t.lastIssuedDate }, todayIso())[0] || null,
    ...(lines
      ? {
          lines: lines.map((l) => ({
            id: l.id,
            revenue_account_id: l.revenueAccountId,
            revenue_account_name: accountsById?.get(l.revenueAccountId)?.name,
            description: l.description,
            quantity: l.quantity,
            unit_price: centsToDollars(l.unitPriceCents),
          })),
        }
      : {}),
  };
}

router.get("/api/recurring-invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const templates = await RecurringInvoice.findAll({
      where: { orgId },
      include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
      order: [["name", "ASC"]],
    });
    const accounts = await Account.findAll({ where: { orgId } });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const items = [];
    for (const t of templates) items.push(serializeRecurringInvoice(t, await loadTemplateLines(t.id), byId));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const recurringLineSchema = z.object({
  revenue_account_id: z.string().min(1),
  description: z.string().max(512).optional(),
  quantity: z.number().min(0).default(1),
  unit_price: z.number().min(0),
});

const recurringInvoiceSchema = z.object({
  customer_id: z.string().min(1),
  name: z.string().min(1).max(256),
  memo: z.string().max(512).optional(),
  frequency: z.enum(RECURRING_INVOICE_FREQUENCIES),
  start_date: z.string().regex(ISO_DATE),
  end_date: z.string().regex(ISO_DATE).optional(),
  auto_send: z.boolean().optional(),
  lines: z.array(recurringLineSchema).min(1),
});

router.post("/api/recurring-invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = recurringInvoiceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const data = parsed.data;

    if (data.end_date && data.end_date < data.start_date) {
      return res.status(422).json({ detail: "A recurring invoice can't end before it starts." });
    }
    const customer = await Customer.findOne({ where: { id: data.customer_id, orgId } });
    if (!customer) return res.status(404).json({ detail: "Customer not found" });
    if (!(await accountsExist(orgId, data.lines.map((l) => l.revenue_account_id)))) {
      return res.status(422).json({ detail: "Every line must bill to a revenue account in your chart of accounts." });
    }

    const template = await RecurringInvoice.create({
      orgId,
      customerId: customer.id,
      name: data.name,
      memo: data.memo || "",
      frequency: data.frequency,
      startDate: data.start_date,
      endDate: data.end_date || null,
      autoSend: data.auto_send || false,
    });
    await RecurringInvoiceLine.bulkCreate(
      data.lines.map((l, i) => ({
        recurringInvoiceId: template.id,
        revenueAccountId: l.revenue_account_id,
        description: l.description || "",
        quantity: l.quantity,
        unitPriceCents: dollarsToCents(l.unit_price),
        position: i,
      }))
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "recurring_invoice_created",
      actor: req.currentUser.email,
      details: { name: template.name, customer: customer.name, frequency: template.frequency },
    });

    template.customer = customer;
    const accounts = await Account.findAll({ where: { orgId } });
    res.status(201).json(serializeRecurringInvoice(template, await loadTemplateLines(template.id), new Map(accounts.map((a) => [a.id, a]))));
  } catch (err) {
    next(err);
  }
});

router.patch("/api/recurring-invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        name: z.string().min(1).max(256).optional(),
        active: z.boolean().optional(),
        end_date: z.string().regex(ISO_DATE).nullable().optional(),
        auto_send: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const template = await RecurringInvoice.findOne({
      where: { id: req.params.id, orgId: req.currentUser.orgId },
      include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
    });
    if (!template) return res.status(404).json({ detail: "Recurring invoice not found" });

    if (parsed.data.name !== undefined) template.name = parsed.data.name;
    if (parsed.data.active !== undefined) template.active = parsed.data.active;
    if (parsed.data.end_date !== undefined) template.endDate = parsed.data.end_date;
    if (parsed.data.auto_send !== undefined) template.autoSend = parsed.data.auto_send;
    await template.save();

    res.json(serializeRecurringInvoice(template));
  } catch (err) {
    next(err);
  }
});

// Deleting stops future issuance. Invoices already created are real
// CustomerInvoice rows and stay -- this only stops the next one.
router.delete("/api/recurring-invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const template = await RecurringInvoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!template) return res.status(404).json({ detail: "Recurring invoice not found" });
    await template.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/api/recurring-invoices/pending", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : todayIso();
    res.json(await previewRecurringInvoices(req.currentUser.orgId, asOf));
  } catch (err) {
    next(err);
  }
});

router.post("/api/recurring-invoices/run", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z
      .object({ as_of: z.string().regex(ISO_DATE).optional(), template_id: z.string().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const asOf = parsed.data.as_of || todayIso();

    const result = await runRecurringInvoices(req.currentUser.orgId, asOf, {
      postedByUserId: req.currentUser.id,
      templateId: parsed.data.template_id || null,
    });

    if (result.issued.length) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "recurring_invoices_run",
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

// ---- Customer invoices ----

async function getOwnedInvoice(id, orgId) {
  return CustomerInvoice.findOne({
    where: { id, orgId },
    include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
  });
}

function loadLines(customerInvoiceId) {
  return CustomerInvoiceLine.findAll({
    where: { customerInvoiceId },
    include: [{ model: Account, as: "revenueAccount", attributes: ["name"] }],
    order: [["position", "ASC"]],
  });
}

router.get("/api/customer-invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.customer_id) where.customerId = req.query.customer_id;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await CustomerInvoice.findAndCountAll({
      where,
      include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
      order: [["issueDate", "DESC"], ["createdAt", "DESC"]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const items = await Promise.all(
      rows.map(async (inv) => serializeInvoice(inv, { paidCents: await amountPaidCents(inv.id) }))
    );
    res.json({ items, total: count, page, page_size: pageSize });
  } catch (err) {
    next(err);
  }
});

const lineSchema = z
  .object({
    revenue_account_id: z.string().min(1),
    description: z.string().max(512).optional(),
    quantity: z.number().min(0).default(1),
    unit_price: z.number().min(0),
    // Both or neither: a half-specified service period has no defensible
    // reading (does it run to the end of time?), so it's rejected rather
    // than guessed at.
    service_start_date: z.string().regex(ISO_DATE).optional(),
    service_end_date: z.string().regex(ISO_DATE).optional(),
  })
  .refine((l) => Boolean(l.service_start_date) === Boolean(l.service_end_date), {
    message: "A service period needs both a start and an end date.",
  })
  .refine((l) => !l.service_start_date || l.service_start_date <= l.service_end_date, {
    message: "A service period can't end before it starts.",
  });

const invoiceSchema = z.object({
  customer_id: z.string().min(1),
  issue_date: z.string().min(1),
  due_date: z.string().optional(),
  memo: z.string().max(512).optional(),
  lines: z.array(lineSchema).min(1),
});

// Amounts are rounded to whole cents per line, then the invoice total is
// the sum of those rounded lines -- never a separately-rounded total,
// which could differ by a cent and make the journal entry unpostable.
function buildLines(parsedLines) {
  return parsedLines.map((l, i) => {
    const unitPriceCents = dollarsToCents(l.unit_price);
    return {
      revenueAccountId: l.revenue_account_id,
      description: l.description || "",
      quantity: l.quantity,
      unitPriceCents,
      amountCents: Math.round(unitPriceCents * l.quantity),
      serviceStartDate: l.service_start_date || null,
      serviceEndDate: l.service_end_date || null,
      position: i,
    };
  });
}

router.post("/api/customer-invoices", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = invoiceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const customer = await Customer.findOne({ where: { id: parsed.data.customer_id, orgId } });
    if (!customer) return res.status(404).json({ detail: "Customer not found" });

    const lines = buildLines(parsed.data.lines);
    const accountIds = [...new Set(lines.map((l) => l.revenueAccountId))];
    const accounts = await Account.findAll({ where: { id: accountIds, orgId, type: "revenue" } });
    if (accounts.length !== accountIds.length) {
      return res.status(422).json({ detail: "Every line must bill to a revenue account in your chart of accounts." });
    }

    const invoice = await CustomerInvoice.create({
      orgId,
      customerId: customer.id,
      invoiceNumber: await nextInvoiceNumber(orgId),
      issueDate: parsed.data.issue_date,
      // Falls back to the customer's own net terms -- the reason payment
      // terms live on the customer at all.
      dueDate: parsed.data.due_date || addDays(parsed.data.issue_date, customer.paymentTermsDays),
      memo: parsed.data.memo || "",
      totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
      status: "draft",
    });
    await CustomerInvoiceLine.bulkCreate(lines.map((l) => ({ ...l, customerInvoiceId: invoice.id })));

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "customer_invoice_created",
      actor: req.currentUser.email,
      details: { invoice_number: invoice.invoiceNumber, total: centsToDollars(invoice.totalCents) },
    });

    invoice.customer = customer;
    res.status(201).json(serializeInvoice(invoice, { lines: await loadLines(invoice.id), paidCents: 0 }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/customer-invoices/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    res.json(
      serializeInvoice(invoice, { lines: await loadLines(invoice.id), paidCents: await amountPaidCents(invoice.id) })
    );
  } catch (err) {
    next(err);
  }
});

// Draft -> sent. This is the moment it becomes a real receivable and hits
// the books; before this the invoice exists but affects nothing.
router.post("/api/customer-invoices/:id/send", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.status !== "draft") {
      return res.status(409).json({ detail: `This invoice is already ${invoice.status}.` });
    }

    const lines = await loadLines(invoice.id);
    await sendCustomerInvoice(invoice, lines, { postedByUserId: req.currentUser.id });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "customer_invoice_sent",
      actor: req.currentUser.email,
      details: { invoice_number: invoice.invoiceNumber, total: centsToDollars(invoice.totalCents) },
    });

    res.json(serializeInvoice(invoice, { lines, paidCents: 0 }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/customer-invoices/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const invoice = await getOwnedInvoice(req.params.id, req.currentUser.orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.status === "void") return res.status(409).json({ detail: "This invoice is already void." });

    // Reverses the issue entry. Payments already recorded against it keep
    // their own entries -- voiding an invoice someone has actually paid
    // is a refund conversation, not something to silently unwind here,
    // so this refuses rather than guessing.
    if ((await amountPaidCents(invoice.id)) > 0) {
      return res.status(409).json({
        detail: "This invoice has payments recorded against it. Remove those first if you need to void it.",
      });
    }

    await voidCustomerInvoiceEntry(req.currentUser.orgId, invoice.id, { postedByUserId: req.currentUser.id });
    // Months already recognized are history -- their journal entries stand
    // and the void's reversal cancels the original invoice posting. Months
    // never earned simply stop being planned.
    await dropUnrecognizedSchedule(req.currentUser.orgId, invoice.id);
    invoice.status = "void";
    await invoice.save();

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "customer_invoice_voided",
      actor: req.currentUser.email,
      details: { invoice_number: invoice.invoiceNumber },
    });

    res.json(serializeInvoice(invoice, { lines: await loadLines(invoice.id), paidCents: 0 }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// ---- Payments ----

const paymentSchema = z.object({
  amount: z.number().positive(),
  payment_date: z.string().min(1),
  deposit_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
});

router.post("/api/customer-invoices/:id/payments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const invoice = await getOwnedInvoice(req.params.id, orgId);
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (!["sent", "paid"].includes(invoice.status)) {
      return res.status(409).json({ detail: `Can't record a payment against a ${invoice.status} invoice.` });
    }

    const depositAccount = await Account.findOne({ where: { id: parsed.data.deposit_account_id, orgId, type: "asset" } });
    if (!depositAccount) return res.status(422).json({ detail: "Deposit account must be an asset account you own." });
    // Depositing into Accounts Receivable itself posts Debit AR / Credit AR:
    // balanced, so every check the ledger makes passes, and it moves nothing.
    // Refused here rather than left to the UI, since nothing downstream
    // would ever flag an invoice marked paid against an entry that did
    // nothing.
    if (depositAccount.subtype === "accounts_receivable") {
      return res.status(422).json({ detail: "Pick the account the money actually landed in, not Accounts Receivable." });
    }

    const amountCents = dollarsToCents(parsed.data.amount);
    const alreadyPaid = await amountPaidCents(invoice.id);
    if (alreadyPaid + amountCents > invoice.totalCents) {
      return res.status(422).json({
        detail: `That would overpay this invoice. Outstanding balance is ${centsToDollars(
          invoice.totalCents - alreadyPaid
        )}.`,
      });
    }

    const payment = await CustomerPayment.create({
      orgId,
      customerInvoiceId: invoice.id,
      depositAccountId: depositAccount.id,
      paymentDate: parsed.data.payment_date,
      amountCents,
      memo: parsed.data.memo || "",
    });

    // The payment row has to exist before the entry can reference it as its
    // source, but a posting that throws (a closed period, most likely) would
    // otherwise leave the row behind with no journal entry against it --
    // money the aging report counts as collected and the ledger has never
    // seen. Unwound explicitly so a refused posting means no payment at all.
    try {
      await postCustomerPayment(payment, invoice, { postedByUserId: req.currentUser.id });
    } catch (err) {
      await payment.destroy();
      throw err;
    }
    await refreshInvoiceStatus(invoice);

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "customer_payment_recorded",
      actor: req.currentUser.email,
      details: { invoice_number: invoice.invoiceNumber, amount: parsed.data.amount },
    });

    res.status(201).json(
      serializeInvoice(invoice, { lines: await loadLines(invoice.id), paidCents: await amountPaidCents(invoice.id) })
    );
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// ---- Aging ----

router.get("/api/reports/ar-aging", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || "") ? req.query.as_of : null;
    res.json(await computeArAging(req.currentUser.orgId, { asOf }));
  } catch (err) {
    next(err);
  }
});

export default router;
