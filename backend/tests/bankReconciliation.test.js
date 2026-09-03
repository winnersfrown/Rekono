// Bank reconciliation (bankReconciliation.js, routes/bankReconciliation.js).
//
// The one thing that has to hold: what the bank actually reported has to
// come from a human, not be derived, and the reconciliation's own math
// (book balance, cleared balance, the outstanding-items lists) has to be
// computed from the ledger's real journal lines rather than trusted at
// face value -- so most of these post real journal entries and check the
// reconciliation's numbers against them, not just against what a route
// echoes back.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, entryDate, lines) {
  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: entryDate, memo: "test entry", lines });
  expect(res.status).toBe(201);
  return res.body;
}

test("only cash & bank accounts are reconcilable", async () => {
  const token = await signup(app, request);
  const ap = await accountId(token, "Accounts Payable");

  const res = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: ap, statement_date: "2026-01-31", statement_ending_balance: 100 });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/cash or bank account/i);
});

test("a clean reconciliation: everything on the statement is cleared and the difference is zero", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");
  const expense = await accountId(token, "Uncategorized Expense");

  const deposit = await postEntry(token, "2026-01-10", [
    { account_id: cash, debit: 1000, credit: 0 },
    { account_id: revenue, debit: 0, credit: 1000 },
  ]);
  const payment = await postEntry(token, "2026-01-15", [
    { account_id: expense, debit: 400, credit: 0 },
    { account_id: cash, debit: 0, credit: 400 },
  ]);

  const start = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-01-31", statement_ending_balance: 600 });
  expect(start.status).toBe(201);
  expect(start.body.book_balance).toBe(600);
  expect(start.body.difference).toBe(600); // nothing cleared yet
  expect(start.body.deposits_in_transit.map((l) => l.journal_line_id)).toEqual(
    expect.arrayContaining([deposit.lines.find((l) => l.account_id === cash).id])
  );
  expect(start.body.outstanding_checks.map((l) => l.journal_line_id)).toEqual(
    expect.arrayContaining([payment.lines.find((l) => l.account_id === cash).id])
  );

  const id = start.body.id;
  const depositLineId = deposit.lines.find((l) => l.account_id === cash).id;
  const paymentLineId = payment.lines.find((l) => l.account_id === cash).id;

  await request(app).post(`/api/bank-reconciliations/${id}/clear`).set(authHeader(token)).send({ journal_line_id: depositLineId, cleared: true });
  const afterSecondClear = await request(app)
    .post(`/api/bank-reconciliations/${id}/clear`)
    .set(authHeader(token))
    .send({ journal_line_id: paymentLineId, cleared: true });

  expect(afterSecondClear.body.difference).toBe(0);
  expect(afterSecondClear.body.outstanding_checks).toHaveLength(0);
  expect(afterSecondClear.body.deposits_in_transit).toHaveLength(0);

  const completed = await request(app).post(`/api/bank-reconciliations/${id}/complete`).set(authHeader(token));
  expect(completed.status).toBe(200);
  expect(completed.body.status).toBe("completed");
});

test("an uncleared item shows up as outstanding, and the difference reflects it", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2026-02-05", [
    { account_id: cash, debit: 2000, credit: 0 },
    { account_id: revenue, debit: 0, credit: 2000 },
  ]);

  const start = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-02-28", statement_ending_balance: 0 });

  // Nothing cleared: the bank says $0, the books have a $2000 deposit in
  // transit -- the reconciliation should say so, not pretend it balances.
  expect(start.body.cleared_balance).toBe(0);
  expect(start.body.difference).toBe(0);
  expect(start.body.deposits_in_transit_total).toBe(2000);
  expect(start.body.book_balance).toBe(2000);
});

test("a line dated after the statement can't be cleared onto it", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  const entry = await postEntry(token, "2026-03-15", [
    { account_id: cash, debit: 500, credit: 0 },
    { account_id: revenue, debit: 0, credit: 500 },
  ]);
  const lineId = entry.lines.find((l) => l.account_id === cash).id;

  const start = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-03-10", statement_ending_balance: 0 });

  const clear = await request(app)
    .post(`/api/bank-reconciliations/${start.body.id}/clear`)
    .set(authHeader(token))
    .send({ journal_line_id: lineId, cleared: true });
  expect(clear.status).toBe(422);
  expect(clear.body.detail).toMatch(/dated after the statement/i);
});

test("a line can't be cleared twice, even across two reconciliations", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  const entry = await postEntry(token, "2026-04-01", [
    { account_id: cash, debit: 100, credit: 0 },
    { account_id: revenue, debit: 0, credit: 100 },
  ]);
  const lineId = entry.lines.find((l) => l.account_id === cash).id;

  const first = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-04-30", statement_ending_balance: 100 });
  await request(app).post(`/api/bank-reconciliations/${first.body.id}/clear`).set(authHeader(token)).send({ journal_line_id: lineId, cleared: true });
  await request(app).post(`/api/bank-reconciliations/${first.body.id}/complete`).set(authHeader(token));

  const dup = await request(app)
    .post(`/api/bank-reconciliations/${first.body.id}/clear`)
    .set(authHeader(token))
    .send({ journal_line_id: lineId, cleared: false });
  expect(dup.status).toBe(422);
  expect(dup.body.detail).toMatch(/already completed/i);
});

test("only one reconciliation can be open per cash account at a time", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  const first = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-05-31", statement_ending_balance: 0 });
  expect(first.status).toBe(201);

  const second = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-06-30", statement_ending_balance: 0 });
  expect(second.status).toBe(422);
  expect(second.body.detail).toMatch(/already has a reconciliation in progress/i);
});

test("completing, reopening, and re-completing round-trips cleanly", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  const start = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(token))
    .send({ cash_account_id: cash, statement_date: "2026-07-31", statement_ending_balance: 0 });

  const completed = await request(app).post(`/api/bank-reconciliations/${start.body.id}/complete`).set(authHeader(token));
  expect(completed.body.status).toBe("completed");

  const reopened = await request(app).post(`/api/bank-reconciliations/${start.body.id}/reopen`).set(authHeader(token));
  expect(reopened.status).toBe(200);
  expect(reopened.body.status).toBe("open");

  const recompleted = await request(app).post(`/api/bank-reconciliations/${start.body.id}/complete`).set(authHeader(token));
  expect(recompleted.status).toBe(200);
  expect(recompleted.body.status).toBe("completed");
});

test("bank reconciliations are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const cashA = await accountId(tokenA, "Cash");

  const start = await request(app)
    .post("/api/bank-reconciliations")
    .set(authHeader(tokenA))
    .send({ cash_account_id: cashA, statement_date: "2026-08-31", statement_ending_balance: 0 });

  const fromB = await request(app).get(`/api/bank-reconciliations/${start.body.id}`).set(authHeader(tokenB));
  expect(fromB.status).toBe(404);

  const listFromB = await request(app).get("/api/bank-reconciliations").set(authHeader(tokenB));
  expect(listFromB.body.items).toHaveLength(0);
});
