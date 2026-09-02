// The general ledger endpoint (routes/accounts.js's GET
// /api/accounts/:id/ledger) -- the answer to "how was this number
// calculated" for a trial balance / income statement / balance sheet line.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function postEntry(token, entryDate, lines) {
  const res = await request(app).post("/api/journal-entries").set(authHeader(token)).send({ entry_date: entryDate, lines });
  if (res.status !== 201) throw new Error(`entry failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("lists every posted line against an account, oldest first, with a running balance", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2026-01-05", [
    { account_id: cash, debit: 100 },
    { account_id: revenue, credit: 100 },
  ]);
  await postEntry(token, "2026-01-10", [
    { account_id: cash, debit: 50 },
    { account_id: revenue, credit: 50 },
  ]);

  const res = await request(app).get(`/api/accounts/${cash}/ledger`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.rows).toHaveLength(2);
  expect(res.body.rows[0]).toMatchObject({ entry_date: "2026-01-05", debit: 100, credit: 0, balance: 100 });
  expect(res.body.rows[1]).toMatchObject({ entry_date: "2026-01-10", debit: 50, credit: 0, balance: 150 });
  expect(res.body.rows[0].other_accounts).toEqual(["Uncategorized Revenue"]);
  expect(res.body.closing_balance).toBe(150);
});

test("the closing balance for a period ties out to the trial balance total for that account", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2026-02-01", [
    { account_id: cash, debit: 200 },
    { account_id: revenue, credit: 200 },
  ]);
  await postEntry(token, "2026-02-15", [
    { account_id: cash, debit: 25 },
    { account_id: revenue, credit: 25 },
  ]);

  const ledger = await request(app).get(`/api/accounts/${cash}/ledger?to=2026-02-15`).set(authHeader(token));
  expect(ledger.status).toBe(200);

  const trialBalance = await request(app).get("/api/ledger/trial-balance?as_of=2026-02-15").set(authHeader(token));
  const row = trialBalance.body.accounts.find((a) => a.account_id === cash);
  expect(ledger.body.closing_balance).toBeCloseTo(row.debit - row.credit, 2);
});

test("`from` carries forward an opening balance instead of re-listing everything before it", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const revenue = await accountId(token, "Uncategorized Revenue");

  await postEntry(token, "2026-01-01", [
    { account_id: cash, debit: 1000 },
    { account_id: revenue, credit: 1000 },
  ]);
  await postEntry(token, "2026-03-01", [
    { account_id: cash, debit: 10 },
    { account_id: revenue, credit: 10 },
  ]);

  const res = await request(app).get(`/api/accounts/${cash}/ledger?from=2026-02-01&to=2026-03-31`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.rows).toHaveLength(1);
  expect(res.body.opening_balance).toBe(1000);
  expect(res.body.closing_balance).toBe(1010);
});

test("404s for an account that isn't yours", async () => {
  const tokenA = await signup(app, request, { email: "owner-a@example.co", orgName: "Org A" });
  const tokenB = await signup(app, request, { email: "owner-b@example.co", orgName: "Org B" });
  const cashA = await accountId(tokenA, "Cash");

  const res = await request(app).get(`/api/accounts/${cashA}/ledger`).set(authHeader(tokenB));
  expect(res.status).toBe(404);
});

test("rejects a malformed date instead of silently ignoring it", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  const res = await request(app).get(`/api/accounts/${cash}/ledger?from=not-a-date`).set(authHeader(token));
  expect(res.status).toBe(422);
});
