// Prepaid expense amortization (prepaidExpenses.js, routes/prepaidExpenses.js)
// -- the AP mirror of revenueRecognition.test.js. buildSchedule's own math
// (day-proration, rounding, leap years) is already covered there since
// it's the same shared function; these assert the posting, amortization,
// void, and aging behavior specific to the AP side.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, PrepaidExpenseScheduleEntry } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

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

async function pnl(token, from, to) {
  return (await request(app).get(`/api/statements/profit-and-loss?from=${from}&to=${to}`).set(authHeader(token))).body;
}

async function makePrepaid(token, overrides = {}) {
  const expenseAccountId = overrides.expense_account_id || (await accountId(token, "Uncategorized Expense"));
  const paymentAccountId = overrides.payment_account_id || (await accountId(token, "Cash"));
  const res = await request(app)
    .post("/api/prepaid-expenses")
    .set(authHeader(token))
    .send({
      vendor_name: "Acme Insurance Co",
      payment_date: "2026-01-01",
      amount: 1200,
      service_start_date: "2026-01-01",
      service_end_date: "2026-12-31",
      ...overrides,
      expense_account_id: expenseAccountId,
      payment_account_id: paymentAccountId,
    });
  if (res.status !== 201) throw new Error(`makePrepaid failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("recording a prepaid expense debits Prepaid Expenses and credits the payment account, not the expense account", async () => {
  const token = await signup(app, request);
  const prepaid = await makePrepaid(token);
  expect(prepaid.unamortized).toBe(1200);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Prepaid Expenses").debit).toBe(1200);
  expect(accountRow(tb, "Cash").credit).toBe(1200);
  // Nothing has been consumed yet.
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(0);
  expect(tb.balanced).toBe(true);

  const jan = await pnl(token, "2026-01-01", "2026-01-31");
  expect(jan.expenses.total).toBe(0);
});

test("amortizing a month moves exactly that month's share into expense", async () => {
  const token = await signup(app, request);
  await makePrepaid(token);

  const res = await request(app)
    .post("/api/prepaid-expenses-amortize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(res.status).toBe(200);
  // 31 of 365 days at $1200.
  expect(res.body.amortized).toBeCloseTo(101.92, 2);

  const tb = await trialBalance(token);
  const prepaidRow = accountRow(tb, "Prepaid Expenses");
  expect(prepaidRow.debit - prepaidRow.credit).toBeCloseTo(1098.08, 2);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBeCloseTo(101.92, 2);
  expect(tb.balanced).toBe(true);
});

test("amortization posts into the month it recognizes, not the day it was run", async () => {
  const token = await signup(app, request);
  await makePrepaid(token);
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2026-02" });

  const feb = await pnl(token, "2026-02-01", "2026-02-28");
  expect(feb.expenses.total).toBeGreaterThan(0);
  const mar = await pnl(token, "2026-03-01", "2026-03-31");
  expect(mar.expenses.total).toBe(0);
});

test("running a later month catches up every period nobody ran, one entry per month", async () => {
  const token = await signup(app, request);
  await makePrepaid(token);

  const res = await request(app)
    .post("/api/prepaid-expenses-amortize")
    .set(authHeader(token))
    .send({ period_month: "2026-03" });
  expect(res.body.periods.map((p) => p.period_month)).toEqual(["2026-01", "2026-02", "2026-03"]);

  const entries = await request(app).get("/api/journal-entries").set(authHeader(token));
  const amortizationEntries = entries.body.items.filter((e) => e.source === "prepaid_expense_amortization");
  expect(amortizationEntries).toHaveLength(3);
});

test("amortizing twice doesn't double-post", async () => {
  const token = await signup(app, request);
  await makePrepaid(token);
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2026-01" });

  const second = await request(app)
    .post("/api/prepaid-expenses-amortize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(second.body.amortized).toBe(0);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBeCloseTo(101.92, 2);
});

test("amortizing the whole term clears Prepaid Expenses to exactly zero", async () => {
  const token = await signup(app, request);
  // An amount that doesn't divide cleanly, to catch a stranded cent.
  await makePrepaid(token, { amount: 999.91, service_start_date: "2026-01-15", service_end_date: "2027-01-14" });
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2027-01" });

  const tb = await trialBalance(token);
  const prepaidRow = accountRow(tb, "Prepaid Expenses");
  expect(prepaidRow.debit - prepaidRow.credit).toBe(0);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(999.91);
  expect(tb.balanced).toBe(true);
});

test("amortization into a closed period is refused, and the month stays pending", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makePrepaid(token);
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-01", status: "closed", closedAt: new Date() });

  const res = await request(app)
    .post("/api/prepaid-expenses-amortize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(res.status).toBe(409);

  expect(await PrepaidExpenseScheduleEntry.count({ where: { orgId: org, recognizedAt: null } })).toBeGreaterThan(0);
  const tb = await trialBalance(token);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(0);
});

test("the waterfall shows what's left and when it releases, and ties to the ledger", async () => {
  const token = await signup(app, request);
  await makePrepaid(token);
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2026-02" });

  const res = await request(app).get("/api/reports/prepaid-expenses").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.periods).toHaveLength(10);
  expect(res.body.periods[0].period_month).toBe("2026-03");

  const tb = await trialBalance(token);
  const prepaidRow = accountRow(tb, "Prepaid Expenses");
  expect(res.body.total_prepaid).toBeCloseTo(prepaidRow.debit - prepaidRow.credit, 2);
});

test("a prepaid expense's own schedule shows recognized and pending months", async () => {
  const token = await signup(app, request);
  const prepaid = await makePrepaid(token);
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2026-01" });

  const res = await request(app).get(`/api/prepaid-expenses/${prepaid.id}/schedule`).set(authHeader(token));
  expect(res.body.total_scheduled).toBe(1200);
  expect(res.body.recognized).toBeCloseTo(101.92, 2);
  expect(res.body.remaining).toBeCloseTo(1098.08, 2);
  expect(res.body.entries.filter((e) => e.recognized)).toHaveLength(1);
});

test("voiding an unamortized prepaid expense reverses it; a partly amortized one refuses", async () => {
  const token = await signup(app, request);
  const unamortized = await makePrepaid(token);
  const voided = await request(app).post(`/api/prepaid-expenses/${unamortized.id}/void`).set(authHeader(token));
  expect(voided.status).toBe(200);
  expect(voided.body.status).toBe("void");

  const bsAfterVoid = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));
  expect(bsAfterVoid.body.balanced).toBe(true);
  // Nothing left to amortize on a voided prepaid expense.
  expect(await PrepaidExpenseScheduleEntry.count({ where: { prepaidExpenseId: unamortized.id } })).toBe(0);

  const partlyAmortized = await makePrepaid(token);
  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(token)).send({ period_month: "2026-01" });
  const refused = await request(app).post(`/api/prepaid-expenses/${partlyAmortized.id}/void`).set(authHeader(token));
  expect(refused.status).toBe(409);
  expect(refused.body.detail).toMatch(/already been amortized/);
});

test("a service period can't end before it starts, and both accounts must be validated", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const expense = await accountId(token, "Uncategorized Expense");

  const backwards = await request(app)
    .post("/api/prepaid-expenses")
    .set(authHeader(token))
    .send({
      vendor_name: "Acme Insurance Co",
      expense_account_id: expense,
      payment_account_id: cash,
      payment_date: "2026-01-01",
      amount: 100,
      service_start_date: "2026-12-31",
      service_end_date: "2026-01-01",
    });
  expect(backwards.status).toBe(422);
  expect(backwards.body.detail).toMatch(/can't end before it starts/);

  const badExpense = await request(app)
    .post("/api/prepaid-expenses")
    .set(authHeader(token))
    .send({
      vendor_name: "Acme Insurance Co",
      expense_account_id: cash,
      payment_account_id: cash,
      payment_date: "2026-01-01",
      amount: 100,
      service_start_date: "2026-01-01",
      service_end_date: "2026-12-31",
    });
  expect(badExpense.status).toBe(422);
  expect(badExpense.body.detail).toMatch(/expense account/i);

  const ap = await accountId(token, "Accounts Payable");
  const badPayment = await request(app)
    .post("/api/prepaid-expenses")
    .set(authHeader(token))
    .send({
      vendor_name: "Acme Insurance Co",
      expense_account_id: expense,
      payment_account_id: ap,
      payment_date: "2026-01-01",
      amount: 100,
      service_start_date: "2026-01-01",
      service_end_date: "2026-12-31",
    });
  expect(badPayment.status).toBe(422);
  expect(badPayment.body.detail).toMatch(/payment account/i);
});

test("prepaid expenses are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const prepaidA = await makePrepaid(tokenA);

  expect((await request(app).get("/api/prepaid-expenses").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect((await request(app).get(`/api/prepaid-expenses/${prepaidA.id}`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).get("/api/reports/prepaid-expenses").set(authHeader(tokenB))).body.total_prepaid).toBe(0);

  await request(app).post("/api/prepaid-expenses-amortize").set(authHeader(tokenB)).send({ period_month: "2026-12" });
  const tbA = await trialBalance(tokenA);
  expect(accountRow(tbA, "Uncategorized Expense").debit).toBe(0);
});
