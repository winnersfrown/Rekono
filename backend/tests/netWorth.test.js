import request from "supertest";
import { app } from "../src/app.js";
import { createAccessToken, hashPassword } from "../src/auth.js";
import { User } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

// Net worth is scoped by userId, not orgId -- so unlike every other resource
// in this app, even a teammate in the *same* organization must not see it.
// This adds a second user to the first user's own org through the model
// directly (the invite HTTP flow isn't what's under test) so that claim gets
// exercised for real, rather than relying on the cross-org isolation every
// orgId-scoped resource already gets for free.
async function addTeammate(orgId, email) {
  const user = await User.create({
    orgId,
    email,
    hashedPassword: await hashPassword("correcthorse123"),
    fullName: "Teammate",
    role: "member",
  });
  return createAccessToken(user.id);
}

async function orgIdFor(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

test("a fresh account has no net worth accounts and zero totals", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/net-worth").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.accounts).toEqual([]);
  expect(res.body.net_worth).toBe(0);
  expect(res.body.trend).toEqual([]);
});

test("creating accounts sets totals with liabilities subtracted", async () => {
  const token = await signup(app, request);

  const cash = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Checking", category: "cash", current_balance: 5000 });
  expect(cash.status).toBe(201);
  expect(cash.body.category).toBe("cash");

  const loan = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Auto loan", category: "loan", current_balance: 12000 });
  expect(loan.status).toBe(201);

  const res = await request(app).get("/api/net-worth").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.accounts).toHaveLength(2);
  expect(res.body.total_assets).toBe(5000);
  expect(res.body.total_liabilities).toBe(12000);
  // A liability is stored positive and subtracted here, not stored negative.
  expect(res.body.net_worth).toBe(-7000);
  expect(res.body.trend).toHaveLength(1);
  expect(res.body.trend[0].net_worth).toBe(-7000);
});

test("a same-day balance edit updates that day's trend point instead of adding one", async () => {
  const token = await signup(app, request);
  const created = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Brokerage", category: "investment", current_balance: 1000 });

  const updated = await request(app)
    .patch(`/api/net-worth/accounts/${created.body.id}`)
    .set(authHeader(token))
    .send({ current_balance: 1500 });
  expect(updated.status).toBe(200);
  expect(updated.body.current_balance).toBe(1500);

  const res = await request(app).get("/api/net-worth").set(authHeader(token));
  expect(res.body.trend).toHaveLength(1);
  expect(res.body.trend[0].net_worth).toBe(1500);
});

test("renaming an account leaves its balance and trend untouched", async () => {
  const token = await signup(app, request);
  const created = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Brokerage", category: "investment", current_balance: 1000 });

  const renamed = await request(app)
    .patch(`/api/net-worth/accounts/${created.body.id}`)
    .set(authHeader(token))
    .send({ name: "Roth IRA", category: "retirement" });
  expect(renamed.status).toBe(200);
  expect(renamed.body.name).toBe("Roth IRA");
  expect(renamed.body.current_balance).toBe(1000);

  const res = await request(app).get("/api/net-worth").set(authHeader(token));
  expect(res.body.trend).toHaveLength(1);
  expect(res.body.net_worth).toBe(1000);
});

test("deleting an account removes it from the list", async () => {
  const token = await signup(app, request);
  const created = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Savings", category: "cash", current_balance: 200 });

  const del = await request(app).delete(`/api/net-worth/accounts/${created.body.id}`).set(authHeader(token));
  expect(del.status).toBe(200);

  const res = await request(app).get("/api/net-worth").set(authHeader(token));
  expect(res.body.accounts).toEqual([]);
  expect(res.body.net_worth).toBe(0);
});

test("rejects an unknown category", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(token))
    .send({ name: "Mystery", category: "crypto", current_balance: 1 });
  expect(res.status).toBe(422);
});

test("requires authentication", async () => {
  const res = await request(app).get("/api/net-worth");
  expect(res.status).toBe(401);
});

test("a teammate in the same organization cannot see or modify another user's accounts", async () => {
  const ownerToken = await signup(app, request);
  const orgId = await orgIdFor(ownerToken);

  const owned = await request(app)
    .post("/api/net-worth/accounts")
    .set(authHeader(ownerToken))
    .send({ name: "Owner's savings", category: "cash", current_balance: 999 });
  expect(owned.status).toBe(201);

  const teammateToken = await addTeammate(orgId, "teammate@example.co");

  const teammateList = await request(app).get("/api/net-worth").set(authHeader(teammateToken));
  expect(teammateList.status).toBe(200);
  expect(teammateList.body.accounts).toEqual([]);

  const patchAttempt = await request(app)
    .patch(`/api/net-worth/accounts/${owned.body.id}`)
    .set(authHeader(teammateToken))
    .send({ current_balance: 1 });
  expect(patchAttempt.status).toBe(404);

  const deleteAttempt = await request(app)
    .delete(`/api/net-worth/accounts/${owned.body.id}`)
    .set(authHeader(teammateToken));
  expect(deleteAttempt.status).toBe(404);

  // The owner's own view is unaffected by the teammate's failed attempts.
  const ownerList = await request(app).get("/api/net-worth").set(authHeader(ownerToken));
  expect(ownerList.body.accounts).toHaveLength(1);
  expect(ownerList.body.net_worth).toBe(999);
});
