// SAFEs and convertible notes (convertibleInstruments.js,
// routes/convertibleInstruments.js). Neither instrument is equity when
// issued -- the cash books as a liability -- so most of these assert
// against the trial balance and share register the same way equity.test.js
// asserts against the balance sheet: a feature that looks right on its own
// endpoint but doesn't move the right accounts is the bug worth catching.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, ConvertibleInstrument } from "../src/models/index.js";
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

async function makeShareholder(token, name = "Acme Ventures") {
  const res = await request(app).post("/api/shareholders").set(authHeader(token)).send({ name });
  return res.body.id;
}

async function makeShareClass(token, { par_value = 0.0001 } = {}) {
  const res = await request(app)
    .post("/api/share-classes")
    .set(authHeader(token))
    .send({ name: "Common", par_value });
  return res.body.id;
}

async function issueInstrument(token, overrides = {}) {
  const cash = await accountId(token, "Cash");
  const shareholderId = overrides.shareholder_id || (await makeShareholder(token));
  return request(app)
    .post("/api/convertible-instruments")
    .set(authHeader(token))
    .send({
      shareholder_id: shareholderId,
      instrument_type: "safe",
      safe_type: "post_money",
      issue_date: "2026-01-15",
      principal: 100000,
      valuation_cap: 5000000,
      cash_account_id: cash,
      ...overrides,
    });
}

// ---- Issuance ----

test("issuing a SAFE debits cash and credits Convertible Notes & SAFEs Payable, not equity", async () => {
  const token = await signup(app, request);
  const res = await issueInstrument(token);
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("outstanding");
  expect(res.body.principal).toBe(100000);

  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").credit).toBe(100000);
  expect(accountRow(tb, "Cash").debit).toBe(100000);
  expect(netEquity(tb, "Common Stock")).toBe(0);
  expect(tb.balanced).toBe(true);
});

test("a convertible note carries interest and maturity terms, informational only", async () => {
  const token = await signup(app, request);
  const res = await issueInstrument(token, {
    instrument_type: "convertible_note",
    safe_type: null,
    discount_rate_percent: 20,
    interest_rate_percent: 6,
    maturity_date: "2027-01-15",
  });
  expect(res.status).toBe(201);
  expect(res.body.instrument_type).toBe("convertible_note");
  expect(res.body.discount_rate_percent).toBe(20);
  expect(res.body.interest_rate_percent).toBe(6);
  expect(res.body.maturity_date).toBe("2027-01-15");
});

test("issuing to an investor who isn't a shareholder on file is refused", async () => {
  const token = await signup(app, request);
  const res = await issueInstrument(token, { shareholder_id: "nonexistent" });
  expect(res.status).toBe(404);
  expect(await ConvertibleInstrument.count()).toBe(0);
});

test("a SAFE issued into a closed period is refused and leaves no record", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-01", status: "closed", closedAt: new Date() });

  const res = await issueInstrument(token, { issue_date: "2026-01-15" });
  expect(res.status).toBe(409);
  expect(await ConvertibleInstrument.count({ where: { orgId: org } })).toBe(0);
});

// ---- Conversion ----

test("converting extinguishes the liability, splits par/APIC, and puts shares on the register", async () => {
  const token = await signup(app, request);
  const shareClassId = await makeShareClass(token, { par_value: 0.0001 });
  const issued = await issueInstrument(token, { principal: 100000 });

  const converted = await request(app)
    .post(`/api/convertible-instruments/${issued.body.id}/convert`)
    .set(authHeader(token))
    .send({
      transaction_date: "2026-06-01",
      share_class_id: shareClassId,
      shares: 100000,
      par_value: 0.0001,
    });
  expect(converted.status).toBe(200);
  expect(converted.body.status).toBe("converted");
  expect(converted.body.conversion_equity_transaction_id).toBeTruthy();
  expect(converted.body.conversion_share_transaction_id).toBeTruthy();

  const tb = await trialBalance(token, "2026-12-31");
  // The liability is gone; par (100,000 x $0.0001 = $10) went to Common
  // Stock and the rest to APIC.
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").debit).toBe(100000);
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").credit).toBe(100000);
  expect(netEquity(tb, "Common Stock")).toBe(10);
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(99990);
  expect(tb.balanced).toBe(true);

  // No cash moved on conversion day -- it stays out of the cash journals.
  const cashJournal = await request(app).get("/api/journal-entries?journal=cash_receipts").set(authHeader(token));
  expect(cashJournal.body.items.some((e) => e.memo?.includes("Conversion"))).toBe(false);

  const capTable = await request(app).get("/api/cap-table").set(authHeader(token));
  expect(capTable.body.holders[0].total_shares).toBe(100000);

  const reconciliation = await request(app).get("/api/share-register/reconciliation").set(authHeader(token));
  expect(reconciliation.body.reconciles).toBe(true);
});

