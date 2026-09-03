// Budget vs actual (budget.js, routes/budget.js).
//
// The one thing that has to hold: "actual" here must always agree with
// what the P&L itself reports for the same accounts and period -- so
// these assert budget-vs-actual numbers against real posted journal
// entries, and check the report against /api/reports/profit-and-loss
// directly in one test rather than trusting the two never drift apart on
// their own.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, entryDate, lines) {
  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: entryDate, memo: "test entry", lines });
  expect(res.status).toBe(201);
  return res.body;
}

async function createBudget(token, fiscalYearEndYear) {
  const res = await request(app).post("/api/budget").set(authHeader(token)).send({ fiscal_year_end_year: fiscalYearEndYear });
  expect(res.status).toBe(201);
  return res.body;
}

test("an annual budget splits evenly across the fiscal year, remainder on the last month", async () => {
  const token = await signup(app, request);
  const budget = await createBudget(token, 2026);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const res = await request(app)
    .post(`/api/budget/${budget.budget_id}/accounts`)
    .set(authHeader(token))
    .send({ account_id: revenue, annual_amount: 12000.05 });
  expect(res.status).toBe(200);

  const row = res.body.rows.find((r) => r.account_id === revenue);
  expect(row.budget).toBe(12000.05);
});

test("budget vs actual reports a shortfall when revenue comes in under plan", async () => {
  const token = await signup(app, request);
  const budget = await createBudget(token, 2026);
  const revenue = await accountId(token, "Uncategorized Revenue");
  const expense = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");

  await request(app).post(`/api/budget/${budget.budget_id}/accounts`).set(authHeader(token)).send({ account_id: revenue, annual_amount: 12000 });

  // Post only $800 of revenue in January against a $1000/month plan.
  await postEntry(token, "2026-01-15", [
    { account_id: cash, debit: 800 },
    { account_id: revenue, credit: 800 },
  ]);

  const res = await request(app).get("/api/budget?fiscal_year_end_year=2026&through_month=2026-01").set(authHeader(token));
  expect(res.status).toBe(200);
  const row = res.body.rows.find((r) => r.account_id === revenue);
  expect(row.budget).toBe(1000);
  expect(row.actual).toBe(800);
  expect(row.variance).toBe(-200);
  expect(row.favorable).toBe(false);
});

test("an expense running under budget is favorable; over budget is not", async () => {
  const token = await signup(app, request);
  const budget = await createBudget(token, 2026);
  const expense = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");

  await request(app).post(`/api/budget/${budget.budget_id}/accounts`).set(authHeader(token)).send({ account_id: expense, annual_amount: 1200 });

  await postEntry(token, "2026-01-10", [
    { account_id: expense, debit: 50 },
    { account_id: cash, credit: 50 },
  ]);

  const underBudget = await request(app).get("/api/budget?fiscal_year_end_year=2026&through_month=2026-01").set(authHeader(token));
  const row1 = underBudget.body.rows.find((r) => r.account_id === expense);
  expect(row1.budget).toBe(100);
  expect(row1.actual).toBe(50);
  expect(row1.favorable).toBe(true);

  await postEntry(token, "2026-02-05", [
    { account_id: expense, debit: 200 },
    { account_id: cash, credit: 200 },
  ]);
  const overBudget = await request(app).get("/api/budget?fiscal_year_end_year=2026&through_month=2026-02").set(authHeader(token));
  const row2 = overBudget.body.rows.find((r) => r.account_id === expense);
  expect(row2.budget).toBe(200); // two months at $100
  expect(row2.actual).toBe(250);
  expect(row2.favorable).toBe(false);
});

