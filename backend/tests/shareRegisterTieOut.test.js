// The share register's tie-out to the financial ledger
// (shareRegister.js's reconcileShareRegister, and the link a share
// movement carries to the equity transaction that paid for it).
//
// Split out from shareRegister.test.js because the signup rate limiter is
// per-process and Jest gives each test file its own module registry, so a
// file's ceiling is 30 accounts -- see routes/auth.js.
//
// Common Stock is credited with par value on every issuance, so its
// balance divided by par is the number of shares issued, and the register
// knows that number independently. Where the two disagree, either a share
// issuance never reached the ledger or an equity contribution never
// reached the register, and somebody's ownership percentage is wrong.
import request from "supertest";
import { app } from "../src/app.js";
import { EquityTransaction } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeClass(token, body = {}) {
  const res = await request(app)
    .post("/api/share-classes")
    .set(authHeader(token))
    .send({ name: "Common", par_value: 0.001, ...body });
  if (res.status !== 201) throw new Error(`share class failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeHolder(token, name) {
  const res = await request(app).post("/api/shareholders").set(authHeader(token)).send({ name });
  if (res.status !== 201) throw new Error(`shareholder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function shareTxn(token, body) {
  return request(app).post("/api/share-transactions").set(authHeader(token)).send(body);
}

async function counts(token) {
  return (await request(app).get("/api/share-classes/counts").set(authHeader(token))).body.items;
}

async function reconciliation(token) {
  return (await request(app).get("/api/share-register/reconciliation").set(authHeader(token))).body;
}

describe("the tie-out to the ledger", () => {
  // Issues shares both ways: through equity.js (which posts par to Common
  // Stock and premium to APIC) and onto the register, linked.
  async function issueForCash(token, { cls, holder, shares, amount, date = "2026-01-15", parValue = 0.001 }) {
    const cash = await accountId(token, "Cash");
    const equity = await request(app)
      .post("/api/equity/transactions")
      .set(authHeader(token))
      .send({ type: "contribution", transaction_date: date, amount, cash_account_id: cash, shares, par_value: parValue });
    if (equity.status !== 201) throw new Error(`equity failed: ${equity.status} ${JSON.stringify(equity.body)}`);

    const share = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: date,
      shares,
      to_shareholder_id: holder.id,
      equity_transaction_id: equity.body.id,
    });
    if (share.status !== 201) throw new Error(`share txn failed: ${share.status} ${JSON.stringify(share.body)}`);
    return { equity: equity.body, share: share.body };
  }

  test("Common Stock divided by par equals the shares the register says were issued", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { par_value: 0.001 });
    const ada = await makeHolder(token, "Ada");

    // 1,000,000 shares at $0.001 par is $1,000 of par against $50,000
    // raised -- the case that broke when par was carried in cents.
    await issueForCash(token, { cls, holder: ada, shares: 1000000, amount: 50000 });

    const rec = await reconciliation(token);
    expect(rec.applicable).toBe(true);
    expect(rec.register_par_value).toBe(1000);
    expect(rec.ledger_common_stock).toBe(1000);
    expect(rec.difference).toBe(0);
    expect(rec.reconciles).toBe(true);
    expect(rec.unlinked_equity_transactions).toHaveLength(0);
  });

  test("a buyback leaves the tie-out alone, because the cost method leaves Common Stock alone", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { par_value: 0.001 });
    const ada = await makeHolder(token, "Ada");
    await issueForCash(token, { cls, holder: ada, shares: 1000000, amount: 50000 });

    const cash = await accountId(token, "Cash");
    const buyback = await request(app)
      .post("/api/equity/transactions")
      .set(authHeader(token))
      .send({ type: "treasury_purchase", transaction_date: "2026-04-01", amount: 5000, cash_account_id: cash, shares: 100000, par_value: 0.001 });
    expect(buyback.status).toBe(201);
    await shareTxn(token, {
      type: "repurchase",
      share_class_id: cls.id,
      transaction_date: "2026-04-01",
      shares: 100000,
      from_shareholder_id: ada.id,
      equity_transaction_id: buyback.body.id,
    });

    const [row] = await counts(token);
    expect(row).toMatchObject({ issued: 1000000, treasury: 100000, outstanding: 900000 });

    // Issued is what Common Stock measures, and issued didn't change.
    const rec = await reconciliation(token);
    expect(rec.reconciles).toBe(true);
    expect(rec.register_par_value).toBe(1000);
  });

  test("an equity contribution with no share movement is named, not just totalled", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { par_value: 0.001 });
    const ada = await makeHolder(token, "Ada");
    await issueForCash(token, { cls, holder: ada, shares: 1000000, amount: 50000 });

    // A second raise that went into the books but never onto the register.
    const cash = await accountId(token, "Cash");
    const stray = await request(app)
      .post("/api/equity/transactions")
      .set(authHeader(token))
      .send({ type: "contribution", transaction_date: "2026-08-01", amount: 20000, cash_account_id: cash, shares: 200000, par_value: 0.001 });
    expect(stray.status).toBe(201);

    const rec = await reconciliation(token);
    expect(rec.reconciles).toBe(false);
    expect(rec.register_par_value).toBe(1000);
    expect(rec.ledger_common_stock).toBe(1200);
    expect(rec.difference).toBe(200);
    expect(rec.unlinked_equity_transactions).toHaveLength(1);
    expect(rec.unlinked_equity_transactions[0]).toMatchObject({ id: stray.body.id, shares: 200000, amount: 20000 });
  });

  test("a voided equity transaction stops being an unexplained difference", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { par_value: 0.001 });
    const ada = await makeHolder(token, "Ada");
    await issueForCash(token, { cls, holder: ada, shares: 1000000, amount: 50000 });

    const cash = await accountId(token, "Cash");
    const stray = await request(app)
      .post("/api/equity/transactions")
      .set(authHeader(token))
      .send({ type: "contribution", transaction_date: "2026-08-01", amount: 20000, cash_account_id: cash, shares: 200000, par_value: 0.001 });
    expect((await reconciliation(token)).reconciles).toBe(false);

    await request(app).post(`/api/equity/transactions/${stray.body.id}/void`).set(authHeader(token));

    // Voiding posts a reversing entry, so Common Stock comes back down and
    // the transaction drops off the unlinked list rather than lingering as
    // a permanent complaint.
    const rec = await reconciliation(token);
    expect(rec.reconciles).toBe(true);
    expect(rec.ledger_common_stock).toBe(1000);
    expect(rec.unlinked_equity_transactions).toHaveLength(0);
  });

  test("no-par stock reports itself inapplicable rather than reconciled", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { name: "Common", par_value: 0 });
    const ada = await makeHolder(token, "Ada");
    // equity.js puts the full proceeds in Common Stock when par rounds to
    // nothing, so the account holds dollars raised, not par value.
    await issueForCash(token, { cls, holder: ada, shares: 1000, amount: 25000, parValue: 0 });

    const rec = await reconciliation(token);
    expect(rec.applicable).toBe(false);
    expect(rec.reconciles).toBeNull();
    expect(rec.reason).toMatch(/no stated par value/);
  });

  test("nothing issued yet reports inapplicable with a reason, not a false pass", async () => {
    const token = await signup(app, request);
    await makeClass(token);
    const rec = await reconciliation(token);
    expect(rec.applicable).toBe(false);
    expect(rec.reconciles).toBeNull();
    expect(rec.reason).toMatch(/nothing in Common Stock/);
  });
});

