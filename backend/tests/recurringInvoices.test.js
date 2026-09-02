// Recurring customer invoices (recurringInvoices.js, routes/receivables.js's
// /api/recurring-invoices endpoints) -- the AR equivalent of
// recurringEntries.js's adjusting-entry templates, for a customer on a
// retainer or subscription who needs billing every period without someone
// re-creating the invoice by hand each time.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, CustomerInvoice, RecurringInvoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

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

async function makeCustomer(token, overrides = {}) {
  const res = await request(app)
    .post("/api/customers")
    .set(authHeader(token))
    .send({ name: "Globex Corp", ...overrides });
  return res.body;
}

async function makeTemplate(token, customerId, overrides = {}) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const res = await request(app)
    .post("/api/recurring-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      name: "Monthly retainer",
      frequency: "monthly",
      start_date: "2026-01-31",
      lines: [{ revenue_account_id: revenue, description: "Retainer", quantity: 1, unit_price: 1000 }],
      ...overrides,
    });
  return res;
}

test("a template issues a draft invoice per due period, and catches up months nobody ran", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  await makeTemplate(token, customer.id);

  const preview = await request(app)
    .get("/api/recurring-invoices/pending?as_of=2026-03-31")
    .set(authHeader(token));
  expect(preview.body.occurrences).toBe(3);
  expect(preview.body.items[0].amount_total).toBe(3000);

  const run = await request(app)
    .post("/api/recurring-invoices/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  expect(run.status).toBe(200);
  expect(run.body.issued).toHaveLength(3);
  expect(run.body.issued.every((i) => i.sent === false)).toBe(true);
  expect(run.body.issued.map((i) => i.issue_date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);

  const invoices = await request(app).get("/api/customer-invoices").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(3);
  expect(invoices.body.items.every((i) => i.status === "draft")).toBe(true);
  expect(invoices.body.items.map((i) => i.invoice_number).sort()).toEqual(["INV-0001", "INV-0002", "INV-0003"]);

  // Drafts don't touch the ledger.
  const tb = await trialBalance(token, "2026-03-31");
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(0);
});

test("running twice doesn't double-issue", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  await makeTemplate(token, customer.id);
  await request(app).post("/api/recurring-invoices/run").set(authHeader(token)).send({ as_of: "2026-03-31" });

  const second = await request(app)
    .post("/api/recurring-invoices/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  expect(second.body.issued).toHaveLength(0);

  const invoices = await request(app).get("/api/customer-invoices").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(3);
});

test("auto-send posts each occurrence to the books immediately", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const created = await makeTemplate(token, customer.id, { auto_send: true });
  expect(created.body.auto_send).toBe(true);

  const run = await request(app)
    .post("/api/recurring-invoices/run")
    .set(authHeader(token))
    .send({ as_of: "2026-01-31" });
  expect(run.body.issued).toHaveLength(1);
  expect(run.body.issued[0].sent).toBe(true);

  const invoices = await request(app).get("/api/customer-invoices").set(authHeader(token));
  expect(invoices.body.items[0].status).toBe("sent");

  const tb = await trialBalance(token, "2026-01-31");
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(1000);
  expect(tb.balanced).toBe(true);

  const aging = await request(app).get("/api/reports/ar-aging?as_of=2026-01-31").set(authHeader(token));
  expect(aging.body.totals.total).toBe(1000);
});

test("a period the ledger refuses to auto-send into still creates the draft", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  await makeTemplate(token, customer.id, { auto_send: true });
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-01", status: "closed", closedAt: new Date() });

  const run = await request(app)
    .post("/api/recurring-invoices/run")
    .set(authHeader(token))
    .send({ as_of: "2026-01-31" });
  expect(run.body.issued).toHaveLength(1);
  expect(run.body.issued[0].sent).toBe(false);
  expect(run.body.issued[0].send_error).toMatch(/2026-01 has been closed/);

  // The draft exists and the template isn't stuck retrying January forever.
  const invoices = await request(app).get("/api/customer-invoices").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(1);
  expect(invoices.body.items[0].status).toBe("draft");
  const template = await RecurringInvoice.findOne({ where: { orgId: org } });
  expect(template.lastIssuedDate).toBe("2026-01-31");
});

test("auto-send can be turned on for an existing template", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const created = await makeTemplate(token, customer.id);
  expect(created.body.auto_send).toBe(false);

  const patched = await request(app)
    .patch(`/api/recurring-invoices/${created.body.id}`)
    .set(authHeader(token))
    .send({ auto_send: true });
  expect(patched.body.auto_send).toBe(true);

  const run = await request(app).post("/api/recurring-invoices/run").set(authHeader(token)).send({ as_of: "2026-01-31" });
  expect(run.body.issued[0].sent).toBe(true);
});

test("a deactivated template stops issuing, and deleting one leaves its history alone", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const created = await makeTemplate(token, customer.id);
  await request(app).post("/api/recurring-invoices/run").set(authHeader(token)).send({ as_of: "2026-01-31" });

  await request(app).patch(`/api/recurring-invoices/${created.body.id}`).set(authHeader(token)).send({ active: false });
  const run = await request(app).post("/api/recurring-invoices/run").set(authHeader(token)).send({ as_of: "2026-03-31" });
  expect(run.body.issued).toHaveLength(0);

  await request(app).delete(`/api/recurring-invoices/${created.body.id}`).set(authHeader(token));
  const invoices = await request(app).get("/api/customer-invoices").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(1);

  const templates = await request(app).get("/api/recurring-invoices").set(authHeader(token));
  expect(templates.body.items).toHaveLength(0);
});

test("a line must bill to a revenue account the org owns", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");

  const res = await request(app)
    .post("/api/recurring-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      name: "Bad template",
      frequency: "monthly",
      start_date: "2026-01-31",
      lines: [{ revenue_account_id: cash, description: "x", quantity: 1, unit_price: 100 }],
    });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/revenue account/i);
});

test("an end date can't be before the start date", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const res = await makeTemplate(token, customer.id, { start_date: "2026-06-30", end_date: "2026-01-01" });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/can't end before it starts/);
});

test("recurring invoices are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const customerA = await makeCustomer(tokenA);
  const created = await makeTemplate(tokenA, customerA.id);

  expect((await request(app).get("/api/recurring-invoices").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect(
    (await request(app).patch(`/api/recurring-invoices/${created.body.id}`).set(authHeader(tokenB)).send({ active: false }))
      .status
  ).toBe(404);

  await request(app).post("/api/recurring-invoices/run").set(authHeader(tokenB)).send({ as_of: "2026-03-31" });
  expect(await CustomerInvoice.count({ where: { orgId: await orgId(tokenB) } })).toBe(0);
});
