import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// requireActivePlan (src/plan.js) replaced the old 14-day trial gate.
// Exercised here directly against one real gated route (GET /api/invoices)
// rather than re-testing every route that mounts it -- they all share the
// exact same middleware, so this is representative of all of them.

beforeEach(resetDb);

test("blocks access with onboarding_required when no plan has been chosen", async () => {
  const token = await signup(app, request, { email: "noplan@planco.co", skipOnboarding: true });
  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(402);
  expect(res.body.onboarding_required).toBe(true);
});

test("allows access on the free plan", async () => {
  const token = await signup(app, request, { email: "free@planco.co" }); // default: onboards onto free
  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(200);
});

test("blocks access with billing_required when a paid plan has no active subscription", async () => {
  const token = await signup(app, request, { email: "unpaid@planco.co", skipOnboarding: true });
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  org.plan = "growth";
  org.billingPeriod = "monthly";
  org.subscriptionStatus = null; // checkout was never completed
  await org.save();

  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(402);
  expect(res.body.billing_required).toBe(true);
});

test("blocks access with billing_required once a subscription is canceled", async () => {
  const token = await signup(app, request, { email: "canceled@planco.co", skipOnboarding: true });
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  org.plan = "starter";
  org.billingPeriod = "annual";
  org.subscriptionStatus = "canceled";
  await org.save();

  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(402);
  expect(res.body.billing_required).toBe(true);
});

test("allows access on a paid plan with an active subscription", async () => {
  const token = await signup(app, request, { email: "paid@planco.co", skipOnboarding: true });
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  org.plan = "growth";
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "active";
  await org.save();

  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(200);
});

test("allows access on a paid plan that's still in its Stripe trial", async () => {
  const token = await signup(app, request, { email: "trialing@planco.co", skipOnboarding: true });
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  org.plan = "starter";
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "trialing";
  await org.save();

  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.status).toBe(200);
});

test("auth routes stay exempt from plan gating", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.onboarding_completed).toBe(false);
});
