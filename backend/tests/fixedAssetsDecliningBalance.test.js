// Declining-balance depreciation (fixedAssets.js's decliningBalancePeriodCents/
// runDecliningBalanceDepreciation, routes/fixedAssets.js's
// POST /api/fixed-assets/:id/run-depreciation).
//
// Unlike straight-line, the amount changes every period, so there's no
// RecurringEntry template to lean on -- these assert that each period's
// amount is recomputed off the ledger's real accumulated balance (not a
// running total that could drift), that it floors at salvage value
// instead of overshooting, and that it never posts through the
// straight-line machinery by mistake.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function accountRow(token, name, asOf) {
  const res = await request(app).get(`/api/ledger/trial-balance?as_of=${asOf}`).set(authHeader(token));
  return res.body.accounts.find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function createDecliningAsset(token, overrides = {}) {
  const asset = await accountId(token, "Uncategorized Asset");
  const expense = await accountId(token, "Uncategorized Expense");
  return request(app)
    .post("/api/fixed-assets")
    .set(authHeader(token))
    .send({
      name: "Delivery Van",
      cost: 1000,
      salvage_value: 100,
      useful_life_months: 24,
      acquisition_date: "2026-01-15",
      asset_account_id: asset,
      expense_account_id: expense,
      accumulated_depreciation_account_id: asset,
      method: "declining_balance",
      declining_balance_rate_percent: 120, // 10%/month of book value
      ...overrides,
    });
}

test("creating a declining-balance asset builds no recurring entry", async () => {
  const token = await signup(app, request);
  const created = await createDecliningAsset(token);
  expect(created.status).toBe(201);
  expect(created.body.method).toBe("declining_balance");
  expect(created.body.recurring_entry_id).toBeNull();
  expect(created.body.declining_balance_rate_percent).toBe(120);
});

test("declining-balance rate is required and must be positive", async () => {
  const token = await signup(app, request);
  const res = await createDecliningAsset(token, { declining_balance_rate_percent: undefined });
  expect(res.status).toBe(422);
});

test("running depreciation posts the rate applied to book value, not a fixed amount", async () => {
  const token = await signup(app, request);
  const created = await createDecliningAsset(token);

  // 120%/year = 10%/month of book value. First month: 1000 * 0.10 = 100.
  const run1 = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2026-01-31" });
  expect(run1.status).toBe(200);
  expect(run1.body.posted).toHaveLength(1);
  expect(run1.body.posted[0].amount).toBe(100);
  expect(run1.body.asset.accumulated_depreciation).toBe(100);

  // Second month depreciates off the NEW book value (900), not the
  // original cost -- that's the whole point of declining balance.
  const run2 = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2026-02-28" });
  expect(run2.body.posted).toHaveLength(1);
  expect(run2.body.posted[0].amount).toBe(90);

  const tb = await accountRow(token, "Uncategorized Expense", "2026-02-28");
  expect(tb.debit).toBe(190);
});

test("catching up several missed months in one call recomputes each period off the real ledger", async () => {
  const token = await signup(app, request);
  const created = await createDecliningAsset(token);

  const run = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2026-04-30" });
  expect(run.body.posted).toHaveLength(4);
  // Each entry should be a bit smaller than the last as book value shrinks.
  const amounts = run.body.posted.map((p) => p.amount);
  expect(amounts[0]).toBeGreaterThan(amounts[1]);
  expect(amounts[1]).toBeGreaterThan(amounts[2]);
  expect(amounts[2]).toBeGreaterThan(amounts[3]);
});

test("depreciation never posts past salvage value", async () => {
  const token = await signup(app, request);
  const created = await createDecliningAsset(token, { declining_balance_rate_percent: 900 });

  const run = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2027-12-31" });

  const asset = run.body.asset;
  expect(asset.book_value).toBe(100); // exactly salvage, never below
  expect(asset.fully_depreciated).toBe(true);

  // Running it again posts nothing more.
  const again = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2028-12-31" });
  expect(again.body.posted).toHaveLength(0);
});

test("pausing a declining-balance asset refuses further runs", async () => {
  const token = await signup(app, request);
  const created = await createDecliningAsset(token);

  const paused = await request(app).patch(`/api/fixed-assets/${created.body.id}`).set(authHeader(token)).send({ active: false });
  expect(paused.body.active).toBe(false);

  const run = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2026-06-30" });
  expect(run.status).toBe(422);
  expect(run.body.detail).toMatch(/paused/i);
});

test("running depreciation on a straight-line asset is refused", async () => {
  const token = await signup(app, request);
  const asset = await accountId(token, "Uncategorized Asset");
  const expense = await accountId(token, "Uncategorized Expense");
  const created = await request(app)
    .post("/api/fixed-assets")
    .set(authHeader(token))
    .send({
      name: "Straight-line Asset",
      cost: 10000,
      salvage_value: 0,
      useful_life_months: 10,
      acquisition_date: "2026-01-01",
      asset_account_id: asset,
      expense_account_id: expense,
      accumulated_depreciation_account_id: asset,
    });

  const run = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(token))
    .send({ as_of: "2026-06-30" });
  expect(run.status).toBe(422);
  expect(run.body.detail).toMatch(/doesn't use declining-balance/i);
});

test("declining-balance assets are isolated per org", async () => {
  const tokenA = await signup(app, request);
  const created = await createDecliningAsset(tokenA);

  const tokenB = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
  const run = await request(app)
    .post(`/api/fixed-assets/${created.body.id}/run-depreciation`)
    .set(authHeader(tokenB))
    .send({ as_of: "2026-06-30" });
  expect(run.status).toBe(404);
});
