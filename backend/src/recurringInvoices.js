// Recurring customer invoices: the AR equivalent of recurringEntries.js's
// adjusting-entry templates, for the subscription/retainer billing case
// that had no home before this -- a customer on a monthly retainer had to
// be re-invoiced by hand every period, with every chance that implies to
// forget a month or bill the wrong amount.
//
// Same template-plus-schedule shape as RecurringEntry, and reuses its
// `dueDates`/`addMonthsClamped` arithmetic verbatim rather than
// reimplementing it: a period that hasn't been issued yet must not exist
// as a real invoice, for the same reason a not-yet-posted depreciation
// entry mustn't -- a pre-created future invoice would show up in this
// month's AR aging before its time.

import { LedgerError, centsToDollars } from "./ledger.js";
import { addDays, nextInvoiceNumber, sendCustomerInvoice } from "./accountsReceivable.js";
import { addMonthsClamped, dueDates } from "./recurringEntries.js";
import { computeInvoiceTaxCents } from "./salesTax.js";
import {
  Account,
  Customer,
  CustomerInvoice,
  CustomerInvoiceLine,
  Organization,
  RecurringInvoice,
  RecurringInvoiceLine,
} from "./models/index.js";

export { addMonthsClamped, dueDates };

export async function loadTemplateLines(recurringInvoiceId) {
  return RecurringInvoiceLine.findAll({
    where: { recurringInvoiceId },
    order: [
      ["position", "ASC"],
      ["id", "ASC"],
    ],
  });
}

// Adapts a RecurringInvoice (lastIssuedDate) to the {frequency, startDate,
// endDate, lastPostedDate} shape dueDates() expects, so the schedule
// arithmetic itself isn't duplicated between the two recurring-template
// systems.
function scheduleFields(template) {
  return { frequency: template.frequency, startDate: template.startDate, endDate: template.endDate, lastPostedDate: template.lastIssuedDate };
}

// Issues one occurrence as a draft invoice. Returns { invoice, sent },
// where `sent` is true only if the template is flagged autoSend and the
// send succeeded. Throws LedgerError only for the send step -- creating
// the draft itself can't fail on a closed period (a draft doesn't touch
// the ledger), so a template whose period is closed still gets its draft,
// just not auto-sent, and that failure is reported rather than silently
// leaving a stuck draft with no explanation.
export async function issueOccurrence(template, lines, issueDate, { postedByUserId = null } = {}) {
  const customer = await Customer.findOne({ where: { id: template.customerId, orgId: template.orgId } });
  if (!customer) throw new LedgerError("This template's customer no longer exists.", 409);

  const builtLines = lines.map((l, i) => ({
    revenueAccountId: l.revenueAccountId,
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    amountCents: Math.round(l.unitPriceCents * l.quantity),
    taxable: l.taxable !== false,
    position: i,
  }));
  const linesTotalCents = builtLines.reduce((sum, l) => sum + l.amountCents, 0);

  const org = await Organization.findOne({ where: { id: template.orgId } });
  const taxCents = customer.taxExempt ? 0 : computeInvoiceTaxCents(org?.salesTaxRatePercent, builtLines);

  const invoice = await CustomerInvoice.create({
    orgId: template.orgId,
    customerId: customer.id,
    invoiceNumber: await nextInvoiceNumber(template.orgId),
    issueDate,
    dueDate: addDays(issueDate, customer.paymentTermsDays),
    memo: template.memo || template.name,
    totalCents: linesTotalCents + taxCents,
    taxCents,
    status: "draft",
  });
  await CustomerInvoiceLine.bulkCreate(builtLines.map((l) => ({ ...l, customerInvoiceId: invoice.id })));

  if (!template.autoSend) return { invoice, sent: false, sendError: null };

  try {
    invoice.customer = customer;
    const createdLines = await CustomerInvoiceLine.findAll({ where: { customerInvoiceId: invoice.id }, order: [["position", "ASC"]] });
    await sendCustomerInvoice(invoice, createdLines, { postedByUserId });
    return { invoice, sent: true, sendError: null };
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    return { invoice, sent: false, sendError: err.message };
  }
}

// Runs every active template up to `asOf`, issuing each occurrence it
// owes. A template that fails doesn't stop the others, same reasoning
// runRecurringEntries uses for adjusting entries.
export async function runRecurringInvoices(orgId, asOf, { postedByUserId = null, templateId = null } = {}) {
  const where = { orgId, active: true };
  if (templateId) where.id = templateId;
  const templates = await RecurringInvoice.findAll({ where, order: [["name", "ASC"]] });

  const issued = [];
  const skipped = [];
  let totalCents = 0;

  for (const template of templates) {
    const dates = dueDates(scheduleFields(template), asOf);
    if (!dates.length) continue;

    const lines = await loadTemplateLines(template.id);
    if (!lines.length) {
      skipped.push({ name: template.name, reason: "This template needs at least one line to bill." });
      continue;
    }

    for (const date of dates) {
      try {
        const { invoice, sent, sendError } = await issueOccurrence(template, lines, date, { postedByUserId });
        totalCents += invoice.totalCents;
        issued.push({
          template: template.name,
          issue_date: date,
          customer_invoice_id: invoice.id,
          invoice_number: invoice.invoiceNumber,
          amount: centsToDollars(invoice.totalCents),
          sent,
          ...(sendError ? { send_error: sendError } : {}),
        });
        // Advanced only after the draft was successfully created, so a
        // failure leaves the template still due for that period.
        template.lastIssuedDate = date;
        await template.save();
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        skipped.push({ name: template.name, issue_date: date, reason: err.message });
        break;
      }
    }
  }

  return { issued, skipped, total: centsToDollars(totalCents) };
}

// What a run would issue, without issuing it.
export async function previewRecurringInvoices(orgId, asOf) {
  const templates = await RecurringInvoice.findAll({ where: { orgId, active: true }, order: [["name", "ASC"]] });
  const items = [];

  for (const template of templates) {
    const dates = dueDates(scheduleFields(template), asOf);
    if (!dates.length) continue;
    const lines = await loadTemplateLines(template.id);
    const amountCents = lines.reduce((s, l) => s + Math.round(l.unitPriceCents * l.quantity), 0);
    items.push({
      id: template.id,
      name: template.name,
      frequency: template.frequency,
      periods: dates,
      amount_each: centsToDollars(amountCents),
      amount_total: centsToDollars(amountCents * dates.length),
      auto_send: template.autoSend,
    });
  }

  return { as_of: asOf, items, occurrences: items.reduce((s, i) => s + i.periods.length, 0) };
}

export async function accountsExist(orgId, accountIds) {
  const found = await Account.findAll({ where: { orgId, id: accountIds, type: "revenue" }, attributes: ["id"], raw: true });
  return found.length === new Set(accountIds).size;
}
