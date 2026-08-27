// Fiscal-year boundaries (fiscalYear.js), the balance sheet's prior-year
// vs. current-year earnings split, and period locking -- the three things
// v1.22 added on top of v1.21's statements.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, Organization } from "../src/models/index.js";
import { fiscalYearFor, dayBefore } from "../src/fiscalYear.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

function postEntry(token, entryDate, memo, lines) {
  return request(app).post("/api/journal-entries").set(authHeader(token)).send({ entry_date: entryDate, memo, lines });
}

describe("fiscalYearFor", () => {
  test("a December year-end is a plain calendar year", () => {
    expect(fiscalYearFor("2026-08-27", 12)).toMatchObject({ start: "2026-01-01", end: "2026-12-31", label: "FY2026" });
  });

  test("a mid-year end spans two calendar years and is named for the year it ends in", () => {
    // Before the year-end month: still in the FY that ends this year.
    expect(fiscalYearFor("2026-03-15", 6)).toMatchObject({ start: "2025-07-01", end: "2026-06-30", label: "FY2026" });
    // After it: already into the next FY.
    expect(fiscalYearFor("2026-09-15", 6)).toMatchObject({ start: "2026-07-01", end: "2027-06-30", label: "FY2027" });
  });

  test("the last day of the year-end month is computed, not hardcoded -- including a leap February", () => {
    expect(fiscalYearFor("2024-02-10", 2).end).toBe("2024-02-29");
    expect(fiscalYearFor("2023-02-10", 2).end).toBe("2023-02-28");
  });

  test("the boundary dates themselves land in the right year", () => {
    expect(fiscalYearFor("2026-01-01", 12).label).toBe("FY2026");
    expect(fiscalYearFor("2026-12-31", 12).label).toBe("FY2026");
    expect(fiscalYearFor("2026-06-30", 6).label).toBe("FY2026");
    expect(fiscalYearFor("2026-07-01", 6).label).toBe("FY2027");
  });

  test("dayBefore crosses a year boundary correctly", () => {
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2024-03-01")).toBe("2024-02-29");
  });
});

test("a new org defaults to a calendar fiscal year, and it's settable", async () => {
  const token = await signup(app, request);

  const before = await request(app).get("/api/org/settings").set(authHeader(token));
  expect(before.body.fiscal_year_end_month).toBe(12);

  const patched = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ fiscal_year_end_month: 6 });
  expect(patched.status).toBe(200);
  expect(patched.body.fiscal_year_end_month).toBe(6);

  const rejected = await request(app).patch("/api/org/settings").set(authHeader(token)).send({ fiscal_year_end_month: 13 });
  expect(rejected.status).toBe(422);
});

test("the balance sheet splits prior-year retained earnings from current-year earnings", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  // One sale in a prior calendar year, one in the current one.
  await postEntry(token, "2025-06-15", "Prior year sale", [
    { account_id: cash, debit: 1000 },
    { account_id: revenue, credit: 1000 },
  ]);
  await postEntry(token, TODAY, "Current year sale", [
    { account_id: cash, debit: 400 },
    { account_id: revenue, credit: 400 },
  ]);

  const res = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  expect(res.status).toBe(200);

  expect(res.body.equity.retained_earnings).toBeCloseTo(1000, 2);
  expect(res.body.equity.current_year_earnings).toBeCloseTo(400, 2);
  // The split is presentational -- the totals are unchanged, so the
  // statement still balances.
  expect(res.body.equity.total).toBeCloseTo(1400, 2);
  expect(res.body.assets.total).toBeCloseTo(1400, 2);
  expect(res.body.balanced).toBe(true);

  expect(res.body.fiscal_year.label).toBe(`FY${new Date().getUTCFullYear()}`);
  expect(res.body.fiscal_year.prior_years_through).toBe(dayBefore(res.body.fiscal_year.start));
});

test("current-year earnings reconciles to a P&L run over the same fiscal year", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");
  const software = await accountId(token, "Software & Subscriptions");

  await postEntry(token, "2025-06-15", "Prior year sale", [
    { account_id: cash, debit: 5000 },
    { account_id: revenue, credit: 5000 },
  ]);
  await postEntry(token, TODAY, "Current year sale", [
    { account_id: cash, debit: 900 },
    { account_id: revenue, credit: 900 },
  ]);
  await postEntry(token, TODAY, "Current year expense", [
    { account_id: software, debit: 250 },
    { account_id: cash, credit: 250 },
  ]);

  const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  const fy = bs.body.fiscal_year;
  const pnl = await request(app)
    .get(`/api/statements/profit-and-loss?from=${fy.start}&to=${TODAY}`)
    .set(authHeader(token));

  // The two are computed independently -- this is the check that the
  // fiscal-year boundary means the same thing to both reports.
  expect(bs.body.equity.current_year_earnings).toBeCloseTo(pnl.body.net_income, 2);
  expect(pnl.body.net_income).toBeCloseTo(650, 2);
  // ...and the prior year stayed out of it.
  expect(bs.body.equity.retained_earnings).toBeCloseTo(5000, 2);
});

