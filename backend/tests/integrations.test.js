import request from "supertest";
import { app } from "../src/app.js";
import { Invoice, Organization } from "../src/models/index.js";
import { rememberVendorExpenseAccount } from "../src/vendorExpenseAccount.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// QUICKBOOKS_CLIENT_ID is never set in the test environment (jest.setup.js),
// so /connect can only be exercised down to its "not configured" 503 here --
// same limitation as the Stripe/Google-backed routes elsewhere in this
// suite (see billing.test.js, googleAuth.test.js). What's fully covered
// instead: auth is required everywhere it should be, every route fails
// closed instead of crashing when QuickBooks isn't configured or connected,
// and the push route's ordering of checks (invoice exists -> connected ->
// default account set -> not already pushed) -- verified by connecting an
// org directly at the database level (bypassing the real OAuth round trip,
// same as settings.test.js's upgradeToBusiness helper bypasses real Stripe).

beforeEach(resetDb);

async function connectOrg(overrides = {}) {
  const org = await Organization.findOne();
  org.quickbooksRealmId = "9999";
  org.quickbooksAccessToken = "fake-access-token";
  org.quickbooksRefreshToken = "fake-refresh-token";
  org.quickbooksAccessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  org.quickbooksRefreshTokenExpiresAt = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
  Object.assign(org, overrides);
  await org.save();
  return org;
}

async function makeInvoice(orgId, overrides = {}) {
  return Invoice.create({
    orgId,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

describe("auth is required", () => {
  test.each([
    ["get", "/api/integrations/quickbooks/status"],
    ["get", "/api/integrations/quickbooks/connect"],
    ["get", "/api/integrations/quickbooks/accounts"],
    ["patch", "/api/integrations/quickbooks/default-account"],
    ["post", "/api/integrations/quickbooks/disconnect"],
    ["post", "/api/integrations/quickbooks/invoices/fake-id/push"],
    ["post", "/api/integrations/quickbooks/invoices/fake-id/suggest-account"],
    ["patch", "/api/integrations/quickbooks/invoices/fake-id/expense-account"],
  ])("%s %s requires authentication", async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });
});

test("GET /api/integrations/quickbooks/status reports unconfigured + disconnected by default", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/integrations/quickbooks/status").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    configured: false,
    connected: false,
    default_expense_account_id: null,
    default_expense_account_name: null,
  });
});

test("GET /api/integrations/quickbooks/connect returns 503 (not a crash) without QuickBooks configured", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/integrations/quickbooks/connect").set(authHeader(token));
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/quickbooks/i);
});

describe("GET /api/integrations/quickbooks/callback", () => {
  test("redirects to an error when the state is unknown", async () => {
    const res = await request(app).get("/api/integrations/quickbooks/callback?code=fake&state=unknown&realmId=1");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?quickbooks=error&reason=state_mismatch");
  });

  test("redirects to an error when Intuit reports the user declined", async () => {
    const res = await request(app).get("/api/integrations/quickbooks/callback?error=access_denied&state=unknown");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?quickbooks=error&reason=state_mismatch"); // unknown state is checked first
  });
});

test("GET /api/integrations/quickbooks/accounts requires a connection first", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/integrations/quickbooks/accounts").set(authHeader(token));
  expect(res.status).toBe(400);
});

describe("PATCH /api/integrations/quickbooks/default-account", () => {
  test("validates the request body", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const res = await request(app).patch("/api/integrations/quickbooks/default-account").set(authHeader(token)).send({});
    expect(res.status).toBe(422);
  });

  test("requires a connection first", async () => {
    const token = await signup(app, request);
    const res = await request(app)
      .patch("/api/integrations/quickbooks/default-account")
      .set(authHeader(token))
      .send({ account_id: "42", account_name: "Office Supplies" });
    expect(res.status).toBe(400);
  });

  test("sets the default account once connected", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const res = await request(app)
      .patch("/api/integrations/quickbooks/default-account")
      .set(authHeader(token))
      .send({ account_id: "42", account_name: "Office Supplies" });
    expect(res.status).toBe(200);
    expect(res.body.default_expense_account_id).toBe("42");
    expect(res.body.default_expense_account_name).toBe("Office Supplies");

    const statusRes = await request(app).get("/api/integrations/quickbooks/status").set(authHeader(token));
    expect(statusRes.body.connected).toBe(true);
    expect(statusRes.body.default_expense_account_id).toBe("42");
  });
});

test("POST /api/integrations/quickbooks/disconnect clears the connection", async () => {
  const token = await signup(app, request);
  await connectOrg({ quickbooksDefaultExpenseAccountId: "42", quickbooksDefaultExpenseAccountName: "Office Supplies" });

  const res = await request(app).post("/api/integrations/quickbooks/disconnect").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.connected).toBe(false);
  expect(res.body.default_expense_account_id).toBeNull();

  const org = await Organization.findOne();
  expect(org.quickbooksRealmId).toBeNull();
  expect(org.quickbooksAccessToken).toBeNull();
});

