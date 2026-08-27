// The three financial statements (financialStatements.js,
// routes/financialStatements.js), computed over v1.20's general ledger.
//
// Most of these run one coherent scenario -- an owner contribution, a cash
// sale, a cash expense, and an accrued (approved) invoice -- and then
// assert all three statements against it. That's deliberate: the real risk
// with financial statements isn't that one report is individually wrong,
// it's that they stop agreeing with each other, and only a shared fixture
// can catch that.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_START = `${new Date().getUTCFullYear()}-01-01`;

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, entryDate, memo, lines) {
  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: entryDate, memo, lines });
  if (res.status !== 201) throw new Error(`postEntry failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// Owner puts in $10,000 cash; $5,000 cash sale; $1,200 software expense
// paid in cash; one $800 invoice approved (accrual -- hits expense and AP,
// never cash). Chosen so every statement section is non-empty and the
// three reports have to agree: net income 3,800 - ... see each test.
async function seedScenario(token) {
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");
  const revenue = await accountId(token, "Uncategorized Revenue");
  const software = await accountId(token, "Software & Subscriptions");

  await postEntry(token, TODAY, "Owner contribution", [
    { account_id: cash, debit: 10000 },
    { account_id: equity, credit: 10000 },
  ]);
  await postEntry(token, TODAY, "Consulting revenue", [
    { account_id: cash, debit: 5000 },
    { account_id: revenue, credit: 5000 },
  ]);
  await postEntry(token, TODAY, "Annual software", [
    { account_id: software, debit: 1200 },
    { account_id: cash, credit: 1200 },
  ]);

  // Accrued, not paid: invoice approval posts Debit expense / Credit AP.
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1",
    total: 800,
    overallConfidence: 0.95,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  return { org, cash, equity, revenue, software, invoice };
}

test("profit & loss reports revenue, expenses, and net income for the period", async () => {
  const token = await signup(app, request);
  await seedScenario(token);

  const res = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(res.status).toBe(200);

  expect(res.body.revenue.total).toBeCloseTo(5000, 2);
  // 1,200 software (cash) + 800 invoice (accrued) -- an accrual-basis P&L
  // counts the approved invoice even though it hasn't been paid.
  expect(res.body.expenses.total).toBeCloseTo(2000, 2);
  expect(res.body.net_income).toBeCloseTo(3000, 2);

  const expenseNames = res.body.expenses.accounts.map((a) => a.name);
  expect(expenseNames).toEqual(expect.arrayContaining(["Software & Subscriptions", "Uncategorized Expense"]));
});

test("profit & loss excludes activity outside the requested window", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2025-06-15", "Last year's revenue", [
    { account_id: cash, debit: 999 },
    { account_id: revenue, credit: 999 },
  ]);
  await postEntry(token, TODAY, "This year's revenue", [
    { account_id: cash, debit: 100 },
    { account_id: revenue, credit: 100 },
  ]);

  const thisYear = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(thisYear.body.revenue.total).toBeCloseTo(100, 2);

  const bothYears = await request(app).get(`/api/statements/profit-and-loss?from=2025-01-01&to=${TODAY}`).set(authHeader(token));
  expect(bothYears.body.revenue.total).toBeCloseTo(1099, 2);
});

test("the balance sheet balances, with retained earnings carrying the period's net income", async () => {
  const token = await signup(app, request);
  await seedScenario(token);

  const res = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  expect(res.status).toBe(200);

  // Cash: 10,000 in + 5,000 in - 1,200 out = 13,800
  expect(res.body.assets.total).toBeCloseTo(13800, 2);
  // Accounts Payable from the approved-but-unpaid invoice.
  expect(res.body.liabilities.total).toBeCloseTo(800, 2);
  // Owner's Equity 10,000 + retained earnings 3,000 (= the P&L's net
  // income for the same window, since the ledger starts empty).
  expect(res.body.equity.retained_earnings).toBeCloseTo(3000, 2);
  expect(res.body.equity.total).toBeCloseTo(13000, 2);

  expect(res.body.total_liabilities_and_equity).toBeCloseTo(13800, 2);
  expect(res.body.balanced).toBe(true);
});

test("retained earnings on the balance sheet equals net income on the P&L for the same window", async () => {
  const token = await signup(app, request);
  await seedScenario(token);

  const [pnl, bs] = await Promise.all([
    request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token)),
    request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token)),
  ]);

  // The two reports are computed independently -- this is the check that
  // they actually agree, which is the whole point of deriving retained
  // earnings rather than storing it.
  expect(bs.body.equity.retained_earnings).toBeCloseTo(pnl.body.net_income, 2);
});

test("a brand-new org's balance sheet is empty but still balances", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));

  expect(res.status).toBe(200);
  expect(res.body.assets.total).toBe(0);
  expect(res.body.equity.retained_earnings).toBe(0);
  expect(res.body.balanced).toBe(true);
});

test("the balance sheet excludes entries posted after its as-of date", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  await postEntry(token, "2026-01-10", "Early contribution", [
    { account_id: cash, debit: 400 },
    { account_id: equity, credit: 400 },
  ]);
  await postEntry(token, "2026-03-10", "Later contribution", [
    { account_id: cash, debit: 600 },
    { account_id: equity, credit: 600 },
  ]);

  const res = await request(app).get("/api/statements/balance-sheet?as_of=2026-02-01").set(authHeader(token));
  expect(res.body.assets.total).toBeCloseTo(400, 2);
  expect(res.body.balanced).toBe(true);
});

test("cash flow classifies operating, investing, and financing activity and reconciles", async () => {
  const token = await signup(app, request);
  await seedScenario(token);

  const res = await request(app).get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(res.status).toBe(200);

  // Revenue +5,000 and software expense -1,200 both moved cash against a
  // P&L account, so both are operating.
  expect(res.body.operating).toBeCloseTo(3800, 2);
  // The owner's contribution moved cash against an equity account.
  expect(res.body.financing).toBeCloseTo(10000, 2);
  expect(res.body.investing).toBeCloseTo(0, 2);

  expect(res.body.net_change_in_cash).toBeCloseTo(13800, 2);
  expect(res.body.reconciled).toBe(true);
});

test("cash flow ignores an accrued invoice entirely -- it never touched cash", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme",
    invoiceNumber: "INV-9",
    total: 4321,
    overallConfidence: 0.95,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  const cashFlow = await request(app).get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(cashFlow.body.net_change_in_cash).toBe(0);
  expect(cashFlow.body.operating).toBe(0);
  expect(cashFlow.body.reconciled).toBe(true);

  // ...but it is on the P&L, since that's accrual-basis. This pair is the
  // whole accrual-vs-cash distinction, asserted directly.
  const pnl = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(pnl.body.expenses.total).toBeCloseTo(4321, 2);
});

test("cash flow classifies a non-cash asset purchase as investing", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  const created = await request(app)
    .post("/api/accounts")
    .set(authHeader(token))
    .send({ name: "Equipment", type: "asset", code: "1500" });
  expect(created.status).toBe(201);

  await postEntry(token, TODAY, "Seed cash", [
    { account_id: cash, debit: 5000 },
    { account_id: equity, credit: 5000 },
  ]);
  await postEntry(token, TODAY, "Buy a laptop", [
    { account_id: created.body.id, debit: 2000 },
    { account_id: cash, credit: 2000 },
  ]);

  const res = await request(app).get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(res.body.investing).toBeCloseTo(-2000, 2);
  expect(res.body.financing).toBeCloseTo(5000, 2);
  expect(res.body.net_change_in_cash).toBeCloseTo(3000, 2);
  expect(res.body.reconciled).toBe(true);
});

test("a voided entry drops out of every statement", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  const entry = await postEntry(token, TODAY, "Revenue to be voided", [
    { account_id: cash, debit: 700 },
    { account_id: revenue, credit: 700 },
  ]);

  const before = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(before.body.revenue.total).toBeCloseTo(700, 2);

  await request(app).post(`/api/journal-entries/${entry.id}/void`).set(authHeader(token));

  // The original's lines stay on the books and its reversal cancels them,
  // so every statement lands back where it started. (Filtering voided
  // entries out instead would leave the reversal counted alone, showing
  // -700 -- which is exactly the bug this test caught in ledger.js's
  // trial balance, see the regression test below.)
  const after = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(after.body.revenue.total).toBe(0);

  const cashFlow = await request(app).get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(cashFlow.body.net_change_in_cash).toBe(0);

  const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  expect(bs.body.assets.total).toBe(0);
  expect(bs.body.balanced).toBe(true);
});

// Regression test for a latent v1.20 bug the statements above surfaced:
// computeTrialBalance filtered to status: "posted", which dropped a voided
// entry while keeping its reversal, leaving the account showing the exact
// negative of the voided amount. It stayed invisible because a reversal is
// itself balanced, so the report's own `balanced` flag never went false.
test("the trial balance nets a voided entry to zero, not to its negative", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  const entry = await postEntry(token, TODAY, "Revenue to be voided", [
    { account_id: cash, debit: 700 },
    { account_id: revenue, credit: 700 },
  ]);
  await request(app).post(`/api/journal-entries/${entry.id}/void`).set(authHeader(token));

  const res = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  const cashRow = res.body.accounts.find((a) => a.name === "Cash");
  const revenueRow = res.body.accounts.find((a) => a.name === "Uncategorized Revenue");

  // Both sides of each account are still on the books (700 each way), and
  // crucially they're equal -- the pre-fix behavior showed only the
  // reversal's side.
  expect(cashRow.debit).toBeCloseTo(700, 2);
  expect(cashRow.credit).toBeCloseTo(700, 2);
  expect(revenueRow.debit).toBeCloseTo(700, 2);
  expect(revenueRow.credit).toBeCloseTo(700, 2);
  expect(res.body.balanced).toBe(true);
});

test("an entry voided in a later period reverses in that later period, not retroactively", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  // Dated in the past so the void (which always carries today's date)
  // lands in a different window.
  const entry = await postEntry(token, "2026-01-15", "January revenue", [
    { account_id: cash, debit: 250 },
    { account_id: revenue, credit: 250 },
  ]);
  await request(app).post(`/api/journal-entries/${entry.id}/void`).set(authHeader(token));

  // January still shows the revenue as originally booked -- a reversal
  // corrects the period it was discovered in, it doesn't rewrite history.
  const january = await request(app)
    .get("/api/statements/profit-and-loss?from=2026-01-01&to=2026-01-31")
    .set(authHeader(token));
  expect(january.body.revenue.total).toBeCloseTo(250, 2);

  // A window spanning both the original and its reversal nets to zero.
  const fullSpan = await request(app)
    .get(`/api/statements/profit-and-loss?from=2026-01-01&to=${TODAY}`)
    .set(authHeader(token));
  expect(fullSpan.body.revenue.total).toBe(0);
});

test("statements are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  await seedScenario(tokenA);

  const res = await request(app).get(`/api/statements/profit-and-liability`).set(authHeader(tokenB));
  expect(res.status).toBe(404); // nonexistent route, guards against a typo'd path silently passing

  const bsB = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(tokenB));
  expect(bsB.body.assets.total).toBe(0);
  expect(bsB.body.liabilities.total).toBe(0);

  const pnlB = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(tokenB));
  expect(pnlB.body.revenue.total).toBe(0);
  expect(pnlB.body.net_income).toBe(0);
});

test("statements require authentication", async () => {
  const res = await request(app).get("/api/statements/balance-sheet");
  expect(res.status).toBe(401);
});

test("a malformed date falls back to the default window instead of erroring", async () => {
  const token = await signup(app, request);
  await seedScenario(token);

  const res = await request(app).get("/api/statements/profit-and-loss?from=not-a-date&to=also-bad").set(authHeader(token));
  expect(res.status).toBe(200);
  // Fell back to year-to-date, which covers the scenario posted today.
  expect(res.body.net_income).toBeCloseTo(3000, 2);
});
