// Stockholders' equity (equity.js, stockholdersEquity.js,
// routes/equity.js).
//
// All of these postings were expressible as raw journal entries already.
// What was missing is classification: a credit to an equity account
// doesn't say whether it was a contribution, a share issuance, or a
// treasury reissue, and those are three different lines on a statement of
// stockholders' equity.
//
// The statement is a roll-forward that has to tie to the balance sheet at
// both ends, so most of these assert against the balance sheet rather than
// the equity endpoints alone.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, EquityTransaction } from "../src/models/index.js";
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

function netEquity(tb, name) {
  const r = accountRow(tb, name);
  return r.credit - r.debit;
}

async function balanceSheet(token, asOf) {
  return (await request(app).get(`/api/statements/balance-sheet?as_of=${asOf}`).set(authHeader(token))).body;
}

async function statement(token, from, to) {
  const q = [from ? `from=${from}` : "", to ? `to=${to}` : ""].filter(Boolean).join("&");
  return (await request(app).get(`/api/statements/stockholders-equity?${q}`).set(authHeader(token))).body;
}

async function equityTxn(token, body) {
  return request(app).post("/api/equity/transactions").set(authHeader(token)).send(body);
}

// Real revenue and expense, posted by hand so the amounts are exact.
async function seedEarnings(token, { date = "2026-06-30", revenue = 10000, expense = 4000 } = {}) {
  const cash = await accountId(token, "Cash");
  const rev = await accountId(token, "Uncategorized Revenue");
  const exp = await accountId(token, "Uncategorized Expense");
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: date, lines: [{ account_id: cash, debit: revenue }, { account_id: rev, credit: revenue }] });
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: date, lines: [{ account_id: exp, debit: expense }, { account_id: cash, credit: expense }] });
}

// ---- Contributions ----

test("an unincorporated contribution credits Owner's Equity", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 50000,
    cash_account_id: cash,
  });
  expect(res.status).toBe(201);

  // No shares and no par value means a sole proprietor or LLC member
  // putting money in -- there's nothing to split.
  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Owner's Equity")).toBe(50000);
  expect(accountRow(tb, "Cash").debit).toBe(50000);
  expect(tb.balanced).toBe(true);
});

test("a share issuance splits par from premium across Common Stock and APIC", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // 10,000 shares at $0.01 par, sold for $50,000: $100 of par, $49,900 of
  // paid-in capital above it.
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 50000,
    cash_account_id: cash,
    shares: 10000,
    par_value: 0.01,
  });
  expect(res.status).toBe(201);

  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Common Stock")).toBe(100);
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(49900);
  expect(netEquity(tb, "Owner's Equity")).toBe(0);
  expect(tb.balanced).toBe(true);
});

test("shares can't be issued below par", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // 1,000 shares at $1 par sold for $500 total. Prohibited in most
  // jurisdictions, and it would produce a negative APIC, which isn't a
  // thing.
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 500,
    cash_account_id: cash,
    shares: 1000,
    par_value: 1,
  });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/below par/i);
  expect(await EquityTransaction.count()).toBe(0);
});

test("share count and par value have to be given together", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 500,
    cash_account_id: cash,
    shares: 1000,
  });
  expect(res.status).toBe(422);
});

// ---- Distributions and dividends ----

test("a distribution reduces equity through a contra account, not retained earnings", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, { type: "contribution", transaction_date: "2026-01-01", amount: 50000, cash_account_id: cash });

  await equityTxn(token, { type: "distribution", transaction_date: "2026-06-01", amount: 8000, cash_account_id: cash });

  const tb = await trialBalance(token, "2026-12-31");
  // Debit-normal equity account, so it shows negative and subtracts on its
  // own -- the year's distributions stay visible as their own line rather
  // than disappearing into the earnings balance.
  expect(netEquity(tb, "Distributions")).toBe(-8000);
  expect(tb.balanced).toBe(true);

  const sheet = await balanceSheet(token, "2026-12-31");
  expect(sheet.equity.total).toBe(42000);
  expect(sheet.balanced).toBe(true);
});