describe("POST /api/integrations/quickbooks/invoices/:id/push", () => {
  test("404s for an invoice that doesn't exist", async () => {
    const token = await signup(app, request);
    const res = await request(app).post("/api/integrations/quickbooks/invoices/does-not-exist/push").set(authHeader(token));
    expect(res.status).toBe(404);
  });

  test("refuses to push when QuickBooks isn't connected", async () => {
    const token = await signup(app, request);
    const invoice = await makeInvoice(await orgId(token));
    const res = await request(app).post(`/api/integrations/quickbooks/invoices/${invoice.id}/push`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/connect quickbooks/i);
  });

  test("refuses to push without a default expense account chosen", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const invoice = await makeInvoice(await orgId(token));
    const res = await request(app).post(`/api/integrations/quickbooks/invoices/${invoice.id}/push`).set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/default expense account/i);
  });

  test("refuses to push an invoice that's already been pushed", async () => {
    const token = await signup(app, request);
    await connectOrg({ quickbooksDefaultExpenseAccountId: "42", quickbooksDefaultExpenseAccountName: "Office Supplies" });
    const invoice = await makeInvoice(await orgId(token), { quickbooksBillId: "already-pushed" });
    const res = await request(app).post(`/api/integrations/quickbooks/invoices/${invoice.id}/push`).set(authHeader(token));
    expect(res.status).toBe(409);
  });

  test("an invoice belonging to another org can't be pushed", async () => {
    const tokenA = await signup(app, request, { email: "a@example.co", orgName: "Org A" });
    const invoiceA = await makeInvoice(await orgId(tokenA));

    const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
    const orgB = await Organization.findByPk(await orgId(tokenB));
    orgB.quickbooksRealmId = "9999";
    orgB.quickbooksAccessToken = "fake-access-token";
    orgB.quickbooksRefreshToken = "fake-refresh-token";
    orgB.quickbooksAccessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    orgB.quickbooksRefreshTokenExpiresAt = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    orgB.quickbooksDefaultExpenseAccountId = "42";
    orgB.quickbooksDefaultExpenseAccountName = "Office Supplies";
    await orgB.save();

    const res = await request(app).post(`/api/integrations/quickbooks/invoices/${invoiceA.id}/push`).set(authHeader(tokenB));
    expect(res.status).toBe(404);
  });
});

// Only paths that don't require a real call to Intuit's API are covered
// here, same boundary the existing GET /accounts tests already draw --
// "no memory, has to actually fetch+categorize" is covered instead at the
// quickbooks.js unit level (see quickbooks.test.js's suggestExpenseAccount
// tests), with an injected fetchImpl standing in for Intuit/Anthropic.
describe("POST /api/integrations/quickbooks/invoices/:id/suggest-account", () => {
  test("404s for an invoice that doesn't exist", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const res = await request(app)
      .post("/api/integrations/quickbooks/invoices/does-not-exist/suggest-account")
      .set(authHeader(token));
    expect(res.status).toBe(404);
  });

  test("requires a connection first", async () => {
    const token = await signup(app, request);
    const invoice = await makeInvoice(await orgId(token));
    const res = await request(app)
      .post(`/api/integrations/quickbooks/invoices/${invoice.id}/suggest-account`)
      .set(authHeader(token));
    expect(res.status).toBe(400);
  });

  test("echoes back an already-categorized invoice without re-suggesting", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const invoice = await makeInvoice(await orgId(token), {
      quickbooksExpenseAccountId: "42",
      quickbooksExpenseAccountName: "Office Supplies",
      quickbooksExpenseAccountConfidence: 0.6,
    });

    const res = await request(app)
      .post(`/api/integrations/quickbooks/invoices/${invoice.id}/suggest-account`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quickbooks_expense_account_id: "42",
      quickbooks_expense_account_name: "Office Supplies",
      quickbooks_expense_account_confidence: 0.6,
    });
  });

  test("uses a remembered vendor account instead of asking for a fresh suggestion", async () => {
    const token = await signup(app, request);
    const org = await connectOrg();
    const invoice = await makeInvoice(await orgId(token), { vendorName: "Amazon Web Services" });
    await rememberVendorExpenseAccount(org.id, "Amazon Web Services", "77", "Software & Subscriptions");

    const res = await request(app)
      .post(`/api/integrations/quickbooks/invoices/${invoice.id}/suggest-account`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.quickbooks_expense_account_id).toBe("77");
    expect(res.body.quickbooks_expense_account_name).toBe("Software & Subscriptions");
    expect(res.body.quickbooks_expense_account_confidence).toBe(1);
  });
});

describe("PATCH /api/integrations/quickbooks/invoices/:id/expense-account", () => {
  test("validates the request body", async () => {
    const token = await signup(app, request);
    await connectOrg();
    const invoice = await makeInvoice(await orgId(token));
    const res = await request(app)
      .patch(`/api/integrations/quickbooks/invoices/${invoice.id}/expense-account`)
      .set(authHeader(token))
      .send({});
    expect(res.status).toBe(422);
  });

  test("404s for an invoice that doesn't exist", async () => {
    const token = await signup(app, request);
    const res = await request(app)
      .patch("/api/integrations/quickbooks/invoices/does-not-exist/expense-account")
      .set(authHeader(token))
      .send({ account_id: "42", account_name: "Office Supplies" });
    expect(res.status).toBe(404);
  });

  test("sets the invoice's account and remembers it for the vendor", async () => {
    const token = await signup(app, request);
    const org = await connectOrg();
    const invoice = await makeInvoice(await orgId(token), { vendorName: "Amazon Web Services" });

    const res = await request(app)
      .patch(`/api/integrations/quickbooks/invoices/${invoice.id}/expense-account`)
      .set(authHeader(token))
      .send({ account_id: "77", account_name: "Software & Subscriptions" });
    expect(res.status).toBe(200);
    expect(res.body.quickbooks_expense_account_id).toBe("77");
    expect(res.body.quickbooks_expense_account_confidence).toBe(1);

    // A second invoice from the same vendor should now suggest the
    // remembered account directly, with no LLM call needed.
    const secondInvoice = await makeInvoice(org.id, { vendorName: "Amazon Web Services" });
    const suggestRes = await request(app)
      .post(`/api/integrations/quickbooks/invoices/${secondInvoice.id}/suggest-account`)
      .set(authHeader(token));
    expect(suggestRes.body.quickbooks_expense_account_id).toBe("77");
  });
});
