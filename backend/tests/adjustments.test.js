// Adjusting entries and year-end closing entries (recurringEntries.js,
// yearEndClose.js, routes/adjustments.js).
//
// Before this, closing a month locked the period and ticked a checklist
// but posted nothing -- so the "closed" books were missing the
// depreciation and accruals that a close exists to record. And Rekono
// derived retained earnings rather than posting closing entries, which is
// fine for the open year but leaves an org with no way to formally shut
// one.
//
// The riskiest thing here is that the two ways of getting retained
// earnings -- derived, and posted by a closing entry -- must not
// double-count. Several of these exist only to pin that.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, JournalEntry, RecurringEntry } from "../src/models/index.js";
import { addMonthsClamped, dueDates } from "../src/recurringEntries.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  return (await request(app).get(`/api/ledger/trial-balance${q}`).set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return tb.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function balanceSheet(token, asOf) {
  return (await request(app).get(`/api/statements/balance-sheet?as_of=${asOf}`).set(authHeader(token))).body;
}

async function pnl(token, from, to) {
  return (await request(app).get(`/api/statements/profit-and-loss?from=${from}&to=${to}`).set(authHeader(token))).body;
}

// Some real revenue and expense to close, posted by hand so the amounts
// are exact.
async function seedActivity(token, { year = 2026, revenue = 10000, expense = 4000 } = {}) {
  const cash = await accountId(token, "Cash");
  const rev = await accountId(token, "Uncategorized Revenue");
  const exp = await accountId(token, "Uncategorized Expense");
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: `${year}-06-30`, lines: [{ account_id: cash, debit: revenue }, { account_id: rev, credit: revenue }] });
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: `${year}-06-30`, lines: [{ account_id: exp, debit: expense }, { account_id: cash, credit: expense }] });
  return { cash, rev, exp };
}

async function makeTemplate(token, overrides = {}) {
  const exp = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");
  const res = await request(app)
    .post("/api/recurring-entries")
    .set(authHeader(token))
    .send({
      name: "Monthly rent accrual",
      frequency: "monthly",
      start_date: "2026-01-31",
      lines: [
        { account_id: exp, debit: 100 },
        { account_id: cash, credit: 100 },
      ],
      ...overrides,
    });
  return res;
}

// ---- Schedule arithmetic ----

test("a template starting on the 31st clamps to each month's last day", () => {
  // Rolling into the next month instead would land an adjusting entry in
  // the wrong period, which is the whole failure mode here.
  expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
  expect(addMonthsClamped("2026-01-31", 3)).toBe("2026-04-30");
  expect(addMonthsClamped("2024-01-31", 1)).toBe("2024-02-29");
  expect(addMonthsClamped("2026-01-15", 2)).toBe("2026-03-15");
});

