// The income tax provision (incomeTax.js, routes/incomeTax.js).
//
// Three things carry the weight:
//
//   1. The base is pre-tax income. If the provision were computed against
//      net income it would feed on itself -- post tax, income drops, next
//      run wants less tax, forever. A second run at the same rate must
//      post nothing.
//   2. A loss accrues no benefit. Booking one asserts a deferred tax asset
//      is realizable, which is a judgment this app can't make for someone.
//   3. It's cumulative-to-date and trues up, because that is how a real
//      provision behaves quarter to quarter.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

// Real revenue and expense, posted by hand so the numbers are exact.
async function seedIncome(token, { date = "2026-06-30", revenue = 100000, expense = 40000 } = {}) {
  const [cash, rev, exp] = await Promise.all([
    accountId(token, "Cash"),
    accountId(token, "Uncategorized Revenue"),
    accountId(token, "Uncategorized Expense"),
  ]);
  if (revenue) {
    await request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({ entry_date: date, lines: [{ account_id: cash, debit: revenue }, { account_id: rev, credit: revenue }] });
  }
  if (expense) {
    await request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({ entry_date: date, lines: [{ account_id: exp, debit: expense }, { account_id: cash, credit: expense }] });
  }
}

async function preview(token, asOf, rate) {
  return (await request(app).get(`/api/income-tax/provision?as_of=${asOf}&rate_percent=${rate}`).set(authHeader(token))).body;
}

function post(token, asOf, rate) {
  return request(app).post("/api/income-tax/provision").set(authHeader(token)).send({ as_of: asOf, rate_percent: rate });
}

async function pl(token, from, to) {
  return (await request(app).get(`/api/statements/profit-and-loss?from=${from}&to=${to}`).set(authHeader(token))).body;
}

describe("computing the provision", () => {
  test("is a percentage of pre-tax income, not of net income", async () => {
    const token = await signup(app, request);
    await seedIncome(token); // $100k revenue - $40k expense = $60k pre-tax

    const p = await preview(token, "2026-12-31", 21);
    expect(p.pre_tax_income).toBe(60000);
    expect(p.provision).toBe(12600); // 21% of 60,000
    expect(p.to_post).toBe(12600);
    expect(p.fiscal_year).toBe("FY2026");
  });

  // The circularity guard. Once tax is on the books it must not shrink its
  // own base, so re-running at the same rate posts nothing.
  test("a second run at the same rate posts nothing", async () => {
    const token = await signup(app, request);
    await seedIncome(token);

    const first = await post(token, "2026-12-31", 21);
    expect(first.status).toBe(201);
    expect(first.body.to_post).toBe(12600);

    const second = await post(token, "2026-12-31", 21);
    expect(second.status).toBe(200);
    expect(second.body.journal_entry_id).toBeNull();
    expect(second.body.pre_tax_income).toBe(60000); // unchanged by its own tax
    expect(second.body.to_post).toBe(0);
  });

  test("raising the rate trues up by the difference", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    await post(token, "2026-12-31", 21);

    const p = await preview(token, "2026-12-31", 25);
    expect(p.already_posted).toBe(12600);
    expect(p.provision).toBe(15000);
    expect(p.to_post).toBe(2400);

    const res = await post(token, "2026-12-31", 25);
    expect(res.body.to_post).toBe(2400);
    expect((await preview(token, "2026-12-31", 25)).to_post).toBe(0);
  });

  // A quarter where income fell posts a negative increment. That is a
  // correct true-up, not an error to suppress.
  test("income falling later in the year trues the provision down", async () => {
    const token = await signup(app, request);
    await seedIncome(token, { date: "2026-03-31", revenue: 100000, expense: 0 });

    await post(token, "2026-03-31", 20);
    expect((await preview(token, "2026-03-31", 20)).already_posted).toBe(20000);

    // A big Q4 expense halves the year's income.
    await seedIncome(token, { date: "2026-11-30", revenue: 0, expense: 50000 });

    const p = await preview(token, "2026-12-31", 20);
    expect(p.pre_tax_income).toBe(50000);
    expect(p.provision).toBe(10000);
    expect(p.to_post).toBe(-10000);

    const res = await post(token, "2026-12-31", 20);
    expect(res.status).toBe(201);
    expect((await preview(token, "2026-12-31", 20)).to_post).toBe(0);
  });

  test("a loss accrues no tax and no benefit", async () => {
    const token = await signup(app, request);
    await seedIncome(token, { revenue: 20000, expense: 50000 }); // -$30k

    const p = await preview(token, "2026-12-31", 21);
    expect(p.pre_tax_income).toBe(-30000);
    // Floored at zero: booking a benefit asserts the loss will shelter
    // future income, which is a judgment this app doesn't make.
    expect(p.provision).toBe(0);
    expect(p.to_post).toBe(0);

    const res = await post(token, "2026-12-31", 21);
    expect(res.body.journal_entry_id).toBeNull();
  });

  test("a rate outside 0-100 is refused", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    expect((await post(token, "2026-12-31", 150)).status).toBe(422);
    expect((await post(token, "2026-12-31", -5)).status).toBe(422);
  });

  test("only the fiscal year containing as_of counts", async () => {
    const token = await signup(app, request);
    await seedIncome(token, { date: "2025-06-30", revenue: 80000, expense: 0 });
    await seedIncome(token, { date: "2026-06-30", revenue: 100000, expense: 40000 });

    // FY2026 sees its own $60k, not the prior year's $80k.
    expect((await preview(token, "2026-12-31", 21)).pre_tax_income).toBe(60000);
    expect((await preview(token, "2025-12-31", 21)).pre_tax_income).toBe(80000);
  });
});

