import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb } from "./testUtils.js";

beforeEach(resetDb);

test("demo login requires no credentials and returns a working token", async () => {
  const res = await request(app).post("/api/demo/login").send({});
  expect(res.status).toBe(201);
  expect(res.body.access_token).toBeTruthy();
  expect(res.body.token_type).toBe("bearer");

  const me = await request(app).get("/api/auth/me").set(authHeader(res.body.access_token));
  expect(me.status).toBe(200);
  expect(me.body.is_demo).toBe(true);
  expect(me.body.onboarding_completed).toBe(true);
  expect(me.body.plan).toBe("scale");
  expect(me.body.subscription_status).toBe("active");
});

test("demo login pre-populates all four document types across a mix of statuses", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const token = login.body.access_token;
  const headers = authHeader(token);

  const invoices = await request(app).get("/api/invoices").set(headers);
  const expenses = await request(app).get("/api/expenses").set(headers);
  const vendorDocs = await request(app).get("/api/vendor-documents").set(headers);
  const leases = await request(app).get("/api/leases").set(headers);

  expect(invoices.status).toBe(200);
  expect(invoices.body.items.length).toBeGreaterThan(0);
  expect(expenses.body.items.length).toBeGreaterThan(0);
  expect(vendorDocs.body.items.length).toBeGreaterThan(0);
  expect(leases.body.items.length).toBeGreaterThan(0);

  // A realistic spread of statuses, not just one flavor of row.
  const statuses = new Set(invoices.body.items.map((i) => i.status));
  expect(statuses.has("approved")).toBe(true);
  expect(statuses.has("needs_review")).toBe(true);
});

test("each demo login spins up its own isolated org", async () => {
  const first = await request(app).post("/api/demo/login").send({});
  const second = await request(app).post("/api/demo/login").send({});

  const firstMe = await request(app).get("/api/auth/me").set(authHeader(first.body.access_token));
  const secondMe = await request(app).get("/api/auth/me").set(authHeader(second.body.access_token));

  expect(firstMe.body.org_id).not.toBe(secondMe.body.org_id);
  expect(firstMe.body.email).not.toBe(secondMe.body.email);

  // Neither org sees the other's data.
  const firstInvoices = await request(app).get("/api/invoices").set(authHeader(first.body.access_token));
  const secondInvoices = await request(app).get("/api/invoices").set(authHeader(second.body.access_token));
  const firstIds = new Set(firstInvoices.body.items.map((i) => i.id));
  const overlap = secondInvoices.body.items.filter((i) => firstIds.has(i.id));
  expect(overlap).toHaveLength(0);
});

// Until v1.38 the demo seeded the five document pipelines and nothing else,
// so every accounting tab -- chart of accounts, journal entries, trial
// balance, income statement, balance sheet -- was empty for anyone clicking
// into the sandbox. The demo showed the front half of the product and none
// of the half it is now mostly made of.
test("demo login pre-populates a working ledger, not just documents", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const accounts = await request(app).get("/api/accounts").set(headers);
  expect(accounts.body.items.length).toBeGreaterThan(0);

  const entries = await request(app).get("/api/journal-entries").set(headers);
  expect(entries.body.items.length).toBeGreaterThan(0);

  // The one thing a demo must never show is books that don't balance.
  const tb = await request(app).get("/api/ledger/trial-balance").set(headers);
  expect(tb.body.balanced).toBe(true);
  expect(tb.body.total_debit).toBeGreaterThan(0);
});

test("the demo's income statement shows a real gross profit", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const pnl = await request(app)
    .get("/api/statements/profit-and-loss?from=2000-01-01&to=2099-12-31")
    .set(headers);
  expect(pnl.status).toBe(200);

  // Seeded with cost of revenue on purpose, so the multi-step statement has
  // something to separate rather than collapsing to the single-step shape.
  expect(pnl.body.revenue.total).toBeGreaterThan(0);
  expect(pnl.body.cost_of_revenue.total).toBeGreaterThan(0);
  expect(pnl.body.gross_profit).toBeCloseTo(pnl.body.revenue.total - pnl.body.cost_of_revenue.total, 2);
  expect(pnl.body.operating_income).toBeCloseTo(pnl.body.gross_profit - pnl.body.expenses.total, 2);
  expect(pnl.body.net_income).toBeGreaterThan(0);

  const bs = await request(app).get("/api/statements/balance-sheet").set(headers);
  expect(bs.body.balanced).toBe(true);
});

