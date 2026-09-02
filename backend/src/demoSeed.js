// Populates a brand-new demo Organization with a realistic, fully worked
// dataset across all five document pipelines -- invoices, expense receipts,
// vendor documents, leases, and tax documents -- plus matching data and an
// audit trail.
// Backs POST /api/demo/login (routes/demo.js): a public, no-signup sandbox
// for investors/prospects to click straight into a populated instance.
//
// Rows are inserted directly rather than run through the real OCR/LLM
// pipeline (jobs.js/pipeline.js etc.) -- the login response needs to come
// back immediately, and there's no real scanned document to OCR anyway --
// but every field is set to what that pipeline would actually have
// produced, so the review UI, confidence bars, and audit log all render
// exactly as they would for a real org's data. Real (tiny, synthetic) PDF
// files are still written to disk for each row so the document preview
// pane has something real to load.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "./config.js";
import * as auth from "./auth.js";
import {
  Organization,
  User,
  Invoice,
  LineItem,
  AuditLog,
  MatchSource,
  MatchEntry,
  MatchResult,
  ExpenseReceipt,
  VendorDocument,
  Lease,
  TaxDocument,
  NetWorthAccount,
  NetWorthEntry,
  Account,
  ClosePeriod,
  CloseTask,
  Vendor,
  Customer,
  CustomerInvoice,
  CustomerInvoiceLine,
  CustomerPayment,
  Employee,
} from "./models/index.js";
import { postInvoiceApproval, postJournalEntry, seedDefaultChartOfAccounts } from "./ledger.js";
import { DEFAULT_CLOSE_TASKS } from "./routes/close.js";
import { addDays, nextInvoiceNumber, postCustomerInvoice, postCustomerPayment, refreshInvoiceStatus } from "./accountsReceivable.js";
import { recordBillPayment } from "./accountsPayable.js";
import { writeCheck } from "./writtenChecks.js";
import { recordPayrollRun } from "./payroll.js";
import { recordEquityTransaction } from "./equity.js";
import { recordProvision, recordTaxPayment } from "./incomeTax.js";

