// Recurring vendor bills: the AP mirror of recurringInvoices.js, for rent,
// subscriptions, and retainers that otherwise had to be keyed into the
// Review Queue by hand every period.
//
// Same template-plus-schedule shape as RecurringInvoice/RecurringEntry, and
// reuses their `dueDates`/`addMonthsClamped` arithmetic verbatim: a period
// that hasn't been issued yet must not exist as a real bill, for the same
// reason a not-yet-posted depreciation entry mustn't -- a pre-created future
// bill would show up in this month's AP aging before its time.
//
// An occurrence is a real Invoice row (the AP bill model), not a separate
// table -- it goes through the same Review Queue, the same
// postInvoiceApproval, and the same AP aging every other bill does, so a
// recurring bill can't drift from what a manually-entered one looks like.

import { buildPdf } from "./demoSeed.js";
import { LedgerError, centsToDollars, postInvoiceApproval } from "./ledger.js";
import { addMonthsClamped, dueDates } from "./recurringEntries.js";
import { Account, AuditLog, Invoice, LineItem, RecurringBill } from "./models/index.js";
import { settings } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export { addMonthsClamped, dueDates };

function scheduleFields(template) {
  return { frequency: template.frequency, startDate: template.startDate, endDate: template.endDate, lastPostedDate: template.lastIssuedDate };
}

// A small real PDF so the Review Queue's document preview has something to
// show, same reasoning as demoSeed.js/sampleSeed.js: there's no scanned
// document behind a template-generated bill, but the preview pane
// shouldn't be the one place that's obviously fake.
function writeOccurrenceFile(template, issueDate) {
  const lines = [
    template.vendorName,
    "",
    "RECURRING BILL",
    `Template: ${template.name}`,
    `Period: ${issueDate}`,
    `Amount: $${centsToDollars(template.amountCents).toFixed(2)}`,
    ...(template.memo ? ["", template.memo] : []),
  ];
  const filename = `recurring-bill-${crypto.randomBytes(8).toString("hex")}.pdf`;
  const storagePath = path.join(settings.storageDir, filename);
  fs.writeFileSync(storagePath, buildPdf(lines));
  return storagePath;
}

// Issues one occurrence as a real Invoice (AP bill) row, in the same
// "needs_review" state a low-confidence upload would land in -- or,
// if the template is flagged autoApprove, approved and posted immediately.
// Returns { invoice, posted }: `posted` is the JournalEntry if autoApprove
// succeeded, null otherwise. postInvoiceApproval never throws for a closed
// period -- it degrades silently and records the skip on the audit log
// (see its own comment in ledger.js) -- so there's nothing to catch here;
// the bill is created either way, just left approved-but-unposted if the
// period was closed.
export async function issueOccurrence(template, issueDate, { postedByUserId = null } = {}) {
  const expenseAccount = await Account.findOne({ where: { id: template.expenseAccountId, orgId: template.orgId } });
  if (!expenseAccount) throw new LedgerError("This template's expense account no longer exists.", 409);

  const amount = centsToDollars(template.amountCents);
  const storagePath = writeOccurrenceFile(template, issueDate);

  const invoice = await Invoice.create({
    orgId: template.orgId,
    originalFilename: `${template.vendorName.replace(/\s+/g, "_")}_${issueDate}.pdf`,
    storagePath,
    contentType: "application/pdf",
    vendorName: template.vendorName,
    invoiceNumber: `${template.name} -- ${issueDate}`,
    invoiceDate: issueDate,
    dueDate: issueDate,
    currency: "USD",
    subtotal: amount,
    tax: 0,
    total: amount,
    status: template.autoApprove ? "approved" : "needs_review",
    overallConfidence: 1,
    crossCheckPassed: true,
    crossCheckDetail: "Generated from a recurring bill template; nothing to cross-check.",
    extractionMethod: "recurring_template",
    quickbooksExpenseAccountId: expenseAccount.id,
    quickbooksExpenseAccountName: expenseAccount.name,
  });
  await LineItem.create({
    invoiceId: invoice.id,
    position: 0,
    description: template.memo || template.name,
    quantity: 1,
    unitPrice: amount,
    amount,
    confidence: 1,
  });
  await AuditLog.create({
    orgId: template.orgId,
    invoiceId: invoice.id,
    action: "recurring_bill_issued",
    actor: "system",
    details: { template: template.name, period: issueDate },
  });

  if (!template.autoApprove) return { invoice, posted: null };
  return { invoice, posted: await postInvoiceApproval(invoice) };
}

// Runs every active template up to `asOf`, issuing each occurrence it
// owes. A template that fails doesn't stop the others, same reasoning
// runRecurringEntries/runRecurringInvoices use. The draft (or approval)
// always succeeds up through invoice creation -- only the auto-approve
// posting step can fail on a closed period, and that failure doesn't
// prevent the period from being marked issued, since the bill itself was
// created either way.
export async function runRecurringBills(orgId, asOf, { postedByUserId = null, templateId = null } = {}) {
  const where = { orgId, active: true };
  if (templateId) where.id = templateId;
  const templates = await RecurringBill.findAll({ where, order: [["name", "ASC"]] });

  const issued = [];
  const skipped = [];
  let totalCents = 0;

  for (const template of templates) {
    const dates = dueDates(scheduleFields(template), asOf);
    if (!dates.length) continue;

    for (const date of dates) {
      try {
        const { invoice, posted } = await issueOccurrence(template, date, { postedByUserId });
        totalCents += template.amountCents;
        issued.push({
          template: template.name,
          issue_date: date,
          invoice_id: invoice.id,
          amount: centsToDollars(template.amountCents),
          approved: Boolean(posted),
        });
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
export async function previewRecurringBills(orgId, asOf) {
  const templates = await RecurringBill.findAll({ where: { orgId, active: true }, order: [["name", "ASC"]] });
  const items = [];

  for (const template of templates) {
    const dates = dueDates(scheduleFields(template), asOf);
    if (!dates.length) continue;
    items.push({
      id: template.id,
      name: template.name,
      vendor_name: template.vendorName,
      frequency: template.frequency,
      periods: dates,
      amount_each: centsToDollars(template.amountCents),
      amount_total: centsToDollars(template.amountCents * dates.length),
      auto_approve: template.autoApprove,
    });
  }

  return { as_of: asOf, items, occurrences: items.reduce((s, i) => s + i.periods.length, 0) };
}
