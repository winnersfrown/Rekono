// Recurring vendor bills (recurringBills.js, routes/payables.js's
// /api/recurring-bills endpoints) -- the AP mirror of recurringInvoices.js,
// for rent, subscriptions, and retainers that recur on a fixed schedule
// without someone re-keying a bill into the Review Queue every period.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, ClosePeriod, Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

// postInvoiceApproval (ledger.js) never takes an entryDate -- unlike
// postCustomerInvoice on the AR side, every bill approval posts dated to
// whenever the approval actually ran, not the bill's own date. A recurring
// template can create an occurrence dated for a past period, but the
// journal entry it posts (when autoApprove is on) still lands today, and a
// closed-period refusal only bites if *today's* period is the one that's
// closed. Same convention tests/payables.test.js uses for the same reason.
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_MONTH = TODAY.slice(0, 7);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token, asOf) {
  return (await request(app).get(`/api/ledger/trial-balance?as_of=${asOf}`).set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return tb.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function makeTemplate(token, overrides = {}) {
  const expenseAccountId = overrides.expense_account_id || (await accountId(token, "Uncategorized Expense"));
  const res = await request(app)
    .post("/api/recurring-bills")
    .set(authHeader(token))
    .send({
      vendor_name: "Meridian Property Partners",
      name: "Monthly rent",
      frequency: "monthly",
      start_date: "2026-01-31",
      amount: 1000,
      ...overrides,
      expense_account_id: expenseAccountId,
    });
  return res;
}

test("a template issues a needs_review bill per due period, and catches up months nobody ran", async () => {
  const token = await signup(app, request);
  await makeTemplate(token);

  const preview = await request(app).get("/api/recurring-bills/pending?as_of=2026-03-31").set(authHeader(token));
  expect(preview.body.occurrences).toBe(3);
  expect(preview.body.items[0].amount_total).toBe(3000);

  const run = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-03-31" });
  expect(run.status).toBe(200);
  expect(run.body.issued).toHaveLength(3);
  expect(run.body.issued.every((i) => i.approved === false)).toBe(true);
  expect(run.body.issued.map((i) => i.issue_date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);

  const invoices = await request(app).get("/api/invoices?status=needs_review").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(3);
  expect(invoices.body.items.every((i) => i.vendor_name === "Meridian Property Partners")).toBe(true);

  // Nothing approved, so nothing has hit the books yet.
  const tb = await trialBalance(token, "2026-03-31");
  expect(accountRow(tb, "Accounts Payable").credit).toBe(0);
});

test("running twice doesn't double-issue", async () => {
  const token = await signup(app, request);
  await makeTemplate(token);
  await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-03-31" });

  const second = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-03-31" });
  expect(second.body.issued).toHaveLength(0);

  const invoices = await request(app).get("/api/invoices?status=needs_review").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(3);
});

test("auto-approve posts each occurrence to the books immediately", async () => {
  const token = await signup(app, request);
  const created = await makeTemplate(token, { auto_approve: true });
  expect(created.body.auto_approve).toBe(true);

  const run = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-01-31" });
  expect(run.body.issued).toHaveLength(1);
  expect(run.body.issued[0].approved).toBe(true);

  const invoices = await request(app).get("/api/invoices?status=approved").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(1);

  // Dated to today, not the bill's own (past) period -- see the TODAY
  // comment above.
  const tb = await trialBalance(token, TODAY);
  expect(accountRow(tb, "Accounts Payable").credit).toBe(1000);
  expect(accountRow(tb, "Uncategorized Expense").debit).toBe(1000);
  expect(tb.balanced).toBe(true);

  // Aging counts approved bills by due date regardless of when the journal
  // entry posted, so this ties out even though the entry itself is dated
  // today rather than the bill's own period.
  const aging = await request(app).get("/api/reports/ap-aging?as_of=2026-01-31").set(authHeader(token));
  expect(aging.body.totals.total).toBe(1000);
});

test("a period the ledger refuses to post into still creates the bill, just unapproved", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTemplate(token, { auto_approve: true });
  // Closes *today's* period, since that's what the approval posting is
  // actually dated to -- see the TODAY comment above.
  await ClosePeriod.create({ orgId: org, periodMonth: TODAY_MONTH, status: "closed", closedAt: new Date() });

  const run = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-01-31" });
  expect(run.body.issued).toHaveLength(1);
  expect(run.body.issued[0].approved).toBe(false);

  // The bill exists (as approved -- postInvoiceApproval degraded, it didn't
  // block the status change) and the template isn't stuck retrying January.
  const invoice = await Invoice.findOne({ where: { orgId: org } });
  expect(invoice.status).toBe("approved");
  const templates = await request(app).get("/api/recurring-bills").set(authHeader(token));
  expect(templates.body.items[0].last_issued_date).toBe("2026-01-31");

  // postInvoiceApproval degrades silently rather than throwing -- it
  // records the skip on the audit log instead of surfacing it to the
  // caller, same as a manual approval into a closed period would.
  const skip = await AuditLog.findOne({ where: { orgId: org, invoiceId: invoice.id, action: "journal_posting_skipped" } });
  expect(skip.details.reason).toMatch(new RegExp(`${TODAY_MONTH} has been closed`));
});

test("auto-approve can be turned on for an existing template", async () => {
  const token = await signup(app, request);
  const created = await makeTemplate(token);
  expect(created.body.auto_approve).toBe(false);

  const patched = await request(app)
    .patch(`/api/recurring-bills/${created.body.id}`)
    .set(authHeader(token))
    .send({ auto_approve: true });
  expect(patched.body.auto_approve).toBe(true);

  const run = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-01-31" });
  expect(run.body.issued[0].approved).toBe(true);
});

test("a deactivated template stops issuing, and deleting one leaves its history alone", async () => {
  const token = await signup(app, request);
  const created = await makeTemplate(token);
  await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-01-31" });

  await request(app).patch(`/api/recurring-bills/${created.body.id}`).set(authHeader(token)).send({ active: false });
  const run = await request(app).post("/api/recurring-bills/run").set(authHeader(token)).send({ as_of: "2026-03-31" });
  expect(run.body.issued).toHaveLength(0);

  await request(app).delete(`/api/recurring-bills/${created.body.id}`).set(authHeader(token));
  const invoices = await request(app).get("/api/invoices?status=needs_review").set(authHeader(token));
  expect(invoices.body.items).toHaveLength(1);

  const templates = await request(app).get("/api/recurring-bills").set(authHeader(token));
  expect(templates.body.items).toHaveLength(0);
});

test("a template must post to an expense account the org owns", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  const res = await makeTemplate(token, { name: "Bad template", expense_account_id: cash });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/expense account/i);
});

test("an end date can't be before the start date", async () => {
  const token = await signup(app, request);
  const res = await makeTemplate(token, { start_date: "2026-06-30", end_date: "2026-01-01" });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/can't end before it starts/);
});

test("recurring bills are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const created = await makeTemplate(tokenA);

  expect((await request(app).get("/api/recurring-bills").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect(
    (await request(app).patch(`/api/recurring-bills/${created.body.id}`).set(authHeader(tokenB)).send({ active: false })).status
  ).toBe(404);

  await request(app).post("/api/recurring-bills/run").set(authHeader(tokenB)).send({ as_of: "2026-03-31" });
  expect(await Invoice.count({ where: { orgId: await orgId(tokenB) } })).toBe(0);
});
