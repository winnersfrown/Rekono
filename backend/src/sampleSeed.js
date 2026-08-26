// A brand-new org's Review Queue is empty until someone uploads something,
// which reads as broken rather than empty -- especially for the flagship
// feature. This drops in one realistic, already-imperfect sample invoice
// (needs_review, not auto-approved) so a first-time login has something to
// click into and actually review, instead of a bare table.
//
// Called from every place an org's onboarding can complete (see
// routes/onboarding.js and routes/billing.js) rather than from signup
// itself, so it runs after the org has a plan, not before. Idempotent: it
// checks for ANY existing invoice (including a previous sample, via the
// withSamples scope) first, so a race between the checkout-confirm route
// and the Stripe webhook -- both of which can call this for the same
// paid-plan signup -- can never seed twice.

import { User, Invoice } from "./models/index.js";
import { seedInvoice } from "./demoSeed.js";

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function seedSampleInvoiceForNewOrg(org) {
  const existing = await Invoice.scope("withSamples").count({ where: { orgId: org.id } });
  if (existing > 0) return;

  const owner = await User.findOne({ where: { orgId: org.id, role: "owner" } });
  if (!owner) return;

  await seedInvoice(org, owner, {
    isSampleData: true,
    status: "needs_review",
    vendorName: "Sample Vendor Co.",
    vendorAddress: "123 Example St, Springfield, IL 62704",
    invoiceNumber: "SAMPLE-001",
    invoiceDate: daysFromNow(-10),
    dueDate: daysFromNow(20),
    subtotal: 450.0,
    tax: 36.0,
    total: 486.0,
    overallConfidence: 0.78,
    crossCheckPassed: true,
    crossCheckDetail: "Line items ($450.00) match subtotal ($450.00); subtotal + tax matches total.",
    extractionMethod: "llm",
    lineItems: [{ description: "Consulting services (10 hrs)", quantity: 10, unitPrice: 45, amount: 450 }],
  });
}
