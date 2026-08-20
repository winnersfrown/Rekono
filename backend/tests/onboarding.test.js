import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// STRIPE_SECRET_KEY is never set in the test environment (jest.setup.js),
// so the paid-plan path below can only be exercised up to the point where
// it would hand off to Stripe -- same "not configured yet" limitation as
// the Resend/Gemini-backed routes elsewhere in this suite.

beforeEach(resetDb);

const personalization = {
  role: "finance_accounting",
  company_size: "just_me",
  primary_use_case: "data_entry",
  monthly_invoice_volume: "under_25",
};

test("rejects unauthenticated requests", async () => {
  const res = await request(app)
    .post("/api/onboarding")
    .send({ ...personalization, plan: "free" });
  expect(res.status).toBe(401);
});

test("rejects missing personalization fields", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  const res = await request(app).post("/api/onboarding").set(authHeader(token)).send({ plan: "free" });
  expect(res.status).toBe(422);
});

test("rejects an unrecognized plan", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  const res = await request(app)
    .post("/api/onboarding")
    .set(authHeader(token))
    .send({ ...personalization, plan: "enterprise" });
  expect(res.status).toBe(422);
});

test("choosing free activates the org immediately, no payment involved", async () => {
  const token = await signup(app, request, { email: "freepicker@onboardco.co", skipOnboarding: true });
  const res = await request(app)
    .post("/api/onboarding")
    .set(authHeader(token))
    .send({ ...personalization, plan: "free" });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ checkout_required: false, onboarding_completed: true });

  const me = await request(app).get("/api/auth/me").set(authHeader(token));
  expect(me.body.plan).toBe("free");
  expect(me.body.onboarding_completed).toBe(true);

  // A now-gated route should work immediately.
  const invoices = await request(app).get("/api/invoices").set(authHeader(token));
  expect(invoices.status).toBe(200);
});

test("choosing a paid plan without billing_period is rejected", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  const res = await request(app)
    .post("/api/onboarding")
    .set(authHeader(token))
    .send({ ...personalization, plan: "growth" });
  expect(res.status).toBe(422);
});

test("choosing a paid plan without Stripe configured returns 503 but still saves personalization", async () => {
  const token = await signup(app, request, { email: "paidpicker@onboardco.co", skipOnboarding: true });
  const res = await request(app)
    .post("/api/onboarding")
    .set(authHeader(token))
    .send({ ...personalization, plan: "growth", billing_period: "monthly" });
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/billing/i);

  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  expect(org.role).toBe("finance_accounting");
  expect(org.plan).toBeNull(); // not activated -- payment never happened
});
