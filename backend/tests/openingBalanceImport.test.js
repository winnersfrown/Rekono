// Trial-balance import (openingBalanceImport.js,
// routes/openingBalanceImport.js): the "switch from Rillet/QuickBooks/
// anything" onboarding path. A trial balance is a balanced snapshot, so
// most of these assert the whole import posts as one entry and ties to
// the trial balance report, not just that the endpoint returns 201.
import request from "supertest";
import { app } from "../src/app.js";
import { Account, ClosePeriod, JournalEntry } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

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

async function preview(token, csv) {
  return request(app).post("/api/onboarding/import-trial-balance/preview").set(authHeader(token)).send({ csv });
}

async function importCsv(token, csv, asOfDate = "2026-01-31") {
  return request(app).post("/api/onboarding/import-trial-balance").set(authHeader(token)).send({ csv, as_of_date: asOfDate });
}

const BASIC_CSV = `Account,Debit,Credit
Cash,50000,
Accounts Receivable,10000,
Accounts Payable,,15000
Owner's Equity,,45000`;

// ---- Preview ----

test("preview matches existing seeded accounts and reports the file balances", async () => {
  const token = await signup(app, request);
  const res = await preview(token, BASIC_CSV);
  expect(res.status).toBe(200);
  expect(res.body.balances).toBe(true);
  expect(res.body.total_debit).toBe(60000);
  expect(res.body.total_credit).toBe(60000);
  expect(res.body.accounts_matched).toBe(4);
  expect(res.body.accounts_to_create).toBe(0);
  expect(res.body.unresolved).toEqual([]);
});

test("preview flags a file that doesn't balance without posting anything", async () => {
  const token = await signup(app, request);
  const unbalanced = `Account,Debit,Credit\nCash,50000,\nOwner's Equity,,40000`;
  const res = await preview(token, unbalanced);
  expect(res.status).toBe(200);
  expect(res.body.balances).toBe(false);
  expect(await JournalEntry.count()).toBe(0);
});

test("preview flags a new account with no recognized type as unresolved", async () => {
  const token = await signup(app, request);
  const csv = `Account,Debit,Credit\nCash,500,\nSome New Vendor Prepayment,,500`;
  const res = await preview(token, csv);
  expect(res.status).toBe(200);
  expect(res.body.unresolved).toHaveLength(1);
  expect(res.body.unresolved[0].name).toBe("Some New Vendor Prepayment");
  expect(res.body.accounts_to_create).toBe(1);
});

// ---- Import ----

test("importing posts one balanced entry that ties to the trial balance", async () => {
  const token = await signup(app, request);
  const res = await importCsv(token, BASIC_CSV, "2026-01-31");
  expect(res.status).toBe(201);
  expect(res.body.accounts_matched).toBe(4);
  expect(res.body.accounts_created).toBe(0);

  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Cash").debit).toBe(50000);
  expect(accountRow(tb, "Accounts Receivable").debit).toBe(10000);
  expect(accountRow(tb, "Accounts Payable").credit).toBe(15000);
  expect(accountRow(tb, "Owner's Equity").credit).toBe(45000);
  expect(tb.balanced).toBe(true);

  expect(await JournalEntry.count()).toBe(1);
});

test("a row naming an account not yet on the chart creates it, given a valid type", async () => {
  const token = await signup(app, request);
  const csv = `Account,Type,Debit,Credit\nCash,asset,1000,\nFounder Loan Payable,liability,,1000`;
  const res = await importCsv(token, csv);
  expect(res.status).toBe(201);
  expect(res.body.accounts_created).toBe(1);
  expect(res.body.accounts_matched).toBe(1);

  const created = await Account.findOne({ where: { name: "Founder Loan Payable" } });
  expect(created).toBeTruthy();
  expect(created.type).toBe("liability");

  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Founder Loan Payable").credit).toBe(1000);
});

test("a row with a code column carries it onto the created account", async () => {
  const token = await signup(app, request);
  const csv = `Account,Code,Type,Debit,Credit\nCash,1000,asset,750,\nCustom Escrow,1250,asset,,750`;
  await importCsv(token, csv);

  const created = await Account.findOne({ where: { name: "Custom Escrow" } });
  expect(created.code).toBe("1250");
});

test("an unresolved row is refused and nothing is created or posted", async () => {
  const token = await signup(app, request);
  const csv = `Account,Debit,Credit\nCash,500,\nMystery Account,,500`;
  const res = await importCsv(token, csv);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/Mystery Account/);
  expect(await Account.findOne({ where: { name: "Mystery Account" } })).toBeNull();
  expect(await JournalEntry.count()).toBe(0);
});

test("a file that doesn't balance is refused before anything is created or posted", async () => {
  const token = await signup(app, request);
  const csv = `Account,Type,Debit,Credit\nCash,asset,500,\nNew Thing,asset,,400`;
  const res = await importCsv(token, csv);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/doesn't balance/);
  expect(await Account.findOne({ where: { name: "New Thing" } })).toBeNull();
  expect(await JournalEntry.count()).toBe(0);
});

test("thousands separators and currency symbols are stripped before parsing", async () => {
  const token = await signup(app, request);
  const csv = `Account,Debit,Credit\nCash,"$1,000.00",\nOwner's Equity,,"1,000.00"`;
  const res = await preview(token, csv);
  expect(res.status).toBe(200);
  expect(res.body.total_debit).toBe(1000);
  expect(res.body.total_credit).toBe(1000);
});

test("a negative value in a Debit/Credit column is refused, not silently reinterpreted", async () => {
  const token = await signup(app, request);
  // A two-column trial balance has no legitimate use for a sign -- which
  // column an amount is in already says which side it's on. Guessing what
  // a stray negative meant (flip columns? cancel the row?) would silently
  // misrepresent the source file, so this is refused with the row and
  // column named instead.
  const csv = `Account,Debit,Credit\nCash,500,\nOwner's Equity,,-500`;
  const res = await preview(token, csv);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/Credit column on row 3/);
});

test("rejects a file with no recognizable header", async () => {
  const token = await signup(app, request);
  const res = await preview(token, `Foo,Bar\n1,2`);
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/Account.*Name/i);
});

test("importing into a closed period is refused and unwinds any newly-created accounts", async () => {
  const token = await signup(app, request);
  const org = (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-01", status: "closed", closedAt: new Date() });

  const csv = `Account,Type,Debit,Credit\nCash,asset,500,\nBrand New Thing,liability,,500`;
  const res = await importCsv(token, csv, "2026-01-15");
  expect(res.status).toBe(409);
  expect(await Account.findOne({ where: { orgId: org, name: "Brand New Thing" } })).toBeNull();
});

test("import is scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "obi-a@example.co" });
  const tokenB = await signup(app, request, { email: "obi-b@example.co", orgName: "Org B" });

  await importCsv(tokenA, BASIC_CSV);

  const tbB = await trialBalance(tokenB, "2026-12-31");
  expect(accountRow(tbB, "Cash").debit).toBe(0);
});
