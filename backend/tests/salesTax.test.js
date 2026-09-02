// Sales tax collected on customer invoices, and its remittance
// (salesTax.js, accountsReceivable.js's tax handling, routes/receivables.js's
// /api/reports/sales-tax and /api/sales-tax/remit).
//
// The one thing that has to hold: tax collected from a customer is a
// liability the instant the invoice is sent, never this org's own revenue --
// so most of these assert against the trial balance, not just the invoice's
// own totals, the same reasoning receivables.test.js gives for checking AR
// itself ties out.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod } from "../src/models/index.js";
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

async function trialBalance(token, asOf) {
  return (await request(app).get(`/api/ledger/trial-balance?as_of=${asOf}`).set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return tb.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function setTaxRate(token, ratePercent) {
  const res = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ sales_tax_rate_percent: ratePercent });
  expect(res.status).toBe(200);
}

async function makeCustomer(token, overrides = {}) {
  const res = await request(app)
    .post("/api/customers")
    .set(authHeader(token))
    .send({ name: "Globex Corp", ...overrides });
  return res.body;
}

async function makeInvoice(token, customerId, lines, overrides = {}) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      issue_date: TODAY,
      lines: lines || [{ revenue_account_id: revenue, description: "Consulting", quantity: 1, unit_price: 1000 }],
      ...overrides,
    });
  return res;
}

test("a taxable invoice charges the org's rate and reports subtotal/tax/total", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 8);
  const customer = await makeCustomer(token);

  const res = await makeInvoice(token, customer.id);
  expect(res.status).toBe(201);
  expect(res.body.subtotal).toBe(1000);
  expect(res.body.tax).toBe(80);
  expect(res.body.total).toBe(1080);
});

test("sending a taxed invoice credits Sales Tax Payable, not revenue", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id);

  const sent = await request(app).post(`/api/customer-invoices/${invoice.body.id}/send`).set(authHeader(token));
  expect(sent.status).toBe(200);
  expect(sent.body.status).toBe("sent");

  const tb = await trialBalance(token, TODAY);
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(1100);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(1000);
  expect(accountRow(tb, "Sales Tax Payable").credit).toBe(100);
  expect(tb.balanced).toBe(true);
});

test("a tax-exempt customer is never taxed, regardless of any line's own flag", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token, { tax_exempt: true });
  const revenue = await accountId(token, "Uncategorized Revenue");

  const res = await makeInvoice(token, customer.id, [
    { revenue_account_id: revenue, description: "Consulting", quantity: 1, unit_price: 1000, taxable: true },
  ]);
  expect(res.body.tax).toBe(0);
  expect(res.body.total).toBe(1000);
});

test("a line marked not taxable is excluded from the tax base", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const res = await makeInvoice(token, customer.id, [
    { revenue_account_id: revenue, description: "Taxable good", quantity: 1, unit_price: 1000, taxable: true },
    { revenue_account_id: revenue, description: "Shipping (pass-through)", quantity: 1, unit_price: 50, taxable: false },
  ]);
  expect(res.body.subtotal).toBe(1050);
  // Only the $1000 taxable line counts toward the base.
  expect(res.body.tax).toBe(100);
  expect(res.body.total).toBe(1150);
});

test("no rate configured means no tax charged", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const res = await makeInvoice(token, customer.id);
  expect(res.body.tax).toBe(0);
  expect(res.body.total).toBe(1000);
});

test("remitting sales tax debits the payable and credits cash", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.body.id}/send`).set(authHeader(token));

  const report = await request(app).get("/api/reports/sales-tax").set(authHeader(token));
  expect(report.body.payable).toBe(100);
  expect(report.body.rate_percent).toBe(10);

  const cash = await accountId(token, "Cash");
  const remit = await request(app)
    .post("/api/sales-tax/remit")
    .set(authHeader(token))
    .send({ amount: 60, payment_date: TODAY, cash_account_id: cash });
  expect(remit.status).toBe(201);
  expect(remit.body.payable).toBe(40);

  const tb = await trialBalance(token, TODAY);
  expect(accountRow(tb, "Sales Tax Payable").debit).toBe(60);
  expect(accountRow(tb, "Sales Tax Payable").credit).toBe(100);
  expect(tb.balanced).toBe(true);

  const after = await request(app).get("/api/reports/sales-tax").set(authHeader(token));
  expect(after.body.payable).toBe(40);
});

test("remitting more than is accrued is refused", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.body.id}/send`).set(authHeader(token));

  const cash = await accountId(token, "Cash");
  const remit = await request(app)
    .post("/api/sales-tax/remit")
    .set(authHeader(token))
    .send({ amount: 500, payment_date: TODAY, cash_account_id: cash });
  expect(remit.status).toBe(422);
  expect(remit.body.detail).toMatch(/only \$100\.00 of sales tax is accrued/i);
});

test("a recurring invoice's auto-sent occurrence applies tax the same way", async () => {
  const token = await signup(app, request);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const template = await request(app)
    .post("/api/recurring-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      name: "Monthly retainer",
      frequency: "monthly",
      start_date: "2026-01-31",
      auto_send: true,
      lines: [{ revenue_account_id: revenue, description: "Retainer", quantity: 1, unit_price: 1000 }],
    });
  expect(template.status).toBe(201);

  const run = await request(app)
    .post("/api/recurring-invoices/run")
    .set(authHeader(token))
    .send({ as_of: "2026-01-31" });
  expect(run.body.issued[0].sent).toBe(true);
  expect(run.body.issued[0].amount).toBe(1100);

  const tb = await trialBalance(token, "2026-01-31");
  expect(accountRow(tb, "Sales Tax Payable").credit).toBe(100);
  expect(tb.balanced).toBe(true);
});

test("sales tax is scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  await setTaxRate(tokenA, 10);
  const customerA = await makeCustomer(tokenA);
  const invoice = await makeInvoice(tokenA, customerA.id);
  await request(app).post(`/api/customer-invoices/${invoice.body.id}/send`).set(authHeader(tokenA));

  const reportB = await request(app).get("/api/reports/sales-tax").set(authHeader(tokenB));
  expect(reportB.body.payable).toBe(0);
  expect(reportB.body.rate_percent).toBeFalsy();
});

test("a closed period refuses the invoice's send, and sales tax settings survive a template's org boundary", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await setTaxRate(token, 10);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, undefined, { issue_date: "2026-02-15" });
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-02", status: "closed", closedAt: new Date() });

  const sent = await request(app).post(`/api/customer-invoices/${invoice.body.id}/send`).set(authHeader(token));
  expect(sent.status).toBe(409);
  expect(sent.body.detail).toMatch(/2026-02 has been closed/);
});
