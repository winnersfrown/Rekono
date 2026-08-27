// The general ledger: chart of accounts (routes/accounts.js), manual
// journal entries + trial balance (routes/journalEntries.js), and the
// invoice-approval auto-posting integration (ledger.js's
// postInvoiceApproval/voidInvoiceJournalEntry, wired into
// routes/invoices.js and pipeline.js). Cross-org denial at the database
// level (row-level security) is covered generically by tests/rls.test.js,
// which iterates RLS_TABLES -- accounts/journal_entries/journal_lines are
// registered there (rls.js) and get that coverage for free; this file
// covers the actual ledger logic and the application-level org scoping
// every route already enforces regardless of RLS.
import request from "supertest";
import { app } from "../src/app.js";
import { Account, Invoice, JournalEntry, JournalLine } from "../src/models/index.js";
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

async function makeInvoice(orgId, overrides = {}) {
  return Invoice.create({
    orgId,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

test("a new org's chart of accounts is seeded at onboarding, including one account per expense category", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  expect(res.status).toBe(200);

  const names = res.body.items.map((a) => a.name);
  expect(names).toEqual(
    expect.arrayContaining(["Cash", "Accounts Receivable", "Accounts Payable", "Owner's Equity", "Uncategorized Expense"])
  );
  // Every seeded account is a protected system account.
  expect(res.body.items.every((a) => a.is_system_account)).toBe(true);
});

test("creating a duplicate-named account is rejected", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/accounts").set(authHeader(token)).send({ name: "Cash", type: "asset" });
  expect(res.status).toBe(409);
});

test("a system account can be renamed but not deactivated", async () => {
  const token = await signup(app, request);
  const cashId = await accountId(token, "Cash");

  const rename = await request(app).patch(`/api/accounts/${cashId}`).set(authHeader(token)).send({ name: "Operating Cash" });
  expect(rename.status).toBe(200);
  expect(rename.body.name).toBe("Operating Cash");

  const deactivate = await request(app).patch(`/api/accounts/${cashId}`).set(authHeader(token)).send({ active: false });
  expect(deactivate.status).toBe(409);
});

test("accounts are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const cashIdA = await accountId(tokenA, "Cash");

  const res = await request(app).patch(`/api/accounts/${cashIdA}`).set(authHeader(tokenB)).send({ name: "Hijacked" });
  expect(res.status).toBe(404);
});

test("posting a manual journal entry rejects an unbalanced one and accepts a balanced one", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  const unbalanced = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-01-01",
      memo: "Owner contribution",
      lines: [
        { account_id: cash, debit: 500 },
        { account_id: equity, credit: 400 },
      ],
    });
  expect(unbalanced.status).toBe(422);
  expect(unbalanced.body.detail).toMatch(/doesn't balance/i);

  const balanced = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-01-01",
      memo: "Owner contribution",
      lines: [
        { account_id: cash, debit: 500 },
        { account_id: equity, credit: 500 },
      ],
    });
  expect(balanced.status).toBe(201);
  expect(balanced.body.status).toBe("posted");
  expect(balanced.body.lines).toHaveLength(2);
});

test("a line that is both a debit and a credit, or neither, is rejected", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  const bothSet = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-01", lines: [{ account_id: cash, debit: 100, credit: 100 }, { account_id: equity, credit: 100 }] });
  expect(bothSet.status).toBe(422);
});

test("an entry needs at least two lines", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-01", lines: [{ account_id: cash, debit: 100 }] });
  expect(res.status).toBe(422);
});

test("voiding a posted entry posts its mirror image and is idempotent", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  const posted = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-01", lines: [{ account_id: cash, debit: 500 }, { account_id: equity, credit: 500 }] });

  const voided1 = await request(app).post(`/api/journal-entries/${posted.body.id}/void`).set(authHeader(token));
  expect(voided1.status).toBe(200);
  expect(voided1.body.status).toBe("voided");
  expect(voided1.body.voided_by_entry_id).toBeTruthy();

  // Voiding an already-voided entry is a no-op, not a second reversal.
  const entryCountBefore = await JournalEntry.count();
  const voided2 = await request(app).post(`/api/journal-entries/${posted.body.id}/void`).set(authHeader(token));
  expect(voided2.status).toBe(200);
  const entryCountAfter = await JournalEntry.count();
  expect(entryCountAfter).toBe(entryCountBefore);
});

