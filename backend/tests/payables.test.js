// Accounts payable: paying the vendor bills the AP pipeline approves, and
// AP aging (accountsPayable.js, routes/payables.js).
//
// Approving a bill has posted Debit expense / Credit Accounts Payable
// since v1.20, but nothing relieved that payable -- AP only ever grew.
// These assert against the trial balance and the statements rather than
// just the payments endpoints, because the whole point of this release is
// that the two sides now net out.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, BillPayment, ClosePeriod, Invoice, JournalEntry } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token) {
  const res = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  return res.body;
}

function accountRow(tb, name) {
  return (tb.accounts || tb.rows).find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function makeInvoice(org, overrides = {}) {
  return Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "BILL-1",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

// An approved bill: the only state that has posted to Accounts Payable and
// so the only state a payment can relieve.
async function makeApprovedInvoice(token, org, overrides = {}) {
  const invoice = await makeInvoice(org, overrides);
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

test("paying an approved bill relieves Accounts Payable and moves cash", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });

  // Approval alone: expense up, AP up, nothing has moved cash.
  const afterApproval = await trialBalance(token);
  expect(accountRow(afterApproval, "Accounts Payable").credit).toBe(1000);
  expect(accountRow(afterApproval, "Cash").credit).toBe(0);

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: TODAY, payment_account_id: cash });
  expect(res.status).toBe(201);
  expect(res.body.amount_paid).toBe(1000);
  expect(res.body.amount_outstanding).toBe(0);

  // Debit AP / Credit Cash: the payable is now fully relieved and the cash
  // is gone. This netting to zero is the whole point of the release.
  const after = await trialBalance(token);
  const ap = accountRow(after, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  expect(accountRow(after, "Cash").credit).toBe(1000);
  expect(after.balanced).toBe(true);
});

test("a partial payment leaves the rest outstanding", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });

  const first = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 400, payment_date: TODAY, payment_account_id: cash });
  expect(first.body.amount_outstanding).toBe(600);

  const second = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 600, payment_date: TODAY, payment_account_id: cash });
  expect(second.body.amount_outstanding).toBe(0);
  expect(second.body.items).toHaveLength(2);

  const after = await trialBalance(token);
  const ap = accountRow(after, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  expect(after.balanced).toBe(true);
});

test("overpaying a bill is refused", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 500 });

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 500.01, payment_date: TODAY, payment_account_id: cash });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/overpay/i);

  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
});

test("a bill that hasn't been approved can't be paid", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  // Never approved, so its expense and payable were never posted -- paying
  // it would debit a payable nothing ever credited.
  const invoice = await makeInvoice(org, { total: 300 });

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 300, payment_date: TODAY, payment_account_id: cash });
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/approve it first/i);
});

test("Accounts Payable is refused as the account a payment comes from", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const ap = await accountId(token, "Accounts Payable");
  const invoice = await makeApprovedInvoice(token, org, { total: 400 });

  // Debit AP / Credit AP balances, so the ledger itself would accept it --
  // it just wouldn't move anything, leaving the bill marked paid against
  // an entry that did nothing.
  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 400, payment_date: TODAY, payment_account_id: ap });
  expect(res.status).toBe(422);
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
});

test("a bill can be paid with a credit card, swapping one liability for another", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const card = await accountId(token, "Credit Card");
  const invoice = await makeApprovedInvoice(token, org, { total: 250 });

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 250, payment_date: TODAY, payment_account_id: card });
  expect(res.status).toBe(201);

  const after = await trialBalance(token);
  const ap = accountRow(after, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  // The money never left the bank -- the debt just moved to the card.
  expect(accountRow(after, "Credit Card").credit).toBe(250);
  expect(accountRow(after, "Cash").credit).toBe(0);
  expect(after.balanced).toBe(true);
});

test("a payment refused by a closed period leaves no payment behind", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 700 });

  await ClosePeriod.create({ orgId: org, periodMonth: "2026-03", status: "closed", closedAt: new Date() });
  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 700, payment_date: "2026-03-15", payment_account_id: cash });
  expect(res.status).toBe(409);

  // The row has to be created before the entry can name it as its source,
  // so a refused posting has to unwind it -- otherwise the bill reads as
  // paid against cash that never posted.
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);

  const still = await request(app).get(`/api/invoices/${invoice.id}/payments`).set(authHeader(token));
  expect(still.body.amount_outstanding).toBe(700);
});

