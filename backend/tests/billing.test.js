import request from "supertest";
import { jest } from "@jest/globals";
import { app } from "../src/app.js";
import { cancelReplacedSubscription, checkoutSessionBelongsToOrg, createCheckoutSession } from "../src/routes/billing.js";
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

// cancelReplacedSubscription is what stops an org upgrading plans from
// ending up with two simultaneous (and simultaneously billed) Stripe
// subscriptions -- exercised directly against a fake Stripe client since the
// rest of this suite never has a real Stripe key to hit the real API with.
describe("cancelReplacedSubscription", () => {
  test("cancels the org's existing subscription when it differs from the new one", async () => {
    const cancel = jest.fn().mockResolvedValue({});
    const stripe = { subscriptions: { cancel } };
    const org = { stripeSubscriptionId: "sub_old" };
    await cancelReplacedSubscription(stripe, org, "sub_new");
    expect(cancel).toHaveBeenCalledWith("sub_old");
  });

  test("does nothing when the org has no prior subscription", async () => {
    const cancel = jest.fn();
    const stripe = { subscriptions: { cancel } };
    const org = { stripeSubscriptionId: null };
    await cancelReplacedSubscription(stripe, org, "sub_new");
    expect(cancel).not.toHaveBeenCalled();
  });

  test("does nothing when the new subscription is the same as the existing one", async () => {
    const cancel = jest.fn();
    const stripe = { subscriptions: { cancel } };
    const org = { stripeSubscriptionId: "sub_same" };
    await cancelReplacedSubscription(stripe, org, "sub_same");
    expect(cancel).not.toHaveBeenCalled();
  });

  test("swallows errors from Stripe instead of throwing", async () => {
    const cancel = jest.fn().mockRejectedValue(new Error("already canceled"));
    const stripe = { subscriptions: { cancel } };
    const org = { stripeSubscriptionId: "sub_old" };
    await expect(cancelReplacedSubscription(stripe, org, "sub_new")).resolves.toBeUndefined();
  });
});

// checkoutSessionBelongsToOrg is the only thing standing between a
// signed-in user hand-crafting /api/billing/confirm?session_id=... with
// someone else's real session_id and activating billing status onto their
// own org using a stranger's completed payment -- exercised directly since
// there's no real Stripe session to fetch in this test env.
describe("checkoutSessionBelongsToOrg", () => {
  test("true when the session's org_id metadata matches the caller's org", () => {
    const session = { metadata: { org_id: "org_1" } };
    expect(checkoutSessionBelongsToOrg(session, "org_1")).toBe(true);
  });

  test("false when the session belongs to a different org", () => {
    const session = { metadata: { org_id: "org_1" } };
    expect(checkoutSessionBelongsToOrg(session, "org_2")).toBe(false);
  });

  test("false when the session has no metadata at all", () => {
    expect(checkoutSessionBelongsToOrg({}, "org_1")).toBe(false);
  });
});

// createCheckoutSession is what onboarding.js (a brand new org's first paid
// plan) and /api/billing/checkout (a later plan change) both build their
// Stripe session from -- trialDays is the one param only onboarding.js ever
// passes, and getting this wrong either bills a new signup immediately (no
// trial) or silently gives every plan change a trial it shouldn't have.
describe("createCheckoutSession", () => {
  function fakeStripe() {
    const create = jest.fn().mockResolvedValue({ url: "https://checkout.stripe.com/fake" });
    return { stripe: { checkout: { sessions: { create } } }, create };
  }

  test("includes subscription_data.trial_period_days when trialDays is passed", async () => {
    const { stripe, create } = fakeStripe();
    await createCheckoutSession({
      org: { id: "org_1" },
      email: "a@b.co",
      planId: "starter",
      billingPeriod: "monthly",
      baseUrl: "https://app.example.com",
      trialDays: 14,
      stripe,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ subscription_data: { trial_period_days: 14 } }));
  });

  test("omits subscription_data entirely when trialDays isn't passed", async () => {
    const { stripe, create } = fakeStripe();
    await createCheckoutSession({
      org: { id: "org_1" },
      email: "a@b.co",
      planId: "starter",
      billingPeriod: "monthly",
      baseUrl: "https://app.example.com",
      stripe,
    });
    const paramsSent = create.mock.calls[0][0];
    expect(paramsSent.subscription_data).toBeUndefined();
  });
});
