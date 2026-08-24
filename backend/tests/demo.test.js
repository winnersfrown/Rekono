import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb } from "./testUtils.js";

beforeEach(resetDb);

test("demo login requires no credentials and returns a working token", async () => {
  const res = await request(app).post("/api/demo/login").send({});
  expect(res.status).toBe(201);
  expect(res.body.access_token).toBeTruthy();
  expect(res.body.token_type).toBe("bearer");

  const me = await request(app).get("/api/auth/me").set(authHeader(res.body.access_token));
  expect(me.status).toBe(200);
  expect(me.body.is_demo).toBe(true);
  expect(me.body.onboarding_completed).toBe(true);
  expect(me.body.plan).toBe("scale");
  expect(me.body.subscription_status).toBe("active");
});

test("demo login pre-populates all four document types across a mix of statuses", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const token = login.body.access_token;
  const headers = authHeader(token);

  const invoices = await request(app).get("/api/invoices").set(headers);
  const expenses = await request(app).get("/api/expenses").set(headers);
  const vendorDocs = await request(app).get("/api/vendor-documents").set(headers);
  const leases = await request(app).get("/api/leases").set(headers);

  expect(invoices.status).toBe(200);
  expect(invoices.body.items.length).toBeGreaterThan(0);
  expect(expenses.body.items.length).toBeGreaterThan(0);
  expect(vendorDocs.body.items.length).toBeGreaterThan(0);
  expect(leases.body.items.length).toBeGreaterThan(0);

  // A realistic spread of statuses, not just one flavor of row.
  const statuses = new Set(invoices.body.items.map((i) => i.status));
  expect(statuses.has("approved")).toBe(true);
  expect(statuses.has("needs_review")).toBe(true);
});

test("each demo login spins up its own isolated org", async () => {
  const first = await request(app).post("/api/demo/login").send({});
  const second = await request(app).post("/api/demo/login").send({});

  const firstMe = await request(app).get("/api/auth/me").set(authHeader(first.body.access_token));
  const secondMe = await request(app).get("/api/auth/me").set(authHeader(second.body.access_token));

  expect(firstMe.body.org_id).not.toBe(secondMe.body.org_id);
  expect(firstMe.body.email).not.toBe(secondMe.body.email);

  // Neither org sees the other's data.
  const firstInvoices = await request(app).get("/api/invoices").set(authHeader(first.body.access_token));
  const secondInvoices = await request(app).get("/api/invoices").set(authHeader(second.body.access_token));
  const firstIds = new Set(firstInvoices.body.items.map((i) => i.id));
  const overlap = secondInvoices.body.items.filter((i) => firstIds.has(i.id));
  expect(overlap).toHaveLength(0);
});

// Kept last, same reasoning as auth.test.js's rate-limit tests -- exhausts
// the shared per-file limiter state, so nothing after it needs a fresh call.
test("demo login rate limits after repeated attempts from the same IP", async () => {
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await request(app).post("/api/demo/login").send({});
  }
  expect(lastRes.status).toBe(429);
  // Generous timeout: the 20 requests before the limiter trips each seed a
  // whole demo org (invoices, receipts, vendor documents, leases, tax
  // documents), so this is the most expensive test in the suite by far and
  // was previously finishing within a few hundred milliseconds of its own
  // limit whenever the workers were busy.
}, 60000);