test("due dates run from the start date and skip nothing already posted", () => {
  const monthly = { frequency: "monthly", startDate: "2026-01-31", endDate: null, lastPostedDate: null };
  expect(dueDates(monthly, "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);

  // A run that already covered February leaves March and April due.
  expect(dueDates({ ...monthly, lastPostedDate: "2026-02-28" }, "2026-04-30")).toEqual(["2026-03-31", "2026-04-30"]);

  const quarterly = { frequency: "quarterly", startDate: "2026-03-31", endDate: null, lastPostedDate: null };
  expect(dueDates(quarterly, "2026-12-31")).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
});

test("an end date stops the schedule", () => {
  const t = { frequency: "monthly", startDate: "2026-01-31", endDate: "2026-03-31", lastPostedDate: null };
  expect(dueDates(t, "2026-12-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
});

// ---- Recurring entries ----

test("a template posts one entry per due period, and catches up months nobody ran", async () => {
  const token = await signup(app, request);
  await makeTemplate(token);

  const preview = await request(app)
    .get("/api/recurring-entries/pending?as_of=2026-03-31")
    .set(authHeader(token));
  expect(preview.body.occurrences).toBe(3);
  expect(preview.body.items[0].amount_total).toBe(300);

  const run = await request(app)
    .post("/api/recurring-entries/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  expect(run.status).toBe(200);
  expect(run.body.posted).toHaveLength(3);
  expect(run.body.posted.map((p) => p.entry_date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);

  const tb = await trialBalance(token, "2026-03-31");
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(300);
  expect(tb.balanced).toBe(true);
});

test("running twice doesn't double-post", async () => {
  const token = await signup(app, request);
  await makeTemplate(token);
  await request(app).post("/api/recurring-entries/run").set(authHeader(token)).send({ as_of: "2026-03-31" });

  const second = await request(app)
    .post("/api/recurring-entries/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  expect(second.body.posted).toHaveLength(0);

  const tb = await trialBalance(token, "2026-03-31");
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(300);
});

test("a period the ledger refuses leaves the template still due for it", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTemplate(token);
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-02", status: "closed", closedAt: new Date() });

  const run = await request(app)
    .post("/api/recurring-entries/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  // January posts, February is refused, and March is not posted over the
  // gap -- books with January and March but no February are harder to
  // spot than a template that visibly stopped.
  expect(run.body.posted.map((p) => p.entry_date)).toEqual(["2026-01-31"]);
  expect(run.body.skipped).toHaveLength(1);
  expect(run.body.skipped[0].reason).toMatch(/2026-02 has been closed/);

  const template = await RecurringEntry.findOne({ where: { orgId: org } });
  expect(template.lastPostedDate).toBe("2026-01-31");
});

test("an unbalanced template is refused at creation, not silently every month", async () => {
  const token = await signup(app, request);
  const exp = await accountId(token, "Uncategorized Expense");
  const cash = await accountId(token, "Cash");

  const res = await request(app)
    .post("/api/recurring-entries")
    .set(authHeader(token))
    .send({
      name: "Broken",
      frequency: "monthly",
      start_date: "2026-01-31",
      lines: [
        { account_id: exp, debit: 100 },
        { account_id: cash, credit: 90 },
      ],
    });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/doesn't balance/i);
});

test("a deactivated template stops posting, and deleting one leaves its history alone", async () => {
  const token = await signup(app, request);
  const created = await makeTemplate(token);
  await request(app).post("/api/recurring-entries/run").set(authHeader(token)).send({ as_of: "2026-01-31" });

  await request(app).patch(`/api/recurring-entries/${created.body.id}`).set(authHeader(token)).send({ active: false });
  const run = await request(app)
    .post("/api/recurring-entries/run")
    .set(authHeader(token))
    .send({ as_of: "2026-03-31" });
  expect(run.body.posted).toHaveLength(0);

  await request(app).delete(`/api/recurring-entries/${created.body.id}`).set(authHeader(token));
  // Deleting stops future postings; it does not un-post history.
  const tb = await trialBalance(token, "2026-03-31");
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(100);
  expect(tb.balanced).toBe(true);
});

test("the depreciation helper works out the monthly amount and stops at the asset's life", async () => {
  const token = await signup(app, request);
  const exp = await accountId(token, "Uncategorized Expense");
  const asset = await accountId(token, "Uncategorized Asset");

  const res = await request(app)
    .post("/api/recurring-entries/depreciation")
    .set(authHeader(token))
    .send({
      name: "Delivery van",
      cost: 30000,
      salvage_value: 6000,
      useful_life_months: 48,
      start_date: "2026-01-31",
      expense_account_id: exp,
      accumulated_depreciation_account_id: asset,
    });
  expect(res.status).toBe(201);
  // (30000 - 6000) / 48
  expect(res.body.monthly_amount).toBe(500);
  // Ends on its own rather than depreciating past cost forever.
  expect(res.body.end_date).toBe("2029-12-31");
});

// ---- Year-end closing entries ----

test("closing a year zeroes revenue and expense into retained earnings", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });

  const preview = await request(app).get("/api/close/year-end?date=2026-06-30").set(authHeader(token));
  expect(preview.body.fiscal_year.label).toBe("FY2026");
  expect(preview.body.net_income).toBe(6000);
  expect(preview.body.already_closed).toBe(false);

  const closed = await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });
  expect(closed.status).toBe(200);

  const tb = await trialBalance(token, "2026-12-31");
  // The P&L accounts stand at zero on the books.
  const rev = accountRow(tb, "Uncategorized Revenue");
  const exp = accountRow(tb, "Uncategorized Expense");
  expect(rev.credit - rev.debit).toBe(0);
  expect(exp.debit - exp.credit).toBe(0);
  // ...and the year's earnings are now a real account balance.
  const retained = accountRow(tb, "Retained Earnings");
  expect(retained.credit - retained.debit).toBe(6000);
  expect(tb.balanced).toBe(true);
});

test("closing does not double-count earnings on the balance sheet", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });

  // This is the one that matters. Rekono derives retained earnings from
  // cumulative revenue minus expenses; a closing entry also credits a
  // Retained Earnings *account*. If both counted, equity would be 12000
  // instead of 6000.
  const before = await balanceSheet(token, "2027-06-30");
  expect(before.equity.total).toBe(6000);

  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const after = await balanceSheet(token, "2027-06-30");
  expect(after.equity.total).toBe(6000);
  expect(after.balanced).toBe(true);
  // The earnings moved from the derived half of equity to the posted half.
  expect(after.equity.retained_earnings).toBe(0);
  expect(after.equity.accounts.find((a) => a.name === "Retained Earnings").amount).toBe(6000);
});