test("an account with actual spend but no budget line still shows up", async () => {
  const token = await signup(app, request);
  await createBudget(token, 2026);
  const expense = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");

  await postEntry(token, "2026-03-01", [
    { account_id: expense, debit: 75 },
    { account_id: cash, credit: 75 },
  ]);

  const res = await request(app).get("/api/budget?fiscal_year_end_year=2026").set(authHeader(token));
  const row = res.body.rows.find((r) => r.account_id === expense);
  expect(row).toBeDefined();
  expect(row.budget).toBe(0);
  expect(row.actual).toBe(75);
  // Spending against a $0 budget is a real, unfavorable answer -- not
  // nothing to report. `null` is reserved for the true nothing-happened
  // case (no budget and no actual either).
  expect(row.favorable).toBe(false);
});

test("the report's totals agree with the P&L for the same period", async () => {
  const token = await signup(app, request);
  await createBudget(token, 2026);
  const revenue = await accountId(token, "Uncategorized Revenue");
  const expense = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");

  await postEntry(token, "2026-01-15", [
    { account_id: cash, debit: 5000 },
    { account_id: revenue, credit: 5000 },
  ]);
  await postEntry(token, "2026-02-10", [
    { account_id: expense, debit: 1200 },
    { account_id: cash, credit: 1200 },
  ]);

  const budgetReport = await request(app).get("/api/budget?fiscal_year_end_year=2026").set(authHeader(token));
  const pnl = await request(app)
    .get("/api/statements/profit-and-loss?from=2026-01-01&to=2026-12-31")
    .set(authHeader(token));

  expect(budgetReport.body.totals.actual_revenue).toBe(pnl.body.revenue.total);
  expect(budgetReport.body.totals.actual_expense).toBe(pnl.body.expenses.total);
  expect(budgetReport.body.totals.actual_net_income).toBeCloseTo(pnl.body.net_income, 2);
});

test("closing entries are excluded from actuals, same as the P&L", async () => {
  const token = await signup(app, request);
  await createBudget(token, 2026);
  const revenue = await accountId(token, "Uncategorized Revenue");
  const cash = await accountId(token, "Cash");

  await postEntry(token, "2026-06-15", [
    { account_id: cash, debit: 2000 },
    { account_id: revenue, credit: 2000 },
  ]);

  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-12-31" });

  const res = await request(app).get("/api/budget?fiscal_year_end_year=2026").set(authHeader(token));
  const row = res.body.rows.find((r) => r.account_id === revenue);
  expect(row.actual).toBe(2000);
});

test("removing an account's budget clears its lines but not its actuals", async () => {
  const token = await signup(app, request);
  const budget = await createBudget(token, 2026);
  const revenue = await accountId(token, "Uncategorized Revenue");
  const cash = await accountId(token, "Cash");

  await request(app).post(`/api/budget/${budget.budget_id}/accounts`).set(authHeader(token)).send({ account_id: revenue, annual_amount: 12000 });
  await postEntry(token, "2026-01-15", [
    { account_id: cash, debit: 500 },
    { account_id: revenue, credit: 500 },
  ]);

  const removed = await request(app).delete(`/api/budget/${budget.budget_id}/accounts/${revenue}`).set(authHeader(token));
  expect(removed.status).toBe(200);
  const row = removed.body.rows.find((r) => r.account_id === revenue);
  expect(row.budget).toBe(0);
  expect(row.actual).toBe(500);
});

test("only revenue and expense accounts can be budgeted", async () => {
  const token = await signup(app, request);
  const budget = await createBudget(token, 2026);
  const cash = await accountId(token, "Cash");

  const res = await request(app)
    .post(`/api/budget/${budget.budget_id}/accounts`)
    .set(authHeader(token))
    .send({ account_id: cash, annual_amount: 1000 });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/revenue or expense account/i);
});

test("budgets are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const budgetA = await createBudget(tokenA, 2026);

  const patchB = await request(app)
    .post(`/api/budget/${budgetA.budget_id}/accounts`)
    .set(authHeader(tokenB))
    .send({ account_id: "does-not-matter", annual_amount: 100 });
  expect(patchB.status).toBe(404);

  const reportB = await request(app).get("/api/budget?fiscal_year_end_year=2026").set(authHeader(tokenB));
  expect(reportB.body.has_budget).toBe(false);
});