// The Close tab is the other thing that read as empty. The seed leaves two
// deliberate gaps -- a month of rent that never posted, and a fixed asset
// with nothing depreciating it -- so closeAutomation.js has something real
// to find instead of handing a visitor a clean bill of health that teaches
// them nothing about what the feature does.
test("the demo's close suggestions have something real to surface", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const month = new Date().toISOString().slice(0, 7);
  const res = await request(app).get(`/api/close/suggestions?period_month=${month}`).set(headers);
  expect(res.status).toBe(200);

  const types = res.body.items.map((i) => i.type);
  expect(types).toContain("missing_expense");
  expect(types).toContain("undepreciated_asset");
});

// Until this the demo's entire Accounting section ran on raw journal
// entries disconnected from the Documents tab, and Receivables, Payroll,
// Equity, and Income Tax were all completely empty -- a visitor exploring
// any of those tabs found nothing, despite the features being real. This
// covers every one of those additions having real, current rows to show.
test("the demo's real AP flow ties the Documents tab's bills to the books", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const vendors = await request(app).get("/api/vendors").set(headers);
  expect(vendors.body.items.length).toBeGreaterThanOrEqual(2);
  const pinehurst = vendors.body.items.find((v) => v.name === "Pinehurst Office Supply");
  expect(pinehurst.early_pay_discount_pct).toBeGreaterThan(0);

  const checks = await request(app).get("/api/written-checks").set(headers);
  expect(checks.body.items.length).toBeGreaterThan(0);

  const aging = await request(app).get("/api/reports/ap-aging").set(headers);
  expect(aging.body.totals.total).toBeGreaterThan(0);

  const purchases = await request(app).get("/api/journal-entries?journal=purchases").set(headers);
  expect(purchases.body.items.length).toBeGreaterThan(0);

  const cashPayments = await request(app).get("/api/journal-entries?journal=cash_payments").set(headers);
  expect(cashPayments.body.items.some((e) => e.source === "bill_payment")).toBe(true);
});

test("the demo's Receivables tab has real customers and invoices across every status", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const customers = await request(app).get("/api/customers").set(headers);
  expect(customers.body.items.length).toBeGreaterThanOrEqual(2);

  const invoices = await request(app).get("/api/customer-invoices").set(headers);
  const statuses = new Set(invoices.body.items.map((i) => i.status));
  expect(statuses.has("draft")).toBe(true);
  expect(statuses.has("sent")).toBe(true);
  expect(statuses.has("paid")).toBe(true);

  const aging = await request(app).get("/api/reports/ar-aging").set(headers);
  expect(aging.body.totals.total).toBeGreaterThan(0);

  const sales = await request(app).get("/api/journal-entries?journal=sales").set(headers);
  expect(sales.body.items.length).toBeGreaterThan(0);

  const cashReceipts = await request(app).get("/api/journal-entries?journal=cash_receipts").set(headers);
  expect(cashReceipts.body.items.some((e) => e.source === "customer_payment")).toBe(true);
});

test("the demo's Payroll tab has real employees and pay runs", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const employees = await request(app).get("/api/employees").set(headers);
  expect(employees.body.length).toBeGreaterThanOrEqual(2);

  const runs = await request(app).get("/api/payroll-runs").set(headers);
  expect(runs.body.length).toBeGreaterThan(0);
  expect(runs.body[0].net_pay).toBeGreaterThan(0);
});

test("the demo's Equity tab has real transactions, not just a balance with nothing behind it", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const transactions = await request(app).get("/api/equity/transactions").set(headers);
  const types = new Set(transactions.body.items.map((t) => t.type));
  expect(types.has("contribution")).toBe(true);
  expect(types.has("distribution")).toBe(true);
});

test("the demo's Income Tax tab shows an accrued provision and a partial payment", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const headers = authHeader(login.body.access_token);

  const asOf = new Date().toISOString().slice(0, 10);
  const provision = await request(app).get(`/api/income-tax/provision?as_of=${asOf}&rate_percent=21`).set(headers);
  expect(provision.status).toBe(200);
  expect(provision.body.already_posted).toBeGreaterThan(0);
  expect(provision.body.payable).toBeGreaterThan(0);
});

// Kept last, same reasoning as auth.test.js's rate-limit tests -- exhausts
// the shared per-file limiter state, so nothing after it needs a fresh call.
test("demo login rate limits after repeated attempts from the same IP", async () => {
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await request(app).post("/api/demo/login").send({});
  }
  expect(lastRes.status).toBe(429);
  // Generous timeout: the 20 requests before the limiter trips each seed a
  // whole demo org (invoices, receipts, vendor documents, leases, tax
  // documents, and since v1.38 around 48 journal entries apiece), so this is
  // the most expensive test in the suite by far. It runs at roughly 15s of
  // the 60s here; the headroom is for a busy machine, not for growth -- if
  // the demo seed gets much heavier, shrink the seed rather than raising
  // this again.
}, 60000);
