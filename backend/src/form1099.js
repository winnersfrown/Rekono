// 1099-NEC prep: which vendors this org paid enough, and by what method,
// to owe them a Form 1099-NEC for the year.
//
// Two rules do the actual filtering, and both come straight from the
// form's own instructions rather than anything invented here:
//   - $600 or more in nonemployee compensation in the calendar year.
//   - Paid by cash, check, or bank transfer -- payments made by credit
//     card, debit card, or a third-party payment network are excluded by
//     statute (IRC 6050W): the card network or platform reports those on
//     a 1099-K instead, and reporting the same payment on both forms is
//     the actual compliance bug this guards against.
// Whether a particular vendor is a corporation (generally exempt) is not
// something Rekono can know without asking, so that call stays a vendor-
// level flag a human sets -- never inferred from a name or category.
import { Op } from "sequelize";
import { Account, BillPayment, Invoice, Vendor } from "./models/index.js";

export const FORM_1099_NEC_THRESHOLD_CENTS = 60000;

// The only payment-account subtype this app uses to represent "the money
// went out on a card" (accountsPayable.js's isValidPaymentAccount lets a
// bill payment come from any asset or liability account) -- see
// accountTaxonomy.js's "credit_card" liability subtype.
const CARD_PAYMENT_SUBTYPE = "credit_card";

// Vendors paid at least the 1099-NEC threshold this calendar year via a
// reportable payment method, with whatever compliance status is already
// on file. Only vendors over the threshold are returned -- a vendor paid
// $40 isn't a filing question, so there's nothing useful to show about it.
export async function compute1099Summary(orgId, taxYear) {
  const from = `${taxYear}-01-01`;
  const to = `${taxYear}-12-31`;

  const invoices = await Invoice.scope("withSamples").findAll({
    where: { orgId, vendorId: { [Op.ne]: null } },
    attributes: ["id", "vendorId"],
    raw: true,
  });
  if (!invoices.length) return [];
  const vendorByInvoice = new Map(invoices.map((i) => [i.id, i.vendorId]));

  const payments = await BillPayment.findAll({
    where: { orgId, invoiceId: { [Op.in]: invoices.map((i) => i.id) }, paymentDate: { [Op.between]: [from, to] } },
    attributes: ["invoiceId", "paymentAccountId", "amountCents"],
    raw: true,
  });
  if (!payments.length) return [];

  const accounts = await Account.findAll({
    where: { id: { [Op.in]: [...new Set(payments.map((p) => p.paymentAccountId))] } },
    attributes: ["id", "subtype"],
    raw: true,
  });
  const subtypeByAccount = new Map(accounts.map((a) => [a.id, a.subtype]));

  const totalsByVendor = new Map();
  for (const payment of payments) {
    if (subtypeByAccount.get(payment.paymentAccountId) === CARD_PAYMENT_SUBTYPE) continue;
    const vendorId = vendorByInvoice.get(payment.invoiceId);
    if (!vendorId) continue;
    totalsByVendor.set(vendorId, (totalsByVendor.get(vendorId) || 0) + payment.amountCents);
  }

  const overThresholdIds = [...totalsByVendor.entries()]
    .filter(([, cents]) => cents >= FORM_1099_NEC_THRESHOLD_CENTS)
    .map(([id]) => id);
  if (!overThresholdIds.length) return [];

  const vendors = await Vendor.findAll({ where: { orgId, id: { [Op.in]: overThresholdIds } } });
  return vendors
    .map((v) => {
      const totalCents = totalsByVendor.get(v.id);
      return {
        vendor_id: v.id,
        vendor_name: v.name,
        total_cents: totalCents,
        tax_id_last4: v.taxIdLast4,
        exempt: v.form1099Exempt,
        missing_tin: !v.form1099Exempt && !v.taxIdLast4,
      };
    })
    .sort((a, b) => b.total_cents - a.total_cents);
}