test("declaring a dividend creates a liability; paying it settles one", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, { type: "contribution", transaction_date: "2026-01-01", amount: 50000, cash_account_id: cash });

  const declared = await equityTxn(token, {
    type: "dividend_declared",
    transaction_date: "2026-06-01",
    amount: 5000,
  });
  expect(declared.status).toBe(201);

  // Declared but unpaid: equity is down, cash is untouched, and the
  // obligation is on the balance sheet as a liability.
  let sheet = await balanceSheet(token, "2026-06-30");
  expect(sheet.equity.total).toBe(45000);
  expect(sheet.liabilities.accounts.find((a) => a.name === "Dividends Payable").amount).toBe(5000);
  let tb = await trialBalance(token, "2026-06-30");
  expect(accountRow(tb, "Cash").debit - accountRow(tb, "Cash").credit).toBe(50000);

  await equityTxn(token, { type: "dividend_paid", transaction_date: "2026-07-01", amount: 5000, cash_account_id: cash });

  // Paying moves cash and clears the liability. Equity is unchanged --
  // the reduction was already recognized on declaration, and counting it
  // twice is the classic error here.
  sheet = await balanceSheet(token, "2026-12-31");
  expect(sheet.equity.total).toBe(45000);
  expect(sheet.liabilities.accounts.find((a) => a.name === "Dividends Payable")).toBeUndefined();
  tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Cash").debit - accountRow(tb, "Cash").credit).toBe(45000);
  expect(tb.balanced).toBe(true);
});

// ---- Treasury stock ----

test("a buyback is carried at cost, with no gain or loss recognized", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-01",
    amount: 50000,
    cash_account_id: cash,
    shares: 10000,
    par_value: 0.01,
  });

  await equityTxn(token, {
    type: "treasury_purchase",
    transaction_date: "2026-06-01",
    amount: 12000,
    cash_account_id: cash,
  });

  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Treasury Stock")).toBe(-12000);
  const sheet = await balanceSheet(token, "2026-12-31");
  expect(sheet.equity.total).toBe(38000);
  expect(sheet.balanced).toBe(true);
});

test("reissuing above cost credits paid-in capital, never income", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-01",
    amount: 50000,
    cash_account_id: cash,
    shares: 10000,
    par_value: 0.01,
  });
  await equityTxn(token, { type: "treasury_purchase", transaction_date: "2026-06-01", amount: 12000, cash_account_id: cash });

  // Bought for 12,000, sold for 15,000. A company can't book profit by
  // trading in its own shares, so the 3,000 is paid-in capital.
  const reissue = await equityTxn(token, {
    type: "treasury_reissue",
    transaction_date: "2026-09-01",
    amount: 15000,
    cost_basis: 12000,
    cash_account_id: cash,
  });
  expect(reissue.status).toBe(201);

  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Treasury Stock")).toBe(0);
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(52900); // 49,900 + 3,000
  expect(tb.balanced).toBe(true);

  // No revenue anywhere.
  const pnl = await request(app)
    .get("/api/statements/profit-and-loss?from=2026-01-01&to=2026-12-31")
    .set(authHeader(token));
  expect(pnl.body.revenue.total).toBe(0);
});

test("reissuing below cost charges paid-in capital first, then retained earnings", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  // Only $100 of APIC available: 10,000 shares at $0.01 par sold for $200.
  await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-01",
    amount: 200,
    cash_account_id: cash,
    shares: 10000,
    par_value: 0.01,
  });
  await equityTxn(token, { type: "treasury_purchase", transaction_date: "2026-06-01", amount: 5000, cash_account_id: cash });

  // Bought for 5,000, sold for 4,000: a 1,000 shortfall against only 100
  // of available APIC. The waterfall takes the 100 and charges the
  // remaining 900 to retained earnings -- charging earnings first would
  // understate accumulated profit while leaving APIC that exists
  // precisely to absorb this.
  const reissue = await equityTxn(token, {
    type: "treasury_reissue",
    transaction_date: "2026-09-01",
    amount: 4000,
    cost_basis: 5000,
    cash_account_id: cash,
  });
  expect(reissue.status).toBe(201);

  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(0);
  expect(netEquity(tb, "Retained Earnings")).toBe(-900);
  expect(netEquity(tb, "Treasury Stock")).toBe(0);
  expect(tb.balanced).toBe(true);
});

// ---- The statement ----