describe("the statements", () => {
  test("the P&L shows pre-tax income, tax, and net income separately", async () => {
    const token = await signup(app, request);
    await seedIncome(token);

    const before = await pl(token, "2026-01-01", "2026-12-31");
    // An org that has never booked a provision looks exactly as it did.
    expect(before.income_before_taxes).toBe(60000);
    expect(before.income_tax_expense).toBe(0);
    expect(before.net_income).toBe(60000);

    await post(token, "2026-12-31", 21);

    const after = await pl(token, "2026-01-01", "2026-12-31");
    expect(after.income_before_taxes).toBe(60000);
    expect(after.income_tax_expense).toBe(12600);
    expect(after.net_income).toBe(47400);
    // Tax is out of the operating expense section, not double-counted in it.
    expect(after.expenses.total).toBe(40000);
    expect(after.expenses.accounts.some((a) => a.name === "Income Tax Expense")).toBe(false);
  });

  test("the accrual creates a liability and the balance sheet still balances", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    await post(token, "2026-12-31", 21);

    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2026-12-31").set(authHeader(token))).body;
    expect(bs.balanced).toBe(true);
    const payable = bs.liabilities.accounts.find((a) => a.name === "Income Taxes Payable");
    expect(payable.amount).toBe(12600);
    // Accruing moves no cash.
    expect(bs.assets.total).toBe(60000);
  });
});

describe("paying it", () => {
  test("settles the liability without touching the P&L", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    await post(token, "2026-12-31", 21);
    const cash = await accountId(token, "Cash");

    const res = await request(app)
      .post("/api/income-tax/payments")
      .set(authHeader(token))
      .send({ amount: 5000, payment_date: "2027-03-15", cash_account_id: cash });
    expect(res.status).toBe(201);
    expect(res.body.payable).toBe(7600);

    // The expense was recognized at accrual, so paying changes nothing on
    // the income statement.
    const statement = await pl(token, "2026-01-01", "2027-12-31");
    expect(statement.income_tax_expense).toBe(12600);

    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2027-12-31").set(authHeader(token))).body;
    expect(bs.balanced).toBe(true);
    expect(bs.liabilities.accounts.find((a) => a.name === "Income Taxes Payable").amount).toBe(7600);
    expect(bs.assets.accounts.find((a) => a.name === "Cash").amount).toBe(55000);
  });

  test("paying more than is accrued is refused", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    await post(token, "2026-12-31", 21);
    const cash = await accountId(token, "Cash");

    const res = await request(app)
      .post("/api/income-tax/payments")
      .set(authHeader(token))
      .send({ amount: 20000, payment_date: "2027-03-15", cash_account_id: cash });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/accrued/);
  });

  test("Income Taxes Payable can't pay itself", async () => {
    const token = await signup(app, request);
    await seedIncome(token);
    await post(token, "2026-12-31", 21);
    const payable = await accountId(token, "Income Taxes Payable");

    const res = await request(app)
      .post("/api/income-tax/payments")
      .set(authHeader(token))
      .send({ amount: 100, payment_date: "2027-03-15", cash_account_id: payable });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/can't pay itself/);
  });
});

describe("org isolation", () => {
  test("one org's provision is invisible to another", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    await seedIncome(token);
    await post(token, "2026-12-31", 21);

    const p = await preview(otherToken, "2026-12-31", 21);
    expect(p.pre_tax_income).toBe(0);
    expect(p.already_posted).toBe(0);
  });

  test("the endpoints require authentication", async () => {
    expect((await request(app).get("/api/income-tax/provision?as_of=2026-12-31&rate_percent=21")).status).toBe(401);
    expect((await request(app).post("/api/income-tax/provision").send({ as_of: "2026-12-31", rate_percent: 21 })).status).toBe(401);
    expect((await request(app).post("/api/income-tax/payments").send({ amount: 1, payment_date: "2026-12-31", cash_account_id: "x" })).status).toBe(401);
  });
});