test("converting an already-converted instrument is refused", async () => {
  const token = await signup(app, request);
  const shareClassId = await makeShareClass(token);
  const issued = await issueInstrument(token);
  const body = { transaction_date: "2026-06-01", share_class_id: shareClassId, shares: 100000, par_value: 0.0001 };
  await request(app).post(`/api/convertible-instruments/${issued.body.id}/convert`).set(authHeader(token)).send(body);

  const again = await request(app)
    .post(`/api/convertible-instruments/${issued.body.id}/convert`)
    .set(authHeader(token))
    .send(body);
  expect(again.status).toBe(422);
  expect(again.body.detail).toMatch(/already converted/i);
});

test("a conversion that would exceed authorized shares is refused and the instrument stays outstanding", async () => {
  const token = await signup(app, request);
  const classRes = await request(app)
    .post("/api/share-classes")
    .set(authHeader(token))
    .send({ name: "Common", par_value: 0.0001, authorized_shares: 1000 });
  const issued = await issueInstrument(token);

  const converted = await request(app)
    .post(`/api/convertible-instruments/${issued.body.id}/convert`)
    .set(authHeader(token))
    .send({ transaction_date: "2026-06-01", share_class_id: classRes.body.id, shares: 100000, par_value: 0.0001 });
  expect(converted.status).toBe(422);

  // The equity posting this would have required must be unwound (a
  // reversing entry, not a deletion -- it was genuinely posted), so the
  // liability nets back to exactly what the original issuance left behind.
  const instrument = await ConvertibleInstrument.findByPk(issued.body.id);
  expect(instrument.status).toBe("outstanding");
  const tb = await trialBalance(token, "2026-12-31");
  expect(netEquity(tb, "Convertible Notes & SAFEs Payable")).toBe(100000);
  expect(netEquity(tb, "Common Stock")).toBe(0);
  expect(netEquity(tb, "Additional Paid-In Capital")).toBe(0);
  expect(tb.balanced).toBe(true);
});

// ---- Repayment ----

test("repaying debits the liability and credits cash, with no equity involved", async () => {
  const token = await signup(app, request);
  const issued = await issueInstrument(token, { instrument_type: "convertible_note", safe_type: null, principal: 50000 });
  const cash = await accountId(token, "Cash");

  const repaid = await request(app)
    .post(`/api/convertible-instruments/${issued.body.id}/repay`)
    .set(authHeader(token))
    .send({ transaction_date: "2026-06-01", amount: 50000, cash_account_id: cash });
  expect(repaid.status).toBe(200);
  expect(repaid.body.status).toBe("repaid");

  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").debit).toBe(50000);
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").credit).toBe(50000);
  expect(netEquity(tb, "Common Stock")).toBe(0);
  expect(tb.balanced).toBe(true);
});

// ---- Voiding ----

test("voiding an outstanding instrument reverses the posting and marks it voided", async () => {
  const token = await signup(app, request);
  const issued = await issueInstrument(token, { principal: 25000 });

  const voided = await request(app).post(`/api/convertible-instruments/${issued.body.id}/void`).set(authHeader(token));
  expect(voided.status).toBe(200);
  expect(voided.body.status).toBe("voided");

  const tb = await trialBalance(token, "2026-12-31");
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").debit).toBe(25000);
  expect(accountRow(tb, "Convertible Notes & SAFEs Payable").credit).toBe(25000);
  expect(tb.balanced).toBe(true);
});

test("a converted instrument can't be voided", async () => {
  const token = await signup(app, request);
  const shareClassId = await makeShareClass(token);
  const issued = await issueInstrument(token);
  await request(app)
    .post(`/api/convertible-instruments/${issued.body.id}/convert`)
    .set(authHeader(token))
    .send({ transaction_date: "2026-06-01", share_class_id: shareClassId, shares: 100000, par_value: 0.0001 });

  const voided = await request(app).post(`/api/convertible-instruments/${issued.body.id}/void`).set(authHeader(token));
  expect(voided.status).toBe(422);
});

// ---- Scoping ----

test("convertible instruments are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const issued = await issueInstrument(tokenA);

  expect((await request(app).get("/api/convertible-instruments").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect(
    (await request(app).post(`/api/convertible-instruments/${issued.body.id}/void`).set(authHeader(tokenB))).status
  ).toBe(404);
});
