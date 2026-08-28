// Close automation (closeAutomation.js, /api/close/suggestions).
//
// The existing close checklist asks document-workflow questions -- are the
// invoices reviewed, is anything still extracting. None of them looks at
// the ledger, so the failure that actually matters at month-end goes
// unnoticed: the month where rent simply never got posted.
//
// What's worth testing hardest is where the line sits. Three of the last
// four months is a pattern; two is a coincidence. And an expense already
// due on a recurring template must not be reported twice by two different
// mechanisms.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeAccount(token, { code, name, type, subtype = "" }) {
  const res = await request(app).post("/api/accounts").set(authHeader(token)).send({ code, name, type, subtype });
  return res.body.id;
}

// One expense posted on the 5th of a month, paid from Cash.
async function postExpense(token, { month, amount, expenseAccount, cash }) {
  return request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: `${month}-05`,
      lines: [{ account_id: expenseAccount, debit: amount }, { account_id: cash, credit: amount }],
    });
}

async function suggestions(token, month) {
  const res = await request(app).get(`/api/close/suggestions?period_month=${month}`).set(authHeader(token));
  return res.body.items;
}

describe("a missing recurring expense", () => {
  test("is flagged when it posted in three of the last four months", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }

    const items = await suggestions(token, "2026-05");
    const rentItem = items.find((i) => i.account_name === "Rent");
    expect(rentItem).toBeTruthy();
    expect(rentItem.type).toBe("missing_expense");
    expect(rentItem.months_seen).toBe(4);
    expect(rentItem.typical_amount).toBe(4000);
    expect(rentItem.last_seen).toBe("2026-04");
    expect(rentItem.detail).toMatch(/nothing in 2026-05/);
  });

  test("tolerates one skipped month inside the window", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    // Three of four: February was missed, which doesn't stop this being
    // plainly a monthly expense.
    for (const month of ["2026-01", "2026-03", "2026-04"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }

    const items = await suggestions(token, "2026-05");
    expect(items.find((i) => i.account_name === "Rent").months_seen).toBe(3);
  });

  test("two months is not a pattern", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    for (const month of ["2026-03", "2026-04"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }

    expect((await suggestions(token, "2026-05")).find((i) => i.account_name === "Rent")).toBeUndefined();
  });

  test("is silent when the expense did post this month", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }

    expect((await suggestions(token, "2026-05")).find((i) => i.account_name === "Rent")).toBeUndefined();
  });

  test("reports the median, so one odd month doesn't move the expectation", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    // A double payment in March would drag a mean to $5,500.
    await postExpense(token, { month: "2026-01", amount: 4000, expenseAccount: rent, cash });
    await postExpense(token, { month: "2026-02", amount: 4000, expenseAccount: rent, cash });
    await postExpense(token, { month: "2026-03", amount: 12000, expenseAccount: rent, cash });
    await postExpense(token, { month: "2026-04", amount: 4000, expenseAccount: rent, cash });

    expect((await suggestions(token, "2026-05")).find((i) => i.account_name === "Rent").typical_amount).toBe(4000);
  });

  // Revenue absence is a business fact, not a bookkeeping omission.
  test("only expenses are watched, not revenue", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rev = await accountId(token, "Uncategorized Revenue");

    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04"]) {
      await request(app)
        .post("/api/journal-entries")
        .set(authHeader(token))
        .send({ entry_date: `${month}-05`, lines: [{ account_id: cash, debit: 9000 }, { account_id: rev, credit: 9000 }] });
    }

    expect((await suggestions(token, "2026-05")).some((i) => i.account_name === "Uncategorized Revenue")).toBe(false);
  });

  test("an expense already due on a recurring template isn't reported twice", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });

    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }
    // A template covering the same account, due and unposted. The
    // recurring-entries preview already surfaces this one, and it can post
    // it -- reporting it here as well would have the user chasing one
    // problem through two screens.
    const created = await request(app)
      .post("/api/recurring-entries")
      .set(authHeader(token))
      .send({
        name: "Monthly rent",
        frequency: "monthly",
        start_date: "2026-05-01",
        lines: [{ account_id: rent, debit: 4000 }, { account_id: cash, credit: 4000 }],
      });
    expect(created.status).toBe(201);

    expect((await suggestions(token, "2026-05")).find((i) => i.account_name === "Rent")).toBeUndefined();
  });
});

describe("an undepreciated fixed asset", () => {
  test("is flagged with the arithmetic already done", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const equipment = await makeAccount(token, { code: "1500", name: "Equipment", type: "asset" });

    await request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({ entry_date: "2026-02-10", lines: [{ account_id: equipment, debit: 60000 }, { account_id: cash, credit: 60000 }] });

    const item = (await suggestions(token, "2026-05")).find((i) => i.account_name === "Equipment");
    expect(item).toBeTruthy();
    expect(item.type).toBe("undepreciated_asset");
    expect(item.balance).toBe(60000);
    expect(item.suggested_useful_life_months).toBe(60);
    expect(item.suggested_monthly_amount).toBe(1000);
  });

  test("cash and receivables are never suggested", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const rev = await accountId(token, "Uncategorized Revenue");
    await request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({ entry_date: "2026-02-10", lines: [{ account_id: cash, debit: 50000 }, { account_id: rev, credit: 50000 }] });

    const items = await suggestions(token, "2026-05");
    expect(items.some((i) => i.type === "undepreciated_asset" && i.account_name === "Cash")).toBe(false);
  });

  test("an asset a recurring template already posts against is left alone", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const equipment = await makeAccount(token, { code: "1500", name: "Equipment", type: "asset" });
    const depExpense = await makeAccount(token, { code: "6300", name: "Depreciation", type: "expense" });

    await request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({ entry_date: "2026-02-10", lines: [{ account_id: equipment, debit: 60000 }, { account_id: cash, credit: 60000 }] });

    await request(app)
      .post("/api/recurring-entries")
      .set(authHeader(token))
      .send({
        name: "Equipment depreciation",
        frequency: "monthly",
        start_date: "2026-03-01",
        lines: [{ account_id: depExpense, debit: 1000 }, { account_id: equipment, credit: 1000 }],
      });

    expect((await suggestions(token, "2026-05")).some((i) => i.account_name === "Equipment")).toBe(false);
  });

  test("an asset account with no balance is not suggested", async () => {
    const token = await signup(app, request);
    await makeAccount(token, { code: "1500", name: "Equipment", type: "asset" });
    expect((await suggestions(token, "2026-05")).some((i) => i.account_name === "Equipment")).toBe(false);
  });
});

describe("the endpoint", () => {
  test("requires a well-formed period month", async () => {
    const token = await signup(app, request);
    expect((await request(app).get("/api/close/suggestions").set(authHeader(token))).status).toBe(422);
    expect((await request(app).get("/api/close/suggestions?period_month=2026").set(authHeader(token))).status).toBe(422);
  });

  test("one org's suggestions are invisible to another", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const cash = await accountId(token, "Cash");
    const rent = await makeAccount(token, { code: "6100", name: "Rent", type: "expense" });
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04"]) {
      await postExpense(token, { month, amount: 4000, expenseAccount: rent, cash });
    }

    expect((await suggestions(token, "2026-05")).length).toBeGreaterThan(0);
    expect(await suggestions(otherToken, "2026-05")).toHaveLength(0);
  });

  test("requires authentication", async () => {
    expect((await request(app).get("/api/close/suggestions?period_month=2026-05")).status).toBe(401);
  });
});
