// Writing a check (writtenChecks.js, models/WrittenCheck.js,
// routes/writtenChecks.js).
//
// A written check has to post the exact same ledger effect "Record
// payment" already does -- these assert against the trial balance, same
// pattern as tests/payables.test.js, to prove the check-number/payee
// wrapper doesn't change what actually happens to the books.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token) {
  return (await request(app).get("/api/ledger/trial-balance").set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return tb.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
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

async function writeCheckFor(token, invoiceId, overrides = {}) {
  const cash = await accountId(token, "Cash");
  return request(app)
    .post("/api/written-checks")
    .set(authHeader(token))
    .send({
      invoice_id: invoiceId,
      check_number: "1001",
      payee_name: "Acme Supplies Inc",
      amount: 1000,
      check_date: TODAY,
      payment_account_id: cash,
      ...overrides,
    });
}

test("writing a check relieves Accounts Payable and moves cash, same as recording a payment", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org);

  const res = await writeCheckFor(token, invoice.id);
  expect(res.status).toBe(201);
  expect(res.body.check_number).toBe("1001");
  expect(res.body.payee_name).toBe("Acme Supplies Inc");
  expect(res.body.amount).toBe(1000);
  expect(res.body.vendor_name).toBe("Acme Supplies Inc");

  const tb = await trialBalance(token);
  const ap = accountRow(tb, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  expect(accountRow(tb, "Cash").credit).toBe(1000);
  expect(tb.balanced).toBe(true);
});

test("a check defaults its memo to the check number when none is given", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org);

  const res = await writeCheckFor(token, invoice.id, { check_number: "2002" });
  expect(res.status).toBe(201);
  expect(res.body.memo).toBe("");

  const payments = await request(app).get(`/api/invoices/${invoice.id}/payments`).set(authHeader(token));
  expect(payments.body.items[0].memo).toBe("Check #2002");
});

test("can't write a check that would overpay the bill", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org, { total: 500 });

  const res = await writeCheckFor(token, invoice.id, { amount: 600 });
  expect(res.status).toBe(422);
});

test("can't write a check against a bill that isn't approved", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    total: 1000,
    overallConfidence: 0.9,
  });

  const res = await writeCheckFor(token, invoice.id);
  expect(res.status).toBe(409);
});

test("can't pay from Accounts Payable itself", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org);
  const ap = await accountId(token, "Accounts Payable");

  const res = await writeCheckFor(token, invoice.id, { payment_account_id: ap });
  expect(res.status).toBe(422);
});

test("voiding a written check reverses the payment and removes the check", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org);

  const created = await writeCheckFor(token, invoice.id);
  const del = await request(app).delete(`/api/written-checks/${created.body.id}`).set(authHeader(token));
  expect(del.status).toBe(200);

  const list = await request(app).get("/api/written-checks").set(authHeader(token));
  expect(list.body.items).toHaveLength(0);

  // Void is a reversal, not an un-post: AP is relieved back to what it
  // owed before the check, same as removing a payment does.
  const tb = await trialBalance(token);
  const ap = accountRow(tb, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(1000);
  expect(tb.balanced).toBe(true);

  const payments = await request(app).get(`/api/invoices/${invoice.id}/payments`).set(authHeader(token));
  expect(payments.body.amount_outstanding).toBe(1000);
});

test("written checks are isolated per org", async () => {
  const tokenA = await signup(app, request);
  const orgA = await orgId(tokenA);
  const invoiceA = await makeApprovedInvoice(tokenA, orgA);
  const created = await writeCheckFor(tokenA, invoiceA.id);

  const tokenB = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
  const listB = await request(app).get("/api/written-checks").set(authHeader(tokenB));
  expect(listB.body.items).toHaveLength(0);

  const deleteB = await request(app).delete(`/api/written-checks/${created.body.id}`).set(authHeader(tokenB));
  expect(deleteB.status).toBe(404);
});