test("removing a payment reverses its entry and restores the balance owed", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 900 });

  const created = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 900, payment_date: TODAY, payment_account_id: cash });
  const paymentId = created.body.items[0].id;

  const removed = await request(app)
    .delete(`/api/invoices/${invoice.id}/payments/${paymentId}`)
    .set(authHeader(token));
  expect(removed.status).toBe(200);
  expect(removed.body.amount_outstanding).toBe(900);

  // The payment is gone but its history isn't: the entry and its reversal
  // both stay on the books and cancel.
  const entries = await JournalEntry.findAll({ where: { orgId: org, sourceType: "bill_payment" } });
  expect(entries).toHaveLength(1);
  expect(entries[0].status).toBe("voided");

  const after = await trialBalance(token);
  expect(after.balanced).toBe(true);
  // Back to owing the full amount, with no cash moved.
  const ap = accountRow(after, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(900);
  const cashRow = accountRow(after, "Cash");
  expect(cashRow.credit - cashRow.debit).toBe(0);
});

test("paying a bill is operating cash, not financing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 600 });

  await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 600, payment_date: TODAY, payment_account_id: cash });

  const year = new Date().getUTCFullYear();
  const cf = await request(app)
    .get(`/api/statements/cash-flow?from=${year}-01-01&to=${year}-12-31`)
    .set(authHeader(token));
  // Settling what you owe is an operating activity. AP is a liability, so
  // a type-based classifier would call this financing (fixed in v1.23).
  expect(cf.body.operating).toBe(-600);
  expect(cf.body.financing).toBe(0);
  expect(cf.body.investing).toBe(0);
});

test("AP aging buckets what's owed by how far past due it is", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  // Due dates relative to a fixed as-of date, one per bucket.
  await makeApprovedInvoice(token, org, { total: 100, dueDate: "2026-07-01", invoiceNumber: "B-CURRENT" });
  await makeApprovedInvoice(token, org, { total: 200, dueDate: "2026-06-01", invoiceNumber: "B-1-30" });
  await makeApprovedInvoice(token, org, { total: 400, dueDate: "2026-05-10", invoiceNumber: "B-31-60" });
  await makeApprovedInvoice(token, org, { total: 800, dueDate: "2026-04-05", invoiceNumber: "B-61-90" });
  await makeApprovedInvoice(token, org, { total: 1600, dueDate: "2026-01-01", invoiceNumber: "B-90-PLUS" });

  const res = await request(app).get("/api/reports/ap-aging?as_of=2026-06-15").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.totals).toEqual({
    current: 100, // due 2026-07-01 -- not yet due
    d1_30: 200, // due 2026-06-01 -- 14 days past
    d31_60: 400,
    d61_90: 800,
    d90_plus: 1600,
    total: 3100,
    discount_available: 0, // none of these vendors have early-payment terms
  });
});

test("AP aging drops a bill once it's paid, and ages only the unpaid part of a partial", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const paid = await makeApprovedInvoice(token, org, { total: 500, dueDate: "2026-05-01", invoiceNumber: "B-PAID" });
  const partial = await makeApprovedInvoice(token, org, {
    total: 1000,
    dueDate: "2026-05-01",
    invoiceNumber: "B-PARTIAL",
    vendorName: "Globex Ltd",
  });

  await request(app)
    .post(`/api/invoices/${paid.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 500, payment_date: "2026-05-02", payment_account_id: cash });
  await request(app)
    .post(`/api/invoices/${partial.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 250, payment_date: "2026-05-02", payment_account_id: cash });

  const res = await request(app).get("/api/reports/ap-aging?as_of=2026-06-01").set(authHeader(token));
  expect(res.body.totals.total).toBe(750);
  expect(res.body.vendors).toHaveLength(1);
  expect(res.body.vendors[0].vendor_name).toBe("Globex Ltd");
  expect(res.body.vendors[0].total).toBe(750);
});

test("AP aging groups vendors whose names differ only by case or padding", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  await makeApprovedInvoice(token, org, { total: 100, vendorName: "Acme Inc.", invoiceNumber: "B-1" });
  await makeApprovedInvoice(token, org, { total: 200, vendorName: "  ACME Inc. ", invoiceNumber: "B-2" });

  const res = await request(app).get("/api/reports/ap-aging").set(authHeader(token));
  expect(res.body.vendors).toHaveLength(1);
  // The first spelling seen is what's displayed.
  expect(res.body.vendors[0].vendor_name).toBe("Acme Inc.");
  expect(res.body.vendors[0].total).toBe(300);
});

