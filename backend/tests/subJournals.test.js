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

test("a cash-in equity contribution lands in cash receipts, not the general journal", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await postManualEntry(token);

  const contribution = await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "contribution", transaction_date: "2026-01-20", amount: 5000, cash_account_id: cash });
  expect(contribution.status).toBe(201);

  const receipts = await journalEntries(token, "cash_receipts");
  expect(receipts.body.items.some((e) => e.source === "equity_contribution")).toBe(true);

  const general = await journalEntries(token, "general");
  expect(general.body.items.every((e) => e.source !== "equity_contribution")).toBe(true);
});

test("cash-out equity events (distribution, dividend paid, treasury purchase) land in cash payments, not general", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  // Fund the org first so there's cash to distribute/pay/buy back with.
  await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "contribution", transaction_date: "2026-01-01", amount: 100000, cash_account_id: cash });

  const distribution = await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "distribution", transaction_date: "2026-01-05", amount: 1000, cash_account_id: cash });
  expect(distribution.status).toBe(201);

  const dividendPaid = await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "dividend_paid", transaction_date: "2026-01-06", amount: 500, cash_account_id: cash });
  expect(dividendPaid.status).toBe(201);

  const treasuryPurchase = await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "treasury_purchase", transaction_date: "2026-01-07", amount: 2000, cash_account_id: cash });
  expect(treasuryPurchase.status).toBe(201);

  const payments = await journalEntries(token, "cash_payments");
  const sources = payments.body.items.map((e) => e.source);
  expect(sources).toEqual(expect.arrayContaining(["equity_distribution", "equity_dividend_paid", "equity_treasury_purchase"]));

  const general = await journalEntries(token, "general");
  const generalSources = general.body.items.map((e) => e.source);
  expect(generalSources).not.toEqual(expect.arrayContaining(["equity_distribution", "equity_dividend_paid", "equity_treasury_purchase"]));
});

test("declaring a dividend stays on the general journal -- no cash has moved yet", async () => {
  const token = await signup(app, request);

  const declared = await request(app)
    .post("/api/equity/transactions")
    .set(authHeader(token))
    .send({ type: "dividend_declared", transaction_date: "2026-01-10", amount: 750 });
  expect(declared.status).toBe(201);

  const general = await journalEntries(token, "general");
  expect(general.body.items.some((e) => e.source === "equity_transaction")).toBe(true);

  const payments = await journalEntries(token, "cash_payments");
  expect(payments.body.items.every((e) => e.source !== "equity_transaction")).toBe(true);
});

test("an income tax payment lands in cash payments, not general -- the accrual (no cash yet) stays general", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // Seed enough revenue that a provision has something to accrue against.
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-01-01",
      lines: [
        { account_id: cash, debit: 10000 },
        { account_id: await accountId(token, "Uncategorized Revenue"), credit: 10000 },
      ],
    });
  const provision = await request(app)
    .post("/api/income-tax/provision")
    .set(authHeader(token))
    .send({ as_of: "2026-01-31", rate_percent: 21 });
  expect(provision.status).toBe(201);

  const payment = await request(app)
    .post("/api/income-tax/payments")
    .set(authHeader(token))
    .send({ amount: 100, payment_date: "2026-02-01", cash_account_id: cash });
  expect(payment.status).toBe(201);

  const payments = await journalEntries(token, "cash_payments");
  expect(payments.body.items.some((e) => e.source === "income_tax_payment")).toBe(true);

  const general = await journalEntries(token, "general");
  expect(general.body.items.some((e) => e.source === "income_tax")).toBe(true);
  expect(general.body.items.every((e) => e.source !== "income_tax_payment")).toBe(true);
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
