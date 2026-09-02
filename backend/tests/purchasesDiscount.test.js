// Early-payment discounts on bill payments (accountsPayable.js's
// PURCHASES_DISCOUNT_SUBTYPE/ensurePurchasesDiscountAccount), and the
// GET /api/journal-entries?include=lines extension that powers the
// purchases and cash-payments journal's specialized columns
// (routes/journalEntries.js, public/app.js's renderPurchasesJournal /
// renderCashPaymentsJournal).
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

async function trialBalanceRow(token, name) {
  const res = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  return res.body.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function makeApprovedInvoice(token, org, overrides = {}) {
  const invoice = await Invoice.create({
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
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

test("a discounted bill payment fully relieves the payable and posts the discount as a credit to Purchases Discounts Taken", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 980, payment_date: "2026-01-15", payment_account_id: cash, discount: 20 });
  expect(res.status).toBe(201);
  expect(res.body.amount_outstanding).toBe(0);
  expect(res.body.items[0].discount).toBe(20);

  const ap = await trialBalanceRow(token, "Accounts Payable");
  expect(ap.debit - ap.credit).toBeCloseTo(0, 2); // fully relieved, not $20 outstanding

  const discountAccount = await trialBalanceRow(token, "Purchases Discounts Taken");
  expect(discountAccount.credit).toBe(20);

  const cashRow = await trialBalanceRow(token, "Cash");
  expect(cashRow.debit).toBe(0); // nothing deposited
  expect(cashRow.credit).toBe(980); // only the actual cash paid
});

test("amount plus discount can't exceed the outstanding balance", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 980, payment_date: "2026-01-15", payment_account_id: cash, discount: 100 });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/overpay/i);
});

test("a written check can also take a discount", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);

  const res = await request(app)
    .post("/api/written-checks")
    .set(authHeader(token))
    .send({
      invoice_id: invoice.id,
      check_number: "500",
      payee_name: "Acme Supplies Inc",
      check_date: "2026-01-20",
      amount: 950,
      discount: 50,
      payment_account_id: cash,
    });
  expect(res.status).toBe(201);

  const ap = await trialBalanceRow(token, "Accounts Payable");
  expect(ap.debit - ap.credit).toBeCloseTo(0, 2);
  const discountAccount = await trialBalanceRow(token, "Purchases Discounts Taken");
  expect(discountAccount.credit).toBe(50);
});

test("a payment with no discount doesn't touch Purchases Discounts Taken at all", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);

  const res = await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: "2026-01-15", payment_account_id: cash });
  expect(res.status).toBe(201);

  const accounts = await request(app).get("/api/accounts").set(authHeader(token));
  expect(accounts.body.items.some((a) => a.name === "Purchases Discounts Taken")).toBe(false);
});

test("GET /api/journal-entries?include=lines returns each entry's lines with account_subtype and post_ref", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);
  await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: "2026-01-15", payment_account_id: cash });

  const res = await request(app).get("/api/journal-entries?journal=cash_payments&include=lines").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].lines.length).toBeGreaterThanOrEqual(2);
  const apLine = res.body.items[0].lines.find((l) => l.account_subtype === "accounts_payable");
  expect(apLine).toBeTruthy();
  expect(apLine.debit).toBe(1000);
  expect(apLine.post_ref).toBe("2000");
});

test("GET /api/journal-entries without include=lines omits lines, same as before", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org);
  await request(app)
    .post(`/api/invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: "2026-01-15", payment_account_id: cash });

  const res = await request(app).get("/api/journal-entries?journal=cash_payments").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.items[0].lines).toBeUndefined();
});