// ---- minimal hand-rolled single-page PDF builder ----
// No PDF library dependency for a handful of lines of Helvetica text --
// this hand-assembles the small, fixed object set a trivial PDF needs
// (Catalog -> Pages -> Page -> content stream + a Type1 font) and computes
// real byte offsets for its own xref table, so the result is a genuinely
// valid PDF any viewer/OCR step can open, not just a byte string that
// happens to start with "%PDF".
// Exported so tests that need a genuinely OCR-able document (see
// taxDocPipeline.test.js) can build one instead of checking in a binary
// fixture -- there's no second implementation of this to drift from.
export function buildPdf(lines) {
  const escape = (s) => String(s).replace(/([()\\])/g, "\\$1");
  const body = lines.map((line, i) => `${i === 0 ? "72 720" : "0 -18"} Td (${escape(line)}) Tj`).join("\n");
  const stream = `BT /F1 12 Tf\n${body}\nET`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

function writeDemoFile(lines) {
  const filename = `demo-${crypto.randomBytes(8).toString("hex")}.pdf`;
  const storagePath = path.join(settings.storageDir, filename);
  fs.writeFileSync(storagePath, buildPdf(lines));
  return storagePath;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const COMPANY_NAMES = ["Aperture Retail Group", "Meridian Facilities Co.", "Northlight Commerce", "Cobalt & Pine Holdings"];

export async function seedDemoOrg() {
  const suffix = crypto.randomBytes(4).toString("hex");
  const companyName = COMPANY_NAMES[Math.floor(Math.random() * COMPANY_NAMES.length)];

  const org = await Organization.create({
    name: companyName,
    isDemo: true,
    plan: "scale",
    subscriptionStatus: "active",
    onboardingCompletedAt: new Date(),
    role: "Finance / Accounting",
    companySize: "51-200 employees",
    primaryUseCase: "Accounts payable automation",
    monthlyInvoiceVolume: "500-2,000",
  });

  const owner = await User.create({
    orgId: org.id,
    email: `demo-${suffix}@rekono-demo.app`,
    hashedPassword: await auth.hashPassword(crypto.randomBytes(32).toString("hex")),
    fullName: "Alex Rivera",
    role: "owner",
  });
  const member = await User.create({
    orgId: org.id,
    email: `demo-${suffix}-2@rekono-demo.app`,
    hashedPassword: await auth.hashPassword(crypto.randomBytes(32).toString("hex")),
    fullName: "Jordan Lee",
    role: "member",
  });

  await AuditLog.create({
    orgId: org.id,
    userId: owner.id,
    action: "account_created",
    actor: owner.email,
    details: { org_name: org.name, via: "demo" },
  });

  // ---- matching data: a PO export + a bank export, uploaded ahead of the
  // invoices below so a couple of them can show a real "matched" result ----
  const poSource = await MatchSource.create({ orgId: org.id, name: "Q3 2026 Purchase Orders.csv", sourceType: "po" });
  const bankSource = await MatchSource.create({ orgId: org.id, name: "Business Checking - August.csv", sourceType: "bank" });

  const poEntryAcme = await MatchEntry.create({
    sourceId: poSource.id,
    vendor: "Pinehurst Office Supply",
    amount: 1284.5,
    entryDate: daysFromNow(-14),
    reference: "PO-5521",
    rawRow: { vendor: "Pinehurst Office Supply", amount: 1284.5, reference: "PO-5521" },
  });
  await MatchEntry.create({
    sourceId: poSource.id,
    vendor: "Birchwood Creative Studio",
    amount: 760,
    entryDate: daysFromNow(-3),
    reference: "PO-5588",
    rawRow: { vendor: "Birchwood Creative Studio", amount: 760, reference: "PO-5588" },
  });
  const bankEntryGlobex = await MatchEntry.create({
    sourceId: bankSource.id,
    vendor: "Ridgeline Cloud Services",
    amount: 4950,
    entryDate: daysFromNow(-6),
    reference: "",
    rawRow: { vendor: "Ridgeline Cloud Services", amount: 4950 },
  });

  // ---- invoices ----
  const invoiceAcme = await seedInvoice(org, owner, {
    status: "approved",
    vendorName: "Pinehurst Office Supply",
    vendorAddress: "4420 Redwood Ave, Suite 100, Portland, OR 97201",
    invoiceNumber: "INV-10432",
    invoiceDate: daysFromNow(-16),
    dueDate: daysFromNow(14),
    poReference: "PO-5521",
    subtotal: 1190.0,
    tax: 94.5,
    total: 1284.5,
    overallConfidence: 0.96,
    crossCheckPassed: true,
    crossCheckDetail: "Line items (1190) match subtotal (1190); subtotal + tax matches total.",
    lineItems: [
      { description: "Standing desks (qty 4)", quantity: 4, unitPrice: 220, amount: 880 },
      { description: "Ergonomic task chairs (qty 2)", quantity: 2, unitPrice: 155, amount: 310 },
    ],
  });
  await MatchResult.create({
    invoiceId: invoiceAcme.id,
    matchEntryId: poEntryAcme.id,
    status: "matched",
    score: 97.2,
    reasoning: "vendor 'Pinehurst Office Supply' vs 'Pinehurst Office Supply' = 100/100; amount diff $0.00 (within tolerance); PO/reference number matches exactly.",
  });

  const invoiceGlobex = await seedInvoice(org, owner, {
    status: "approved",
    vendorName: "Ridgeline Cloud Services",
    vendorAddress: "2100 Harbor Blvd, San Jose, CA 95131",
    invoiceNumber: "INV-88213",
    invoiceDate: daysFromNow(-9),
    dueDate: daysFromNow(21),
    subtotal: 4500.0,
    tax: 450.0,
    total: 4950.0,
    overallConfidence: 0.94,
    crossCheckPassed: true,
    crossCheckDetail: "Line items (4500) match subtotal (4500); subtotal + tax matches total.",
    lineItems: [{ description: "Compute & storage, production environment (Aug 1-31)", quantity: 1, unitPrice: 4500, amount: 4500 }],
    quickbooksBillId: "bill_9F3K21",
    quickbooksExpenseAccountName: "Software & Cloud Services",
    quickbooksPaidAt: new Date(Date.now() - 2 * 86400000),
    quickbooksPaymentTransactionId: "txn_2AKX90",
    quickbooksPaymentTransactionType: "Purchase",
  });
  await MatchResult.create({
    invoiceId: invoiceGlobex.id,
    matchEntryId: bankEntryGlobex.id,
    status: "matched",
    score: 95.0,
    reasoning: "vendor 'Ridgeline Cloud Services' vs 'Ridgeline Cloud Services' = 100/100; amount diff $0.00 (within tolerance); date diff 3d (within 5d window).",
  });

  await seedInvoice(org, owner, {
    status: "needs_review",
    vendorName: "Cascade Freight & Logistics",
    vendorAddress: "880 Dockside Rd, Tacoma, WA 98421",
    invoiceNumber: "",
    invoiceDate: daysFromNow(-2),
    total: 2310.75,
    overallConfidence: 0.41,
    crossCheckPassed: false,
    crossCheckDetail: "No line items extracted to cross-check against the total.",
    extractionMethod: "heuristic",
    lineItems: [],
  });

  const duplicateOfAcme = await seedInvoice(org, member, {
    status: "needs_review",
    vendorName: "Pinehurst Office Supply",
    vendorAddress: "4420 Redwood Ave, Suite 100, Portland, OR 97201",
    invoiceNumber: "INV-10432",
    invoiceDate: daysFromNow(-1),
    poReference: "PO-5521",
    subtotal: 1190.0,
    tax: 94.5,
    total: 1284.5,
    overallConfidence: 0.91,
    crossCheckPassed: true,
    crossCheckDetail: "Line items (1190) match subtotal (1190); subtotal + tax matches total.",
    lineItems: [
      { description: "Standing desks (qty 4)", quantity: 4, unitPrice: 220, amount: 880 },
      { description: "Ergonomic task chairs (qty 2)", quantity: 2, unitPrice: 155, amount: 310 },
    ],
  });
  duplicateOfAcme.duplicateOfInvoiceId = invoiceAcme.id;
  duplicateOfAcme.duplicateOfFilename = invoiceAcme.originalFilename;
  await duplicateOfAcme.save();

  await seedInvoice(org, member, {
    status: "extracted",
    vendorName: "Birchwood Creative Studio",
    vendorAddress: "12 Elm Street, Studio 4, Austin, TX 78701",
    invoiceNumber: "INV-2291",
    invoiceDate: daysFromNow(-3),
    dueDate: daysFromNow(27),
    poReference: "PO-5588",
    subtotal: 700,
    tax: 60,
    total: 760,
    overallConfidence: 0.93,
    crossCheckPassed: true,
    crossCheckDetail: "Line items (700) match subtotal (700); subtotal + tax matches total.",
    lineItems: [{ description: "Brand refresh: logo and signage design", quantity: 1, unitPrice: 700, amount: 700 }],
  });

  await seedInvoice(org, owner, {
    status: "rejected",
    vendorName: "Southbridge Consulting LLC",
    vendorAddress: "1 Financial Plaza, Hartford, CT 06103",
    invoiceNumber: "INV-004",
    invoiceDate: daysFromNow(-20),
    dueDate: daysFromNow(10),
    total: 8200,
    overallConfidence: 0.55,
    crossCheckPassed: false,
    crossCheckDetail: "Line items sum to 6100, which does not match total (8200).",
    lineItems: [{ description: "Advisory retainer, Q3", quantity: 1, unitPrice: 6100, amount: 6100 }],
  });

  // ---- expense receipts ----
  await seedExpenseReceipt(org, owner, {
    status: "approved",
    merchantName: "Delta Air Lines",
    category: "Travel",
    receiptDate: daysFromNow(-11),
    amount: 412.0,
    tax: 0,
    overallConfidence: 0.95,
  });
  await seedExpenseReceipt(org, member, {
    status: "needs_review",
    merchantName: "The Capital Grille",
    category: "Meals & Entertainment",
    receiptDate: daysFromNow(-4),
    amount: 186.4,
    tax: 14.9,
    overallConfidence: 0.58,
  });
  await seedExpenseReceipt(org, member, {
    status: "extracted",
    merchantName: "Figma, Inc.",
    category: "Software & Subscriptions",
    receiptDate: daysFromNow(-1),
    amount: 45.0,
    tax: 0,
    overallConfidence: 0.97,
  });
  await seedExpenseReceipt(org, owner, {
    status: "approved",
    merchantName: "Staples",
    category: "Office Supplies",
    receiptDate: daysFromNow(-8),
    amount: 92.15,
    tax: 7.15,
    overallConfidence: 0.92,
  });

  // ---- vendor documents ----
  await seedVendorDocument(org, owner, {
    status: "approved",
    vendorName: "Cascade Freight & Logistics",
    documentType: "W-9",
    effectiveDate: daysFromNow(-200),
    referenceNumber: "TIN ***-**-4821",
    overallConfidence: 0.95,
  });
  await seedVendorDocument(org, member, {
    status: "needs_review",
    vendorName: "BuildRight Contractors",
    documentType: "Certificate of Insurance",
    effectiveDate: daysFromNow(-350),
    expirationDate: daysFromNow(18),
    referenceNumber: "Policy GL-88213",
    amount: 2000000,
    overallConfidence: 0.6,
  });
  await seedVendorDocument(org, owner, {
    status: "approved",
    vendorName: "CloudScale Hosting",
    documentType: "Contract",
    effectiveDate: daysFromNow(-90),
    expirationDate: daysFromNow(275),
    referenceNumber: "MSA-2026-014",
    amount: 54000,
    overallConfidence: 0.9,
  });

  // ---- leases ----
  await seedLease(org, owner, {
    status: "approved",
    landlordName: "Meridian Property Partners",
    propertyAddress: "480 Market Street, Suite 900, San Francisco, CA",
    commencementDate: daysFromNow(-540),
    expirationDate: daysFromNow(920),
    renewalNoticeDeadline: daysFromNow(560),
    monthlyRent: 28500,
    annualEscalationPct: 3.0,
    overallConfidence: 0.93,
  });
  await seedLease(org, member, {
    status: "needs_review",
    landlordName: "Harborview Industrial Realty",
    propertyAddress: "2200 Dockside Ave, Warehouse B, Oakland, CA",
    commencementDate: daysFromNow(-720),
    expirationDate: daysFromNow(430),
    renewalNoticeDeadline: daysFromNow(25),
    monthlyRent: 9800,
    annualEscalationPct: 2.5,
    overallConfidence: 0.64,
  });

  // ---- tax documents ----
  // Last tax year rather than the current one -- these forms arrive in
  // January reporting on the year just ended, so a demo showing the
  // current year would look wrong to anyone who files them.
  const lastTaxYear = new Date().getUTCFullYear() - 1;
  await seedTaxDocument(org, owner, {
    status: "approved",
    documentType: "1099-NEC",
    taxYear: lastTaxYear,
    payerName: "Brightline Systems Inc.",
    recipientName: "Northwind Consulting LLC",
    recipientTinLast4: "4417",
    amount: 84250,
    federalTaxWithheld: 0,
    overallConfidence: 0.94,
  });
  await seedTaxDocument(org, member, {
    status: "extracted",
    documentType: "1099-K",
    taxYear: lastTaxYear,
    payerName: "Stripe Payments Company",
    recipientName: "Northwind Consulting LLC",
    recipientTinLast4: "4417",
    amount: 212880.44,
    federalTaxWithheld: 0,
    overallConfidence: 0.89,
  });
  // Deliberately missing its recipient TIN, so the "Missing recipient TIN"
  // filter and the detail-view B-notice warning both have something real
  // to show.
  await seedTaxDocument(org, member, {
    status: "needs_review",
    documentType: "1099-MISC",
    taxYear: lastTaxYear,
    payerName: "Cedar Ridge Property Management",
    recipientName: "Northwind Consulting LLC",
    recipientTinLast4: "",
    amount: 18000,
    federalTaxWithheld: 5400,
    overallConfidence: 0.58,
  });

  const { byCode, openingDate } = await seedLedger(org, owner);
  await seedEquity(org, owner, byCode, openingDate);
  await seedVendorBillsAndPayments(org, owner, invoiceAcme, invoiceGlobex, byCode);
  await seedCustomersAndInvoices(org, owner, byCode);
  await seedPayroll(org, owner, byCode);
  await seedIncomeTax(org, owner);
  await seedClosePeriod(org, owner);
  await seedNetWorth(owner);

  return { org, user: owner };
}

// ---- the ledger ----
//
// Until this existed the demo seeded the five document pipelines and
// nothing else, which left every accounting tab -- chart of accounts,
// journal entries, trial balance, income statement, balance sheet, cash
// flow -- completely empty for anyone clicking into the sandbox. The demo
// showed the front half of the product and none of the half it is now
// mostly made of.
//
// Everything below goes through postJournalEntry, the same single write
// path a real posting uses, so the demo's books are subject to exactly the
// balance checks a customer's are. A seed that inserted journal_lines
// directly could produce an out-of-balance demo, which is the one thing
// this product must never show.
const DEMO_MONTHS = 6;

// A month key `n` months before the seeded "today", so the demo's data
// slides forward with the calendar rather than aging into a fixed year and
// eventually showing an income statement with nothing in the period a
// visitor's date picker defaults to.
function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

function isoDay(monthDate, day) {
  const y = monthDate.getUTCFullYear();
  const m = String(monthDate.getUTCMonth() + 1).padStart(2, "0");
  // Clamped so a "31st" never rolls into the next month on a short one.
  const lastDay = new Date(Date.UTC(y, monthDate.getUTCMonth() + 1, 0)).getUTCDate();
  return `${y}-${m}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

async function seedLedger(org, owner) {
  await seedDefaultChartOfAccounts(org);
  // The default chart's expense accounts mirror EXPENSE_CATEGORIES exactly
  // (5010 Travel through 5070 Other), so it has no Rent and no Equipment.
  // A real org adds them; posting rent to "Other" instead would make the
  // demo's own close suggestion ("Rent posted in 5 of the last 6 months")
  // read as nonsense.
  // Payroll needs its own three accounts too -- nothing in the default
  // chart or EXPENSE_CATEGORIES models wages at all, since the demo (like
  // any org before it adds employees) starts as an all-contractor company.
  await Account.bulkCreate([
    { orgId: org.id, code: "1500", name: "Equipment", type: "asset" },
    { orgId: org.id, code: "5080", name: "Rent", type: "expense" },
    { orgId: org.id, code: "5090", name: "Wages Expense", type: "expense" },
    { orgId: org.id, code: "5095", name: "Payroll Tax Expense", type: "expense" },
    { orgId: org.id, code: "2050", name: "Payroll Liabilities", type: "liability" },
  ]);

  const accounts = await Account.findAll({ where: { orgId: org.id }, raw: true });
  const byCode = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

  const cash = byCode["1000"];
  const ar = byCode["1100"];
  const revenue = byCode["4900"];
  const cogs = byCode["5000"];

  const post = (entryDate, memo, lines) =>
    postJournalEntry(org.id, { entryDate, memo, source: "manual", postedByUserId: owner.id, lines });

  // Dated before the reporting window so the opening entries below land on
  // the balance sheet without distorting any month's income statement.
  // The founder contribution itself is posted by seedEquity as a real
  // EquityTransaction, not a raw entry here, so the Equity tab has a real
  // row to show instead of a balance with nothing behind it.
  const opening = monthsAgo(DEMO_MONTHS);
  const openingDate = isoDay(opening, 1);

  // A fixed asset with nothing depreciating it, which is one of the two
  // things closeAutomation.js looks for -- so the Close tab's suggestions
  // have something real to surface instead of an empty list.
  await post(isoDay(opening, 12), "Server hardware", [
    { accountId: byCode["1500"], debitCents: 18_000_00 },
    { accountId: cash, creditCents: 18_000_00 },
  ]);

  // Six months of trading. Revenue grows, cost of revenue tracks it at
  // roughly 38% so gross margin is a number worth looking at, and the
  // operating expenses are the recurring ones a real close chases.
  const monthly = [
    { revenue: 41_200_00, cogs: 15_600_00 },
    { revenue: 46_800_00, cogs: 17_900_00 },
    { revenue: 44_100_00, cogs: 16_800_00 },
    { revenue: 52_400_00, cogs: 19_700_00 },
    { revenue: 58_900_00, cogs: 22_300_00 },
    { revenue: 63_500_00, cogs: 24_100_00 },
  ];

  for (let i = 0; i < monthly.length; i += 1) {
    const month = monthsAgo(DEMO_MONTHS - 1 - i);
    const { revenue: rev, cogs: cost } = monthly[i];

    // Billed on account, collected the following month -- so Accounts
    // Receivable carries a real balance and the AR aging report and cash
    // flow statement both have something to show.
    await post(isoDay(month, 28), "Consulting fees billed", [
      { accountId: ar, debitCents: rev },
      { accountId: revenue, creditCents: rev },
    ]);
    if (i > 0) {
      await post(isoDay(month, 8), "Customer payments received", [
        { accountId: cash, debitCents: monthly[i - 1].revenue },
        { accountId: ar, creditCents: monthly[i - 1].revenue },
      ]);
    }

    // Cost of revenue: contractor delivery time. This is what makes the
    // multi-step income statement show a gross profit line rather than
    // collapsing to the single-step shape.
    await post(isoDay(month, 25), "Contractor delivery time", [
      { accountId: cogs, debitCents: cost },
      { accountId: cash, creditCents: cost },
    ]);

    for (const [code, cents, memo] of [
      ["5080", 9_400_00, "Office rent"],
      ["5040", 1_850_00, "Software subscriptions"],
      ["5050", 640_00, "Utilities"],
      ["5030", 415_00, "Office supplies"],
      ["5010", 2_100_00, "Travel"],
    ]) {
      // Rent skips the most recent month on purpose. That is the other
      // thing closeAutomation.js looks for -- an expense that posted in
      // most of the window and not in this one -- so the Close tab shows a
      // genuine "this month is missing something" suggestion rather than a
      // clean bill of health nobody learns anything from.
      if (code === "5080" && i === monthly.length - 1) continue;
      await post(isoDay(month, 5), memo, [
        { accountId: byCode[code], debitCents: cents },
        { accountId: cash, creditCents: cents },
      ]);
    }
  }

  return { byCode, openingDate };
}

// The founder contribution as a real EquityTransaction (equity.js) rather
// than the raw manual entry seedLedger used to post -- same amount, same
// date, so the balance sheet doesn't move, but now the Equity tab and the
// Statement of Stockholders' Equity have a real row to show. A modest
// owner draw partway through the window does the same for Distributions,
// and gives the cash payments journal an equity_distribution row to show
// alongside the bill payments and payroll it already has.
async function seedEquity(org, owner, byCode, openingDate) {
  const cash = byCode["1000"];

  await recordEquityTransaction(
    org.id,
    { type: "contribution", transactionDate: openingDate, amountCents: 25_000_00, cashAccountId: cash },
    { postedByUserId: owner.id }
  );

  await recordEquityTransaction(
    org.id,
    { type: "distribution", transactionDate: isoDay(monthsAgo(2), 20), amountCents: 6_000_00, cashAccountId: cash },
    { postedByUserId: owner.id }
  );
}

// Ties two of the AP-automation documents seeded above to the real ledger:
// approving them for real (ledger.js's postInvoiceApproval) instead of
// leaving them as rows the Documents tab shows but the books never heard
// about -- before this, the entire Accounting section ran on a separate,
// disconnected set of raw journal entries and nothing in Payables ever
// touched it. Pinehurst gets early-payment terms and the demo actually
// takes the discount on a written check, so the Purchases and Cash
// Payments journals, AP Aging, Written Checks, and Vendors tabs all have
// real, current data instead of reading empty.
async function seedVendorBillsAndPayments(org, owner, invoiceAcme, invoiceGlobex, byCode) {
  await Vendor.create({
    orgId: org.id,
    name: "Pinehurst Office Supply",
    paymentTermsDays: 30,
    earlyPayDiscountPct: 2,
    earlyPayDiscountDays: 10,
  });
  await Vendor.create({ orgId: org.id, name: "Ridgeline Cloud Services", paymentTermsDays: 30 });

  await postInvoiceApproval(invoiceAcme);
  await postInvoiceApproval(invoiceGlobex);

  const cash = byCode["1000"];
  const totalAcmeCents = Math.round(invoiceAcme.total * 100);
  const discountCents = Math.round(totalAcmeCents * 0.02); // the full 2% -- paid inside the 10-day window
  await writeCheck(org.id, {
    invoiceId: invoiceAcme.id,
    checkNumber: "1024",
    payeeName: invoiceAcme.vendorName,
    checkDate: daysFromNow(-8),
    amountCents: totalAcmeCents - discountCents,
    discountCents,
    paymentAccountId: cash,
    postedByUserId: owner.id,
  });

  // Partial payment on the other bill, so AP Aging has a real outstanding
  // balance to show -- a demo where every bill is either untouched or
  // fully settled doesn't demonstrate what that report is for.
  await recordBillPayment(invoiceGlobex, {
    amountCents: 3_000_00,
    paymentDate: daysFromNow(-2),
    paymentAccountId: cash,
    postedByUserId: owner.id,
  });
}

// Two customers and a handful of AR invoices across every lifecycle stage
// -- draft (not on the books yet), sent and overdue, sent and partially
// paid, sent and fully paid -- posted through the real AR flow
// (accountsReceivable.js) rather than the raw revenue entries seedLedger
// posts. Receivables was the one section of the demo with nothing in it
// at all: no customers, no AR aging, nothing in the Sales or Cash Receipts
// journals.
async function seedCustomersAndInvoices(org, owner, byCode) {
  const revenue = byCode["4900"];
  const cash = byCode["1000"];

  const fernhollow = await Customer.create({
    orgId: org.id,
    name: "Fernhollow Media",
    email: "ap@fernhollowmedia.com",
    paymentTermsDays: 30,
  });
  const brightpoint = await Customer.create({
    orgId: org.id,
    name: "Brightpoint Analytics",
    email: "billing@brightpointanalytics.com",
    paymentTermsDays: 15,
  });

  async function draftInvoice(customer, { issueDate, dueDate, description, amount }) {
    const totalCents = Math.round(amount * 100);
    const invoice = await CustomerInvoice.create({
      orgId: org.id,
      customerId: customer.id,
      invoiceNumber: await nextInvoiceNumber(org.id),
      issueDate,
      dueDate: dueDate || addDays(issueDate, customer.paymentTermsDays),
      totalCents,
      status: "draft",
    });
    await CustomerInvoiceLine.create({
      customerInvoiceId: invoice.id,
      revenueAccountId: revenue,
      description,
      quantity: 1,
      unitPriceCents: totalCents,
      amountCents: totalCents,
      position: 0,
    });
    return invoice;
  }

  async function sendInvoice(invoice, customer) {
    await postCustomerInvoice(
      { ...invoice.get(), customerName: customer.name },
      [{ revenueAccountId: revenue, amountCents: invoice.totalCents }],
      { postedByUserId: owner.id }
    );
    invoice.status = "sent";
    invoice.sentAt = new Date();
    await invoice.save();
    return invoice;
  }

  async function pay(invoice, amountCents, paymentDate) {
    const payment = await CustomerPayment.create({
      orgId: org.id,
      customerInvoiceId: invoice.id,
      depositAccountId: cash,
      paymentDate,
      amountCents,
    });
    await postCustomerPayment(payment, invoice, { postedByUserId: owner.id });
    await refreshInvoiceStatus(invoice);
  }

  // Fully paid, on time -- the clean case.
  const paidInFull = await sendInvoice(
    await draftInvoice(fernhollow, { issueDate: daysFromNow(-40), description: "Q3 retainer -- strategy & analytics", amount: 6200 }),
    fernhollow
  );
  await pay(paidInFull, paidInFull.totalCents, daysFromNow(-32));

  // Sent, partially paid -- AR still carries a real outstanding balance.
  const partiallyPaid = await sendInvoice(
    await draftInvoice(fernhollow, { issueDate: daysFromNow(-18), description: "October ad campaign management", amount: 8400 }),
    fernhollow
  );
  await pay(partiallyPaid, 4_000_00, daysFromNow(-5));

  // Sent, untouched, and past due -- gives the AR aging report a bucket
  // beyond "current" to show.
  await sendInvoice(
    await draftInvoice(brightpoint, {
      issueDate: daysFromNow(-70),
      dueDate: daysFromNow(-40),
      description: "Data pipeline audit",
      amount: 3150,
    }),
    brightpoint
  );

  // Still a draft -- hasn't hit the books, which is the point: it proves a
  // draft really doesn't touch revenue or receivables until sent.
  await draftInvoice(brightpoint, { issueDate: daysFromNow(-1), description: "Q4 analytics dashboard build", amount: 5000 });
}

// Two employees and a couple of pay periods, posted through the real
// payroll flow (payroll.js's recordPayrollRun) -- individual employees,
// full tax withholding, and the employer's own payroll tax cost, so the
// Payroll tab (previously empty) and the cash payments journal both have
// something real.
async function seedPayroll(org, owner, byCode) {
  const alex = await Employee.create({ orgId: org.id, name: "Alex Rivera" });
  const jordan = await Employee.create({ orgId: org.id, name: "Jordan Lee" });

  const cash = byCode["1000"];
  const wages = byCode["5090"];
  const payrollTax = byCode["5095"];
  const liabilities = byCode["2050"];

  for (const monthOffset of [1, 0]) {
    for (const [employee, grossCents] of [
      [alex, 6_500_00],
      [jordan, 5_800_00],
    ]) {
      const federal = Math.round(grossCents * 0.12);
      const state = Math.round(grossCents * 0.04);
      const ficaEmployee = Math.round(grossCents * 0.0765);
      const ficaEmployer = ficaEmployee;
      const unemployment = Math.round(grossCents * 0.006);

      await recordPayrollRun(
        org.id,
        {
          employeeId: employee.id,
          payDate: isoDay(monthsAgo(monthOffset), 15),
          grossWagesCents: grossCents,
          federalTaxWithheldCents: federal,
          stateTaxWithheldCents: state,
          ficaEmployeeWithheldCents: ficaEmployee,
          otherDeductionsCents: 0,
          employerFicaMatchCents: ficaEmployer,
          employerUnemploymentTaxCents: unemployment,
          paymentAccountId: cash,
          wagesExpenseAccountId: wages,
          payrollTaxExpenseAccountId: payrollTax,
          liabilityAccountId: liabilities,
        },
        { postedByUserId: owner.id, employeeName: employee.name }
      );
    }
  }
}

// One provision at a plausible effective rate, plus a partial payment
// against it -- so the Income Tax tab shows both an accrued amount and a
// remaining payable instead of reading as a feature nobody has used yet.
// Run last, after every other revenue- and expense-affecting seed, so the
// provision is computed against the complete picture rather than a
// partial one.
async function seedIncomeTax(org, owner) {
  const asOf = new Date().toISOString().slice(0, 10);
  const { to_post: toPost, provision } = await recordProvision(
    org.id,
    { asOf, ratePercent: 21 },
    { postedByUserId: owner.id }
  );
  if (toPost <= 0) return;

  const accounts = await Account.findAll({ where: { orgId: org.id }, raw: true });
  const cash = accounts.find((a) => a.code === "1000").id;
  const paymentCents = Math.round(provision * 100 * 0.4); // paid roughly 40% of what's accrued so far
  if (paymentCents > 0) {
    // Dated the same day as the provision, never before it -- paying
    // against tax that isn't accrued as of the payment date yet is exactly
    // the LedgerError this would otherwise hit.
    await recordTaxPayment(org.id, { amountCents: paymentCents, paymentDate: asOf, cashAccountId: cash }, { postedByUserId: owner.id });
  }
}

// An open close period for the current month. Without one the Close tab
// says "No close period open yet" and stops there, so a visitor never
// reaches the checklist or the ledger-derived suggestions underneath it --
// which are the two things that tab exists to show. Half the tasks are
// ticked so it reads as a close in progress rather than an untouched list.
async function seedClosePeriod(org, owner) {
  const period = await ClosePeriod.create({ orgId: org.id, periodMonth: new Date().toISOString().slice(0, 7) });
  await CloseTask.bulkCreate(
    DEFAULT_CLOSE_TASKS.map((title, i) => ({
      closePeriodId: period.id,
      orgId: org.id,
      title,
      position: i,
      done: i < 3,
      completedAt: i < 3 ? new Date() : null,
      completedBy: i < 3 ? owner.email : null,
    }))
  );
}

// The Net Worth tab is personal, not org data, so it hangs off the demo's
// owner rather than the demo organization. Seeded with eight monthly
// readings rather than a single current balance: with one reading the trend
// panel correctly says "add another to see a line", which is honest for a
// real new account and useless in a sandbox meant to show what the feature
// does.
async function seedNetWorth(user) {
  // Each account's balance at each of the eight months, oldest first. Hand-
  // written rather than generated from a growth rate so the line has the
  // shape a real one does -- the brokerage dips mid-series, the mortgage
  // amortizes down at a believable pace, the card balance wanders.
  const HISTORY = [
    { name: "Everyday checking", category: "cash", notes: "", balances: [8200, 9100, 7400, 10250, 9800, 11400, 10900, 12300] },
    { name: "High-yield savings", category: "cash", notes: "Emergency fund", balances: [24000, 24100, 26000, 26100, 28000, 28150, 30000, 30200] },
    { name: "Brokerage", category: "investment", notes: "Index funds", balances: [71000, 74500, 69800, 72300, 78900, 81200, 79600, 86400] },
    { name: "401(k)", category: "retirement", notes: "", balances: [108000, 111500, 109200, 114800, 119300, 123100, 126400, 132900] },
    { name: "Condo", category: "property", notes: "County assessment", balances: [402000, 402000, 402000, 415000, 415000, 415000, 415000, 415000] },
    { name: "Mortgage", category: "mortgage", notes: "", balances: [296400, 295300, 294200, 293100, 292000, 290800, 289600, 288300] },
    { name: "Auto loan", category: "loan", notes: "", balances: [18900, 17600, 16300, 15000, 13700, 12400, 11100, 9800] },
    { name: "Rewards card", category: "credit_card", notes: "Paid in full monthly", balances: [1850, 2400, 1200, 3100, 980, 2260, 1740, 2140] },
  ];

  // Roughly one reading a month, ending today -- 30-day steps rather than
  // calendar months so this doesn't have to care what today's date is.
  const dates = HISTORY[0].balances.map((_, i) => daysFromNow(-30 * (HISTORY[0].balances.length - 1 - i)));

  for (const { name, category, notes, balances } of HISTORY) {
    const account = await NetWorthAccount.create({
      userId: user.id,
      name,
      category,
      notes,
      currentBalance: balances[balances.length - 1],
    });
    await NetWorthEntry.bulkCreate(
      balances.map((balance, i) => ({ accountId: account.id, balance, asOfDate: dates[i] }))
    );
  }
}

// Renders something that actually looks like a vendor's invoice -- a
// letterhead, a Bill To, the line-item table, and the subtotal/tax/total
// breakdown -- rather than four bare label/value lines. The document
// preview pane is the first thing anyone clicks in the demo, right next
// to the "extracted" fields it's supposed to have come from; four lines
// of "Invoice #: X" made that comparison look nothing like the real
// upload-and-extract experience the product actually delivers.
function formatInvoiceDoc(org, { vendorName, vendorAddress, invoiceNumber, invoiceDate, dueDate, poReference, lineItems, subtotal, tax, total }) {
  const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = [vendorName];
  if (vendorAddress) lines.push(vendorAddress);
  lines.push("", "INVOICE");
  lines.push(`Invoice #: ${invoiceNumber || "-"}`);
  lines.push(`Date: ${invoiceDate || "-"}`);
  if (dueDate) lines.push(`Due: ${dueDate}`);
  if (poReference) lines.push(`PO #: ${poReference}`);
  lines.push("", `Bill To: ${org.name}`, "");

  if (lineItems && lineItems.length) {
    for (const li of lineItems) lines.push(`  ${li.description}: ${money(li.amount)}`);
    lines.push("");
    if (subtotal !== undefined) lines.push(`  Subtotal: ${money(subtotal)}`);
    if (tax !== undefined) lines.push(`  Tax: ${money(tax)}`);
  }
  lines.push(`  Total: ${money(total)}`);
  lines.push("", "Terms: Net 30");
  return lines;
}

// Exported for sampleSeed.js -- the single-invoice onboarding sample reuses
// this rather than duplicating the "write a real synthetic PDF + set every
// field a real extraction would + write the matching audit-log rows" logic.
export async function seedInvoice(org, actorUser, { vendorAddress, ...overrides }) {
  const storagePath = writeDemoFile(formatInvoiceDoc(org, { ...overrides, vendorAddress }));
  const originalFilename = `${overrides.vendorName.replace(/\s+/g, "_")}_${overrides.invoiceNumber || "invoice"}.pdf`;

  const invoice = await Invoice.create({
    orgId: org.id,
    originalFilename,
    storagePath,
    contentType: "application/pdf",
    currency: "USD",
    extractionMethod: "llm",
    fieldConfidence: {
      vendor_name: overrides.overallConfidence,
      invoice_number: overrides.overallConfidence,
      invoice_date: overrides.overallConfidence,
      total: overrides.overallConfidence,
    },
    ...overrides,
  });

  await LineItem.bulkCreate(
    (overrides.lineItems || []).map((li, i) => ({
      invoiceId: invoice.id,
      position: i,
      confidence: overrides.overallConfidence,
      ...li,
    }))
  );

  await AuditLog.create({
    orgId: org.id,
    userId: actorUser.id,
    invoiceId: invoice.id,
    action: "uploaded",
    actor: actorUser.email,
    details: { filename: invoice.originalFilename },
  });
  await AuditLog.create({
    orgId: org.id,
    invoiceId: invoice.id,
    action: "extraction_completed",
    actor: "system",
    details: {
      method: invoice.extractionMethod,
      overall_confidence: overrides.overallConfidence,
      cross_check_passed: overrides.crossCheckPassed,
      cross_check_detail: overrides.crossCheckDetail,
    },
  });
  if (invoice.status === "approved" || invoice.status === "rejected") {
    await AuditLog.create({
      orgId: org.id,
      userId: actorUser.id,
      invoiceId: invoice.id,
      action: invoice.status === "approved" ? "approved" : "rejected",
      actor: actorUser.email,
      details: {},
    });
  }

  return invoice;
}

async function seedExpenseReceipt(org, actorUser, overrides) {
  const storagePath = writeDemoFile([`RECEIPT - ${overrides.merchantName}`, `Date: ${overrides.receiptDate}`, `Amount: $${overrides.amount}`]);
  const receipt = await ExpenseReceipt.create({
    orgId: org.id,
    originalFilename: `${overrides.merchantName.replace(/\s+/g, "_")}_receipt.pdf`,
    storagePath,
    contentType: "application/pdf",
    currency: "USD",
    extractionMethod: "llm",
    fieldConfidence: { merchant_name: overrides.overallConfidence, amount: overrides.overallConfidence },
    ...overrides,
  });

  await AuditLog.create({
    orgId: org.id,
    userId: actorUser.id,
    receiptId: receipt.id,
    action: "uploaded",
    actor: actorUser.email,
    details: { filename: receipt.originalFilename },
  });
  await AuditLog.create({
    orgId: org.id,
    receiptId: receipt.id,
    action: "extraction_completed",
    actor: "system",
    details: { method: receipt.extractionMethod, overall_confidence: overrides.overallConfidence },
  });
  if (receipt.status === "approved" || receipt.status === "rejected") {
    await AuditLog.create({
      orgId: org.id,
      userId: actorUser.id,
      receiptId: receipt.id,
      action: receipt.status,
      actor: actorUser.email,
      details: {},
    });
  }

  return receipt;
}

async function seedVendorDocument(org, actorUser, overrides) {
  const storagePath = writeDemoFile([`${overrides.documentType} - ${overrides.vendorName}`, `Reference: ${overrides.referenceNumber}`]);
  const doc = await VendorDocument.create({
    orgId: org.id,
    originalFilename: `${overrides.vendorName.replace(/\s+/g, "_")}_${overrides.documentType.replace(/\s+/g, "_")}.pdf`,
    storagePath,
    contentType: "application/pdf",
    extractionMethod: "llm",
    fieldConfidence: { vendor_name: overrides.overallConfidence, document_type: overrides.overallConfidence },
    ...overrides,
  });

  await AuditLog.create({
    orgId: org.id,
    userId: actorUser.id,
    vendorDocumentId: doc.id,
    action: "uploaded",
    actor: actorUser.email,
    details: { filename: doc.originalFilename },
  });
  await AuditLog.create({
    orgId: org.id,
    vendorDocumentId: doc.id,
    action: "extraction_completed",
    actor: "system",
    details: { method: doc.extractionMethod, overall_confidence: overrides.overallConfidence },
  });
  if (doc.status === "approved" || doc.status === "rejected") {
    await AuditLog.create({
      orgId: org.id,
      userId: actorUser.id,
      vendorDocumentId: doc.id,
      action: doc.status,
      actor: actorUser.email,
      details: {},
    });
  }

  return doc;
}

async function seedLease(org, actorUser, overrides) {
  const storagePath = writeDemoFile([`LEASE AGREEMENT - ${overrides.propertyAddress}`, `Landlord: ${overrides.landlordName}`]);
  const lease = await Lease.create({
    orgId: org.id,
    originalFilename: `${overrides.landlordName.replace(/\s+/g, "_")}_lease.pdf`,
    storagePath,
    contentType: "application/pdf",
    extractionMethod: "llm",
    fieldConfidence: { landlord_name: overrides.overallConfidence, property_address: overrides.overallConfidence },
    ...overrides,
  });

  await AuditLog.create({
    orgId: org.id,
    userId: actorUser.id,
    leaseId: lease.id,
    action: "uploaded",
    actor: actorUser.email,
    details: { filename: lease.originalFilename },
  });
  await AuditLog.create({
    orgId: org.id,
    leaseId: lease.id,
    action: "extraction_completed",
    actor: "system",
    details: { method: lease.extractionMethod, overall_confidence: overrides.overallConfidence },
  });
  if (lease.status === "approved" || lease.status === "rejected") {
    await AuditLog.create({
      orgId: org.id,
      userId: actorUser.id,
      leaseId: lease.id,
      action: lease.status,
      actor: actorUser.email,
      details: {},
    });
  }

  return lease;
}

async function seedTaxDocument(org, actorUser, overrides) {
  const storagePath = writeDemoFile([
    `FORM ${overrides.documentType} - Tax Year ${overrides.taxYear}`,
    `PAYER: ${overrides.payerName}`,
    `RECIPIENT: ${overrides.recipientName}`,
    // Masked in the demo's own synthetic source document too -- there's no
    // reason for a sample file to carry a full SSN-shaped string.
    `RECIPIENT'S TIN: ${overrides.recipientTinLast4 ? `***-**-${overrides.recipientTinLast4}` : "(not provided)"}`,
  ]);
  const doc = await TaxDocument.create({
    orgId: org.id,
    originalFilename: `${overrides.documentType}_${overrides.payerName.replace(/\s+/g, "_")}.pdf`,
    storagePath,
    contentType: "application/pdf",
    extractionMethod: "llm",
    fieldConfidence: {
      document_type: overrides.overallConfidence,
      tax_year: overrides.overallConfidence,
      payer_name: overrides.overallConfidence,
      amount: overrides.overallConfidence,
    },
    ...overrides,
  });

  await AuditLog.create({
    orgId: org.id,
    userId: actorUser.id,
    taxDocumentId: doc.id,
    action: "uploaded",
    actor: actorUser.email,
    details: { filename: doc.originalFilename },
  });
  await AuditLog.create({
    orgId: org.id,
    taxDocumentId: doc.id,
    action: "extraction_completed",
    actor: "system",
    details: { method: doc.extractionMethod, overall_confidence: overrides.overallConfidence },
  });
  if (doc.status === "approved" || doc.status === "rejected") {
    await AuditLog.create({
      orgId: org.id,
      userId: actorUser.id,
      taxDocumentId: doc.id,
      action: doc.status,
      actor: actorUser.email,
      details: {},
    });
  }

  return doc;
}