test("a closed year's P&L still reports its revenue", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  // The closing entry debits every revenue account to zero. A P&L that
  // counted it would report nothing for the year -- the report going blank
  // precisely because the books were closed properly.
  const year = await pnl(token, "2026-01-01", "2026-12-31");
  expect(year.revenue.total).toBe(10000);
  expect(year.expenses.total).toBe(4000);
  expect(year.net_income).toBe(6000);
});

test("closing twice is refused", async () => {
  const token = await signup(app, request);
  await seedActivity(token);
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const again = await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });
  expect(again.status).toBe(409);
  expect(again.body.detail).toMatch(/already been closed/i);

  const tb = await trialBalance(token, "2026-12-31");
  expect(tb.balanced).toBe(true);
});

test("reopening a year puts the balances back", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const reopened = await request(app)
    .post("/api/close/year-end/reopen")
    .set(authHeader(token))
    .send({ date: "2026-06-30" });
  expect(reopened.status).toBe(200);

  // Closing is the posting most likely to be done too early -- a late
  // adjusting entry arrives and the year has to be reopened to take it.
  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Uncategorized Revenue").credit - accountRow(tb, "Uncategorized Revenue").debit).toBe(10000);
  expect(accountRow(tb, "Retained Earnings").credit - accountRow(tb, "Retained Earnings").debit).toBe(0);
  expect(tb.balanced).toBe(true);

  const sheet = await balanceSheet(token, "2027-06-30");
  expect(sheet.equity.total).toBe(6000);
  expect(sheet.balanced).toBe(true);
});

test("a year with nothing in it can't be closed", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/no revenue or expense activity/i);
});

test("a loss year debits retained earnings", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 3000, expense: 8000 });
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const tb = await trialBalance(token, "2026-12-31");
  const retained = accountRow(tb, "Retained Earnings");
  expect(retained.debit - retained.credit).toBe(5000);
  expect(tb.balanced).toBe(true);

  const sheet = await balanceSheet(token, "2027-06-30");
  expect(sheet.equity.total).toBe(-5000);
  expect(sheet.balanced).toBe(true);
});

test("closing only touches the fiscal year asked for", async () => {
  const token = await signup(app, request);
  await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });
  await seedActivity(token, { year: 2027, revenue: 7000, expense: 2000 });

  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const tb = await trialBalance(token, "2027-12-31");
  // FY2026 closed out; FY2027 still open and carrying its own balances.
  expect(accountRow(tb, "Retained Earnings").credit - accountRow(tb, "Retained Earnings").debit).toBe(6000);
  const rev = accountRow(tb, "Uncategorized Revenue");
  expect(rev.credit - rev.debit).toBe(7000);
  expect(tb.balanced).toBe(true);
});

test("recurring entries and closing entries are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const created = await makeTemplate(tokenA);
  await seedActivity(tokenA);

  expect((await request(app).get("/api/recurring-entries").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect(
    (await request(app).patch(`/api/recurring-entries/${created.body.id}`).set(authHeader(tokenB)).send({ active: false }))
      .status
  ).toBe(404);

  // B running either job must not touch A's books.
  await request(app).post("/api/recurring-entries/run").set(authHeader(tokenB)).send({ as_of: "2026-03-31" });
  await request(app).post("/api/close/year-end").set(authHeader(tokenB)).send({ date: "2026-06-30" });
  const tbA = await trialBalance(tokenA, "2026-12-31");
  expect(accountRow(tbA, "Retained Earnings").credit).toBe(0);
  expect(await JournalEntry.count({ where: { orgId: await orgId(tokenB) } })).toBe(0);
});

test("a closed year that picks up later activity is flagged rather than silently stale", async () => {
  const token = await signup(app, request);
  const { cash, exp } = await seedActivity(token, { year: 2026, revenue: 10000, expense: 4000 });
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  // A late adjusting entry lands in the year after it was closed. Nothing
  // stops this -- period locking is a separate mechanism -- so the closing
  // entry is now incomplete.
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-09-30", lines: [{ account_id: exp, debit: 1000 }, { account_id: cash, credit: 1000 }] });

  const preview = await request(app).get("/api/close/year-end?date=2026-06-30").set(authHeader(token));
  expect(preview.body.already_closed).toBe(true);
  expect(preview.body.needs_reclose).toBe(true);
  expect(preview.body.unclosed_since_close).toBe(-1000);

  // The totals stay right regardless -- the balance sheet derives whatever
  // the closing entry didn't capture. That's the property that makes this
  // a reporting wrinkle rather than a corruption.
  const sheet = await balanceSheet(token, "2027-06-30");
  expect(sheet.equity.total).toBe(5000);
  expect(sheet.balanced).toBe(true);
});
