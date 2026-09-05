// Recurring-invoice-based SaaS metrics: MRR and ARR.
//
// This asks a different question than revenueRecognition.js. Deferred
// revenue asks "how much revenue has been earned so far against a
// specific invoice's service period." MRR asks "if nothing changes, what
// would a month of this customer's billing be, right now." A recurring
// invoice template (recurringInvoices.js) already states that directly --
// quantity and unit price per line, at a known cadence -- so MRR is read
// off it, never derived from anything in the ledger. Normalizing an
// annual template's stated amount to "a month of it" is division, not
// invention, the same way computeCashPosition reads a balance rather than
// estimating one.
//
// What this deliberately doesn't do: a historical trend. `active` on a
// RecurringInvoice is a current-state switch, not a dated event -- a
// template someone paused without setting an end date has no record of
// *when* that happened, so replaying "MRR as of three months ago" against
// today's active flags would be quietly wrong for exactly that case. This
// answers "MRR right now," which the data actually supports.

import { Op } from "sequelize";
import { centsToDollars } from "./ledger.js";
import { Customer, RecurringInvoice, RecurringInvoiceLine } from "./models/index.js";

const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, annually: 12 };

function templateMonthlyCents(template) {
  const totalCents = template.lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceCents), 0);
  return Math.round(totalCents / MONTHS_PER_PERIOD[template.frequency]);
}

export async function computeMrr(orgId, { asOf = null } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);

  const templates = await RecurringInvoice.findAll({
    where: {
      orgId,
      active: true,
      startDate: { [Op.lte]: today },
      [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: today } }],
    },
    include: [
      { model: RecurringInvoiceLine, as: "lines" },
      { model: Customer, as: "customer" },
    ],
  });

  const byCustomer = new Map();
  let totalCents = 0;
  for (const t of templates) {
    const monthlyCents = templateMonthlyCents(t);
    totalCents += monthlyCents;

    const existing = byCustomer.get(t.customerId) || {
      customer_id: t.customerId,
      customer_name: t.customer?.name ?? "Unknown",
      mrr_cents: 0,
      subscriptions: 0,
    };
    existing.mrr_cents += monthlyCents;
    existing.subscriptions += 1;
    byCustomer.set(t.customerId, existing);
  }

  const customers = [...byCustomer.values()]
    .sort((a, b) => b.mrr_cents - a.mrr_cents)
    .map((c) => ({
      customer_id: c.customer_id,
      customer_name: c.customer_name,
      subscriptions: c.subscriptions,
      mrr: centsToDollars(c.mrr_cents),
    }));

  return {
    as_of: today,
    mrr: centsToDollars(totalCents),
    arr: centsToDollars(totalCents * 12),
    active_subscriptions: templates.length,
    customers,
  };
}
