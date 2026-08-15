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

test("GET /api/org/settings includes the org name", async () => {
  const token = await signup(app, request, { orgName: "Acme Co" });
  const res = await request(app).get("/api/org/settings").set(authHeader(token));
  expect(res.body.org_name).toBe("Acme Co");
});

test("the owner can rename the organization", async () => {
  const token = await signup(app, request, { orgName: "Old Name" });
  const res = await request(app).patch("/api/org/settings").set(authHeader(token)).send({ org_name: "New Name" });
  expect(res.status).toBe(200);
  expect(res.body.org_name).toBe("New Name");

  const getRes = await request(app).get("/api/org/settings").set(authHeader(token));
  expect(getRes.body.org_name).toBe("New Name");
});

test("a non-owner member cannot rename the organization", async () => {
  const ownerToken = await signup(app, request, { orgName: "Acme Co" });
  await upgradeToBusiness(); // needs >1 seat to invite a teammate

  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(ownerToken))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");
  const acceptRes = await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: "correcthorse123" });
  const memberToken = acceptRes.body.access_token;

  const res = await request(app)
    .patch("/api/org/settings")
    .set(authHeader(memberToken))
    .send({ org_name: "Hijacked Name" });
  expect(res.status).toBe(403);

  const getRes = await request(app).get("/api/org/settings").set(authHeader(ownerToken));
  expect(getRes.body.org_name).toBe("Acme Co"); // unchanged
});

test("renaming the org does not require also sending a confidence threshold", async () => {
  const token = await signup(app, request, { orgName: "Old Name" });
  const res = await request(app).patch("/api/org/settings").set(authHeader(token)).send({ org_name: "New Name" });
  expect(res.status).toBe(200);
  expect(res.body.confidence_threshold).toBeNull(); // untouched, not reset by omission
});