test("the statement rolls forward and ties to the balance sheet at both ends", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // Opening position, before the period being reported.
  await equityTxn(token, { type: "contribution", transaction_date: "2025-06-01", amount: 20000, cash_account_id: cash });
  await seedEarnings(token, { date: "2025-06-30", revenue: 5000, expense: 1000 });

  // Activity inside the period.
  await equityTxn(token, { type: "contribution", transaction_date: "2026-03-01", amount: 30000, cash_account_id: cash });
  await equityTxn(token, { type: "distribution", transaction_date: "2026-08-01", amount: 7000, cash_account_id: cash });
  await equityTxn(token, { type: "treasury_purchase", transaction_date: "2026-09-01", amount: 4000, cash_account_id: cash });
  await seedEarnings(token, { date: "2026-06-30", revenue: 10000, expense: 4000 });

  const s = await statement(token, "2026-01-01", "2026-12-31");

  // Opening: 20,000 contributed + 4,000 earned in 2025.
  expect(s.beginning_balance).toBe(24000);
  expect(s.net_income).toBe(6000);
  expect(s.contributions).toBe(30000);
  expect(s.distributions).toBe(-7000);
  expect(s.treasury_stock).toBe(-4000);
  expect(s.other).toBe(0);
  expect(s.ending_balance).toBe(49000);
  expect(s.reconciles).toBe(true);

  // Both ends come straight from the balance sheet, so they can't disagree
  // with the statement sitting next to them.
  const closing = await balanceSheet(token, "2026-12-31");
  expect(s.ending_balance).toBe(closing.equity.total);
  const opening = await balanceSheet(token, "2025-12-31");
  expect(s.beginning_balance).toBe(opening.equity.total);
});

test("equity moved by a manual journal entry lands on the 'other' line rather than being swallowed", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const equityAccount = await accountId(token, "Owner's Equity");
  await equityTxn(token, { type: "contribution", transaction_date: "2026-02-01", amount: 10000, cash_account_id: cash });

  // Equity accounts are reachable by a plain journal entry, so this is
  // always possible. A statement that silently absorbed it would be
  // wrong; one that refused to balance would be useless.
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-05-01",
      lines: [{ account_id: cash, debit: 2500 }, { account_id: equityAccount, credit: 2500 }],
    });

  const s = await statement(token, "2026-01-01", "2026-12-31");
  expect(s.contributions).toBe(10000);
  expect(s.other).toBe(2500);
  expect(s.ending_balance).toBe(12500);
  expect(s.reconciles).toBe(true);
});

test("paying a declared dividend doesn't reduce equity a second time", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, { type: "contribution", transaction_date: "2026-01-01", amount: 50000, cash_account_id: cash });
  await equityTxn(token, { type: "dividend_declared", transaction_date: "2026-06-01", amount: 5000 });
  await equityTxn(token, { type: "dividend_paid", transaction_date: "2026-07-01", amount: 5000, cash_account_id: cash });

  const s = await statement(token, "2026-01-01", "2026-12-31");
  // 5,000 once, not 10,000. The reduction was recognized on declaration;
  // payment just settles the liability.
  expect(s.distributions).toBe(-5000);
  expect(s.ending_balance).toBe(45000);
  expect(s.other).toBe(0);
  expect(s.reconciles).toBe(true);
});

test("the statement still ties after a fiscal year has been formally closed", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, { type: "contribution", transaction_date: "2026-01-01", amount: 20000, cash_account_id: cash });
  await seedEarnings(token, { date: "2026-06-30", revenue: 10000, expense: 4000 });

  // Closing moves earnings from the derived half of equity to a posted
  // Retained Earnings balance (v1.27). The statement reads both ends from
  // the balance sheet, so the move has to be invisible to it.
  await request(app).post("/api/close/year-end").set(authHeader(token)).send({ date: "2026-06-30" });

  const s = await statement(token, "2026-01-01", "2026-12-31");
  expect(s.net_income).toBe(6000);
  expect(s.contributions).toBe(20000);
  expect(s.ending_balance).toBe(26000);
  expect(s.other).toBe(0);
  expect(s.reconciles).toBe(true);
});

