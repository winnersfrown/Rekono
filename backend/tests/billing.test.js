import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are never set in the test
// environment (jest.setup.js), so every request below exercises the "not
// configured yet" path rather than a real Stripe call -- same limitation
// as the Resend/Anthropic-backed routes elsewhere in this suite. What's
// still fully covered here: auth is required, request validation happens
// before the Stripe-configured check (not after, as middleware would force),
// and every route fails closed (503) instead of crashing without a key.

beforeEach(resetDb);

test("checkout requires authentication", async () => {
  const res = await request(app).post("/api/billing/checkout").send({ plan: "growth", billing_period: "monthly" });
  expect(res.status).toBe(401);
});

test("checkout validates the request body before checking Stripe is configured", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/billing/checkout").set(authHeader(token)).send({ plan: "not-a-plan" });
  expect(res.status).toBe(422);
});

test("checkout returns 503 (not a crash) without Stripe configured", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/billing/checkout")
    .set(authHeader(token))
    .send({ plan: "growth", billing_period: "monthly" });
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/billing/i);
});

test("confirm requires authentication", async () => {
  const res = await request(app).get("/api/billing/confirm?session_id=cs_test_fake");
  expect(res.status).toBe(401);
});

test("confirm returns 503 without Stripe configured", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/billing/confirm?session_id=cs_test_fake").set(authHeader(token));
  expect(res.status).toBe(503);
});

test("portal requires authentication", async () => {
  const res = await request(app).get("/api/billing/portal");
  expect(res.status).toBe(401);
});

test("portal returns 503 without Stripe configured", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/billing/portal").set(authHeader(token));
  expect(res.status).toBe(503);
});

test("webhook returns 503 without Stripe configured, not a crash", async () => {
  const res = await request(app)
    .post("/api/billing/webhook")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ type: "checkout.session.completed" }));
  expect(res.status).toBe(503);
});