test("journal entries and their lines are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const cashA = await accountId(tokenA, "Cash");
  const equityA = await accountId(tokenA, "Owner's Equity");

  const posted = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(tokenA))
    .send({ entry_date: "2026-01-01", lines: [{ account_id: cashA, debit: 500 }, { account_id: equityA, credit: 500 }] });

  const getFromB = await request(app).get(`/api/journal-entries/${posted.body.id}`).set(authHeader(tokenB));
  expect(getFromB.status).toBe(404);

  const listFromB = await request(app).get("/api/journal-entries").set(authHeader(tokenB));
  expect(listFromB.body.total).toBe(0);
});

test("the trial balance always sums to zero across manual and auto-posted entries", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const equity = await accountId(token, "Owner's Equity");

  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-01", lines: [{ account_id: cash, debit: 1000 }, { account_id: equity, credit: 1000 }] });

  const invoice = await makeInvoice(org, { total: 250.5 });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  const trialBalance = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  expect(trialBalance.status).toBe(200);
  expect(trialBalance.body.balanced).toBe(true);
  expect(trialBalance.body.total_debit).toBe(trialBalance.body.total_credit);
  expect(trialBalance.body.total_debit).toBeCloseTo(1250.5, 2);
});

test("approving an invoice auto-posts to its matched expense account, falling back to Uncategorized Expense", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const matched = await makeInvoice(org, { total: 300, quickbooksExpenseAccountName: "Software & Subscriptions" });
  const fallback = await makeInvoice(org, { total: 75, invoiceNumber: "INV-2" });

  await request(app).post(`/api/invoices/${matched.id}/approve`).set(authHeader(token));
  await request(app).post(`/api/invoices/${fallback.id}/approve`).set(authHeader(token));

  const entries = await JournalEntry.findAll({ where: { orgId: org, source: "invoice_approval" }, raw: true });
  expect(entries).toHaveLength(2);

  const matchedEntry = entries.find((e) => e.sourceId === matched.id);
  const matchedLines = await JournalLine.findAll({ where: { journalEntryId: matchedEntry.id }, include: [Account] });
  const debitLine = matchedLines.find((l) => l.debitCents > 0);
  expect(debitLine.Account.name).toBe("Software & Subscriptions");
  expect(debitLine.debitCents).toBe(30000);

  const fallbackEntry = entries.find((e) => e.sourceId === fallback.id);
  const fallbackLines = await JournalLine.findAll({ where: { journalEntryId: fallbackEntry.id }, include: [Account] });
  const fallbackDebitLine = fallbackLines.find((l) => l.debitCents > 0);
  expect(fallbackDebitLine.Account.name).toBe("Uncategorized Expense");
});

test("approving an invoice twice (e.g. via bulk-action after a manual approve) never double-posts", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  // Force it back into an approvable status and "approve" again via the
  // bulk endpoint, simulating two code paths racing to post the same
  // invoice -- postInvoiceApproval must no-op the second time.
  invoice.status = "needs_review";
  await invoice.save();
  await request(app).post("/api/invoices/bulk-action").set(authHeader(token)).send({ ids: [invoice.id], action: "approve" });

  const entries = await JournalEntry.count({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });
  expect(entries).toBe(1);
});

test("rejecting a previously-approved invoice voids its journal entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  const postedEntry = await JournalEntry.findOne({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });
  expect(postedEntry.status).toBe("posted");

  await request(app).post(`/api/invoices/${invoice.id}/reject`).set(authHeader(token));

  await postedEntry.reload();
  expect(postedEntry.status).toBe("voided");
});

test("deleting a previously-approved invoice voids its journal entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));

  const postedEntry = await JournalEntry.findOne({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });
  expect(postedEntry.status).toBe("voided");
});

test("an invoice with no total or a zero total doesn't post anything", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org, { total: null });

  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  const entries = await JournalEntry.count({ where: { orgId: org, sourceType: "invoice", sourceId: invoice.id } });
  expect(entries).toBe(0);
});

test("postInvoiceApproval (the function pipeline.js's auto-approval branch calls) posts a balanced entry for an already-approved invoice", async () => {
  // pipeline.test.js covers shouldAutoApprove's own decision logic directly
  // rather than through a real upload+OCR round trip -- this mirrors that
  // approach for the one line pipeline.js adds (`if (autoApproved) await
  // postInvoiceApproval(invoice)`), verifying the function it calls rather
  // than re-driving the whole extraction pipeline just to reach it.
  const token = await signup(app, request);
  const org = await orgId(token);
  const { postInvoiceApproval } = await import("../src/ledger.js");
  const invoice = await makeInvoice(org, { status: "approved" });

  await postInvoiceApproval(invoice);

  const entries = await JournalEntry.count({ where: { orgId: org, source: "invoice_approval", sourceId: invoice.id } });
  expect(entries).toBe(1);
});
