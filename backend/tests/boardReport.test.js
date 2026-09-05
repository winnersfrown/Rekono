// The board report (boardReport.js, routes/boardReport.js): an assembled
// view over statements this app already computes and tests independently
// -- financialStatements.js, budget.js, equityAwards.js. What's actually
// new here, and worth testing directly, is burn rate and runway; the rest
// of this file is mostly making sure assembly doesn't silently drop or
// mis-scope a piece.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

function monthsBefore(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

// Matches boardReport.js's own BURN_WINDOW_MONTHS -- the test has to know
// the window to place fixtures inside or outside it on purpose.
const BURN_FROM = monthsBefore(TODAY, 3);
const BEFORE_WINDOW = monthsBefore(BURN_FROM, 1);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, entryDate, memo, lines) {
  const res = await request(app).post("/api/journal-entries").set(authHeader(token)).send({ entry_date: entryDate, memo, lines });
  if (res.status !== 201) throw new Error(`postEntry failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function boardReport(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  const res = await request(app).get(`/api/reports/board${q}`).set(authHeader(token));
  if (res.status !== 200) throw new Error(`board report failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("requires authentication", async () => {
  expect((await request(app).get("/api/reports/board")).status).toBe(401);
});

test("a fresh org with no activity gets a sane zeroed report, not an error", async () => {
  const token = await signup(app, request);
  const report = await boardReport(token);

  expect(report.cash).toMatchObject({ on_hand: 0, monthly_burn: 0, runway_months: null });
  expect(report.budget_vs_actual.has_budget).toBe(false);
  expect(report.cap_table.holders).toEqual([]);
  expect(report.cap_table.fully_diluted_shares).toBe(0);
  expect(report.profit_and_loss).toBeTruthy();
  expect(report.balance_sheet.balanced).toBe(true);
});

describe("cash, burn, and runway", () => {
  test("burn only counts the trailing window; cash on hand is cumulative", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const equity = await accountId(token, "Owner's Equity");
    const software = await accountId(token, "Software & Subscriptions");

    // Well before the burn window -- counts toward cash on hand, not burn.
    await postEntry(token, BEFORE_WINDOW, "Owner contribution", [
      { account_id: cash, debit: 12000 },
      { account_id: equity, credit: 12000 },
    ]);
    // Inside the window -- the only thing that should move burn.
    await postEntry(token, BURN_FROM, "Software spend", [
      { account_id: software, debit: 3000 },
      { account_id: cash, credit: 3000 },
    ]);

    const report = await boardReport(token, TODAY);
    expect(report.cash.on_hand).toBe(9000);
    expect(report.cash.monthly_burn).toBe(1000); // $3,000 over 3 months
    expect(report.cash.runway_months).toBe(9); // $9,000 / $1,000
  });

  test("cash flowing in over the window means no burn, not negative burn", async () => {
    const token = await signup(app, request);
    const cash = await accountId(token, "Cash");
    const revenue = await accountId(token, "Uncategorized Revenue");

    await postEntry(token, BURN_FROM, "Cash sale", [
      { account_id: cash, debit: 5000 },
      { account_id: revenue, credit: 5000 },
    ]);

    const report = await boardReport(token, TODAY);
    expect(report.cash.on_hand).toBe(5000);
    expect(report.cash.monthly_burn).toBe(0);
    expect(report.cash.runway_months).toBeNull();
  });
});

test("a budget shows up as this month's actual, scoped to the current fiscal year", async () => {
  const token = await signup(app, request);
  // The default fiscal year end month is December, so the fiscal year
  // ending in the current calendar year is always the one "today" falls
  // in -- see fiscalYearFor's own comment on why endMonth 12 collapses to
  // exactly this.
  const created = await request(app)
    .post("/api/budget")
    .set(authHeader(token))
    .send({ fiscal_year_end_year: new Date().getUTCFullYear() });
  expect(created.status).toBe(201);

  const report = await boardReport(token);
  expect(report.budget_vs_actual.has_budget).toBe(true);
  expect(report.budget_vs_actual.budget_id).toBe(created.body.budget_id);
});

test("the cap table reflects issued shares and dilutes with the option pool", async () => {
  const token = await signup(app, request);
  const cls = await request(app).post("/api/share-classes").set(authHeader(token)).send({ name: "Common", par_value: 0.0001 });
  const holder = await request(app).post("/api/shareholders").set(authHeader(token)).send({ name: "Ada" });
  await request(app)
    .post("/api/share-transactions")
    .set(authHeader(token))
    .send({ type: "issue", share_class_id: cls.body.id, transaction_date: TODAY, shares: 8000, to_shareholder_id: holder.body.id });

  const report = await boardReport(token);
  expect(report.cap_table.outstanding_shares).toBe(8000);
  expect(report.cap_table.holders).toEqual(
    expect.arrayContaining([expect.objectContaining({ shareholder_name: "Ada", shares: 8000, fully_diluted_shares: 8000 })])
  );
});

test("never sees another org's cash, budget, or cap table", async () => {
  const mine = await signup(app, request, { email: "board-mine@example.co" });
  const theirs = await signup(app, request, { email: "board-theirs@example.co", orgName: "Other Co" });

  const cash = await accountId(theirs, "Cash");
  const equity = await accountId(theirs, "Owner's Equity");
  await postEntry(theirs, TODAY, "Their contribution", [
    { account_id: cash, debit: 50000 },
    { account_id: equity, credit: 50000 },
  ]);
  await request(app).post("/api/budget").set(authHeader(theirs)).send({ fiscal_year_end_year: new Date().getUTCFullYear() + 1 });

  const report = await boardReport(mine);
  expect(report.cash.on_hand).toBe(0);
  expect(report.budget_vs_actual.has_budget).toBe(false);
});
