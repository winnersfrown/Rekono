// Employees and payroll runs (payroll.js, routes/payroll.js). Rekono
// records a pay run's already-computed numbers and posts the balanced
// journal entry they imply -- it never calculates withholding itself, so
// these tests check the accounting (the entry balances, the right
// accounts move by the right amounts), not tax math.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

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

async function makeEmployee(token, name = "Jordan Lee") {
  const res = await request(app).post("/api/employees").set(authHeader(token)).send({ name });
  return res.body;
}

async function standardAccounts(token) {
  return {
    cash: await accountId(token, "Cash"),
    wagesExpense: await accountId(token, "Uncategorized Expense"),
    liability: await accountId(token, "Uncategorized Liability"),
  };
}

async function basicPayrollPayload(token, employeeId, overrides = {}) {
  const { cash, wagesExpense, liability } = await standardAccounts(token);
  return {
    employee_id: employeeId,
    pay_date: "2026-06-15",
    gross_wages: 5000,
    federal_tax_withheld: 800,
    state_tax_withheld: 200,
    fica_employee_withheld: 382.5,
    other_deductions: 0,
    employer_fica_match: 382.5,
    employer_unemployment_tax: 42,
    payment_account_id: cash,
    wages_expense_account_id: wagesExpense,
    payroll_tax_expense_account_id: wagesExpense,
    liability_account_id: liability,
    ...overrides,
  };
}

test("creates an employee", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/employees").set(authHeader(token)).send({ name: "Jordan Lee" });
  expect(res.status).toBe(201);
  expect(res.body.name).toBe("Jordan Lee");
  expect(res.body.active).toBe(true);
});

test("deactivates an employee without deleting them", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const res = await request(app).patch(`/api/employees/${employee.id}`).set(authHeader(token)).send({ active: false });
  expect(res.status).toBe(200);
  expect(res.body.active).toBe(false);

  const listRes = await request(app).get("/api/employees").set(authHeader(token));
  expect(listRes.body.find((e) => e.id === employee.id).active).toBe(false);
});

test("recording a payroll run posts a balanced entry across wages, payroll tax, cash, and liabilities", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const payload = await basicPayrollPayload(token, employee.id);

  const res = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);
  expect(res.status).toBe(201);
  // net pay = 5000 - 800 - 200 - 382.5 = 3617.50
  expect(res.body.net_pay).toBeCloseTo(3617.5, 2);
  // employer tax = 382.5 + 42 = 424.50
  expect(res.body.employer_tax_total).toBeCloseTo(424.5, 2);

  const tb = await trialBalance(token);
  // Wages expense debited for the full gross, payroll tax expense (same
  // account here) debited again for the employer's share on top of it.
  expect(accountRow(tb, "Uncategorized Expense").debit).toBeCloseTo(5000 + 424.5, 2);
  // Cash credited only for net pay actually disbursed.
  expect(accountRow(tb, "Cash").credit).toBeCloseTo(3617.5, 2);
  // Liabilities credited for everything withheld/owed but not yet remitted:
  // 800 + 200 + 382.5 + 382.5 + 42 = 1807.00
  expect(accountRow(tb, "Uncategorized Liability").credit).toBeCloseTo(1807, 2);

  // Balances by construction: total debits == total credits across the org.
  const totalDebit = tb.accounts.reduce((sum, a) => sum + a.debit, 0);
  const totalCredit = tb.accounts.reduce((sum, a) => sum + a.credit, 0);
  expect(totalDebit).toBeCloseTo(totalCredit, 2);
});

test("rejects a run where withholding and deductions exceed gross wages", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const payload = await basicPayrollPayload(token, employee.id, {
    gross_wages: 100,
    federal_tax_withheld: 90,
    state_tax_withheld: 20,
  });

  const res = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/can't add up to more than gross wages/i);

  // Nothing should have been left behind -- the run and its (never-posted)
  // entry both get cleaned up on a rejected post.
  const listRes = await request(app).get("/api/payroll-runs").set(authHeader(token));
  expect(listRes.body).toHaveLength(0);
});

test("rejects a wages expense account that isn't actually an expense account", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const cash = await accountId(token, "Cash");
  const payload = await basicPayrollPayload(token, employee.id, { wages_expense_account_id: cash });

  const res = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/expense account/i);
});

test("rejects a liability account that's actually an expense account", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const wagesExpense = await accountId(token, "Uncategorized Expense");
  const payload = await basicPayrollPayload(token, employee.id, { liability_account_id: wagesExpense });

  const res = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/liability account/i);
});

test("voiding a payroll run reverses its journal entry", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const payload = await basicPayrollPayload(token, employee.id);
  const createRes = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);

  const voidRes = await request(app).post(`/api/payroll-runs/${createRes.body.id}/void`).set(authHeader(token));
  expect(voidRes.status).toBe(200);

  const tb = await trialBalance(token);
  // Fully reversed -- every account nets back to zero activity from this.
  expect(accountRow(tb, "Cash").debit).toBeCloseTo(accountRow(tb, "Cash").credit, 2);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBeCloseTo(accountRow(tb, "Uncategorized Expense").credit, 2);
});

test("voiding an already-voided (or never-posted) run is rejected, not silently repeated", async () => {
  const token = await signup(app, request);
  const employee = await makeEmployee(token);
  const payload = await basicPayrollPayload(token, employee.id);
  const createRes = await request(app).post("/api/payroll-runs").set(authHeader(token)).send(payload);
  await request(app).post(`/api/payroll-runs/${createRes.body.id}/void`).set(authHeader(token));

  const secondVoid = await request(app).post(`/api/payroll-runs/${createRes.body.id}/void`).set(authHeader(token));
  expect(secondVoid.status).toBe(409);
});

test("an org only ever sees its own employees and payroll runs", async () => {
  const tokenA = await signup(app, request, { email: "payroll-a@example.co" });
  const employeeA = await makeEmployee(tokenA, "Employee A");
  const payloadA = await basicPayrollPayload(tokenA, employeeA.id);
  await request(app).post("/api/payroll-runs").set(authHeader(tokenA)).send(payloadA);

  const tokenB = await signup(app, request, { email: "payroll-b@example.co", orgName: "Other Org" });
  const employeesB = await request(app).get("/api/employees").set(authHeader(tokenB));
  expect(employeesB.body).toHaveLength(0);
  const runsB = await request(app).get("/api/payroll-runs").set(authHeader(tokenB));
  expect(runsB.body).toHaveLength(0);

  // Cross-org account ids are rejected as if they don't exist, same as
  // every other org-scoped lookup in this app.
  const crossOrgPayload = await basicPayrollPayload(tokenA, employeeA.id);
  const res = await request(app).post("/api/payroll-runs").set(authHeader(tokenB)).send(crossOrgPayload);
  expect(res.status).toBe(404);
});