test("AP aging total reconciles to the Accounts Payable balance on the balance sheet", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  await makeApprovedInvoice(token, org, { total: 1200, invoiceNumber: "B-A" });
  const b = await makeApprovedInvoice(token, org, { total: 800, invoiceNumber: "B-B", vendorName: "Initech" });
  await request(app)
    .post(`/api/invoices/${b.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 300, payment_date: TODAY, payment_account_id: cash });

  const aging = await request(app).get("/api/reports/ap-aging").set(authHeader(token));
  const sheet = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));
  const apLine = sheet.body.liabilities.accounts.find((l) => l.name === "Accounts Payable");

  // The report and the ledger have to agree -- an aging report that
  // disagrees with the balance sheet is worse than no aging report.
  expect(aging.body.totals.total).toBe(1700);
  expect(apLine.amount).toBe(1700);
});

test("bill payments and AP aging are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  const cashA = await accountId(tokenA, "Cash");
  const invoiceA = await makeApprovedInvoice(tokenA, orgA, { total: 100 });

  await request(app)
    .post(`/api/invoices/${invoiceA.id}/payments`)
    .set(authHeader(tokenA))
    .send({ amount: 100, payment_date: TODAY, payment_account_id: cashA });

  expect((await request(app).get(`/api/invoices/${invoiceA.id}/payments`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).get("/api/reports/ap-aging").set(authHeader(tokenB))).body.totals.total).toBe(0);

  // ...and B can't pay A's bill either.
  const cashB = await accountId(tokenB, "Cash");
  const attempt = await request(app)
    .post(`/api/invoices/${invoiceA.id}/payments`)
    .set(authHeader(tokenB))
    .send({ amount: 100, payment_date: TODAY, payment_account_id: cashB });
  expect(attempt.status).toBe(404);
});

test("the trial balance stays balanced across the whole AP lifecycle", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const a = await makeApprovedInvoice(token, org, { total: 1000, invoiceNumber: "B-A" });
  await request(app)
    .post(`/api/invoices/${a.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 400, payment_date: TODAY, payment_account_id: cash });

  const b = await makeApprovedInvoice(token, org, { total: 500, invoiceNumber: "B-B" });
  const paid = await request(app)
    .post(`/api/invoices/${b.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 500, payment_date: TODAY, payment_account_id: cash });
  await request(app)
    .delete(`/api/invoices/${b.id}/payments/${paid.body.items[0].id}`)
    .set(authHeader(token));

  const tb = await trialBalance(token);
  expect(tb.balanced).toBe(true);
});

test("an approved bill whose approval never posted can't be paid", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  // Approve into a period that is then closed, and delete the entry the
  // approval posted -- the shape of a bill approved while its period was
  // already closed, which postInvoiceApproval records as a skip rather
  // than failing the approval.
  const invoice = await makeApprovedInvoice(token, org, { total: 450 });
  await JournalEntry.destroy({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });

  // Debiting AP for a bill that never credited it drives the balance
  // negative against nothing.
  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 450, payment_date: TODAY, payment_account_id: cash });
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/never posted to Accounts Payable/i);
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
});

test("confirming a QuickBooks bank match relieves the payable in Rekono's ledger too", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org, { total: 1000, quickbooksBillId: "bill_1" });

  // Before this release the loop closed only in QuickBooks' direction:
  // the bill was marked paid there and Accounts Payable kept it forever.
  const res = await request(app)
    .post("/api/integrations/quickbooks/bank-transactions/txn1/confirm")
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, transaction_date: "2026-01-16" });
  expect(res.status).toBe(200);
  expect(res.body.ledger_posted).toBe(true);

  const after = await trialBalance(token);
  const ap = accountRow(after, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  expect(accountRow(after, "Cash").credit).toBe(1000);
  expect(after.balanced).toBe(true);

  // ...and it shows up as a real payment, not just a QuickBooks flag.
  const payments = await request(app).get(`/api/invoices/${invoice.id}/payments`).set(authHeader(token));
  expect(payments.body.amount_outstanding).toBe(0);
});

test("a QuickBooks match on a bill that never posted still confirms, and records why the ledger was skipped", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  // Pushed to QuickBooks but never approved in Rekono, so nothing ever
  // credited Accounts Payable.
  const invoice = await makeInvoice(org, { total: 500, quickbooksBillId: "bill_1" });

  // The QuickBooks fact is true regardless, so the match must still
  // succeed -- it just can't post a payment against a payable that isn't
  // there.
  const res = await request(app)
    .post("/api/integrations/quickbooks/bank-transactions/txn1/confirm")
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, transaction_date: "2026-01-16" });
  expect(res.status).toBe(200);
  expect(res.body.ledger_posted).toBe(false);

  await invoice.reload();
  expect(invoice.quickbooksPaidAt).not.toBeNull();

  // The skip is findable at close time rather than surfacing later as an
  // unexplained AP balance.
  const skipped = await AuditLog.findOne({ where: { orgId: org, action: "journal_posting_skipped" } });
  expect(skipped).not.toBeNull();
  expect(skipped.details.reason).toMatch(/never posted to Accounts Payable/i);

  const after = await trialBalance(token);
  expect(after.balanced).toBe(true);
  expect(accountRow(after, "Accounts Payable").debit).toBe(0);
});

test("AP aging includes an approved sample invoice, so it ties to the balance sheet", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  // The Review Queue deliberately shows the seeded sample and lets it be
  // approved like any other invoice, and approving it posts to Accounts
  // Payable for real. A report that filtered it out would disagree with
  // the balance sheet by exactly the sample's amount -- which is what the
  // default scope on Invoice would have done here.
  const sample = await Invoice.create({
    orgId: org,
    originalFilename: "sample.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Sample Vendor Co.",
    invoiceNumber: "SAMPLE-001",
    total: 486,
    overallConfidence: 0.95,
    isSampleData: true,
  });
  await request(app).post(`/api/invoices/${sample.id}/approve`).set(authHeader(token));
  await makeApprovedInvoice(token, org, { total: 1200, invoiceNumber: "B-REAL" });

  const aging = await request(app).get("/api/reports/ap-aging").set(authHeader(token));
  const sheet = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));
  const apLine = sheet.body.liabilities.accounts.find((l) => l.name === "Accounts Payable");

  expect(aging.body.totals.total).toBe(1686);
  expect(apLine.amount).toBe(1686);
});

test("GET /api/bills lists approved bills with what's still owed on each", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const a = await makeApprovedInvoice(token, org, { total: 1000, invoiceNumber: "B-A", dueDate: "2026-06-01" });
  await makeApprovedInvoice(token, org, { total: 500, invoiceNumber: "B-B", dueDate: "2026-05-01" });
  await request(app)
    .post(`/api/invoices/${a.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 250, payment_date: TODAY, payment_account_id: cash });

  const res = await request(app).get("/api/bills").set(authHeader(token));
  expect(res.status).toBe(200);
  // Soonest due first, and carrying the due date the invoice list
  // serializer doesn't expose.
  expect(res.body.items.map((i) => i.invoice_number)).toEqual(["B-B", "B-A"]);
  expect(res.body.items[1]).toMatchObject({ total: 1000, amount_paid: 250, amount_outstanding: 750 });
  expect(res.body.items[0].due_date).toBe("2026-05-01");
  expect(res.body.total_outstanding).toBe(1250);
});