describe("the link between a share movement and the money that paid for it", () => {
  async function contribution(token, { shares = 1000, amount = 5000, date = "2026-01-15" } = {}) {
    const cash = await accountId(token, "Cash");
    const res = await request(app)
      .post("/api/equity/transactions")
      .set(authHeader(token))
      .send({ type: "contribution", transaction_date: date, amount, cash_account_id: cash, shares, par_value: 0.001 });
    expect(res.status).toBe(201);
    return res.body;
  }

  test("the equity transaction has to be the kind that funds this movement", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const funding = await contribution(token);

    // A contribution pays for an issuance, not for a buyback.
    const res = await shareTxn(token, {
      type: "repurchase",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      from_shareholder_id: ada.id,
      equity_transaction_id: funding.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/treasury purchase/);
  });

  test("the share counts have to agree", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const funding = await contribution(token, { shares: 1000 });

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 900,
      to_shareholder_id: ada.id,
      equity_transaction_id: funding.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/covers 1000 shares, not 900/);
  });

  test("one equity transaction can't pay for two issuances", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");
    const funding = await contribution(token, { shares: 1000 });

    const first = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      to_shareholder_id: ada.id,
      equity_transaction_id: funding.id,
    });
    expect(first.status).toBe(201);

    const second = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      to_shareholder_id: grace.id,
      equity_transaction_id: funding.id,
    });
    expect(second.status).toBe(422);
    expect(second.body.detail).toMatch(/already linked/);
  });

  test("a transfer has no equity transaction to link to", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");
    const funding = await contribution(token, { shares: 1000 });

    await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      to_shareholder_id: ada.id,
    });
    const res = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-02-01",
      shares: 100,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
      equity_transaction_id: funding.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/moves no company money/);
  });

  test("a voided equity transaction can't fund anything", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const funding = await contribution(token, { shares: 1000 });
    await request(app).post(`/api/equity/transactions/${funding.id}/void`).set(authHeader(token));

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      to_shareholder_id: ada.id,
      equity_transaction_id: funding.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/voided/);
  });

  test("another org's equity transaction is invisible", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const theirs = await contribution(otherToken, { shares: 1000 });

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 1000,
      to_shareholder_id: ada.id,
      equity_transaction_id: theirs.id,
    });
    expect(res.status).toBe(404);
    // 404 rather than a validation error, and the row really does exist --
    // it's just not this org's to see.
    expect(await EquityTransaction.count()).toBe(1);
  });
});

