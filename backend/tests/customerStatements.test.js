// Customer statements (accountsReceivable.js's computeCustomerStatement,
// routes/receivables.js's GET /api/customers/:id/statement) -- a
// customer's own AR activity over a period with a running balance, built
// from the same three events that move a customer's AR balance in the
// ledger: an invoice at its issue date, a payment at its payment date, a
// credit memo at its own issue date (not whichever invoice it later
// offsets).
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeCustomer(token, overrides = {}) {
  const res = await request(app)
    .post("/api/customers")
    .set(authHeader(token))
    .send({ name: "Globex Corp", email: "ap@globex.test", ...overrides });
  if (res.status !== 201) throw new Error(`makeCustomer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeInvoice(token, customerId, amount, issueDate) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      issue_date: issueDate,
      lines: [{ revenue_account_id: revenue, description: "Consulting", quantity: 1, unit_price: amount }],
    });
  if (res.status !== 201) throw new Error(`makeInvoice failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function send(token, invoiceId) {
  return request(app).post(`/api/customer-invoices/${invoiceId}/send`).set(authHeader(token));
}

async function pay(token, invoiceId, amount, paymentDate) {
  const cash = await accountId(token, "Cash");
  const res = await request(app)
    .post(`/api/customer-invoices/${invoiceId}/payments`)
    .set(authHeader(token))
    .send({ amount, payment_date: paymentDate, deposit_account_id: cash });
  if (res.status !== 201) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeCreditMemo(token, customerId, amount, issueDate) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const res = await request(app)
    .post("/api/customer-credit-memos")
    .set(authHeader(token))
    .send({ customer_id: customerId, issue_date: issueDate, lines: [{ revenue_account_id: revenue, amount }] });
  if (res.status !== 201) throw new Error(`makeCreditMemo failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("a statement lists invoices, payments, and credit memos in date order with a running balance", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);

  const invoice = await makeInvoice(token, customer.id, 1000, "2026-01-05");
  await send(token, invoice.id);
  await pay(token, invoice.id, 400, "2026-01-15");
  await makeCreditMemo(token, customer.id, 100, "2026-01-20");

  const res = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-01-01&to=2026-01-31`)
    .set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.opening_balance).toBe(0);
  expect(res.body.activity).toHaveLength(3);

  expect(res.body.activity[0]).toMatchObject({ date: "2026-01-05", type: "invoice", amount: 1000, balance: 1000 });
  expect(res.body.activity[1]).toMatchObject({ date: "2026-01-15", type: "payment", amount: -400, balance: 600 });
  expect(res.body.activity[2]).toMatchObject({ date: "2026-01-20", type: "credit_memo", amount: -100, balance: 500 });
  expect(res.body.closing_balance).toBe(500);
});

test("activity from before the period sets the opening balance instead of appearing as a line", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);

  const januaryInvoice = await makeInvoice(token, customer.id, 1000, "2026-01-10");
  await send(token, januaryInvoice.id);
  await pay(token, januaryInvoice.id, 300, "2026-01-20");

  const februaryInvoice = await makeInvoice(token, customer.id, 500, "2026-02-05");
  await send(token, februaryInvoice.id);

  const res = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-02-01&to=2026-02-28`)
    .set(authHeader(token));
  expect(res.body.opening_balance).toBe(700); // 1000 - 300, carried in, not listed
  expect(res.body.activity).toHaveLength(1);
  expect(res.body.activity[0]).toMatchObject({ date: "2026-02-05", type: "invoice", amount: 500, balance: 1200 });
  expect(res.body.closing_balance).toBe(1200);
});

test("a draft invoice, a voided invoice, and a voided credit memo never appear on a statement", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);

  // Draft: never sent, never touched AR.
  await makeInvoice(token, customer.id, 200, "2026-01-01");

  // Voided: sent then voided, so it posted and reversed -- net zero, and
  // shouldn't appear as a line either.
  const voided = await makeInvoice(token, customer.id, 300, "2026-01-02");
  await send(token, voided.id);
  await request(app).post(`/api/customer-invoices/${voided.id}/void`).set(authHeader(token));

  // A real invoice plus a credit memo that gets voided before it does
  // anything else.
  const real = await makeInvoice(token, customer.id, 1000, "2026-01-03");
  await send(token, real.id);
  const memo = await makeCreditMemo(token, customer.id, 100, "2026-01-04");
  await request(app).post(`/api/customer-credit-memos/${memo.id}/void`).set(authHeader(token));

  const res = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-01-01&to=2026-01-31`)
    .set(authHeader(token));
  expect(res.body.activity).toHaveLength(1);
  expect(res.body.activity[0]).toMatchObject({ type: "invoice", amount: 1000 });
  expect(res.body.closing_balance).toBe(1000);
});

test("a credit memo lands on the statement at its own issue date, not whichever invoice it's later applied to", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);

  const invoice = await makeInvoice(token, customer.id, 1000, "2026-01-01");
  await send(token, invoice.id);
  const memo = await makeCreditMemo(token, customer.id, 200, "2026-01-10");

  // Applied weeks later, in February -- the memo already reduced AR back
  // in January, when it was issued.
  await request(app)
    .post(`/api/customer-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, amount: 200, applied_date: "2026-02-15" });

  const january = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-01-01&to=2026-01-31`)
    .set(authHeader(token));
  expect(january.body.activity.map((a) => a.type)).toEqual(["invoice", "credit_memo"]);
  expect(january.body.closing_balance).toBe(800);

  const february = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-02-01&to=2026-02-28`)
    .set(authHeader(token));
  expect(february.body.activity).toHaveLength(0); // applying isn't its own AR-moving event
  expect(february.body.opening_balance).toBe(800);
  expect(february.body.closing_balance).toBe(800);
});

test("a statement with no activity at all is a flat zero balance, and an unknown customer 404s", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);

  const res = await request(app)
    .get(`/api/customers/${customer.id}/statement?from=2026-01-01&to=2026-01-31`)
    .set(authHeader(token));
  expect(res.body.opening_balance).toBe(0);
  expect(res.body.activity).toHaveLength(0);
  expect(res.body.closing_balance).toBe(0);

  const missing = await request(app).get("/api/customers/does-not-exist/statement").set(authHeader(token));
  expect(missing.status).toBe(404);
});

test("statements are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const customerA = await makeCustomer(tokenA);
  const invoice = await makeInvoice(tokenA, customerA.id, 500, "2026-01-01");
  await send(tokenA, invoice.id);

  const res = await request(app).get(`/api/customers/${customerA.id}/statement`).set(authHeader(tokenB));
  expect(res.status).toBe(404);
});
