// The multi-step income statement (financialStatements.js's
// computeProfitAndLoss, GET /api/statements/profit-and-loss).
//
// The statement now separates cost of revenue from operating expenses so it
// can report gross profit. Two things are worth testing hardest, and neither
// is "does it add up":
//
//   1. The split is by account *subtype*, never by name. An org renaming
//      its accounts must not move a reported figure.
//   2. An org that posts nothing to a cost-of-revenue account has to see
//      exactly what it saw before -- same `expenses.total`, gross profit
//      equal to revenue. A new classification nobody has used yet cannot be
//      allowed to restate anyone's books.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_START = `${new Date().getUTCFullYear()}-01-01`;

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, lines, entryDate = TODAY) {
  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: entryDate, memo: "test", lines });
  if (res.status !== 201) throw new Error(`postEntry failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function incomeStatement(token) {
  const res = await request(app)
    .get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`)
    .set(authHeader(token));
  expect(res.status).toBe(200);
  return res.body;
}

// $10,000 of revenue, $3,000 of cost of revenue, $1,500 of operating
// expense. Gross profit $7,000, operating income $5,500.
async function tradingOrg(token) {
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");
  const cogs = await accountId(token, "Cost of Revenue");
  const software = await accountId(token, "Software & Subscriptions");

  await postEntry(token, [
    { account_id: cash, debit: 10000 },
    { account_id: revenue, credit: 10000 },
  ]);
  await postEntry(token, [
    { account_id: cogs, debit: 3000 },
    { account_id: cash, credit: 3000 },
  ]);
  await postEntry(token, [
    { account_id: software, debit: 1500 },
    { account_id: cash, credit: 1500 },
  ]);
  return { cash, revenue, cogs, software };
}

describe("the multi-step income statement", () => {
  test("separates cost of revenue and reports gross profit", async () => {
    const token = await signup(app, request);
    await tradingOrg(token);

    const pnl = await incomeStatement(token);
    expect(pnl.revenue.total).toBeCloseTo(10000, 2);
    expect(pnl.cost_of_revenue.total).toBeCloseTo(3000, 2);
    expect(pnl.gross_profit).toBeCloseTo(7000, 2);
    expect(pnl.expenses.total).toBeCloseTo(1500, 2);
    expect(pnl.operating_income).toBeCloseTo(5500, 2);
    expect(pnl.net_income).toBeCloseTo(5500, 2);
  });

  test("every subtotal is the one above it minus the section between", async () => {
    const token = await signup(app, request);
    await tradingOrg(token);

    const pnl = await incomeStatement(token);
    expect(pnl.gross_profit).toBeCloseTo(pnl.revenue.total - pnl.cost_of_revenue.total, 2);
    expect(pnl.operating_income).toBeCloseTo(pnl.gross_profit - pnl.expenses.total, 2);
    expect(pnl.net_income).toBeCloseTo(pnl.income_before_taxes - pnl.income_tax_expense, 2);
  });

  // Cost of revenue must never appear twice -- once in its own section and
  // again inside operating expenses -- which is the failure mode of
  // filtering one list and forgetting the other.
  test("a cost-of-revenue account is not also counted as an operating expense", async () => {
    const token = await signup(app, request);
    const { cogs } = await tradingOrg(token);

    const pnl = await incomeStatement(token);
    expect(pnl.expenses.accounts.some((a) => a.account_id === cogs)).toBe(false);
    expect(pnl.cost_of_revenue.accounts.map((a) => a.account_id)).toEqual([cogs]);
    // The two sections plus tax still account for every expense dollar.
    expect(pnl.cost_of_revenue.total + pnl.expenses.total + pnl.income_tax_expense).toBeCloseTo(4500, 2);
  });

  test("the split follows the subtype, not the account name", async () => {
    const token = await signup(app, request);
    const { cogs } = await tradingOrg(token);

    // An org is free to call it whatever it likes. The statement must not
    // notice.
    const renamed = await request(app)
      .patch(`/api/accounts/${cogs}`)
      .set(authHeader(token))
      .send({ name: "Delivery & Fulfilment" });
    expect(renamed.status).toBe(200);

    const pnl = await incomeStatement(token);
    expect(pnl.cost_of_revenue.total).toBeCloseTo(3000, 2);
    expect(pnl.gross_profit).toBeCloseTo(7000, 2);
  });
});

describe("an org that doesn't separate cost of revenue", () => {
  test("sees gross profit equal to revenue and an unchanged expense total", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const revenue = await accountId(token, "Uncategorized Revenue");
    const software = await accountId(token, "Software & Subscriptions");

    await postEntry(token, [
      { account_id: cash, debit: 10000 },
      { account_id: revenue, credit: 10000 },
    ]);
    await postEntry(token, [
      { account_id: software, debit: 1500 },
      { account_id: cash, credit: 1500 },
    ]);

    const pnl = await incomeStatement(token);
    // The single-step shape, unchanged: nothing was reclassified.
    expect(pnl.cost_of_revenue.total).toBe(0);
    expect(pnl.cost_of_revenue.accounts).toHaveLength(0);
    expect(pnl.gross_profit).toBeCloseTo(pnl.revenue.total, 2);
    expect(pnl.expenses.total).toBeCloseTo(1500, 2);
    expect(pnl.net_income).toBeCloseTo(8500, 2);
  });
});

describe("the income statement and the balance sheet still agree", () => {
  // The real risk with a new subtotal isn't that it's individually wrong,
  // it's that the statements stop agreeing with each other. Retained
  // earnings is derived from revenue minus expenses, so a cost-of-revenue
  // dollar that got lost or double-counted on the way into gross profit
  // shows up here as a balance sheet that no longer ties to net income.
  test("current-year earnings equals net income, and the books balance", async () => {
    const token = await signup(app, request);
    await tradingOrg(token);

    const pnl = await incomeStatement(token);
    const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
    expect(bs.status).toBe(200);
    expect(bs.body.balanced).toBe(true);
    expect(bs.body.equity.current_year_earnings).toBeCloseTo(pnl.net_income, 2);

    const tb = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
    expect(tb.body.balanced).toBe(true);
  });
});