test("with no start date the statement opens at zero and covers everything", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  await equityTxn(token, { type: "contribution", transaction_date: "2024-01-01", amount: 15000, cash_account_id: cash });

  const s = await statement(token, null, "2026-12-31");
  expect(s.beginning_balance).toBe(0);
  expect(s.contributions).toBe(15000);
  expect(s.ending_balance).toBe(15000);
  expect(s.reconciles).toBe(true);
});

// ---- Guards and lifecycle ----

test("a transaction the ledger refuses leaves no record behind", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-03", status: "closed", closedAt: new Date() });

  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-03-15",
    amount: 5000,
    cash_account_id: cash,
  });
  expect(res.status).toBe(409);
  // The row has to be created before the entry can name it as its source,
  // so a refused posting has to unwind it.
  expect(await EquityTransaction.count({ where: { orgId: org } })).toBe(0);
});

test("equity can't be funded from an equity account", async () => {
  const token = await signup(app, request);
  const equityAccount = await accountId(token, "Owner's Equity");
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 5000,
    cash_account_id: equityAccount,
  });
  // Circular, and moves nothing real.
  expect(res.status).toBe(422);
});

test("voiding reverses the posting and stops the statement counting it", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const created = await equityTxn(token, {
    type: "distribution",
    transaction_date: "2026-05-01",
    amount: 3000,
    cash_account_id: cash,
  });
  await equityTxn(token, { type: "contribution", transaction_date: "2026-01-01", amount: 10000, cash_account_id: cash });

  const voided = await request(app)
    .post(`/api/equity/transactions/${created.body.id}/void`)
    .set(authHeader(token));
  expect(voided.status).toBe(200);

  const s = await statement(token, "2026-01-01", "2026-12-31");
  expect(s.distributions).toBe(0);
  expect(s.ending_balance).toBe(10000);
  // The reversal is in the ledger, so counting the voided transaction
  // would push a phantom difference onto `other`.
  expect(s.other).toBe(0);
  expect(s.reconciles).toBe(true);

  const tb = await trialBalance(token, "2026-12-31");
  expect(tb.balanced).toBe(true);
  // The record itself is kept -- a distribution that happened and was
  // corrected is history someone may need to explain.
  expect(await EquityTransaction.count()).toBe(2);
});

test("equity transactions and the statement are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const cashA = await accountId(tokenA, "Cash");
  const created = await equityTxn(tokenA, {
    type: "contribution",
    transaction_date: "2026-01-01",
    amount: 10000,
    cash_account_id: cashA,
  });

  expect((await request(app).get("/api/equity/transactions").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect((await statement(tokenB, "2026-01-01", "2026-12-31")).ending_balance).toBe(0);
  expect(
    (await request(app).post(`/api/equity/transactions/${created.body.id}/void`).set(authHeader(tokenB))).status
  ).toBe(404);

  // ...and A's books are untouched by any of it.
  expect((await statement(tokenA, "2026-01-01", "2026-12-31")).ending_balance).toBe(10000);
});

test("a sub-cent par value survives, because par is carried in millionths", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // $0.001 is a common par value and $0.0001 is the Delaware default --
  // both round to zero cents. Converting per-share par to cents before
  // multiplying loses the par entirely and emits a zero-value line, which
  // the ledger rejects outright.
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 250000,
    cash_account_id: cash,
    shares: 1000000,
    par_value: 0.001,
  });
  expect(res.status).toBe(201);
  expect(res.body.par_value).toBe(0.001);

  // 1,000,000 x $0.001 = $1,000 of par, the rest paid-in capital.
  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Common Stock")).toBe(1000);
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(249000);
  expect(tb.balanced).toBe(true);
});

test("par so small it rounds under a cent in total puts everything in Common Stock", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");

  // 100 shares at $0.0001 is $0.01 of par... but 10 shares is $0.001,
  // under a cent. A zero par line can't be posted, so no-par treatment
  // applies and the whole issuance is Common Stock.
  const res = await equityTxn(token, {
    type: "contribution",
    transaction_date: "2026-01-15",
    amount: 5000,
    cash_account_id: cash,
    shares: 10,
    par_value: 0.0001,
  });
  expect(res.status).toBe(201);

  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Common Stock")).toBe(5000);
  expect(tb.balanced).toBe(true);
});