test("a non-calendar fiscal year moves the split without changing the totals", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2026-02-15", "February sale", [
    { account_id: cash, debit: 300 },
    { account_id: revenue, credit: 300 },
  ]);
  await postEntry(token, "2026-08-15", "August sale", [
    { account_id: cash, debit: 700 },
    { account_id: revenue, credit: 700 },
  ]);

  // Calendar year: both sales fall in FY2026, so nothing is "prior year".
  const calendar = await request(app).get("/api/statements/balance-sheet?as_of=2026-09-01").set(authHeader(token));
  expect(calendar.body.equity.retained_earnings).toBeCloseTo(0, 2);
  expect(calendar.body.equity.current_year_earnings).toBeCloseTo(1000, 2);

  // June year-end: FY2027 starts 2026-07-01, so February is prior-year and
  // August is current-year.
  await Organization.update({ fiscalYearEndMonth: 6 }, { where: { id: org } });
  const june = await request(app).get("/api/statements/balance-sheet?as_of=2026-09-01").set(authHeader(token));
  expect(june.body.fiscal_year.label).toBe("FY2027");
  expect(june.body.equity.retained_earnings).toBeCloseTo(300, 2);
  expect(june.body.equity.current_year_earnings).toBeCloseTo(700, 2);

  // Reconfiguring posts nothing and rewrites nothing -- the equity total
  // and the balance are identical either way.
  expect(june.body.equity.total).toBeCloseTo(calendar.body.equity.total, 2);
  expect(june.body.balanced).toBe(true);
});

test("posting into a closed period is refused, and reopening it unblocks", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  const period = await ClosePeriod.create({ orgId: org, periodMonth: "2026-04", status: "closed", closedAt: new Date() });

  const blocked = await postEntry(token, "2026-04-15", "Backdated into a closed month", [
    { account_id: cash, debit: 100 },
    { account_id: revenue, credit: 100 },
  ]);
  expect(blocked.status).toBe(409);
  expect(blocked.body.detail).toMatch(/2026-04 has been closed/);

  // A different, still-open month is unaffected.
  const allowed = await postEntry(token, "2026-05-15", "Open month", [
    { account_id: cash, debit: 100 },
    { account_id: revenue, credit: 100 },
  ]);
  expect(allowed.status).toBe(201);

  // Reopening makes it writable again -- this is a control, not a one-way door.
  period.status = "open";
  await period.save();
  const afterReopen = await postEntry(token, "2026-04-15", "Now allowed", [
    { account_id: cash, debit: 100 },
    { account_id: revenue, credit: 100 },
  ]);
  expect(afterReopen.status).toBe(201);
});

test("period locking is scoped per org -- one org's close doesn't block another's", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);

  await ClosePeriod.create({ orgId: orgA, periodMonth: "2026-04", status: "closed", closedAt: new Date() });

  const cashB = await accountId(tokenB, "Cash");
  const revenueB = await accountId(tokenB, "Uncategorized Revenue");
  const res = await postEntry(tokenB, "2026-04-15", "Org B is unaffected", [
    { account_id: cashB, debit: 100 },
    { account_id: revenueB, credit: 100 },
  ]);
  expect(res.status).toBe(201);
});

test("approving an invoice into a closed period still succeeds, but records why nothing was posted", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const { Invoice, AuditLog, JournalEntry } = await import("../src/models/index.js");

  // Close the month the auto-post would land in (auto-posting always
  // carries today's date).
  await ClosePeriod.create({ orgId: org, periodMonth: TODAY.slice(0, 7), status: "closed", closedAt: new Date() });

  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme",
    invoiceNumber: "INV-1",
    total: 500,
    overallConfidence: 0.95,
  });

  // Approval must not fail because the ledger refused the posting.
  const res = await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");

  // Nothing was posted...
  const entries = await JournalEntry.count({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });
  expect(entries).toBe(0);

  // ...but the gap is findable rather than silent.
  // Not raw: true -- Sequelize's JSON getter (which parses `details` back
  // into an object on SQLite) only runs on a model instance.
  const skipped = await AuditLog.findOne({ where: { orgId: org, action: "journal_posting_skipped" } });
  expect(skipped).toBeTruthy();
  expect(skipped.invoiceId).toBe(invoice.id);
  expect(skipped.details.reason).toMatch(/has been closed/);
});
