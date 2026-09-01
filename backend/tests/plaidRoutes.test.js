import request from "supertest";
import { app } from "../src/app.js";
import { BankAccount, BankConnection } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

// PLAID_CLIENT_ID/PLAID_SECRET are never set in the test environment
// (jest.setup.js), so every route gated on plaidConfigured() genuinely
// returns 503 here -- this file exercises those gates and the parts of
// the surface that don't touch Plaid's network at all (listing/deleting
// connections already in the database). The Plaid API logic itself
// (link tokens, exchange, transaction paging) is covered directly in
// plaid.test.js against an injected fake client.

async function makeConnection(orgId, overrides = {}) {
  return BankConnection.create({
    orgId,
    institutionName: "First National Bank",
    plaidItemId: "item-1",
    accessToken: "access-sandbox-fake",
    ...overrides,
  });
}

async function makeAccount(orgId, connectionId, overrides = {}) {
  return BankAccount.create({
    orgId,
    connectionId,
    plaidAccountId: "acct-1",
    name: "Checking",
    mask: "1234",
    accountType: "depository",
    accountSubtype: "checking",
    currentBalance: 500.25,
    ...overrides,
  });
}

test("status reports unconfigured when no Plaid credentials are set", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/integrations/plaid/status").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(false);
});

test("requesting a link token is rejected with a clean 503 when Plaid isn't configured", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/integrations/plaid/link-token").set(authHeader(token));
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/not.*configured|aren't configured/i);
});

test("exchanging a public token is rejected the same way when Plaid isn't configured", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/integrations/plaid/exchange")
    .set(authHeader(token))
    .send({ public_token: "public-sandbox-fake" });
  expect(res.status).toBe(503);
});

test("syncing an account is rejected the same way when Plaid isn't configured", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const connection = await makeConnection(org);
  const account = await makeAccount(org, connection.id);

  const res = await request(app).post(`/api/integrations/plaid/accounts/${account.id}/sync`).set(authHeader(token));
  expect(res.status).toBe(503);
});

test("lists connections with their nested accounts", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const connection = await makeConnection(org);
  await makeAccount(org, connection.id);

  const res = await request(app).get("/api/integrations/plaid/connections").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].institution_name).toBe("First National Bank");
  expect(res.body[0].accounts).toHaveLength(1);
  expect(res.body[0].accounts[0].mask).toBe("1234");
  expect(res.body[0].accounts[0].current_balance).toBe(500.25);
});

test("never exposes the encrypted access token in the connections list", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeConnection(org);

  const res = await request(app).get("/api/integrations/plaid/connections").set(authHeader(token));
  expect(JSON.stringify(res.body)).not.toMatch(/access-sandbox-fake/);
  expect(res.body[0]).not.toHaveProperty("accessToken");
  expect(res.body[0]).not.toHaveProperty("access_token");
});

test("an org only ever sees its own bank connections", async () => {
  const tokenA = await signup(app, request, { email: "plaid-a@example.co" });
  const orgA = await orgId(tokenA);
  await makeConnection(orgA);

  const tokenB = await signup(app, request, { email: "plaid-b@example.co", orgName: "Other Org" });
  const res = await request(app).get("/api/integrations/plaid/connections").set(authHeader(tokenB));
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(0);
});

test("disconnecting a connection removes it and its accounts, without a real Plaid call", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const connection = await makeConnection(org);
  const account = await makeAccount(org, connection.id);

  const res = await request(app).delete(`/api/integrations/plaid/connections/${connection.id}`).set(authHeader(token));
  expect(res.status).toBe(200);

  expect(await BankConnection.findByPk(connection.id)).toBeNull();
  expect(await BankAccount.findByPk(account.id)).toBeNull();
});

test("disconnecting another org's connection is rejected", async () => {
  const tokenA = await signup(app, request, { email: "plaid-c@example.co" });
  const orgA = await orgId(tokenA);
  const connection = await makeConnection(orgA);

  const tokenB = await signup(app, request, { email: "plaid-d@example.co", orgName: "Other Org 2" });
  const res = await request(app).delete(`/api/integrations/plaid/connections/${connection.id}`).set(authHeader(tokenB));
  expect(res.status).toBe(404);

  expect(await BankConnection.findByPk(connection.id)).not.toBeNull();
});

test("disconnecting an already-nonexistent connection returns 404", async () => {
  const token = await signup(app, request);
  const res = await request(app).delete("/api/integrations/plaid/connections/does-not-exist").set(authHeader(token));
  expect(res.status).toBe(404);
});
