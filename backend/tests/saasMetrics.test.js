// MRR/ARR (saasMetrics.js), surfaced through the board report. Reads
// active recurring invoice templates directly rather than deriving
// anything from the ledger -- see saasMetrics.js's own comment on why a
// historical trend isn't offered.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeCustomer(token, name) {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ name });
  return res.body;
}

async function makeTemplate(token, customerId, overrides = {}) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  return request(app)
    .post("/api/recurring-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      name: "Subscription",
      frequency: "monthly",
      start_date: "2026-01-01",
      lines: [{ revenue_account_id: revenue, description: "Plan", quantity: 1, unit_price: 500 }],
      ...overrides,
    });
}

async function boardReport(token, asOf = TODAY) {
  const res = await request(app).get(`/api/reports/board?as_of=${asOf}`).set(authHeader(token));
  if (res.status !== 200) throw new Error(`board report failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("a fresh org has zero MRR and ARR, not an error", async () => {
  const token = await signup(app, request);
  const report = await boardReport(token);
  expect(report.saas).toMatchObject({ mrr: 0, arr: 0, active_subscriptions: 0, customers: [] });
});

test("MRR is the monthly template amount; ARR is MRR times twelve", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, "Acme Inc");
  await makeTemplate(token, customer.id);

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(500);
  expect(report.saas.arr).toBe(6000);
  expect(report.saas.active_subscriptions).toBe(1);
  expect(report.saas.customers).toEqual([{ customer_id: customer.id, customer_name: "Acme Inc", subscriptions: 1, mrr: 500 }]);
});

test("a quarterly template is normalized to a monthly figure, not counted at face value", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, "Quarterly Co");
  // $1,200 billed once a quarter is $400 of MRR, not $1,200.
  await makeTemplate(token, customer.id, {
    frequency: "quarterly",
    lines: [{ revenue_account_id: await accountId(token, "Uncategorized Revenue"), description: "Plan", quantity: 1, unit_price: 1200 }],
  });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(400);
});

test("an annual template divides by twelve", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, "Annual Co");
  await makeTemplate(token, customer.id, {
    frequency: "annually",
    lines: [{ revenue_account_id: await accountId(token, "Uncategorized Revenue"), description: "Plan", quantity: 1, unit_price: 1200 }],
  });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(100);
  expect(report.saas.arr).toBe(1200);
});

test("multiple lines on one template sum before normalizing", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, "Multi-line Co");
  const revenue = await accountId(token, "Uncategorized Revenue");
  await makeTemplate(token, customer.id, {
    lines: [
      { revenue_account_id: revenue, description: "Seats", quantity: 5, unit_price: 20 },
      { revenue_account_id: revenue, description: "Support", quantity: 1, unit_price: 50 },
    ],
  });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(150); // 5*20 + 50
});

test("a template that hasn't started yet, or has already ended, doesn't count", async () => {
  const token = await signup(app, request);
  const notStarted = await makeCustomer(token, "Not Started Co");
  await makeTemplate(token, notStarted.id, { start_date: "2027-01-01" });

  const ended = await makeCustomer(token, "Ended Co");
  const endedRes = await makeTemplate(token, ended.id, { start_date: "2025-01-01" });
  await request(app)
    .patch(`/api/recurring-invoices/${endedRes.body.id}`)
    .set(authHeader(token))
    .send({ end_date: "2026-01-01" });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(0);
  expect(report.saas.active_subscriptions).toBe(0);
});

test("a deactivated template doesn't count toward MRR right now", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, "Paused Co");
  const created = await makeTemplate(token, customer.id);
  await request(app).patch(`/api/recurring-invoices/${created.body.id}`).set(authHeader(token)).send({ active: false });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(0);
});

test("two customers roll up separately and sum into the total", async () => {
  const token = await signup(app, request);
  const a = await makeCustomer(token, "A Corp");
  const b = await makeCustomer(token, "B Corp");
  await makeTemplate(token, a.id, { lines: [{ revenue_account_id: await accountId(token, "Uncategorized Revenue"), description: "Plan", quantity: 1, unit_price: 300 }] });
  await makeTemplate(token, b.id, { lines: [{ revenue_account_id: await accountId(token, "Uncategorized Revenue"), description: "Plan", quantity: 1, unit_price: 700 }] });

  const report = await boardReport(token, "2026-06-01");
  expect(report.saas.mrr).toBe(1000);
  expect(report.saas.customers.map((c) => c.customer_name)).toEqual(["B Corp", "A Corp"]); // highest MRR first
});

test("MRR is scoped to the caller's org", async () => {
  const mine = await signup(app, request, { email: "saas-mine@example.co" });
  const theirs = await signup(app, request, { email: "saas-theirs@example.co", orgName: "Other Co" });
  const theirCustomer = await makeCustomer(theirs, "Their Customer");
  await makeTemplate(theirs, theirCustomer.id);

  const report = await boardReport(mine, "2026-06-01");
  expect(report.saas.mrr).toBe(0);
  expect(report.saas.customers).toEqual([]);
});