test("GET /api/bills hides fully paid bills unless asked for them", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 300, invoiceNumber: "B-PAID" });
  await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 300, payment_date: TODAY, payment_account_id: cash });

  expect((await request(app).get("/api/bills").set(authHeader(token))).body.items).toHaveLength(0);
  const all = await request(app).get("/api/bills?outstanding=false").set(authHeader(token));
  expect(all.body.items).toHaveLength(1);
  expect(all.body.items[0].amount_outstanding).toBe(0);
});

test("Accounts Receivable is refused as the account a bill is paid from", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const ar = await accountId(token, "Accounts Receivable");
  const invoice = await makeApprovedInvoice(token, org, { total: 200 });

  // Crediting AR to pay a vendor reads as a customer having settled their
  // invoice -- money owed *to* the org is not a place money leaves *from*.
  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 200, payment_date: TODAY, payment_account_id: ar });
  expect(res.status).toBe(422);
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
});

test("an approved sample invoice can be paid, not just shown as owed", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  // AP aging counts approved samples, so the payments endpoints have to
  // see them too -- otherwise there's a line on the report with no way to
  // clear it.
  const sample = await Invoice.create({
    orgId: org,
    originalFilename: "sample.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Sample Vendor Co.",
    invoiceNumber: "SAMPLE-001",
    total: 486,
    overallConfidence: 0.95,
    isSampleData: true,
  });
  await request(app).post(`/api/invoices/${sample.id}/approve`).set(authHeader(token));

  expect((await request(app).get("/api/bills").set(authHeader(token))).body.items).toHaveLength(1);

  const paid = await request(app)
    .post(`/api/invoices/${sample.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 486, payment_date: TODAY, payment_account_id: cash });
  expect(paid.status).toBe(201);
  expect(paid.body.amount_outstanding).toBe(0);

  const aging = await request(app).get("/api/reports/ap-aging").set(authHeader(token));
  expect(aging.body.totals.total).toBe(0);
});
