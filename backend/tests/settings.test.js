import request from "supertest";
import { app } from "../src/app.js";
import { Organization } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function upgradeToBusiness() {
  const org = await Organization.findOne();
  org.plan = "business";
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "active";
  await org.save();
  return org;
}

test("GET /api/org/settings reports the feature as unavailable on the free plan", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/org/settings").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.custom_confidence_threshold_available).toBe(false);
  expect(res.body.confidence_threshold).toBeNull();
  expect(res.body.effective_confidence_threshold).toBe(res.body.default_confidence_threshold);
});

test("PATCH /api/org/settings rejects a custom threshold on the free plan", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ confidence_threshold: 0.5 });
  expect(res.status).toBe(403);
});

test("PATCH /api/org/settings allows resetting to null on any plan", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ confidence_threshold: null });
  expect(res.status).toBe(200);
  expect(res.body.confidence_threshold).toBeNull();
});

test("PATCH /api/org/settings sets and GET reflects a custom threshold on Business", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  await upgradeToBusiness();

  const patchRes = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ confidence_threshold: 0.6 });
  expect(patchRes.status).toBe(200);
  expect(patchRes.body.confidence_threshold).toBe(0.6);
  expect(patchRes.body.effective_confidence_threshold).toBe(0.6);
  expect(patchRes.body.custom_confidence_threshold_available).toBe(true);

  const getRes = await request(app).get("/api/org/settings").set(authHeader(token));
  expect(getRes.body.confidence_threshold).toBe(0.6);
});

test("PATCH /api/org/settings rejects an out-of-range threshold", async () => {
  const token = await signup(app, request, { skipOnboarding: true });
  await upgradeToBusiness();

  const res = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(token))
    .send({ confidence_threshold: 1.5 });
  expect(res.status).toBe(422);
});
