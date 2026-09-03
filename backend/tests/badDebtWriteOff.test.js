// Bad debt write-offs (accountsReceivable.js's writeOffInvoice,
// routes/receivables.js's POST /api/customer-invoices/:id/write-off).
//
// Deliberately not a void: a write-off posts Debit Bad Debt Expense /
// Credit Accounts Receivable, leaving the original sale's revenue exactly
// as billed -- the claim is "this was earned but will never be collected",
// not "this never happened". Most of these assert against the trial
// balance for that reason: a write-off that quietly reversed revenue would
// look identical to a void in its own API response.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeCustomer(token) {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ name: "Globex Corp" });
  return res.body;
}

async function makeSentInvoice(token, customerId, amount = 1000) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const created = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      issue_date: "2026-01-01",
      lines: [{ revenue_account_id: revenue, description: "Consulting", quantity: 1, unit_price: amount }],
    });
  await request(app).post(`/api/customer-invoices/${created.body.id}/send`).set(authHeader(token));
  return created.body;
}

async function trialBalance(token) {
  return (await request(app).get("/api/ledger/trial-balance").set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return tb.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

test("writing off an invoice debits Bad Debt Expense and credits AR, leaving revenue untouched", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 1000);

  const res = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 1000, write_off_date: "2026-02-01", memo: "Customer went bankrupt" });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("paid"); // fully settled, just not by cash
  expect(res.body.amount_written_off).toBe(1000);
  expect(res.body.amount_outstanding).toBe(0);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Bad Debt Expense").debit).toBe(1000);
  expect(accountRow(tb, "Accounts Receivable").credit).toBe(1000);
  // The sale itself is untouched -- this is the whole point of not voiding.
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(1000);
  expect(tb.balanced).toBe(true);
});

test("a partial write-off leaves the rest outstanding, and a second write-off can finish it", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 1000);

  const first = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 400, write_off_date: "2026-02-01" });
  expect(first.body.status).toBe("sent"); // not fully settled yet
  expect(first.body.amount_outstanding).toBe(600);

  const second = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 600, write_off_date: "2026-02-15" });
  expect(second.body.status).toBe("paid");
  expect(second.body.amount_outstanding).toBe(0);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Bad Debt Expense").debit).toBe(1000);
});

test("a write-off can't exceed what's still outstanding, including what's already paid or credited", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 1000);
  const cash = await accountId(token, "Cash");

  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 300, payment_date: "2026-01-15", deposit_account_id: cash });

  const overWriteOff = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 800, write_off_date: "2026-02-01" });
  expect(overWriteOff.status).toBe(422);
  expect(overWriteOff.body.detail).toMatch(/over-write-off/);

  const exact = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 700, write_off_date: "2026-02-01" });
  expect(exact.status).toBe(201);
  expect(exact.body.status).toBe("paid");
});

test("a draft invoice can't be written off, and neither can a voided one", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const draft = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      lines: [{ revenue_account_id: revenue, quantity: 1, unit_price: 500 }],
    });
  const draftWriteOff = await request(app)
    .post(`/api/customer-invoices/${draft.body.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 500, write_off_date: "2026-01-05" });
  expect(draftWriteOff.status).toBe(409);
  expect(draftWriteOff.body.detail).toMatch(/draft/);

  const voided = await makeSentInvoice(token, customer.id, 500);
  await request(app).post(`/api/customer-invoices/${voided.id}/void`).set(authHeader(token));
  const voidWriteOff = await request(app)
    .post(`/api/customer-invoices/${voided.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 500, write_off_date: "2026-01-05" });
  expect(voidWriteOff.status).toBe(409);
});

test("a fully written-off invoice drops off AR aging", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 1000);
  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 1000, write_off_date: "2026-02-01" });

  const aging = await request(app).get("/api/reports/ar-aging").set(authHeader(token));
  expect(aging.body.totals.total).toBe(0);
});

test("a write-off appears on the customer statement at its own date, reducing the balance", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 1000);
  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 1000, write_off_date: "2026-01-20" });

  const statement = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-01-01&to=2026-01-31`)
    .set(authHeader(token));
  expect(statement.body.activity).toHaveLength(2);
  expect(statement.body.activity[1]).toMatchObject({ type: "write_off", amount: -1000, balance: 0 });
  expect(statement.body.closing_balance).toBe(0);
});

test("writing off an invoice is audit-logged", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  const invoice = await makeSentInvoice(token, customer.id, 250);

  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/write-off`)
    .set(authHeader(token))
    .send({ amount: 250, write_off_date: "2026-01-10", memo: "Uncollectible" });

  const log = await AuditLog.findOne({ where: { orgId: org, action: "customer_invoice_written_off" } });
  expect(log.details.amount).toBe(250);
});

test("write-offs are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const customerA = await makeCustomer(tokenA);
  const invoiceA = await makeSentInvoice(tokenA, customerA.id, 500);

  const res = await request(app)
    .post(`/api/customer-invoices/${invoiceA.id}/write-off`)
    .set(authHeader(tokenB))
    .send({ amount: 500, write_off_date: "2026-01-10" });
  expect(res.status).toBe(404);
});
