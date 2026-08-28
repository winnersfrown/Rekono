// Revenue recognition (revenueRecognition.js, routes/revenue.js).
//
// Sending an annual invoice in January used to credit twelve months of
// revenue into January -- a P&L spike that didn't happen and eleven dead
// months, neither of which is a number you could hand an investor. A line
// with a service period now credits Deferred Revenue instead, and releases
// month by month as it's earned.
//
// Most of these assert against the trial balance and the P&L rather than
// the schedule's own endpoints: revenue recognized in the wrong period is
// exactly the bug that looks fine in its own API.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, RevenueScheduleEntry } from "../src/models/index.js";
import { buildSchedule } from "../src/revenueRecognition.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeCustomer(token) {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ name: "Globex Corp" });
  return res.body;
}

// An invoice with one line, optionally carrying a service period.
async function makeInvoice(token, customerId, { amount = 1200, issueDate = "2026-01-01", service = null } = {}) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const line = {
    revenue_account_id: revenue,
    description: "Annual subscription",
    quantity: 1,
    unit_price: amount,
    ...(service ? { service_start_date: service[0], service_end_date: service[1] } : {}),
  };
  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({ customer_id: customerId, issue_date: issueDate, lines: [line] });
  if (res.status !== 201) throw new Error(`makeInvoice failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function send(token, invoiceId) {
  return request(app).post(`/api/customer-invoices/${invoiceId}/send`).set(authHeader(token));
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

// ---- The schedule split, unit-tested directly ----

test("a clean calendar year splits into twelve months summing to the total", () => {
  const schedule = buildSchedule(120000, "2026-01-01", "2026-12-31");
  expect(schedule).toHaveLength(12);
  expect(schedule.reduce((s, m) => s + m.amountCents, 0)).toBe(120000);
  expect(schedule[0].period_month || schedule[0].periodMonth).toBe("2026-01");
  expect(schedule[11].periodMonth).toBe("2026-12");
});

test("a mid-month term prorates by days rather than pretending each month is equal", () => {
  // Jan 15 2026 - Jan 14 2027 is 365 days: 17 of January 2026 and 14 of
  // January 2027. Calling both "one month" would overstate the first
  // period and understate the last.
  const schedule = buildSchedule(365000, "2026-01-15", "2027-01-14");
  expect(schedule).toHaveLength(13);
  expect(schedule[0].periodMonth).toBe("2026-01");
  expect(schedule[0].days).toBe(17);
  expect(schedule[12].periodMonth).toBe("2027-01");
  expect(schedule[12].days).toBe(14);
  // $1000/day at exactly 365 days.
  expect(schedule[0].amountCents).toBe(17000);
  expect(schedule.reduce((s, m) => s + m.amountCents, 0)).toBe(365000);
});

test("rounding remainder lands on the final month so nothing is stranded", () => {
  // $100 over 3 months divides to 3333.33 cents -- rounding each month
  // independently would leave a cent that never clears out of deferred
  // revenue and that nobody can explain a year later.
  const schedule = buildSchedule(10000, "2026-01-01", "2026-03-31");
  expect(schedule.reduce((s, m) => s + m.amountCents, 0)).toBe(10000);

  // A deliberately awkward one: a prime amount over a leap year.
  const awkward = buildSchedule(99991, "2024-01-01", "2024-12-31");
  expect(awkward.reduce((s, m) => s + m.amountCents, 0)).toBe(99991);
  expect(awkward).toHaveLength(12);
});

test("a service period inside one month is a single entry", () => {
  const schedule = buildSchedule(50000, "2026-03-05", "2026-03-20");
  expect(schedule).toHaveLength(1);
  expect(schedule[0]).toMatchObject({ periodMonth: "2026-03", amountCents: 50000 });
});

test("a leap February gets its 29th day", () => {
  const schedule = buildSchedule(100000, "2024-02-01", "2024-02-29");
  expect(schedule).toHaveLength(1);
  expect(schedule[0].days).toBe(29);
});

// ---- Posting behaviour ----

test("a line with no service period still credits revenue directly", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, { amount: 500 });
  await send(token, invoice.id);

  // Point-in-time delivery is earned when billed -- unchanged from before
  // this release.
  const tb = await trialBalance(token);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(500);
  expect(accountRow(tb, "Deferred Revenue").credit).toBe(0);
  expect(await RevenueScheduleEntry.count()).toBe(0);
});

test("an annual invoice credits deferred revenue, not twelve months of income", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(1200);
  expect(accountRow(tb, "Deferred Revenue").credit).toBe(1200);
  // The whole point: nothing has been earned yet.
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(0);
  expect(tb.balanced).toBe(true);

  // And January's P&L shows no revenue spike.
  const january = await pnl(token, "2026-01-01", "2026-01-31");
  expect(january.revenue.total).toBe(0);
});

test("recognizing a month moves exactly that month out of deferred revenue", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);

  const res = await request(app)
    .post("/api/revenue/recognize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(res.status).toBe(200);
  // 31 of 365 days at $1200.
  expect(res.body.recognized).toBeCloseTo(101.92, 2);

  const tb = await trialBalance(token);
  const deferred = accountRow(tb, "Deferred Revenue");
  expect(deferred.credit - deferred.debit).toBeCloseTo(1098.08, 2);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBeCloseTo(101.92, 2);
  expect(tb.balanced).toBe(true);
});

test("recognition posts into the month it recognizes, not the day it was run", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2026-02" });

  // February's revenue has to land in February's P&L. Dating the entry to
  // whatever day someone happened to run the job would smear a
  // subscription's revenue across whichever months the operator was at
  // their desk.
  const february = await pnl(token, "2026-02-01", "2026-02-28");
  expect(february.revenue.total).toBeGreaterThan(0);
  const march = await pnl(token, "2026-03-01", "2026-03-31");
  expect(march.revenue.total).toBe(0);
});

test("running a later month catches up every period nobody ran", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);

  // Nobody ran January or February. March shouldn't leave them stranded in
  // deferred revenue forever.
  const res = await request(app)
    .post("/api/revenue/recognize")
    .set(authHeader(token))
    .send({ period_month: "2026-03" });
  expect(res.body.periods.map((p) => p.period_month)).toEqual(["2026-01", "2026-02", "2026-03"]);

  // One journal entry per month, so each period stays its own reviewable
  // document rather than a lump dated March.
  const entries = await request(app).get("/api/journal-entries").set(authHeader(token));
  const recognitionEntries = entries.body.items.filter((e) => e.source === "revenue_recognition");
  expect(recognitionEntries).toHaveLength(3);
});

test("recognizing twice doesn't double-post", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2026-01" });

  const second = await request(app)
    .post("/api/revenue/recognize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(second.body.recognized).toBe(0);

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBeCloseTo(101.92, 2);
  expect(tb.balanced).toBe(true);
});

test("recognizing the whole term clears deferred revenue to exactly zero", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  // An amount that doesn't divide cleanly, to catch a stranded cent.
  const invoice = await makeInvoice(token, customer.id, {
    amount: 999.91,
    issueDate: "2026-01-01",
    service: ["2026-01-15", "2027-01-14"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2027-01" });

  const tb = await trialBalance(token);
  const deferred = accountRow(tb, "Deferred Revenue");
  // The liability has to land on zero, not "about zero" -- a residue here
  // is a balance nobody can ever explain or clear.
  expect(deferred.credit - deferred.debit).toBe(0);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(999.91);
  expect(tb.balanced).toBe(true);
});

test("recognition into a closed period is refused, and the month stays pending", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-01", status: "closed", closedAt: new Date() });

  const res = await request(app)
    .post("/api/revenue/recognize")
    .set(authHeader(token))
    .send({ period_month: "2026-01" });
  expect(res.status).toBe(409);

  // Marked only after a successful posting -- otherwise the month would
  // read as recognized against an entry that never posted.
  expect(await RevenueScheduleEntry.count({ where: { orgId: org, recognizedAt: null } })).toBeGreaterThan(0);
  const tb = await trialBalance(token);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(0);
});

test("the waterfall shows what's left and when it releases", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2026-02" });

  const res = await request(app).get("/api/reports/deferred-revenue").set(authHeader(token));
  expect(res.status).toBe(200);
  // Ten months left after January and February released.
  expect(res.body.periods).toHaveLength(10);
  expect(res.body.periods[0].period_month).toBe("2026-03");

  // And it ties to the ledger's deferred revenue balance.
  const tb = await trialBalance(token);
  const deferred = accountRow(tb, "Deferred Revenue");
  expect(res.body.total_deferred).toBeCloseTo(deferred.credit - deferred.debit, 2);
});

test("voiding an invoice drops unearned months but keeps recognized ones", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    issueDate: "2026-01-01",
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2026-01" });

  await request(app).post(`/api/customer-invoices/${invoice.id}/void`).set(authHeader(token));

  // January was really earned and its entry stands; the other eleven
  // months were never earned and simply stop being planned.
  expect(await RevenueScheduleEntry.count({ where: { orgId: org, recognizedAt: null } })).toBe(0);
  expect(await RevenueScheduleEntry.count({ where: { orgId: org } })).toBe(1);

  const tb = await trialBalance(token);
  expect(tb.balanced).toBe(true);
});

test("a half-specified service period is refused rather than guessed at", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      lines: [{ revenue_account_id: revenue, quantity: 1, unit_price: 100, service_start_date: "2026-01-01" }],
    });
  expect(res.status).toBe(422);

  const backwards = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      lines: [
        {
          revenue_account_id: revenue,
          quantity: 1,
          unit_price: 100,
          service_start_date: "2026-12-31",
          service_end_date: "2026-01-01",
        },
      ],
    });
  expect(backwards.status).toBe(422);
});

test("a draft carries no schedule until it's sent", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    service: ["2026-01-01", "2026-12-31"],
  });

  // Consistent with a draft posting nothing at all.
  expect(await RevenueScheduleEntry.count()).toBe(0);
  await send(token, invoice.id);
  expect(await RevenueScheduleEntry.count()).toBe(12);
});

test("an invoice's own schedule shows recognized and pending months", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id, {
    amount: 1200,
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(token, invoice.id);
  await request(app).post("/api/revenue/recognize").set(authHeader(token)).send({ period_month: "2026-01" });

  const res = await request(app)
    .get(`/api/customer-invoices/${invoice.id}/revenue-schedule`)
    .set(authHeader(token));
  expect(res.body.total_scheduled).toBe(1200);
  expect(res.body.recognized).toBeCloseTo(101.92, 2);
  expect(res.body.deferred).toBeCloseTo(1098.08, 2);
  expect(res.body.entries.filter((e) => e.recognized)).toHaveLength(1);
});

test("revenue schedules are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const customerA = await makeCustomer(tokenA);
  const invoiceA = await makeInvoice(tokenA, customerA.id, {
    amount: 1200,
    service: ["2026-01-01", "2026-12-31"],
  });
  await send(tokenA, invoiceA.id);

  expect((await request(app).get("/api/revenue/schedule").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect((await request(app).get("/api/reports/deferred-revenue").set(authHeader(tokenB))).body.total_deferred).toBe(0);
  expect(
    (await request(app).get(`/api/customer-invoices/${invoiceA.id}/revenue-schedule`).set(authHeader(tokenB))).status
  ).toBe(404);

  // ...and B running recognition must not touch A's deferred revenue.
  await request(app).post("/api/revenue/recognize").set(authHeader(tokenB)).send({ period_month: "2026-12" });
  const tbA = await trialBalance(tokenA);
  expect(accountRow(tbA, "Uncategorized Revenue").credit).toBe(0);
});

test("a mixed invoice defers only the line that has a service period", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  const created = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      lines: [
        { revenue_account_id: revenue, description: "Setup fee", quantity: 1, unit_price: 500 },
        {
          revenue_account_id: revenue,
          description: "Annual subscription",
          quantity: 1,
          unit_price: 1200,
          service_start_date: "2026-01-01",
          service_end_date: "2026-12-31",
        },
      ],
    });
  await send(token, created.body.id);

  // A one-off setup fee is earned on delivery; the subscription isn't.
  // Mixing them on one invoice is normal and each line has to be treated
  // on its own terms.
  const tb = await trialBalance(token);
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(1700);
  expect(accountRow(tb, "Uncategorized Revenue").credit).toBe(500);
  expect(accountRow(tb, "Deferred Revenue").credit).toBe(1200);
  expect(tb.balanced).toBe(true);
});
