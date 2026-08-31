// Fixed assets (fixedAssets.js, models/FixedAsset.js, routes/fixedAssets.js).
//
// Before this, straight-line depreciation was a one-shot calculator
// (routes/adjustments.js's old POST /api/recurring-entries/depreciation)
// that built a RecurringEntry template and then discarded the cost/
// salvage/useful-life/acquisition-date inputs that produced it -- nothing
// tracked the asset itself. These tests pin that a FixedAsset (1) still
// posts through the exact same recurring-entry machinery, (2) reports
// accumulated depreciation from what's actually posted rather than from
// schedule math, and (3) stops closeAutomation.js's undepreciated-asset
// suggestion from nagging about an asset that's now properly set up.
import request from "supertest";
import { app } from "../src/app.js";
import { suggestDepreciation } from "../src/closeAutomation.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function createOfficeEquipmentAsset(token, overrides = {}) {
  const asset = await accountId(token, "Uncategorized Asset");
  const expense = await accountId(token, "Uncategorized Expense");
  return request(app)
    .post("/api/fixed-assets")
    .set(authHeader(token))
    .send({
      name: "Delivery Van",
      cost: 30000,
      salvage_value: 6000,
      useful_life_months: 48,
      acquisition_date: "2026-01-31",
      asset_account_id: asset,
      expense_account_id: expense,
      accumulated_depreciation_account_id: asset,
      ...overrides,
    });
}

test("creating a fixed asset works out the monthly amount and starts with nothing posted yet", async () => {
  const token = await signup(app, request);
  const res = await createOfficeEquipmentAsset(token);
  expect(res.status).toBe(201);
  // (30000 - 6000) / 48
  expect(res.body.monthly_amount).toBe(500);
  // Nothing posts until /api/recurring-entries/run actually runs it --
  // creation only builds the schedule.
  expect(res.body.accumulated_depreciation).toBe(0);
  expect(res.body.book_value).toBe(30000);
  expect(res.body.fully_depreciated).toBe(false);
});

test("salvage value can't exceed cost", async () => {
  const token = await signup(app, request);
  const res = await createOfficeEquipmentAsset(token, { cost: 1000, salvage_value: 2000 });
  expect(res.status).toBe(422);
});

test("the asset account must actually be an asset", async () => {
  const token = await signup(app, request);
  const liability = await accountId(token, "Accounts Payable");
  const res = await createOfficeEquipmentAsset(token, { asset_account_id: liability });
  expect(res.status).toBe(422);
});

test("running due entries posts real depreciation, and accumulated depreciation reflects only what actually posted", async () => {
  const token = await signup(app, request);
  const created = await createOfficeEquipmentAsset(token);

  // Two months due: Jan 31 and Feb 28.
  await request(app)
    .post("/api/recurring-entries/run")
    .set(authHeader(token))
    .send({ as_of: "2026-02-28" });

  const list = await request(app).get("/api/fixed-assets").set(authHeader(token));
  const asset = list.body.items.find((a) => a.id === created.body.id);
  expect(asset.accumulated_depreciation).toBe(1000); // 2 x 500
  expect(asset.book_value).toBe(29000); // 30000 - 1000
  expect(asset.fully_depreciated).toBe(false);
});

test("pausing a fixed asset stops it from posting further", async () => {
  const token = await signup(app, request);
  const created = await createOfficeEquipmentAsset(token);

  const paused = await request(app)
    .patch(`/api/fixed-assets/${created.body.id}`)
    .set(authHeader(token))
    .send({ active: false });
  expect(paused.body.active).toBe(false);

  await request(app).post("/api/recurring-entries/run").set(authHeader(token)).send({ as_of: "2026-06-30" });

  const list = await request(app).get("/api/fixed-assets").set(authHeader(token));
  const asset = list.body.items.find((a) => a.id === created.body.id);
  expect(asset.accumulated_depreciation).toBe(0);
});

test("deleting a fixed asset removes its recurring entry too", async () => {
  const token = await signup(app, request);
  const created = await createOfficeEquipmentAsset(token);

  const del = await request(app).delete(`/api/fixed-assets/${created.body.id}`).set(authHeader(token));
  expect(del.status).toBe(200);

  const templates = await request(app).get("/api/recurring-entries").set(authHeader(token));
  expect(templates.body.items.find((t) => t.id === created.body.recurring_entry_id)).toBeUndefined();

  const assets = await request(app).get("/api/fixed-assets").set(authHeader(token));
  expect(assets.body.items).toHaveLength(0);
});

test("a tracked fixed asset stops the close automation from suggesting it needs depreciation", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const asset = await accountId(token, "Uncategorized Asset");
  const expense = await accountId(token, "Uncategorized Expense");

  // Give the asset account a balance the way a real purchase would --
  // a manual journal entry debiting it.
  const cash = await accountId(token, "Cash");
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-01-15",
      memo: "Bought equipment",
      lines: [
        { account_id: asset, debit: 30000 },
        { account_id: cash, credit: 30000 },
      ],
    });

  const before = await suggestDepreciation(org, "2026-01");
  expect(before.some((s) => s.account_id === asset)).toBe(true);

  await createOfficeEquipmentAsset(token, { asset_account_id: asset, expense_account_id: expense, accumulated_depreciation_account_id: asset });

  const after = await suggestDepreciation(org, "2026-01");
  expect(after.some((s) => s.account_id === asset)).toBe(false);
});

test("fixed assets are isolated per org", async () => {
  const tokenA = await signup(app, request);
  const created = await createOfficeEquipmentAsset(tokenA);

  const tokenB = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
  const listB = await request(app).get("/api/fixed-assets").set(authHeader(tokenB));
  expect(listB.body.items).toHaveLength(0);

  const patchB = await request(app)
    .patch(`/api/fixed-assets/${created.body.id}`)
    .set(authHeader(tokenB))
    .send({ active: false });
  expect(patchB.status).toBe(404);

  const deleteB = await request(app).delete(`/api/fixed-assets/${created.body.id}`).set(authHeader(tokenB));
  expect(deleteB.status).toBe(404);
});
