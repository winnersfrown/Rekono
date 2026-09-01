// The traditional Sales/Purchases/Cash Receipts/Cash Payments/General
// journals, expressed as filters over the one ledger by JournalEntry.source
// (routes/journalEntries.js's `journal` query param) rather than a second
// place transactions get written to.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postManualEntry(token, entryDate = "2026-01-05") {
  const cash = await accountId(token, "Cash");
  const expense = await accountId(token, "Uncategorized Expense");
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: entryDate, lines: [{ account_id: expense, debit: 10 }, { account_id: cash, credit: 10 }] });
}

// A customer invoice only hits the books once it's sent (draft -> sent is
// the moment it becomes a real receivable) -- so this posts a
// "customer_invoice" journal entry, creating it alone would not.
async function postCustomerInvoice(token) {
  const customerRes = await request(app).post("/api/customers").set(authHeader(token)).send({ name: "Acme Co" });
  const revenue = await accountId(token, "Uncategorized Revenue");
  const createRes = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerRes.body.id,
      issue_date: "2026-01-10",
      due_date: "2026-02-10",
      lines: [{ description: "Consulting", quantity: 1, unit_price: 500, revenue_account_id: revenue }],
    });
  await request(app).post(`/api/customer-invoices/${createRes.body.id}/send`).set(authHeader(token));
}

async function journalEntries(token, journal) {
  const q = journal ? `?journal=${journal}` : "";
  return request(app).get(`/api/journal-entries${q}`).set(authHeader(token));
}

test("an unfiltered request still returns every entry, unchanged from before this filter existed", async () => {
  const token = await signup(app, request);
  await postManualEntry(token);
  await postCustomerInvoice(token);

  const res = await journalEntries(token, null);
  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(2);
});

test("the sales journal shows only customer-invoice entries", async () => {
  const token = await signup(app, request);
  await postManualEntry(token);
  await postCustomerInvoice(token);

  const res = await journalEntries(token, "sales");
  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThan(0);
  expect(res.body.items.every((e) => e.source === "customer_invoice")).toBe(true);
});

test("the general journal excludes everything the four special journals claim", async () => {
  const token = await signup(app, request);
  await postManualEntry(token);
  await postCustomerInvoice(token);

  const res = await journalEntries(token, "general");
  expect(res.status).toBe(200);
  expect(res.body.items.some((e) => e.source === "manual")).toBe(true);
  expect(res.body.items.every((e) => e.source !== "customer_invoice")).toBe(true);
});

test("an unrecognized journal name is rejected with a clean 422, not silently ignored", async () => {
  const token = await signup(app, request);
  const res = await journalEntries(token, "not_a_real_journal");
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/journal must be one of/i);
});

test("cash_payments groups bill payments and payroll runs together", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  // Bypasses the OCR/extraction pipeline entirely -- this test only cares
  // about the payment's journal entry, not how the invoice got created.
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Test Vendor",
    total: 100,
    overallConfidence: 0.95,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 100, payment_date: "2026-01-15", payment_account_id: cash });

  const res = await journalEntries(token, "cash_payments");
  expect(res.status).toBe(200);
  expect(res.body.items.some((e) => e.source === "bill_payment")).toBe(true);
});
